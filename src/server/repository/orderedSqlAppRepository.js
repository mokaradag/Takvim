import 'server-only';
import { canonicalizeCommitChanges } from './commitChangeValidation.js';
import { createHardenedSqlAppRepository } from './hardenedSqlAppRepository.js';
import { orderWbsUpsertsByParents } from './wbsCommitPlanning.js';

export function createOrderedSqlAppRepository() {
  const repository = createHardenedSqlAppRepository();
  return {
    ...repository,
    commitChanges(changes = {}) {
      const canonicalChanges = canonicalizeCommitChanges(changes);
      return repository.commitChanges({
        ...canonicalChanges,
        wbsUpserts: orderWbsUpsertsByParents(canonicalChanges.wbsUpserts || [])
      });
    }
  };
}
