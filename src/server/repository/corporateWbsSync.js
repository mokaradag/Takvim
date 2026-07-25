import 'server-only';
import { getCorporateWbsDbConfig, isCorporateWbsSourceConfigured } from '../db/corporateWbsConfig.js';
import { getCorporateWbsPool } from '../db/corporateWbsPool.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import {
  CORPORATE_PROJECT_CODES_SQL,
  CORPORATE_WBS_MERGE_SQL,
  CORPORATE_WBS_SYNC_STATE_SQL,
  CORPORATE_WBS_SYNC_STATE_UPSERT_SQL,
  buildCorporateWbsSourceQuery
} from './corporateWbsQueries.js';
import { planCorporateWbsNodes } from './corporateWbsProjection.js';
import { indexCorporateWbsSyncState, planCorporateWbsSyncBatch } from './corporateWbsSyncState.js';

function chunk(values, size) {
  const batches = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

async function loadCorporateProjects(executor) {
  const result = await executor.request().query(CORPORATE_PROJECT_CODES_SQL);
  return (result.recordset || [])
    .map((row) => ({
      projectId: String(row.ProjectId),
      projectCode: String(row.ProjectCode || '').trim().toUpperCase(),
      projectName: String(row.ProjectName || '').trim()
    }))
    .filter((project) => project.projectCode);
}

/**
 * Eşitleme durumu tablosu okunamazsa (eski şema, izin eksikliği) eşitleme
 * durmaz: boş durumla devam edilir, yalnızca hızlandırma katmanı devre dışı
 * kalır.
 */
async function loadSyncState(executor, logger) {
  try {
    const result = await executor.request().query(CORPORATE_WBS_SYNC_STATE_SQL);
    return indexCorporateWbsSyncState(result.recordset || []);
  } catch (cause) {
    logger?.warn?.('Kurumsal WBS eşitleme durumu okunamadı; parmak izi hızlandırması bu tur devre dışı.', cause);
    return new Map();
  }
}

async function loadSourceRows(sourcePool, config, projectCodes) {
  const request = sourcePool.request();
  projectCodes.forEach((code, index) => {
    request.input(`code${index}`, sql.NVarChar(255), code);
  });
  const result = await request.query(buildCorporateWbsSourceQuery(config, projectCodes.length));
  return result.recordset || [];
}

async function mergeProjectNodes(executor, actorSicil, project, nodes) {
  const request = executor.request();
  request.input('projectId', sql.UniqueIdentifier, project.projectId);
  request.input('projectCode', sql.NVarChar(100), project.projectCode.slice(0, 100));
  request.input('projectName', sql.NVarChar(1000), project.projectName || project.projectCode);
  request.input('actorSicil', sql.Int, actorSicil);
  request.input('payload', sql.NVarChar(sql.MAX), JSON.stringify(nodes));
  await request.query(CORPORATE_WBS_MERGE_SQL);
}

async function recordSyncState(executor, actorSicil, projectCode, contentHash, nodeCount) {
  const request = executor.request();
  request.input('projectCode', sql.NVarChar(100), projectCode.slice(0, 100));
  request.input('contentHash', sql.Char(64), contentHash);
  request.input('nodeCount', sql.Int, nodeCount);
  request.input('actorSicil', sql.Int, actorSicil);
  await request.query(CORPORATE_WBS_SYNC_STATE_UPSERT_SQL);
}

/**
 * Kurumsal projelerin iş dağılım ağacını CN43N kaynağından eşitler.
 *
 * Kaynak yapılandırılmadıysa hiçbir şey yapmaz. Kaynağa erişilemediğinde hata
 * yükseltilmez: anlık görüntü yüklemesi kurumsal WBS olmadan da sürer, yalnızca
 * sunucu günlüğüne uyarı yazılır. Aksi hâlde ikinci veritabanındaki geçici bir
 * kesinti tüm uygulamayı kullanılamaz hâle getirirdi.
 *
 * Başarım notu: içeriği değişmeyen projeler için birleştirme adımı atlanır ve
 * eşitlemenin tamamı süreç düzeyinde bir tazelik penceresiyle sınırlanır. Bu
 * iki katman olmadan 38 bin satırlık kurulumda her anlık görüntü isteği
 * MR_WBS üzerinde baştan birleştirme yapıyor, açılış otuz saniyeyi aşıyordu.
 *
 * @returns {Promise<{ synchronized: boolean, projectCount: number, nodeCount: number,
 *   mergedProjectCount: number, skippedProjectCount: number, reason?: string }>}
 */
export async function synchronizeCorporateWbs(executor, actorSicil, { logger = console } = {}) {
  if (!isCorporateWbsSourceConfigured()) {
    return { synchronized: false, projectCount: 0, nodeCount: 0, mergedProjectCount: 0, skippedProjectCount: 0, reason: 'NOT_CONFIGURED' };
  }

  const config = getCorporateWbsDbConfig();
  try {
    const sourcePool = await getCorporateWbsPool();
    if (!sourcePool) {
      return { synchronized: false, projectCount: 0, nodeCount: 0, mergedProjectCount: 0, skippedProjectCount: 0, reason: 'NOT_CONFIGURED' };
    }

    const projects = await loadCorporateProjects(executor);
    if (!projects.length) {
      return { synchronized: true, projectCount: 0, nodeCount: 0, mergedProjectCount: 0, skippedProjectCount: 0 };
    }

    const projectsByCode = new Map(projects.map((project) => [project.projectCode, project]));
    const syncState = await loadSyncState(executor, logger);
    let nodeCount = 0;
    let projectCount = 0;
    let mergedProjectCount = 0;
    let skippedProjectCount = 0;

    for (const batch of chunk([...projectsByCode.keys()], config.projectBatchSize)) {
      const rows = await loadSourceRows(sourcePool, config, batch);
      const planned = planCorporateWbsNodes(rows);
      const { merges, skipped } = planCorporateWbsSyncBatch(batch, planned, syncState);

      skippedProjectCount += skipped.length;
      for (const projectCode of skipped) {
        projectCount += 1;
        nodeCount += syncState.get(projectCode)?.nodeCount || 0;
      }

      for (const merge of merges) {
        const project = projectsByCode.get(merge.projectCode);
        // Her proje kendi işlemine alınır: uzun süren tek bir işlem MR_WBS
        // üzerinde kilit biriktirmesin.
        await withSqlTransaction(async (transaction) => {
          await mergeProjectNodes(transaction, actorSicil, project, merge.nodes);
          await recordSyncState(transaction, actorSicil, merge.projectCode, merge.contentHash, merge.nodes.length);
        });
        projectCount += 1;
        mergedProjectCount += 1;
        nodeCount += merge.nodes.length;
      }
    }

    return { synchronized: true, projectCount, nodeCount, mergedProjectCount, skippedProjectCount };
  } catch (cause) {
    logger?.warn?.('Kurumsal WBS (CN43N) eşitlemesi tamamlanamadı; anlık görüntü kurumsal WBS olmadan yükleniyor.', cause);
    return { synchronized: false, projectCount: 0, nodeCount: 0, mergedProjectCount: 0, skippedProjectCount: 0, reason: 'SOURCE_UNAVAILABLE' };
  }
}
