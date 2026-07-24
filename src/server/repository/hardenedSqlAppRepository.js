import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { findDependencyCycle } from './dependencyGraphValidation.js';
import { createSqlAppRepository as createBaseSqlAppRepository } from './sqlAppRepository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value, label = 'Kimlik') {
  const normalized = String(value || '');
  if (!UUID_PATTERN.test(normalized)) {
    throw new ServerPersistenceError('MUTATION_FAILED', `${label} geçerli UUID olmalıdır.`);
  }
  return normalized;
}

function normalizeDelete(value) {
  return typeof value === 'string' ? { id: value, version: null } : value;
}

function normalizeChanges(changes = {}) {
  return {
    projectUpserts: changes.projectUpserts || [],
    projectDeletes: (changes.projectDeletes || []).map(normalizeDelete),
    wbsUpserts: changes.wbsUpserts || [],
    wbsDeletes: (changes.wbsDeletes || []).map(normalizeDelete),
    taskUpserts: changes.taskUpserts || [],
    taskDeletes: (changes.taskDeletes || []).map(normalizeDelete)
  };
}

function request(executor) {
  return executor.request();
}

async function rowForUpdate(executor, table, idColumn, value, label) {
  const entityId = uuid(value, label);
  const req = request(executor);
  req.input('entityId', sql.UniqueIdentifier, entityId);
  const result = await req.query(`
    SELECT TOP (1) *
    FROM dbo.${table} WITH (UPDLOCK, HOLDLOCK)
    WHERE ${idColumn} = @entityId;
  `);
  return result.recordset[0] || null;
}

async function assertActiveCalendarReferences(executor, changes) {
  const calendarIds = new Set();
  for (const entity of [...changes.projectUpserts, ...changes.taskUpserts]) {
    if (entity.calendarId) calendarIds.add(uuid(entity.calendarId, 'Takvim kimliği'));
  }

  for (const calendarId of [...calendarIds].sort()) {
    const req = request(executor);
    req.input('calendarId', sql.UniqueIdentifier, calendarId);
    const result = await req.query(`
      SELECT TOP (1) CalendarId
      FROM dbo.MR_Calendars WITH (UPDLOCK, HOLDLOCK)
      WHERE CalendarId = @calendarId AND IsActive = 1;
    `);
    if (!result.recordset.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Seçilen çalışma takvimi bulunamadı veya etkin değil.');
    }
  }
}

async function loadWbsRowsForUpdate(executor, projectId) {
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  return (await req.query(`
    SELECT WbsId, ProjectId, ParentWbsId
    FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK)
    WHERE ProjectId = @projectId
    ORDER BY WbsId;
  `)).recordset;
}

async function assertSingleRootWbs(executor, changes) {
  const changedWbsRows = new Map();
  const affectedProjectIds = new Set(changes.projectUpserts.map((project) => uuid(project.id, 'Proje kimliği')));

  for (const node of changes.wbsUpserts) {
    const wbsId = uuid(node.id, 'WBS kimliği');
    const projectId = uuid(node.projectId, 'Proje kimliği');
    affectedProjectIds.add(projectId);
    changedWbsRows.set(wbsId, { ...node, id: wbsId, projectId });
  }

  for (const entry of changes.wbsDeletes) {
    const row = await rowForUpdate(executor, 'MR_WBS', 'WbsId', entry.id, 'WBS kimliği');
    if (row) affectedProjectIds.add(String(row.ProjectId));
  }

  const newProjectIds = new Set();
  for (const project of changes.projectUpserts) {
    const projectId = uuid(project.id, 'Proje kimliği');
    const existing = await rowForUpdate(executor, 'MR_Projects', 'ProjectId', projectId, 'Proje kimliği');
    if (!existing) newProjectIds.add(projectId);
  }

  for (const projectId of [...affectedProjectIds].sort()) {
    const rows = await loadWbsRowsForUpdate(executor, projectId);
    const existingRoots = rows.filter((row) => row.ParentWbsId == null).map((row) => String(row.WbsId));
    if (existingRoots.length > 1) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Projede birden fazla kök WBS düğümü bulundu.');
    }

    const candidate = new Map(rows.map((row) => [String(row.WbsId), {
      id: String(row.WbsId),
      projectId: String(row.ProjectId),
      parentId: row.ParentWbsId == null ? null : String(row.ParentWbsId)
    }]));

    for (const entry of changes.wbsDeletes) candidate.delete(String(entry.id));
    for (const node of changedWbsRows.values()) {
      if (node.projectId !== projectId) continue;
      const before = candidate.get(node.id);
      if (before && before.projectId !== projectId) {
        throw new ServerPersistenceError('MUTATION_FAILED', 'WBS kaydı farklı bir projeye taşınamaz.');
      }
      candidate.set(node.id, {
        id: node.id,
        projectId,
        parentId: node.parentId == null ? null : uuid(node.parentId, 'Üst WBS kimliği')
      });
    }

    let roots = [...candidate.values()].filter((node) => node.parentId == null);
    if (newProjectIds.has(projectId) && roots.length === 0) {
      roots = [{ id: `implicit-root:${projectId}`, projectId, parentId: null }];
    }
    if (roots.length !== 1) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Bir projede yalnızca bir kök WBS düğümü bulunabilir.');
    }
    if (existingRoots.length === 1 && roots[0].id !== existingRoots[0]) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Proje kök WBS düğümü değiştirilemez veya başka bir WBS altına taşınamaz.');
    }
  }
}

