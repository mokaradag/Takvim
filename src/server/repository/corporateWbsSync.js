import 'server-only';
import { getCorporateWbsDbConfig, isCorporateWbsSourceConfigured } from '../db/corporateWbsConfig.js';
import { getCorporateWbsPool } from '../db/corporateWbsPool.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import {
  CORPORATE_PROJECT_CODES_SQL,
  CORPORATE_WBS_MERGE_SQL,
  buildCorporateWbsSourceQuery
} from './corporateWbsQueries.js';
import { planCorporateWbsNodes } from './corporateWbsProjection.js';

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

/**
 * Kurumsal projelerin iş dağılım ağacını CN43N kaynağından eşitler.
 *
 * Kaynak yapılandırılmadıysa hiçbir şey yapmaz. Kaynağa erişilemediğinde hata
 * yükseltilmez: anlık görüntü yüklemesi kurumsal WBS olmadan da sürer, yalnızca
 * sunucu günlüğüne uyarı yazılır. Aksi hâlde ikinci veritabanındaki geçici bir
 * kesinti tüm uygulamayı kullanılamaz hâle getirirdi.
 *
 * @returns {Promise<{ synchronized: boolean, projectCount: number, nodeCount: number, reason?: string }>}
 */
export async function synchronizeCorporateWbs(executor, actorSicil, { logger = console } = {}) {
  if (!isCorporateWbsSourceConfigured()) {
    return { synchronized: false, projectCount: 0, nodeCount: 0, reason: 'NOT_CONFIGURED' };
  }

  const config = getCorporateWbsDbConfig();
  try {
    const sourcePool = await getCorporateWbsPool();
    if (!sourcePool) {
      return { synchronized: false, projectCount: 0, nodeCount: 0, reason: 'NOT_CONFIGURED' };
    }

    const projects = await loadCorporateProjects(executor);
    if (!projects.length) return { synchronized: true, projectCount: 0, nodeCount: 0 };

    const projectsByCode = new Map(projects.map((project) => [project.projectCode, project]));
    let nodeCount = 0;
    let projectCount = 0;

    for (const batch of chunk([...projectsByCode.keys()], config.projectBatchSize)) {
      const rows = await loadSourceRows(sourcePool, config, batch);
      const planned = planCorporateWbsNodes(rows);
      for (const projectCode of batch) {
        const nodes = planned.get(projectCode) || [];
        if (!nodes.length) continue;
        await withSqlTransaction((transaction) => mergeProjectNodes(
          transaction,
          actorSicil,
          projectsByCode.get(projectCode),
          nodes
        ));
        projectCount += 1;
        nodeCount += nodes.length;
      }
    }

    return { synchronized: true, projectCount, nodeCount };
  } catch (cause) {
    logger?.warn?.('Kurumsal WBS (CN43N) eşitlemesi tamamlanamadı; anlık görüntü kurumsal WBS olmadan yükleniyor.', cause);
    return { synchronized: false, projectCount: 0, nodeCount: 0, reason: 'SOURCE_UNAVAILABLE' };
  }
}
