import 'server-only';
import { createHardenedSqlAppRepository } from './hardenedSqlAppRepository.js';
import { orderWbsUpsertsByParents } from './wbsCommitPlanning.js';

export function createOrderedSqlAppRepository() {
  const repository = createHardenedSqlAppRepository();
  return {
    ...repository,
    commitChanges(changes = {}) {
      return repository.commitChanges({
        ...changes,
        wbsUpserts: orderWbsUpsertsByParents(changes.wbsUpserts || [])
      });
    }
  };
}
