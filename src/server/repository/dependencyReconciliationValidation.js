import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { findTaskDependencyReconciliationIssue } from './dependencyReconciliationPolicy.js';

function id(value) {
  if (value == null || value === '') return null;
  // Kimlikler kanonik biçimde karşılaştırılır; SQL Server büyük, istemci küçük harf üretir.
  return canonicalActualId(value) ?? String(value);
}

function deleteId(value) {
  return id(typeof value === 'string' ? value : value?.id);
}

async function loadStoredProjectId(executor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  const result = await request.query(`
    SELECT TOP (1) ProjectId
    FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK)
    WHERE TaskId = @taskId;
  `);
  return result.recordset?.[0]?.ProjectId == null
    ? null
    : id(result.recordset[0].ProjectId);
}

async function loadIncomingTaskIds(executor, predecessorId) {
  const request = executor.request();
  request.input('predecessorId', sql.UniqueIdentifier, predecessorId);
  const result = await request.query(`
    SELECT DISTINCT dependency.TaskId
    FROM dbo.MR_TaskDependencies dependency WITH (UPDLOCK, HOLDLOCK)
    JOIN dbo.MR_Tasks successor WITH (UPDLOCK, HOLDLOCK)
      ON successor.TaskId = dependency.TaskId
     AND successor.ProjectId = dependency.ProjectId
    WHERE dependency.PredecessorTaskId = @predecessorId
    ORDER BY dependency.TaskId;
  `);
  return (result.recordset || []).map((row) => id(row.TaskId));
}

/** Bağımlılık ilişkileri yalnızca projede FULL yetkisi olana görünür; anlık görüntü de yalnızca ona yükler. */
function seesDependencies(actor, projectId) {
  return Boolean(actor?.isSystemAdmin || actor?.effective?.access?.get(projectId)?.accessLevel === 'FULL');
}

/**
 * Taşınan ya da silinen öncülün ardıllarının aynı değişiklik kümesinde
 * uzlaştırıldığını doğrular. Ardıl kimlikleri hatada yalnızca bu ilişkileri
 * zaten görebilen aktöre döner. Öteki aktörlerde aynı kural temel depoda,
 * işlem yetkisi doğrulandıktan SONRA ve kimliksiz uygulanır
 * (`assertSuccessorsReconciledWithoutDisclosure`); bağımlılıklı taşıma ise
 * kaynak projede FULL yetki ister.
 */
export async function assertTaskDependencyReconciliationCovered(executor, changes, actor) {
  // Aktörsüz çağrı denetimi sessizce atlamaz: görünürlük süzgeci aktör olmadan her öncülü düşürürdü.
  if (!actor) throw new TypeError('Dependency reconciliation requires the authorized actor.');
  const taskUpserts = [...(changes.taskUpserts || [])]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const taskDeleteIds = (changes.taskDeletes || []).map(deleteId).filter(Boolean);
  const invalidatedPredecessorIds = new Set(taskDeleteIds);
  const storedProjects = new Map();
  for (const taskId of taskDeleteIds) storedProjects.set(taskId, await loadStoredProjectId(executor, taskId));

  for (const task of taskUpserts) {
    const taskId = id(task.id);
    const nextProjectId = id(task.projectId);
    const storedProjectId = await loadStoredProjectId(executor, taskId);
    storedProjects.set(taskId, storedProjectId);
    if (storedProjectId && storedProjectId !== nextProjectId) {
      invalidatedPredecessorIds.add(taskId);
    }
  }
  for (const predecessorId of invalidatedPredecessorIds) {
    if (!seesDependencies(actor, storedProjects.get(predecessorId))) invalidatedPredecessorIds.delete(predecessorId);
  }

  if (!invalidatedPredecessorIds.size) return;

  const incomingTaskIdsByPredecessor = new Map();
  for (const predecessorId of [...invalidatedPredecessorIds].sort()) {
    incomingTaskIdsByPredecessor.set(
      predecessorId,
      await loadIncomingTaskIds(executor, predecessorId)
    );
  }

  const issue = findTaskDependencyReconciliationIssue({
    invalidatedPredecessorIds,
    incomingTaskIdsByPredecessor,
    // Kimlikler KANONİK gönderilir. `loadIncomingTaskIds` kanonik kimlik döner
    // ve karşılaştırma düz `String()` iledir: ham `task.id` (örneğin büyük
    // harfli bir GUID) hiç eşleşmiyor ve bağımlılığı gerçekten uzlaştıran bir
    // değişiklik kümesi reddediliyordu.
    taskUpsertIds: taskUpserts.map((task) => id(task.id)),
    taskDeleteIds
  });
  if (!issue) return;

  throw new ServerPersistenceError('MUTATION_FAILED', issue.message, {
    status: 400,
    details: {
      code: issue.code,
      predecessorId: issue.predecessorId,
      taskIds: issue.taskIds
    }
  });
}

/**
 * Bağımlılık ilişkilerini GÖREMEYEN aktörün silmesi için aynı uzlaştırma
 * kuralı. Temel depoda silme yetkisi doğrulandıktan SONRA çağrılır; hata
 * ardıl kimliklerini taşımaz.
 */
export async function assertSuccessorsReconciledWithoutDisclosure(executor, predecessorId, changes = {}) {
  const predecessor = id(predecessorId);
  const issue = findTaskDependencyReconciliationIssue({
    invalidatedPredecessorIds: [predecessor],
    incomingTaskIdsByPredecessor: new Map([[predecessor, await loadIncomingTaskIds(executor, predecessor)]]),
    taskUpsertIds: (changes.taskUpserts || []).map((task) => id(task.id)),
    taskDeleteIds: (changes.taskDeletes || []).map(deleteId).filter(Boolean)
  });
  if (!issue) return;
  throw new ServerPersistenceError('MUTATION_FAILED', issue.message, {
    status: 400,
    details: { code: issue.code, predecessorId: issue.predecessorId }
  });
}
