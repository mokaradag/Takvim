from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(path, old, new, label):
    text = read(path)
    if old not in text:
        raise SystemExit(f'{label}: expected block not found in {path}')
    write(path, text.replace(old, new, 1))
    print(f'patched: {label}')


# P2: keep all persisted Sicil values inside SQL Server int range.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "    if (!/^\\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0) {",
    "    if (!/^\\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0 || sicil > 2147483647) {",
    'Sicil SQL int upper bound',
)

# P2: make project-level READ grants return project Tasks/WBS/assignees while remaining PARTIAL for scheduling.
repo_path = 'src/server/repository/sqlAppRepository.js'
repo = read(repo_path)
repo = repo.replace(
    "    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));\n",
    "    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));\n"
    "    DECLARE @ReadGrantedProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY);\n",
    1,
)
read_grants_anchor = """    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT pa.ProjectId, CASE WHEN pa.AccessLevel = 'FULL' THEN 'FULL' ELSE 'PARTIAL' END
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE @isAdmin = 0 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND p.IsActive = 1
      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = pa.ProjectId);
"""
read_grants_block = """    INSERT @ReadGrantedProjects(ProjectId)
    SELECT pa.ProjectId
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE @isAdmin = 0 AND pa.Sicil = @sicil AND pa.IsActive = 1
      AND pa.AccessLevel = 'READ' AND p.IsActive = 1;

""" + read_grants_anchor
if read_grants_anchor not in repo:
    raise SystemExit('READ grant visible-project block not found')
repo = repo.replace(read_grants_anchor, read_grants_block, 1)
repo = repo.replace(
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)",
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = w.ProjectId)\n       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)",
    1,
)
repo = repo.replace(
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (\n          SELECT 1\n          FROM dbo.MR_TaskAssignees ta",
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)\n       OR EXISTS (\n          SELECT 1\n          FROM dbo.MR_TaskAssignees ta",
    1,
)
repo = repo.replace(
    "    WHERE v.AccessLevel = 'FULL'\n       OR ta.Sicil = @sicil",
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)\n       OR ta.Sicil = @sicil",
    1,
)
old_people_gate = """          WHERE visibleAssignee.Sicil = pd.Sicil
            AND EXISTS (
              SELECT 1
              FROM dbo.MR_TaskAssignees visibilityGate
              WHERE visibilityGate.TaskId = visibleTask.TaskId
                AND (
                  visibilityGate.Sicil = @sicil
                  OR EXISTS (
                    SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                    WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibilityGate.Sicil
                  )
                )
            )
"""
new_people_gate = """          WHERE visibleAssignee.Sicil = pd.Sicil
            AND (
              EXISTS (
                SELECT 1 FROM @ReadGrantedProjects readProject
                WHERE readProject.ProjectId = visibleTask.ProjectId
              )
              OR EXISTS (
                SELECT 1
                FROM dbo.MR_TaskAssignees visibilityGate
                WHERE visibilityGate.TaskId = visibleTask.TaskId
                  AND (
                    visibilityGate.Sicil = @sicil
                    OR EXISTS (
                      SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                      WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = visibilityGate.Sicil
                    )
                  )
              )
            )
"""
if old_people_gate not in repo:
    raise SystemExit('partial people visibility gate not found')
repo = repo.replace(old_people_gate, new_people_gate, 1)

# P2: prevent root WBS deletion at the trusted persistence boundary.
root_delete_anchor = """  const projectId = id(before.ProjectId);
  assertProjectWriteAccess(actor.effective, projectId);
  const refs = request(executor);
"""
root_delete_replacement = """  const projectId = id(before.ProjectId);
  assertProjectWriteAccess(actor.effective, projectId);
  if (before.ParentWbsId == null) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Proje kök WBS düğümü silinemez.');
  }
  const refs = request(executor);
"""
if root_delete_anchor not in repo:
    raise SystemExit('deleteWbs authorization anchor not found')
repo = repo.replace(root_delete_anchor, root_delete_replacement, 1)

# P2: include server-generated fallback roots in the authoritative commit response.
repo = repo.replace(
    "        const wbsIds = new Set(changes.wbsUpserts.map((value) => value.id));",
    "        const wbsIds = new Set([...changes.wbsUpserts.map((value) => value.id), ...consumedRootIds]);",
    1,
)
write(repo_path, repo)
print('patched: READ visibility, root deletion guard, fallback root response')

