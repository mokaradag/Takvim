import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { findDependencyCycle } from './dependencyGraphValidation.js';
import {
  findFinalTaskReferenceIssue,
  orderTaskUpsertsByDependencies
} from './taskCommitPlanning.js';
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

async function assertActiveProjectMutationTargets(executor, changes) {
  const projectRows = new Map();
  const newProjectIds = new Set();

  async function loadProject(projectId) {
    if (!projectRows.has(projectId)) {
      projectRows.set(
        projectId,
        await rowForUpdate(executor, 'MR_Projects', 'ProjectId', projectId, 'Proje kimliği')
      );
    }
    return projectRows.get(projectId);
  }

  async function requireActiveProject(value) {
    const projectId = uuid(value, 'Proje kimliği');
    if (newProjectIds.has(projectId)) return projectId;
    const row = await loadProject(projectId);
    if (!row || !Boolean(row.IsActive)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Hedef proje bulunamadı veya etkin değil.', {
        details: { projectId }
      });
    }
    return projectId;
  }

  for (const project of changes.projectUpserts) {
    const projectId = uuid(project.id, 'Proje kimliği');
    const row = await loadProject(projectId);
    if (!row) {
      newProjectIds.add(projectId);
    } else if (!Boolean(row.IsActive)) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Etkin olmayan proje değiştirilemez.', {
        details: { projectId }
      });
    }
  }

  for (const node of changes.wbsUpserts) {
    await requireActiveProject(node.projectId);
    const before = await rowForUpdate(executor, 'MR_WBS', 'WbsId', node.id, 'WBS kimliği');
    if (before) await requireActiveProject(String(before.ProjectId));
  }
  for (const entry of changes.wbsDeletes) {
    const before = await rowForUpdate(executor, 'MR_WBS', 'WbsId', entry.id, 'WBS kimliği');
    if (before) await requireActiveProject(String(before.ProjectId));
  }

  for (const task of changes.taskUpserts) {
    await requireActiveProject(task.projectId);
    const before = await rowForUpdate(executor, 'MR_Tasks', 'TaskId', task.id, 'Görev kimliği');
    if (before) await requireActiveProject(String(before.ProjectId));
  }
  for (const entry of changes.taskDeletes) {
    const before = await rowForUpdate(executor, 'MR_Tasks', 'TaskId', entry.id, 'Görev kimliği');
    if (before) await requireActiveProject(String(before.ProjectId));
  }
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

function taskReferenceMessage(issue) {
  const messages = {
    TASK_IDENTITY_REQUIRED: 'Görev ve proje kimlikleri zorunludur.',
    DUPLICATE_TASK_UPSERT: 'Aynı görev bir değişiklik kümesinde birden fazla kez güncellenemez.',
    TASK_UPSERT_DELETE_CONFLICT: 'Aynı görev tek değişiklik kümesinde hem güncellenip hem silinemez.',
    DEPENDENCY_PREDECESSOR_REQUIRED: 'Bağımlılık için öncül görev seçilmelidir.',
    DUPLICATE_DEPENDENCY: 'Aynı öncül görev bağımlılığı birden fazla kez eklenemez.',
    SELF_DEPENDENCY: 'Bir görev kendisine bağımlı olamaz.',
    DEPENDENCY_TARGET_DELETED: 'Silinen görev aynı değişiklik kümesinde öncül olarak kullanılamaz.',
    DEPENDENCY_TARGET_NOT_FOUND: 'Öncül görev bulunamadı.',
    CROSS_PROJECT_DEPENDENCY: 'Bağımlılık görevleri son durumda aynı projede olmalıdır.'
  };
  return messages[issue.code] || 'Görev bağımlılıkları geçerli değildir.';
}

async function planTaskCommits(executor, changes) {
  const taskUpserts = changes.taskUpserts.map((task) => ({
    ...task,
    id: uuid(task.id, 'Görev kimliği'),
    projectId: uuid(task.projectId, 'Proje kimliği'),
    deps: (task.deps || []).map((dependency) => ({
      ...dependency,
      predecessorId: uuid(dependency?.predecessorId, 'Öncül görev kimliği')
    }))
  }));
  const taskDeletes = changes.taskDeletes.map((entry) => ({
    ...entry,
    id: uuid(entry.id, 'Görev kimliği')
  }));
  const referencedTaskIds = new Set([
    ...taskUpserts.map((task) => task.id),
    ...taskDeletes.map((entry) => entry.id),
    ...taskUpserts.flatMap((task) => task.deps.map((dependency) => dependency.predecessorId))
  ]);
  const existingTaskProjects = new Map();

  for (const taskId of [...referencedTaskIds].sort()) {
    const row = await rowForUpdate(executor, 'MR_Tasks', 'TaskId', taskId, 'Görev kimliği');
    if (row) existingTaskProjects.set(taskId, String(row.ProjectId));
  }

  const issue = findFinalTaskReferenceIssue({
    existingTaskProjects,
    taskUpserts,
    taskDeletes
  });
  if (issue) {
    throw new ServerPersistenceError('MUTATION_FAILED', taskReferenceMessage(issue), { details: issue });
  }

  return {
    ...changes,
    taskUpserts: orderTaskUpsertsByDependencies(taskUpserts),
    taskDeletes
  };
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
      projectEdges.set(nextProjectId, removeTaskEdges(
        projectEdges.get(nextProjectId) || [],
        taskId,
        { incoming: false }
      ));
    }
  }

  for (const entry of changes.taskDeletes) {
    const taskId = uuid(entry.id, 'Görev kimliği');
    const row = changedTaskRows.get(taskId);
    if (!row) continue;
    const projectId = String(row.ProjectId);
    projectEdges.set(projectId, removeTaskEdges(projectEdges.get(projectId) || [], taskId));
  }

  for (const task of changes.taskUpserts) {
    const taskId = uuid(task.id, 'Görev kimliği');
    const projectId = uuid(task.projectId, 'Proje kimliği');
    const nextEdges = projectEdges.get(projectId) || [];
    for (const dependency of task.deps || []) {
      nextEdges.push({
        taskId,
        predecessorId: uuid(dependency.predecessorId, 'Öncül görev kimliği')
      });
    }
    projectEdges.set(projectId, nextEdges);
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

async function planIntegrity(executor, changes) {
  await assertActiveProjectMutationTargets(executor, changes);
  await assertActiveCalendarReferences(executor, changes);
  await assertSingleRootWbs(executor, changes);
  const plannedChanges = await planTaskCommits(executor, changes);
  await assertAcyclicTaskDependencies(executor, plannedChanges);
  return plannedChanges;
}

export function createHardenedSqlAppRepository() {
  const baseRepository = createBaseSqlAppRepository();
  return {
    ...baseRepository,
    async commitChanges(input) {
      const changes = normalizeChanges(input);
      return withSqlTransaction(async (transaction) => {
        const plannedChanges = await planIntegrity(transaction, changes);
        return baseRepository.commitChanges(plannedChanges);
      });
    }
  };
}