function removeTaskEdges(edges, taskId, { incoming = true, outgoing = true } = {}) {
  return edges.filter((edge) => (
    (!outgoing || edge.taskId !== taskId)
    && (!incoming || edge.predecessorId !== taskId)
  ));
}

async function loadProjectDependencyEdgesForUpdate(executor, projectId) {
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
  const result = await req.query(`
    SELECT TaskId, PredecessorTaskId
    FROM dbo.MR_TaskDependencies WITH (UPDLOCK, HOLDLOCK)
    WHERE ProjectId = @projectId
    ORDER BY TaskId, PredecessorTaskId;
  `);
  return (result.recordset || []).map((row) => ({
    taskId: String(row.TaskId),
    predecessorId: String(row.PredecessorTaskId)
  }));
}

async function assertAcyclicTaskDependencies(executor, changes) {
  const changedTaskRows = new Map();
  const affectedProjectIds = new Set();
  const changedIds = new Set([
    ...changes.taskUpserts.map((task) => uuid(task.id, 'Görev kimliği')),
    ...changes.taskDeletes.map((entry) => uuid(entry.id, 'Görev kimliği'))
  ]);

  for (const taskId of [...changedIds].sort()) {
    const row = await rowForUpdate(executor, 'MR_Tasks', 'TaskId', taskId, 'Görev kimliği');
    if (row) {
      changedTaskRows.set(taskId, row);
      affectedProjectIds.add(String(row.ProjectId));
    }
  }
  for (const task of changes.taskUpserts) affectedProjectIds.add(uuid(task.projectId, 'Proje kimliği'));

  const projectEdges = new Map();
  for (const projectId of [...affectedProjectIds].sort()) {
    projectEdges.set(projectId, await loadProjectDependencyEdgesForUpdate(executor, projectId));
  }

  for (const task of changes.taskUpserts) {
    const taskId = uuid(task.id, 'Görev kimliği');
    const nextProjectId = uuid(task.projectId, 'Proje kimliği');
    const previousProjectId = changedTaskRows.has(taskId) ? String(changedTaskRows.get(taskId).ProjectId) : null;

    if (previousProjectId && previousProjectId !== nextProjectId) {
      projectEdges.set(previousProjectId, removeTaskEdges(projectEdges.get(previousProjectId) || [], taskId));
      projectEdges.set(nextProjectId, removeTaskEdges(projectEdges.get(nextProjectId) || [], taskId));
    } else {
      projectEdges.set(nextProjectId, removeTaskEdges(projectEdges.get(nextProjectId) || [], taskId, { incoming: false }));
    }

    const nextEdges = projectEdges.get(nextProjectId) || [];
    for (const dependency of task.deps || []) {
      nextEdges.push({
        taskId,
        predecessorId: uuid(dependency.predecessorId, 'Öncül görev kimliği')
      });
    }
    projectEdges.set(nextProjectId, nextEdges);
  }

  for (const entry of changes.taskDeletes) {
    const taskId = uuid(entry.id, 'Görev kimliği');
    const row = changedTaskRows.get(taskId);
    if (!row) continue;
    const projectId = String(row.ProjectId);
    projectEdges.set(projectId, removeTaskEdges(projectEdges.get(projectId) || [], taskId));
  }

  for (const projectId of [...affectedProjectIds].sort()) {
    const cycleTaskIds = findDependencyCycle(projectEdges.get(projectId) || []);
    if (cycleTaskIds.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Görev bağımlılıkları döngü oluşturamaz.', {
        details: { projectId, taskIds: cycleTaskIds }
      });
    }
  }
}

async function assertIntegrity(executor, changes) {
  await assertActiveCalendarReferences(executor, changes);
  await assertSingleRootWbs(executor, changes);
  await assertAcyclicTaskDependencies(executor, changes);
}

export function createHardenedSqlAppRepository() {
  const baseRepository = createBaseSqlAppRepository();
  return {
    ...baseRepository,
    async commitChanges(input) {
      const changes = normalizeChanges(input);
      return withSqlTransaction(async (transaction) => {
        await assertIntegrity(transaction, changes);
        return baseRepository.commitChanges(input);
      });
    }
  };
}
