import 'server-only';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { findUpsertIntentIssue } from './upsertIntentPolicy.js';

const UPSERT_TARGETS = Object.freeze([
  {
    collection: 'projectUpserts',
    table: 'MR_Projects',
    idColumn: 'ProjectId',
    entityType: 'PROJECT'
  },
  {
    collection: 'wbsUpserts',
    table: 'MR_WBS',
    idColumn: 'WbsId',
    entityType: 'WBS'
  },
  {
    collection: 'taskUpserts',
    table: 'MR_Tasks',
    idColumn: 'TaskId',
    entityType: 'TASK'
  }
]);

async function targetExistsForUpdate(executor, target, id) {
  const request = executor.request();
  request.input('entityId', sql.UniqueIdentifier, id);
  const result = await request.query(`
    SELECT TOP (1) ${target.idColumn}
    FROM dbo.${target.table} WITH (UPDLOCK, HOLDLOCK)
    WHERE ${target.idColumn} = @entityId;
  `);
  return Boolean(result.recordset?.length);
}

export async function assertUpsertIntentMatchesPersistence(executor, changes = {}) {
  for (const target of UPSERT_TARGETS) {
    for (const entry of changes[target.collection] || []) {
      const id = String(entry.id);
      const exists = await targetExistsForUpdate(executor, target, id);
      const issue = findUpsertIntentIssue({
        exists,
        version: entry.version,
        entityType: target.entityType,
        id
      });

      if (issue) {
        throw new ServerPersistenceError('CONFLICT', issue.message, {
          details: {
            code: issue.code,
            entityType: issue.entityType,
            id: issue.id
          }
        });
      }
    }
  }
}