# P2: prevent root deletion in the client/domain transition as well.
validation_path = 'src/domain/validation/wbsValidation.js'
validation = read(validation_path)
old_validation = """export function validateWbsDeletion(wbs, tasks, wbsId) {
  const issues = [];
  const childIds = (wbs || []).filter((node) => node.parentId === wbsId).map((node) => node.id);
  const taskIds = (tasks || []).filter((task) => task.wbsId === wbsId).map((task) => task.id);

  if (childIds.length) issues.push(issue('WBS_HAS_CHILDREN', wbsId, { childIds }));
  if (taskIds.length) issues.push(issue('WBS_HAS_TASKS', wbsId, { taskIds }));
  return issues;
}
"""
new_validation = """export function validateWbsDeletion(wbs, tasks, wbsId) {
  const issues = [];
  const node = indexWbs(wbs).get(wbsId) || null;
  const childIds = (wbs || []).filter((item) => item.parentId === wbsId).map((item) => item.id);
  const taskIds = (tasks || []).filter((task) => task.wbsId === wbsId).map((task) => task.id);

  if (node && node.parentId == null) issues.push(issue('WBS_ROOT_DELETE_FORBIDDEN', wbsId));
  if (childIds.length) issues.push(issue('WBS_HAS_CHILDREN', wbsId, { childIds }));
  if (taskIds.length) issues.push(issue('WBS_HAS_TASKS', wbsId, { taskIds }));
  return issues;
}
"""
if old_validation not in validation:
    raise SystemExit('validateWbsDeletion block not found')
write(validation_path, validation.replace(old_validation, new_validation, 1))
print('patched: domain root WBS deletion validation')

app_state_path = 'src/state/appState.js'
app_state = read(app_state_path)
app_state = app_state.replace(
    "    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.',",
    "    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.',\n    WBS_ROOT_DELETE_FORBIDDEN: 'Proje kök WBS düğümü silinemez.',",
    1,
)

# P2: preserve session capabilities through state normalization and collection-only reloads.
old_empty = """function emptyApplicationData() {
  return {
    calendars: [],
    projects: [],
    people: [],
    wbs: [],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  };
}
"""
new_empty = """function emptyApplicationData() {
  return {
    calendars: [],
    projects: [],
    people: [],
    wbs: [],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: [],
    session: null,
    currentUser: null,
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: []
  };
}
"""
if old_empty not in app_state:
    raise SystemExit('emptyApplicationData block not found')
app_state = app_state.replace(old_empty, new_empty, 1)
old_state_start = """function createStateFromSnapshot(snapshot = {}, previous = createLoadingState()) {
  const base = {
    calendars: snapshot.calendars || [],
    projects: snapshot.projects || [],
    people: snapshot.people || [],
    wbs: snapshot.wbs || [],
    baselines: snapshot.baselines || [],
    taskBaselineSnapshots: snapshot.taskBaselineSnapshots || []
  };
"""
new_state_start = """function createStateFromSnapshot(snapshot = {}, previous = createLoadingState()) {
  const hasSession = Object.prototype.hasOwnProperty.call(snapshot, 'session');
  const session = hasSession ? snapshot.session : previous.session;
  const sessionState = hasSession
    ? {
        session: session || null,
        currentUser: session?.currentUser || null,
        isSystemAdmin: Boolean(session?.isSystemAdmin),
        isExecutive: Boolean(session?.isExecutive),
        canCreateProjects: Boolean(session?.canCreateProjects),
        projectAccess: session?.projectAccess || []
      }
    : {
        session: previous.session || null,
        currentUser: previous.currentUser || null,
        isSystemAdmin: Boolean(previous.isSystemAdmin),
        isExecutive: Boolean(previous.isExecutive),
        canCreateProjects: Boolean(previous.canCreateProjects),
        projectAccess: previous.projectAccess || []
      };
  const base = {
    ...sessionState,
    calendars: snapshot.calendars || [],
    projects: snapshot.projects || [],
    people: snapshot.people || [],
    wbs: snapshot.wbs || [],
    baselines: snapshot.baselines || [],
    taskBaselineSnapshots: snapshot.taskBaselineSnapshots || []
  };
"""
if old_state_start not in app_state:
    raise SystemExit('createStateFromSnapshot start not found')
app_state = app_state.replace(old_state_start, new_state_start, 1)
write(app_state_path, app_state)
print('patched: session capabilities preserved in app state')

