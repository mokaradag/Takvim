import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ACCESS_REASONS } from '../authorization/authorization.js';
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

/** Hedef satırın projesi; satır yoksa `null`. */
async function targetProjectForUpdate(executor, target, id) {
  const safeTable = sqlIdentifier(target.table, 'table');
  const safeColumn = sqlIdentifier(target.idColumn, 'column');
  const request = executor.request();
  request.input('entityId', sql.UniqueIdentifier, id);
  const result = await request.query(`
    SELECT TOP (1) ProjectId
    FROM dbo.${safeTable} WITH (UPDLOCK, HOLDLOCK)
    WHERE ${safeColumn} = @entityId;
  `);
  const row = result.recordset?.[0];
  return row ? (canonicalActualId(row.ProjectId) ?? String(row.ProjectId)) : null;
}

/**
 * Kayıt aktöre GÖRÜNÜR mü?
 *
 * Görünmeyen kayıt sürümlü güncelleme ve silme niyetinde YOK sayılır. Aksi
 * hâlde yetkisiz çağıran, korunan bir görev/WBS/proje kimliğinin var olduğunu
 * "bulunamadı" (409) ile "yetkiniz yok" (403) yanıtları arasındaki farktan
 * öğrenebiliyordu. Görünürlük anlık görüntüyle aynı yetki bağlamından türetilir.
 */
function observableTo(actor, entityType, id, projectId) {
  if (actor?.isSystemAdmin) return true;
  const access = actor?.effective?.access?.get(projectId);
  if (!access) return false;
  if (entityType === 'PROJECT' || access.accessLevel === 'FULL' || access.reasons?.includes(ACCESS_REASONS.MANUAL_GRANT)) return true;
  // KISMİ projede görev yalnızca kendi kapsamıyla; WBS kataloğu ise aktörün
  // kendi görevi (sorumlu ya da oluşturucu) bulunan projede görünür.
  return entityType === 'TASK'
    ? Boolean(actor.effective.partialTaskIds?.has(id))
    : Boolean(access.reasons?.some((reason) => reason === ACCESS_REASONS.ASSIGNEE || reason === ACCESS_REASONS.TASK_CREATOR));
}

/**
 * Upsert niyetini kalıcı durumla karşılaştırır ve kalıcı görev hedeflerinin
 * projelerini döndürür. Oluşturma niyeti var olan kimlikle çakışmayı yine
 * bildirir: istemci kimlikleri tahmin edilemeyen UUID'lerdir ve yanıt yalnızca
 * çağıranın kendi gönderdiği kimliği taşır.
 */
export async function assertUpsertIntentMatchesPersistence(executor, changes = {}, actor = null) {
  const storedTaskProjects = new Map();
  for (const target of UPSERT_TARGETS) {
    const entries = [...(changes[target.collection] || [])]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const entry of entries) {
      const id = String(entry.id);
      const projectId = await targetProjectForUpdate(executor, target, id);
      if (projectId && target.entityType === 'TASK') storedTaskProjects.set(id, projectId);
      const updateIntent = entry.version != null && String(entry.version).trim() !== '';
      const issue = findUpsertIntentIssue({
        exists: Boolean(projectId) && (!updateIntent || observableTo(actor, target.entityType, id, projectId)),
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
  return storedTaskProjects;
}

export async function assertDeleteIntentMatchesPersistence(executor, changes = {}, actor = null) {
  for (const target of DELETE_TARGETS) {
    const entries = [...(changes[target.collection] || [])]
      .map(normalizedDelete)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const entry of entries) {
      const id = String(entry.id);
      const projectId = await targetProjectForUpdate(executor, target, id);
      const issue = findDeleteIntentIssue({
        exists: Boolean(projectId) && observableTo(actor, target.entityType, id, projectId),
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
