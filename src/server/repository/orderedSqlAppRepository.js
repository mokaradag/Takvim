import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { assertCanCreateManualProject, assertProjectWriteAccess } from '../authorization/authorization.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
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
 * Proje kodu uygunluğu yalnızca o proje işlemine yetkili aktöre bildirilir.
 * Kurumsal ayrılmış kod ile başka projede kullanılan kod farklı yanıt alır;
 * denetim yetkiden önce çalıştığında yetkisiz çağıran kod tahminlerini
 * yoklayabiliyordu. Yetki temel deponun kuralıyla aynıdır ve aynı FORBIDDEN'ı
 * döndürür.
 */
async function assertManualProjectCodesAvailable(transaction, changes, actor) {
  const pendingProjectCodes = new Map();

  for (const project of changes.projectUpserts || []) {
    const projectCode = normalizedProjectCode(project.code);
    if (!projectCode) continue;
    if (await lockedProjectRow(transaction, project.id)) assertProjectWriteAccess(actor.effective, project.id);
    else assertCanCreateManualProject(actor);

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
 * FORBIDDEN ile reddedilir. Aynı kümede oluşturulan (kaydı olmayan) proje
 * temel depoda oluşturana FULL sahiplikle yazıldığı için bu denetimde FULL
 * sayılır; oluşturma yetkisi orada denetlenir. Aktörün göremediği ve atama
 * kapsamına girmeyen MEVCUT hedef proje, var olmayan projeyle aynı yanıtı alır.
 */
async function assertTaskTargetsDisclosable(transaction, changes, actor, storedTaskProjects) {
  const upsertedProjectIds = [...new Set((changes.projectUpserts || []).map((project) => canonicalActualId(project.id)).filter(Boolean))].sort();
  const createdProjectIds = new Set();
  if ((changes.taskUpserts || []).some((task) => (task.deps || []).length)) {
    for (const projectId of upsertedProjectIds) {
      if (!(await lockedProjectRow(transaction, projectId))) createdProjectIds.add(projectId);
    }
  }
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
        // farklı yanıtlardan öğrenebiliyordu.
        let actor;
        let storedTaskProjects;
        await observePhase('phase.commit.intent-validation', async () => {
          actor = await loadAuthorizationContext(transaction);
          // `projectDeletes` isteğe bağlıdır ve kanonikleştirme onu `undefined`
          // olarak korur: doğrudan `.length` okuması, alanı hiç göndermeyen
          // (tamamen geçerli) bir istekte işlem başlamadan TypeError üretiyordu.
          if ((orderedChanges.projectDeletes || []).length && !actor.isSystemAdmin) {
            throw new ServerPersistenceError('FORBIDDEN', 'Projeyi yalnızca sistem yöneticisi silebilir.');
          }
          storedTaskProjects = await assertUpsertIntentMatchesPersistence(transaction, orderedChanges, actor);
          await assertManualProjectCodesAvailable(transaction, orderedChanges, actor);
          await assertDeleteIntentMatchesPersistence(transaction, orderedChanges, actor);
          await assertTaskTargetsDisclosable(transaction, orderedChanges, actor, storedTaskProjects);
        });
        await observePhase('phase.commit.dependency-reconciliation', async () => {
          await assertTaskDependencyReconciliationCovered(transaction, orderedChanges, actor);
        });
        return repository.commitChanges(orderedChanges);
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE }));
    }
  };
}
