import 'server-only';
import { sql } from '../db/pool.js';
import { sqlIdentifier } from '../db/sqlIdentifier.js';
import { ServerPersistenceError } from '../errors.js';
import { findDeleteIntentIssue } from './deleteIntentPolicy.js';
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

const DELETE_TARGETS = Object.freeze([
  {
    collection: 'projectDeletes',
    table: 'MR_Projects',
    idColumn: 'ProjectId',
    entityType: 'PROJECT'
  },
  {
    collection: 'wbsDeletes',
    table: 'MR_WBS',
    idColumn: 'WbsId',
    entityType: 'WBS'
  },
  {
    collection: 'taskDeletes',
    table: 'MR_Tasks',
    idColumn: 'TaskId',
    entityType: 'TASK'
  }
]);

function normalizedDelete(entry) {
  return typeof entry === 'string' ? { id: entry, version: null } : entry;
}

async function targetExistsForUpdate(executor, target, id) {
  const safeTable = sqlIdentifier(target.table, 'table');
  const safeColumn = sqlIdentifier(target.idColumn, 'column');
  const request = executor.request();
  request.input('entityId', sql.UniqueIdentifier, id);
  const result = await request.query(`
    SELECT TOP (1) ${safeColumn}
    FROM dbo.${safeTable} WITH (UPDLOCK, HOLDLOCK)
    WHERE ${safeColumn} = @entityId;
  `);
  return Boolean(result.recordset?.length);
}

export async function assertUpsertIntentMatchesPersistence(executor, changes = {}) {
  for (const target of UPSERT_TARGETS) {
    const entries = [...(changes[target.collection] || [])]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const entry of entries) {
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

export async function assertDeleteIntentMatchesPersistence(executor, changes = {}) {
  for (const target of DELETE_TARGETS) {
    const entries = [...(changes[target.collection] || [])]
      .map(normalizedDelete)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const entry of entries) {
      const id = String(entry.id);
      const exists = await targetExistsForUpdate(executor, target, id);
      const issue = findDeleteIntentIssue({
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
