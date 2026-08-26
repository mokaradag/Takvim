import 'server-only';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
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

      return withSqlTransaction(async (transaction) => {
        // Proje varlığı/sürümü sorgulanmadan önce rol denetlenir. Aksi hâlde
        // yönetici olmayan kullanıcı etkin, etkin olmayan ve bilinmeyen proje
        // kimlikleri için farklı hata alarak kayıt varlığını yoklayabilirdi.
        if (orderedChanges.projectDeletes.length) {
          const actor = await loadAuthorizationContext(transaction);
          if (!actor.isSystemAdmin) {
            throw new ServerPersistenceError('FORBIDDEN', 'Projeyi yalnızca sistem yöneticisi silebilir.');
          }
        }
        await assertUpsertIntentMatchesPersistence(transaction, orderedChanges);
        await assertManualProjectCodesAvailable(transaction, orderedChanges);
        await assertDeleteIntentMatchesPersistence(transaction, orderedChanges);
        await assertTaskDependencyReconciliationCovered(transaction, orderedChanges);
        return repository.commitChanges(orderedChanges);
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE });
    }
  };
}
