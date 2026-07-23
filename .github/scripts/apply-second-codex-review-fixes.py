from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


replace_once(
    'src/server/authorization/loadAuthorizationContext.js',
    """    SELECT pa.ProjectId, CASE WHEN pa.GrantSource = 'OWNER' THEN 'MANUAL_OWNER' ELSE 'MANUAL_GRANT' END
    FROM dbo.MR_ProjectAccess pa
    WHERE pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel = 'FULL';
""",
    """    SELECT pa.ProjectId, CASE WHEN pa.GrantSource = 'OWNER' THEN 'MANUAL_OWNER' ELSE 'MANUAL_GRANT' END
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE p.IsActive = 1 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel = 'FULL';
"""
)

replace_once(
    'src/state/persistence.js',
    """export async function loadApplicationData(repository) {
  try {
    const [snapshot, session] = await Promise.all([
      repository.loadSnapshot(),
      repository.loadSessionContext()
    ]);
    return { ok: true, snapshot: { ...snapshot, session } };
""",
    """function defaultSessionContext(repository) {
  return {
    dataMode: repository?.kind === 'actual-api' || repository?.kind === 'sql-server' ? 'actual' : 'demo',
    currentUser: null,
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: []
  };
}

export async function loadApplicationData(repository) {
  try {
    const sessionPromise = typeof repository.loadSessionContext === 'function'
      ? repository.loadSessionContext()
      : Promise.resolve(defaultSessionContext(repository));
    const [snapshot, session] = await Promise.all([
      repository.loadSnapshot(),
      sessionPromise
    ]);
    return { ok: true, snapshot: { ...snapshot, session } };
"""
)

api = Path('src/data/api/createApiRepository.js')
text = api.read_text()
old = """function collectClientIds(changes = {}) {
  const map = new Map();
  for (const collection of [changes.projectUpserts, changes.wbsUpserts, changes.taskUpserts]) {
    for (const entity of collection || []) {
      const original = entity?.id == null ? null : String(entity.id);
      const actual = toActualUuid(original);
      if (original && actual && original !== actual) map.set(actual, original);
    }
  }
  return map;
}
"""
new = """function rememberClientId(map, value) {
  if (value == null || value === '') return;
  const original = String(value);
  const actual = toActualUuid(original);
  if (actual && original !== actual) map.set(actual, original);
}

function rememberDeleteId(map, entry) {
  rememberClientId(map, typeof entry === 'string' ? entry : entry?.id);
}

function collectClientIds(changes = {}, map = new Map()) {
  for (const project of changes.projectUpserts || []) {
    rememberClientId(map, project?.id);
    rememberClientId(map, project?.calendarId);
  }
  for (const entry of changes.projectDeletes || []) rememberDeleteId(map, entry);

  for (const node of changes.wbsUpserts || []) {
    rememberClientId(map, node?.id);
    rememberClientId(map, node?.projectId);
    rememberClientId(map, node?.parentId);
  }
  for (const entry of changes.wbsDeletes || []) rememberDeleteId(map, entry);

  for (const task of changes.taskUpserts || []) {
    rememberClientId(map, task?.id);
    rememberClientId(map, task?.projectId);
    rememberClientId(map, task?.wbsId);
    rememberClientId(map, task?.calendarId);
    for (const dependency of task?.deps || []) {
      rememberClientId(map, dependency?.id);
      rememberClientId(map, dependency?.predecessorId);
    }
  }
  for (const entry of changes.taskDeletes || []) rememberDeleteId(map, entry);
  return map;
}
"""
if old not in text:
    raise SystemExit('collectClientIds block not found')
text = text.replace(old, new, 1)
text = text.replace(
    "export function restoreActualCommitIds(body, changes = {}) {\n  if (!body || typeof body !== 'object') return body;\n  const map = collectClientIds(changes);",
    "export function restoreActualCommitIds(body, changes = {}, aliases = null) {\n  if (!body || typeof body !== 'object') return body;\n  const map = collectClientIds(changes, aliases || new Map());",
    1
)
marker = "function normalizeActualResponse(body) {\n"
snapshot_helper = """function restoreActualSnapshotIds(body, map) {
  if (!body || typeof body !== 'object' || !map?.size) return body;
  return {
    ...body,
    projects: Array.isArray(body.projects) ? body.projects.map((project) => ({
      ...project,
      id: restoreClientId(project.id, map),
      calendarId: restoreClientId(project.calendarId, map)
    })) : body.projects,
    wbs: Array.isArray(body.wbs) ? body.wbs.map((node) => ({
      ...node,
      id: restoreClientId(node.id, map),
      projectId: restoreClientId(node.projectId, map),
      parentId: restoreClientId(node.parentId, map)
    })) : body.wbs,
    tasks: Array.isArray(body.tasks) ? body.tasks.map((task) => ({
      ...task,
      id: restoreClientId(task.id, map),
      projectId: restoreClientId(task.projectId, map),
      wbsId: restoreClientId(task.wbsId, map),
      calendarId: restoreClientId(task.calendarId, map),
      deps: (task.deps || []).map((dependency) => ({
        ...dependency,
        predecessorId: restoreClientId(dependency.predecessorId, map)
      }))
    })) : body.tasks
  };
}

"""
if marker not in text:
    raise SystemExit('normalizeActualResponse marker not found')
