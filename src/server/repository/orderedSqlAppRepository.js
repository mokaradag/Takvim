import 'server-only';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { canonicalizeCommitChanges } from './commitChangeValidation.js';
import { canonicalizeCommitScalars } from './commitScalarCanonicalization.js';
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
      WHERE ProjectId <> @projectId AND ProjectCode = @projectCode;
    `);

    const storedSourceType = result.recordsets?.[0]?.[0]?.SourceType || null;
    if (storedSourceType && storedSourceType !== 'MANUAL') continue;

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
        await assertUpsertIntentMatchesPersistence(transaction, orderedChanges);
        await assertManualProjectCodesAvailable(transaction, orderedChanges);
        await assertDeleteIntentMatchesPersistence(transaction, orderedChanges);
        return repository.commitChanges(orderedChanges);
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE });
    }
  };
}
