import { assertTaskProjectScope } from './sqlAppRepository.js';
import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { ACCESS_REASONS, assertCanCreateManualProject, assertProjectWriteAccess } from '../authorization/authorization.js';
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
 * WBS düğümü, yöneticinin kapsamındaki bir sorumlunun görevinin bağlı olduğu
 * düğüm ya da onun atası mı? Anlık görüntünün `RequiredPartialWbs` kümesiyle
 * aynı kural; yönetim kapsamı kataloğun geri kalanını açmaz.
 */
async function executiveScopedWbsVisible(executor, actor, wbsId, projectId) {
  const request = executor.request();
  request.input('wbsId', sql.UniqueIdentifier, wbsId);
  request.input('projectId', sql.UniqueIdentifier, projectId);
  request.input('sicil', sql.Int, actor.sicil);
  const result = await request.query(`
    ;WITH ScopedWbsChain AS (
      SELECT w.WbsId, w.ParentWbsId
      FROM dbo.MR_WBS w
      WHERE w.ProjectId = @projectId AND EXISTS (
        SELECT 1
        FROM dbo.MR_Tasks t
        JOIN dbo.MR_TaskAssignees ta ON ta.TaskId = t.TaskId
        JOIN dbo.MR_V_ExecutiveScope es ON es.EmployeeSicil = ta.Sicil AND es.ManagerSicil = @sicil
        WHERE t.ProjectId = @projectId AND t.WbsId = w.WbsId
      )
      UNION ALL
      SELECT parent.WbsId, parent.ParentWbsId
      FROM dbo.MR_WBS parent
      JOIN ScopedWbsChain child ON child.ParentWbsId = parent.WbsId
      WHERE parent.ProjectId = @projectId
    )
    SELECT TOP (1) 1 AS Found FROM ScopedWbsChain WHERE WbsId = @wbsId
    OPTION (MAXRECURSION 1000);
  `);
  return Boolean(result.recordset?.length);
}

/**
 * Kayıt aktöre GÖRÜNÜR mü?
 *
 * Görünmeyen kayıt sürümlü güncelleme ve silme niyetinde YOK sayılır. Aksi
 * hâlde yetkisiz çağıran, korunan bir görev/WBS/proje kimliğinin var olduğunu
 * "bulunamadı" (409) ile "yetkiniz yok" (403) yanıtları arasındaki farktan
 * öğrenebiliyordu. Görünürlük anlık görüntüyle aynı kuraldır: görünen kayıt
 * yetki denetimine ulaşır, görünmeyen var olmayanla aynı yanıtı alır.
 * Kimlikler commit sınırında (`canonicalizeCommitChanges`) kanonikleşmiştir.
 */
async function observableTo(executor, actor, entityType, id, projectId) {
  if (actor?.isSystemAdmin) return true;
  const access = actor?.effective?.access?.get(projectId);
  if (!access) return false;
  if (entityType === 'PROJECT' || access.accessLevel === 'FULL' || access.reasons?.includes(ACCESS_REASONS.MANUAL_GRANT)) return true;
  // KISMİ projede görev yalnızca kendi kapsamıyla; WBS kataloğu aktörün kendi
  // görevi (sorumlu ya da oluşturucu) bulunan projede görünür.
  if (entityType === 'TASK') return Boolean(actor.effective.partialTaskIds?.has(id));
  if (access.reasons?.some((reason) => reason === ACCESS_REASONS.ASSIGNEE || reason === ACCESS_REASONS.TASK_CREATOR)) return true;
  return Boolean(access.reasons?.includes(ACCESS_REASONS.EXECUTIVE_SCOPE))
    && executiveScopedWbsVisible(executor, actor, id, projectId);
}

/**
 * Upsert niyetini kalıcı durumla karşılaştırır ve kalıcı görev hedeflerinin
 * projelerini döndürür. Proje oluşturma yetkisi, kimlik çakışması okunmadan
 * denetlenir; oluşturamayan aktör gizli projeyi var olmayandan ayıramaz.
 */
export async function assertUpsertIntentMatchesPersistence(executor, changes = {}, actor = null, { createdProjectIds = new Set() } = {}) {
  const storedTaskProjects = new Map();
  for (const target of UPSERT_TARGETS) {
    const entries = [...(changes[target.collection] || [])]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const entry of entries) {
      const id = String(entry.id);
      const updateIntent = entry.version != null && String(entry.version).trim() !== '';
      if (target.entityType === 'PROJECT' && !updateIntent) assertCanCreateManualProject(actor);
      if (!updateIntent && target.entityType !== 'PROJECT') {
        const destination = canonicalActualId(entry.projectId);
        if (createdProjectIds.has(destination)) assertCanCreateManualProject(actor);
        else if (target.entityType === 'WBS') assertProjectWriteAccess(actor.effective, destination);
        else await assertTaskProjectScope(executor, actor, destination, { allowAssigneeCreate: true });
      }
      const projectId = await targetProjectForUpdate(executor, target, id);
      if (projectId && target.entityType === 'TASK') storedTaskProjects.set(id, projectId);
      const issue = findUpsertIntentIssue({
        exists: Boolean(projectId) && (!updateIntent || await observableTo(executor, actor, target.entityType, id, projectId)),
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
  const storedTaskProjects = new Map();
  for (const target of DELETE_TARGETS) {
    const entries = [...(changes[target.collection] || [])]
      .map(normalizedDelete)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));

    for (const entry of entries) {
      const id = String(entry.id);
      const projectId = await targetProjectForUpdate(executor, target, id);
      if (projectId && target.entityType === 'TASK') storedTaskProjects.set(id, projectId);
      const issue = findDeleteIntentIssue({
        exists: Boolean(projectId) && await observableTo(executor, actor, target.entityType, id, projectId),
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