text = text.replace(marker, snapshot_helper + marker, 1)
old_repo = """export function createApiRepository({ basePath = '/api/mergen-rota' } = {}) {
  return {
    kind: 'actual-api',
    loadSessionContext() {
      return requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext');
    },
    loadSnapshot() {
      return requestJson(`${basePath}/snapshot`, { method: 'GET' }, 'loadSnapshot');
    },
    async commitChanges(changes) {
      const committed = await requestJson(`${basePath}/commit`, {
        method: 'POST',
        body: JSON.stringify({ changes: normalizeActualChanges(changes) })
      }, 'commitChanges');
      return restoreActualCommitIds(committed, changes);
    },
    async flush() {}
  };
}
"""
new_repo = """export function createApiRepository({ basePath = '/api/mergen-rota' } = {}) {
  const clientIdAliases = new Map();
  return {
    kind: 'actual-api',
    loadSessionContext() {
      return requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext');
    },
    async loadSnapshot() {
      const snapshot = await requestJson(`${basePath}/snapshot`, { method: 'GET' }, 'loadSnapshot');
      return restoreActualSnapshotIds(snapshot, clientIdAliases);
    },
    async commitChanges(changes) {
      const committed = await requestJson(`${basePath}/commit`, {
        method: 'POST',
        body: JSON.stringify({ changes: normalizeActualChanges(changes) })
      }, 'commitChanges');
      return restoreActualCommitIds(committed, changes, clientIdAliases);
    },
    async flush() {}
  };
}
"""
if old_repo not in text:
    raise SystemExit('createApiRepository block not found')
api.write_text(text.replace(old_repo, new_repo, 1))

repo = Path('src/server/repository/sqlAppRepository.js')
text = repo.read_text()
old_wbs = """async function commitWbs(executor, actor, node, correlationId) {
  const wbsId = uuid(node.id);
  const projectId = uuid(node.projectId);
  assertProjectWriteAccess(actor.effective, projectId);
  const before = await wbsRow(executor, wbsId);
"""
new_wbs = """async function commitWbs(executor, actor, node, correlationId) {
  const wbsId = uuid(node.id);
  const projectId = uuid(node.projectId);
  const before = await wbsRow(executor, wbsId);
  if (before) {
    const storedProjectId = id(before.ProjectId);
    assertProjectWriteAccess(actor.effective, storedProjectId);
    if (storedProjectId !== projectId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'WBS kaydı farklı bir projeye taşınamaz.');
    }
  } else {
    assertProjectWriteAccess(actor.effective, projectId);
  }
"""
if old_wbs not in text:
    raise SystemExit('commitWbs authorization block not found')
text = text.replace(old_wbs, new_wbs, 1)
old_task = """async function commitTask(executor, actor, task, correlationId) {
  const taskId = uuid(task.id);
  const projectId = uuid(task.projectId);
  assertProjectWriteAccess(actor.effective, projectId);
  if (!await projectRow(executor, projectId)) {
"""
new_task = """async function commitTask(executor, actor, task, correlationId) {
  const taskId = uuid(task.id);
  const projectId = uuid(task.projectId);
  const before = await taskRow(executor, taskId);
  if (before) assertProjectWriteAccess(actor.effective, id(before.ProjectId));
  assertProjectWriteAccess(actor.effective, projectId);
  if (!await projectRow(executor, projectId)) {
"""
if old_task not in text:
    raise SystemExit('commitTask authorization block not found')
text = text.replace(old_task, new_task, 1)
old_before = """  await ensurePeople(executor, task.assigneeIds || []);
  const before = await taskRow(executor, taskId);
  const req = request(executor);
"""
new_before = """  await ensurePeople(executor, task.assigneeIds || []);
  const projectChanged = before && id(before.ProjectId) !== projectId;
  if (projectChanged) {
    const dependencyCleanup = request(executor);
    dependencyCleanup.input('taskId', sql.UniqueIdentifier, taskId);
    await dependencyCleanup.query(`
      DELETE dbo.MR_TaskDependencies
      WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;
    `);
  }
  const req = request(executor);
"""
if old_before not in text:
    raise SystemExit('commitTask before-row block not found')
repo.write_text(text.replace(old_before, new_before, 1))

