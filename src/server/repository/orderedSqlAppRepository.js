import 'server-only';
import { sql, withSqlTransaction } from '../db/pool.js';
import { canonicalizeCommitChanges } from './commitChangeValidation.js';
import { canonicalizeCommitScalars } from './commitScalarCanonicalization.js';
import { createHardenedSqlAppRepository } from './hardenedSqlAppRepository.js';
import {
  assertDeleteIntentMatchesPersistence,
  assertUpsertIntentMatchesPersistence
} from './upsertIntentValidation.js';
import { orderWbsUpsertsByParents } from './wbsCommitPlanning.js';

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
        await assertDeleteIntentMatchesPersistence(transaction, orderedChanges);
        return repository.commitChanges(orderedChanges);
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE });
    }
  };
}