# Regression coverage.
codex_test_path = 'test/codex-p2-regressions.test.mjs'
codex_tests = read(codex_test_path)
additions = r'''

test('server-generated fallback project roots are included in commit WBS responses', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /const wbsIds = new Set\(\[\.\.\.changes\.wbsUpserts\.map\(\(value\) => value\.id\), \.\.\.consumedRootIds\]\)/);
  assert.match(source, /return \{ created: true, consumedRootId: authoritativeRoot\.id \}/);
});

test('persisted Sicil validation rejects values above SQL Server int maximum', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /sicil <= 0 \|\| sicil > 2147483647/);
  assert.ok(source.indexOf('sicil > 2147483647') < source.indexOf("req.input('sicil', sql.Int, sicil)"));
});

test('project-level READ grants expose project tasks, WBS, assignees, and required people without enabling complete scheduling data', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /DECLARE @ReadGrantedProjects TABLE\(ProjectId uniqueidentifier PRIMARY KEY\)/);
  assert.match(source, /pa\.AccessLevel = 'READ'/);
  assert.match(source, /@ReadGrantedProjects readProject WHERE readProject\.ProjectId = w\.ProjectId/);
  assert.match(source, /@ReadGrantedProjects readProject WHERE readProject\.ProjectId = t\.ProjectId/);
  assert.match(source, /readProject\.ProjectId = visibleTask\.ProjectId/);
  assert.match(source, /SELECT d\.\*[\s\S]*WHERE v\.AccessLevel = 'FULL';/);
});

test('root WBS deletion is rejected in both domain state and SQL persistence', () => {
  const snapshot = {
    projects: [{ id: 'p1', name: 'Project' }],
    people: [],
    calendars: [],
    wbs: [{ id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 }],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  };
  const state = appStateReducer(createInitialState(snapshot), { type: 'wbs/delete', id: 'root' });
  assert.equal(state.wbs.length, 1);
  assert.equal(state.wbsActionError?.code, 'WBS_ROOT_DELETE_FORBIDDEN');

  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function deleteWbs'), source.indexOf('export function createSqlAppRepository'));
  assert.match(body, /if \(before\.ParentWbsId == null\)/);
  assert.match(body, /Proje kök WBS düğümü silinemez/);
});

test('loaded session capabilities survive state normalization and later collection-only reloads', () => {
  const session = {
    dataMode: 'actual',
    currentUser: { id: '18068', name: 'User' },
    isSystemAdmin: false,
    isExecutive: true,
    canCreateProjects: true,
    projectAccess: [{ projectId: 'p1', accessLevel: 'PARTIAL', reasons: ['MANUAL_GRANT'] }]
  };
  const snapshot = {
    session,
    projects: [{ id: 'p1', name: 'Project' }],
    people: [],
    calendars: [],
    wbs: [],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: []
  };
  let state = createInitialState(snapshot);
  assert.deepEqual(state.session, session);
  assert.equal(state.currentUser.id, '18068');
  assert.equal(state.canCreateProjects, true);
  assert.deepEqual(state.projectAccess, session.projectAccess);

  state = appStateReducer(state, {
    type: 'data/load-success',
    snapshot: { ...snapshot, session: undefined }
  });
  assert.equal(state.currentUser, null);

  state = createInitialState(snapshot);
  state = appStateReducer(state, {
    type: 'data/load-success',
    snapshot: {
      projects: snapshot.projects,
      people: [], calendars: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: []
    }
  });
  assert.deepEqual(state.session, session);
  assert.equal(state.currentUser.id, '18068');
  assert.equal(state.canCreateProjects, true);
  assert.deepEqual(state.projectAccess, session.projectAccess);
});
'''
if 'server-generated fallback project roots are included in commit WBS responses' not in codex_tests:
    codex_tests += additions
write(codex_test_path, codex_tests)
print('patched: sixth Codex regression coverage')

# Add direct domain coverage for root deletion semantics.
domain_test_path = 'test/domain-validation-edge-cases.test.mjs'
domain_tests = read(domain_test_path)
domain_addition = r'''

test('WBS deletion validation rejects a project root even when it is empty', () => {
  const result = validateWbsDeletion(wbs, [], 'p2-root');
  assert.equal(result[0].code, 'WBS_ROOT_DELETE_FORBIDDEN');
});
'''
if 'WBS deletion validation rejects a project root even when it is empty' not in domain_tests:
    domain_tests += domain_addition
write(domain_test_path, domain_tests)
print('patched: root WBS domain regression')
