import 'server-only';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { findTaskDependencyReconciliationIssue } from './dependencyReconciliationPolicy.js';

function id(value) {
  return value == null || value === '' ? null : String(value);
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
    : String(result.recordset[0].ProjectId);
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
  return (result.recordset || []).map((row) => String(row.TaskId));
}

export async function assertTaskDependencyReconciliationCovered(executor, changes = {}) {
  const taskUpserts = [...(changes.taskUpserts || [])]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const taskDeleteIds = (changes.taskDeletes || []).map(deleteId).filter(Boolean);
  const invalidatedPredecessorIds = new Set(taskDeleteIds);

  for (const task of taskUpserts) {
    const taskId = id(task.id);
    const nextProjectId = id(task.projectId);
    const storedProjectId = await loadStoredProjectId(executor, taskId);
    if (storedProjectId && storedProjectId !== nextProjectId) {
      invalidatedPredecessorIds.add(taskId);
    }
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
    taskUpsertIds: taskUpserts.map((task) => task.id),
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