tests = Path('test/codex-p2-regressions.test.mjs')
text = tests.read_text()
text = text.replace(
    "import { createStateMutationOrchestrator } from '../src/state/persistence.js';",
    "import { createStateMutationOrchestrator, loadApplicationData } from '../src/state/persistence.js';",
    1
)
additions = r'''

test('existing WBS updates authorize the stored project and reject forged project reassignment', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitWbs'), source.indexOf('async function commitTask'));
  assert.ok(body.indexOf('const before = await wbsRow(executor, wbsId)') < body.indexOf('assertProjectWriteAccess(actor.effective, storedProjectId)'));
  assert.match(body, /const storedProjectId = id\(before\.ProjectId\);/);
  assert.match(body, /if \(storedProjectId !== projectId\)/);
});

test('existing task updates authorize both stored source and requested destination projects', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitTask'), source.indexOf('async function deleteTask'));
  const loadIndex = body.indexOf('const before = await taskRow(executor, taskId)');
  const sourceAuthIndex = body.indexOf('if (before) assertProjectWriteAccess(actor.effective, id(before.ProjectId))');
  const destinationAuthIndex = body.indexOf('assertProjectWriteAccess(actor.effective, projectId)');
  assert.ok(loadIndex >= 0 && loadIndex < sourceAuthIndex);
  assert.ok(sourceAuthIndex < destinationAuthIndex);
});

test('cross-project task moves clear incoming and outgoing dependency rows before changing ProjectId', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitTask'), source.indexOf('async function deleteTask'));
  const cleanupIndex = body.indexOf('WHERE TaskId = @taskId OR PredecessorTaskId = @taskId;');
  const updateIndex = body.indexOf('UPDATE dbo.MR_Tasks');
  assert.match(body, /const projectChanged = before && id\(before\.ProjectId\) !== projectId;/);
  assert.ok(cleanupIndex >= 0 && cleanupIndex < updateIndex);
});

test('manual FULL grants are ignored when their project is inactive', () => {
  const source = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(
    source,
    /FROM dbo\.MR_ProjectAccess pa\s+JOIN dbo\.MR_Projects p ON p\.ProjectId = pa\.ProjectId\s+WHERE p\.IsActive = 1 AND pa\.Sicil = @sicil AND pa\.IsActive = 1 AND pa\.AccessLevel = 'FULL'/s
  );
});

test('repositories without loadSessionContext still load with a conservative default session', async () => {
  const result = await loadApplicationData({
    kind: 'legacy-test',
    async loadSnapshot() {
      return { calendars: [], projects: [], people: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [] };
    },
    async commitChanges(changes) { return changes; }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.session, {
    dataMode: 'demo',
    currentUser: null,
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: []
  });
});

test('Actual repository keeps client ID aliases across later snapshot loads and delete-only responses', async () => {
  const projectClientId = `project-${PROJECT_ID}`;
  const wbsClientId = `wbs-${WBS_ID}`;
  const taskClientId = `task-${TASK_ID}`;
  const originalFetch = globalThis.fetch;
  let step = 0;

  globalThis.fetch = async (url) => {
    step += 1;
    if (String(url).endsWith('/commit') && step === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            projectUpserts: [{ id: PROJECT_ID, name: 'Persistent Alias', version: 'pv' }],
            wbsUpserts: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Root', version: 'wv' }],
            taskUpserts: [{ id: TASK_ID, projectId: PROJECT_ID, wbsId: WBS_ID, status: 'planned', deps: [], version: 'tv' }]
          };
        }
      };
    }
    if (String(url).endsWith('/snapshot')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            projects: [{ id: PROJECT_ID, name: 'Persistent Alias' }],
            wbs: [{ id: WBS_ID, projectId: PROJECT_ID, parentId: null, code: '1', name: 'Root' }],
            tasks: [{ id: TASK_ID, projectId: PROJECT_ID, wbsId: WBS_ID, status: 'planned', deps: [] }]
          };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { taskDeletes: [TASK_ID] }; }
    };
  };

  try {
    const repository = createApiRepository({ basePath: '/alias-api' });
    await repository.commitChanges({
      projectUpserts: [{ id: projectClientId, name: 'Persistent Alias' }],
      wbsUpserts: [{ id: wbsClientId, projectId: projectClientId, parentId: null, code: '1', name: 'Root' }],
      taskUpserts: [{ id: taskClientId, projectId: projectClientId, wbsId: wbsClientId, status: 'todo', deps: [] }]
    });

    const snapshot = await repository.loadSnapshot();
    assert.equal(snapshot.projects[0].id, projectClientId);
    assert.equal(snapshot.wbs[0].id, wbsClientId);
    assert.equal(snapshot.wbs[0].projectId, projectClientId);
    assert.equal(snapshot.tasks[0].id, taskClientId);
    assert.equal(snapshot.tasks[0].projectId, projectClientId);
    assert.equal(snapshot.tasks[0].wbsId, wbsClientId);

    const deleted = await repository.commitChanges({ taskDeletes: [taskClientId] });
    assert.equal(deleted.taskDeletes[0], taskClientId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
'''
if "existing WBS updates authorize the stored project" in text:
    raise SystemExit('Regression tests already present unexpectedly')
tests.write_text(text + additions)
