from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_required(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label}: expected marker not found')
    return text.replace(old, new, 1)


# Server repository fixes.
repo_path = 'src/server/repository/sqlAppRepository.js'
repo = read(repo_path)
repo = replace_required(
    repo,
    "    if (!/^\\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0) {",
    "    if (!/^\\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0 || sicil > 2147483647) {",
    'Sicil SQL int upper bound',
)
repo = replace_required(
    repo,
    "    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));\n",
    "    DECLARE @VisibleProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY, AccessLevel varchar(10));\n"
    "    DECLARE @ReadGrantedProjects TABLE(ProjectId uniqueidentifier PRIMARY KEY);\n",
    'READ project table declaration',
)
manual_grant_marker = """    INSERT @VisibleProjects(ProjectId, AccessLevel)
    SELECT pa.ProjectId, CASE WHEN pa.AccessLevel = 'FULL' THEN 'FULL' ELSE 'PARTIAL' END
"""
read_grant_insert = """    INSERT @ReadGrantedProjects(ProjectId)
    SELECT pa.ProjectId
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE @isAdmin = 0 AND pa.Sicil = @sicil AND pa.IsActive = 1
      AND pa.AccessLevel = 'READ' AND p.IsActive = 1;

"""
repo = replace_required(repo, manual_grant_marker, read_grant_insert + manual_grant_marker, 'READ grant population')
repo = replace_required(
    repo,
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)",
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = w.ProjectId)\n       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)",
    'READ WBS visibility',
)
repo = replace_required(
    repo,
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (\n          SELECT 1\n          FROM dbo.MR_TaskAssignees ta",
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)\n       OR EXISTS (\n          SELECT 1\n          FROM dbo.MR_TaskAssignees ta",
    'READ task visibility',
)
repo = replace_required(
    repo,
    "    WHERE v.AccessLevel = 'FULL'\n       OR ta.Sicil = @sicil",
    "    WHERE v.AccessLevel = 'FULL'\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)\n       OR ta.Sicil = @sicil",
    'READ assignee visibility',
)
people_marker = repo.index("WHERE visibleAssignee.Sicil = pd.Sicil")
people_start = repo.rfind("\n", 0, people_marker) + 1
order_start = repo.index("    ORDER BY pd.DisplayName, pd.Sicil;", people_marker)
people_end = repo.rfind("        )\n", people_marker, order_start)
if people_end < people_start:
    raise SystemExit('people visibility outer close not found')
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
repo = repo[:people_start] + new_people_gate + repo[people_end:]
repo = replace_required(
    repo,
    "  const projectId = id(before.ProjectId);\n  assertProjectWriteAccess(actor.effective, projectId);\n  const refs = request(executor);",
    "  const projectId = id(before.ProjectId);\n  assertProjectWriteAccess(actor.effective, projectId);\n  if (before.ParentWbsId == null) {\n    throw new ServerPersistenceError('MUTATION_FAILED', 'Proje kök WBS düğümü silinemez.');\n  }\n  const refs = request(executor);",
    'server root WBS deletion guard',
)
repo = replace_required(
    repo,
    "        const wbsIds = new Set(changes.wbsUpserts.map((value) => value.id));",
    "        const wbsIds = new Set([...changes.wbsUpserts.map((value) => value.id), ...consumedRootIds]);",
    'fallback root commit response',
)
write(repo_path, repo)
print('patched server repository')


# Domain and state root-deletion/session fixes.
validation_path = 'src/domain/validation/wbsValidation.js'
validation = read(validation_path)
validation_start = validation.index('export function validateWbsDeletion(wbs, tasks, wbsId) {')
validation = validation[:validation_start] + """export function validateWbsDeletion(wbs, tasks, wbsId) {
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
write(validation_path, validation)
print('patched WBS deletion validation')

app_state_path = 'src/state/appState.js'
app_state = read(app_state_path)
app_state = replace_required(
    app_state,
    "    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.',",
    "    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.',\n    WBS_ROOT_DELETE_FORBIDDEN: 'Proje kök WBS düğümü silinemez.',",
    'root deletion UI message',
)
empty_start = app_state.index('function emptyApplicationData() {')
empty_end = app_state.index('export function createLoadingState()', empty_start)
app_state = app_state[:empty_start] + """function emptyApplicationData() {
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

""" + app_state[empty_end:]
state_marker = """function createStateFromSnapshot(snapshot = {}, previous = createLoadingState()) {
  const base = {
"""
state_replacement = """function createStateFromSnapshot(snapshot = {}, previous = createLoadingState()) {
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
"""
app_state = replace_required(app_state, state_marker, state_replacement, 'session state normalization')
write(app_state_path, app_state)
print('patched app session state')


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
    projects: [{ id: 'p1', name: 'Project' }], people: [], calendars: [],
    wbs: [{ id: 'root', projectId: 'p1', parentId: null, code: '1', name: 'Root', sortOrder: 1 }],
    tasks: [], baselines: [], taskBaselineSnapshots: []
  };
  const state = appStateReducer(createInitialState(snapshot), { type: 'wbs/delete', id: 'root' });
  assert.equal(state.wbs.length, 1);
  assert.equal(state.wbsActionError?.code, 'WBS_ROOT_DELETE_FORBIDDEN');
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function deleteWbs'), source.indexOf('export function createSqlAppRepository'));
  assert.match(body, /if \(before\.ParentWbsId == null\)/);
});

test('loaded session capabilities survive state normalization and collection-only reloads', () => {
  const session = {
    dataMode: 'actual', currentUser: { id: '18068', name: 'User' },
    isSystemAdmin: false, isExecutive: true, canCreateProjects: true,
    projectAccess: [{ projectId: 'p1', accessLevel: 'PARTIAL', reasons: ['MANUAL_GRANT'] }]
  };
  const snapshot = {
    session, projects: [{ id: 'p1', name: 'Project' }], people: [], calendars: [],
    wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: []
  };
  let state = createInitialState(snapshot);
  assert.deepEqual(state.session, session);
  assert.equal(state.currentUser.id, '18068');
  assert.equal(state.canCreateProjects, true);
  assert.deepEqual(state.projectAccess, session.projectAccess);
  state = appStateReducer(state, {
    type: 'data/load-success',
    snapshot: { projects: snapshot.projects, people: [], calendars: [], wbs: [], tasks: [], baselines: [], taskBaselineSnapshots: [] }
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
print('patched regression coverage')
