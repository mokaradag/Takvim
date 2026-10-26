import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { assertCanCreateManualProject, assertProjectWriteAccess } from '../authorization/authorization.js';
import { loadTransactionAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { observePhase } from '../observability/observeOperation.js';
import { canonicalizeCommitChanges } from './commitChangeValidation.js';
import { canonicalizeCommitScalars } from './commitScalarCanonicalization.js';
import { assertTaskDependencyReconciliationCovered } from './dependencyReconciliationValidation.js';
import { createHardenedSqlAppRepository } from './hardenedSqlAppRepository.js';
import {
  assertDeleteIntentMatchesPersistence,
  assertUpsertIntentMatchesPersistence
} from './upsertIntentValidation.js';
import { orderWbsUpsertsByParents } from './wbsCommitPlanning.js';

function normalizedProjectCode(value) {
  const code = value == null ? '' : String(value).trim().toUpperCase();
  return code || null;
}

async function lockedProjectRow(transaction, projectId) {
  const request = transaction.request();
  request.input('entityId', sql.UniqueIdentifier, projectId);
  const result = await request.query(`
    SELECT TOP (1) *
    FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK)
    WHERE ProjectId = @entityId;
  `);
  return result.recordset?.[0] || null;
}

/**
 * Proje upsert'lerinin yetkisi, kalıcı duruma bağlı sonraki denetimlerden
 * (kod uygunluğu, bağımlılık planı) ÖNCE ve temel deponun kuralıyla kurulur:
 * var olan projeye FULL yazma, kaydı olmayan projeye manuel proje oluşturma
 * yetkisi. Eskiden yetki yalnızca kodlu projede denetleniyordu; kodsuz sahte
 * proje bağımlılık muafiyetini alıyor ve proje oluşturamayan aktör gizli öncül
 * kimliklerini plan hatalarından yoklayabiliyordu.
 *
 * @returns {Set<string>} oluşturma yetkisi kanıtlanmış, kaydı olmayan projeler
 */
async function assertProjectUpsertsAuthorized(transaction, changes, actor) {
  const createdProjectIds = new Set();
  for (const project of changes.projectUpserts || []) {
    if (await lockedProjectRow(transaction, project.id)) {
      assertProjectWriteAccess(actor.effective, project.id);
    } else {
      assertCanCreateManualProject(actor);
      createdProjectIds.add(canonicalActualId(project.id));
    }
  }
  return createdProjectIds;
}

/**
 * Proje kodu uygunluğu yalnızca o proje işlemine yetkili aktöre bildirilir
 * (bkz. assertProjectUpsertsAuthorized). Kurumsal ayrılmış kod ile başka
 * projede kullanılan kod farklı yanıt alır.
 */
async function assertManualProjectCodesAvailable(transaction, changes) {
  const pendingProjectCodes = new Map();

  for (const project of changes.projectUpserts || []) {
    const projectCode = normalizedProjectCode(project.code);
    if (!projectCode) continue;

    const request = transaction.request();
    request.input('projectId', sql.UniqueIdentifier, project.id);
    request.input('projectCode', sql.NVarChar(255), projectCode);
    const result = await request.query(`
      SELECT TOP (1) SourceType
      FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK)
      WHERE ProjectId = @projectId;

      SELECT TOP (1) ProjectCode
      FROM dbo.MR_V_CorporateProjects
      WHERE ProjectCode = @projectCode;

      SELECT TOP (1) ProjectId
      FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK)
      WHERE ProjectId <> @projectId AND UPPER(ProjectCode) = @projectCode;
    `);

    const storedSourceType = result.recordsets?.[0]?.[0]?.SourceType || null;
    if (storedSourceType && storedSourceType !== 'MANUAL') continue;

    const pendingProjectId = pendingProjectCodes.get(projectCode);
    if (pendingProjectId && pendingProjectId !== project.id) {
      throw new ServerPersistenceError('CONFLICT', 'Proje kodu değişiklik kümesinde birden fazla proje için kullanılıyor.', {
        details: { code: 'PROJECT_CODE_CONFLICT', projectCode }
      });
    }
    pendingProjectCodes.set(projectCode, project.id);

    if (result.recordsets?.[1]?.length) {
      throw new ServerPersistenceError('CONFLICT', 'Kurumsal proje kodu manuel proje için kullanılamaz.', {
        details: { code: 'PROJECT_CODE_RESERVED', projectCode }
      });
    }
    if (result.recordsets?.[2]?.length) {
      throw new ServerPersistenceError('CONFLICT', 'Proje kodu başka bir proje tarafından kullanılıyor.', {
        details: { code: 'PROJECT_CODE_CONFLICT', projectCode }
      });
    }
  }
}

function hasFullProjectAccess(actor, projectId) {
  return Boolean(actor.isSystemAdmin) || actor.effective.access.get(projectId)?.accessLevel === 'FULL';
}

/**
 * Görev hedeflerinin yetki öncesi açıklama sınırı.
 *
 * Sertleştirilmiş planlama öncüllerin varlığını, projesini ve döngü yolunu
 * kalıcı durumdan okur. Bağımlılık düzenlemesi temel depoda kaynak ve hedef
 * projede FULL yetki ister; yetkisiz aktörün isteği bu okumalara ulaşmadan aynı
 * FORBIDDEN ile reddedilir. Aynı kümede oluşturulan proje temel depoda
 * oluşturana FULL sahiplikle yazıldığı için FULL sayılır; muafiyet yalnızca
 * oluşturma yetkisi ÖNCEDEN kanıtlanmış projelere verilir. Aktörün göremediği
 * ve atama kapsamına girmeyen MEVCUT hedef proje, var olmayan projeyle aynı
 * yanıtı alır.
 */
async function assertTaskTargetsDisclosable(transaction, changes, actor, storedTaskProjects, createdProjectIds) {
  const upsertedProjectIds = [...new Set((changes.projectUpserts || []).map((project) => canonicalActualId(project.id)).filter(Boolean))].sort();
  for (const task of changes.taskUpserts || []) {
    if (!(task.deps || []).length) continue;
    const storedProjectId = storedTaskProjects.get(String(task.id));
    const destinationFull = createdProjectIds.has(canonicalActualId(task.projectId)) || hasFullProjectAccess(actor, task.projectId);
    if (!destinationFull || (storedProjectId && !hasFullProjectAccess(actor, storedProjectId))) {
      throw new ServerPersistenceError('FORBIDDEN', 'Görev bağımlılıkları yalnızca tam proje yetkisiyle düzenlenebilir.');
    }
  }

  const destinations = new Set([...(changes.taskUpserts || []), ...(changes.wbsUpserts || [])]
    .map((entry) => canonicalActualId(entry.projectId))
    .filter((projectId) => projectId && !upsertedProjectIds.includes(projectId)));
  if (actor.isSystemAdmin) return;
  for (const projectId of [...destinations].sort()) {
    if (actor.effective.access.has(projectId)) continue;
    const row = await lockedProjectRow(transaction, projectId);
    if (!row || (actor.canAssignAllCorporateProjects && row.SourceType === 'CORPORATE')) continue;
    throw new ServerPersistenceError('MUTATION_FAILED', 'Hedef proje bulunamadı veya etkin değil.', {
      details: { projectId }
    });
  }
}

export function createOrderedSqlAppRepository() {
  const repository = createHardenedSqlAppRepository();
  return {
    ...repository,
    commitChanges(changes = {}) {
      const canonicalChanges = canonicalizeCommitScalars(canonicalizeCommitChanges(changes));
      const orderedChanges = {
        ...canonicalChanges,
        wbsUpserts: orderWbsUpsertsByParents(canonicalChanges.wbsUpserts || [])
      };

      return observePhase('phase.commit.transaction', () => withSqlTransaction(async (transaction) => {
        // Kimlik ve yetki bağlamı, kalıcı duruma bağlı HER doğrulamadan önce
        // kurulur. Niyet, proje kodu ve bağımlılık uzlaştırma denetimleri
        // eskiden kimlik doğrulanmadan çalışıyor; kimliksiz ya da yetkisiz
        // çağıran kayıt varlığını, ayrılmış kodları ve gizli ardıl kimliklerini
        // farklı yanıtlardan öğrenebiliyordu. Bağlam temel depoyla paylaşılır.
        //
        // Yetki okuması SERIALIZABLE paylaşımlı kilitlerini güncelleme
        // kilitlerinden ÖNCE alır; aynı görevi kaydeden iki istek birbirinin
        // paylaşımlı kilidini bekleyerek kilitlenebilir. Sıra açıklama sınırı
        // gereğidir; kurban işlem baştan yinelenir ve kazananın ardından ya
        // tamamlanır ya da eskimiş sürüm çakışması alır.
        let actor;
        let storedTaskProjects;
        await observePhase('phase.commit.intent-validation', async () => {
          actor = await loadTransactionAuthorizationContext(transaction);
          // `projectDeletes` isteğe bağlıdır ve kanonikleştirme onu `undefined`
          // olarak korur: doğrudan `.length` okuması, alanı hiç göndermeyen
          // (tamamen geçerli) bir istekte işlem başlamadan TypeError üretiyordu.
          if ((orderedChanges.projectDeletes || []).length && !actor.isSystemAdmin) {
            throw new ServerPersistenceError('FORBIDDEN', 'Projeyi yalnızca sistem yöneticisi silebilir.');
          }
          storedTaskProjects = await assertUpsertIntentMatchesPersistence(transaction, orderedChanges, actor);
          const createdProjectIds = await assertProjectUpsertsAuthorized(transaction, orderedChanges, actor);
          await assertManualProjectCodesAvailable(transaction, orderedChanges);
          await assertDeleteIntentMatchesPersistence(transaction, orderedChanges, actor);
          await assertTaskTargetsDisclosable(transaction, orderedChanges, actor, storedTaskProjects, createdProjectIds);
        });
        await observePhase('phase.commit.dependency-reconciliation', async () => {
          await assertTaskDependencyReconciliationCovered(transaction, orderedChanges, actor);
        });
        return repository.commitChanges(orderedChanges);
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE, deadlockRetries: 2 }));
    }
  };
}
