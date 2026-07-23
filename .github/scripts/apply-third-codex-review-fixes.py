from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old in text:
        p.write_text(text.replace(old, new, 1))
        return
    if new in text:
        return
    raise SystemExit(f'Expected block not found in {path}: {old[:140]!r}')


# P2: serialize concurrent corporate-project insert existence checks.
replace_once(
    'src/server/repository/corporateQueries.js',
    "WHERE NOT EXISTS (SELECT 1 FROM dbo.MR_Projects p WHERE p.ProjectCode = source.ProjectCode);",
    "WHERE NOT EXISTS (SELECT 1 FROM dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK) WHERE p.ProjectCode = source.ProjectCode);"
)

# P2: validate exactly the Sicil values that are persisted.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    """async function ensurePeople(executor, sicils) {
  for (const sicil of [...new Set((sicils || []).filter(Boolean).map(Number))]) {
    if (!Number.isInteger(sicil) || sicil <= 0) {
      throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${sicil}`);
    }
    const req = request(executor);
    req.input('sicil', sql.Int, sicil);
    const result = await req.query('SELECT TOP (1) Sicil FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil;');
    if (!result.recordset.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${sicil}`);
    }
  }
}
""",
    """function normalizeSicils(sicils) {
  const normalized = [];
  for (const value of sicils || []) {
    const text = value == null ? '' : String(value).trim();
    const sicil = Number(text);
    if (!/^\\d+$/.test(text) || !Number.isSafeInteger(sicil) || sicil <= 0) {
      throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${text || value}`);
    }
    if (!normalized.includes(sicil)) normalized.push(sicil);
  }
  return normalized;
}

async function ensurePeople(executor, sicils) {
  const normalized = normalizeSicils(sicils);
  for (const sicil of normalized) {
    const req = request(executor);
    req.input('sicil', sql.Int, sicil);
    const result = await req.query('SELECT TOP (1) Sicil FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil;');
    if (!result.recordset.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', `Geçersiz çalışan Sicil: ${sicil}`);
    }
  }
  return normalized;
}
"""
)

# P2: HR09 role access is only valid for corporate projects in snapshots.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "WHERE @isAdmin = 0 AND p.IsActive = 1 AND a.Sicil = @sicil",
    "WHERE @isAdmin = 0 AND p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil"
)

# P2: partial snapshots expose only WBS context required by visible tasks, plus ancestors.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    """    SELECT w.*
    FROM dbo.MR_WBS w
    JOIN @VisibleProjects v ON v.ProjectId = w.ProjectId
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code;
""",
    """    ;WITH RequiredPartialWbs AS (
      SELECT DISTINCT w.WbsId, w.ParentWbsId, w.ProjectId
      FROM dbo.MR_WBS w
      JOIN dbo.MR_Tasks t ON t.WbsId = w.WbsId
      JOIN @VisibleProjects v ON v.ProjectId = t.ProjectId
      WHERE v.AccessLevel = 'PARTIAL'
        AND EXISTS (
          SELECT 1
          FROM dbo.MR_TaskAssignees ta
          WHERE ta.TaskId = t.TaskId
            AND (
              ta.Sicil = @sicil
              OR EXISTS (
                SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
              )
            )
        )
      UNION ALL
      SELECT parent.WbsId, parent.ParentWbsId, parent.ProjectId
      FROM dbo.MR_WBS parent
      JOIN RequiredPartialWbs child ON child.ParentWbsId = parent.WbsId
      WHERE parent.ProjectId = child.ProjectId
    )
    SELECT w.*
    FROM dbo.MR_WBS w
    JOIN @VisibleProjects v ON v.ProjectId = w.ProjectId
    WHERE v.AccessLevel = 'FULL'
       OR EXISTS (SELECT 1 FROM RequiredPartialWbs r WHERE r.WbsId = w.WbsId)
    ORDER BY w.ProjectId, w.ParentWbsId, w.SortOrder, w.Code
    OPTION (MAXRECURSION 1000);
"""
)

# P2: lock WBS rows/ancestry while validating reparenting to prevent concurrent cycles.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    """function projectRow(executor, value) { return rowById(executor, 'MR_Projects', 'ProjectId', value); }
function wbsRow(executor, value) { return rowById(executor, 'MR_WBS', 'WbsId', value); }
function taskRow(executor, value) { return rowById(executor, 'MR_Tasks', 'TaskId', value); }
""",
    """function projectRow(executor, value) { return rowById(executor, 'MR_Projects', 'ProjectId', value); }
function wbsRow(executor, value) { return rowById(executor, 'MR_WBS', 'WbsId', value); }
async function wbsRowForUpdate(executor, value) {
  const req = request(executor);
  req.input('id', sql.UniqueIdentifier, uuid(value));
  return (await req.query('SELECT TOP (1) * FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK) WHERE WbsId = @id;')).recordset[0] || null;
}
function taskRow(executor, value) { return rowById(executor, 'MR_Tasks', 'TaskId', value); }
"""
)
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "  const before = await wbsRow(executor, wbsId);",
    "  const before = await wbsRowForUpdate(executor, wbsId);"
)
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "    let parent = await wbsRow(executor, node.parentId);",
    "    let parent = await wbsRowForUpdate(executor, node.parentId);"
)
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "      parent = parent.ParentWbsId ? await wbsRow(executor, parent.ParentWbsId) : null;",
    "      parent = parent.ParentWbsId ? await wbsRowForUpdate(executor, parent.ParentWbsId) : null;"
)

# P2: project lead updates must validate the logical HR02 reference too.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    """  assertProjectWriteAccess(actor.effective, projectId);
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
""",
    """  assertProjectWriteAccess(actor.effective, projectId);
  await ensurePeople(executor, project.leadId ? [project.leadId] : []);
  const req = request(executor);
  req.input('projectId', sql.UniqueIdentifier, projectId);
"""
)

# Persist only the validated/normalized assignee list.
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "  await ensurePeople(executor, task.assigneeIds || []);",
    "  const assigneeSicils = await ensurePeople(executor, task.assigneeIds || []);"
)
replace_once(
    'src/server/repository/sqlAppRepository.js',
    "  for (const sicil of task.assigneeIds || []) {",
    "  for (const sicil of assigneeSicils) {"
)

# Regression coverage for the six findings.
tests = Path('test/codex-p2-regressions.test.mjs')
text = tests.read_text()
text = text.replace(
    "assert.ok(body.indexOf('const before = await wbsRow(executor, wbsId)') < body.indexOf('assertProjectWriteAccess(actor.effective, storedProjectId)'));",
    "assert.ok(body.indexOf('const before = await wbsRowForUpdate(executor, wbsId)') < body.indexOf('assertProjectWriteAccess(actor.effective, storedProjectId)'));"
)
marker = "test('corporate project sync serializes concurrent first inserts by ProjectCode'"
if marker not in text:
    text += r'''


test('corporate project sync serializes concurrent first inserts by ProjectCode', () => {
  const source = read('src/server/repository/corporateQueries.js');
  assert.match(
    source,
    /NOT EXISTS \(SELECT 1 FROM dbo\.MR_Projects p WITH \(UPDLOCK, HOLDLOCK\) WHERE p\.ProjectCode = source\.ProjectCode\)/
  );
});

test('task assignees persist only the Sicil list that passed normalization and directory validation', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /function normalizeSicils\(sicils\)/);
  assert.match(source, /const assigneeSicils = await ensurePeople\(executor, task\.assigneeIds \|\| \[\]\);/);
  assert.match(source, /for \(const sicil of assigneeSicils\)/);
  assert.doesNotMatch(source, /\(sicils \|\| \[\]\)\.filter\(Boolean\)\.map\(Number\)/);
});

test('snapshot HR09 FULL visibility applies only to corporate projects', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(
    source,
    /JOIN dbo\.MR_V_CorporateProjectAccess a ON a\.ProjectCode = p\.ProjectCode\s+WHERE @isAdmin = 0 AND p\.SourceType = 'CORPORATE' AND p\.IsActive = 1 AND a\.Sicil = @sicil/s
  );
});

test('partial snapshots return only visible-task WBS context and its ancestor chain', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /;WITH RequiredPartialWbs AS \(/);
  assert.match(source, /WHERE v\.AccessLevel = 'PARTIAL'[\s\S]*JOIN RequiredPartialWbs child ON child\.ParentWbsId = parent\.WbsId/);
  assert.match(source, /WHERE v\.AccessLevel = 'FULL'\s+OR EXISTS \(SELECT 1 FROM RequiredPartialWbs r WHERE r\.WbsId = w\.WbsId\)/s);
  assert.match(source, /OPTION \(MAXRECURSION 1000\)/);
});

test('WBS reparent validation holds update and serializable locks across the ancestry walk', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitWbs'), source.indexOf('async function commitTask'));
  assert.match(source, /FROM dbo\.MR_WBS WITH \(UPDLOCK, HOLDLOCK\) WHERE WbsId = @id/);
  assert.match(body, /const before = await wbsRowForUpdate\(executor, wbsId\)/);
  assert.match(body, /let parent = await wbsRowForUpdate\(executor, node\.parentId\)/);
  assert.match(body, /await wbsRowForUpdate\(executor, parent\.ParentWbsId\)/);
});

test('project updates validate LeadSicil before binding and writing it', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  const body = source.slice(source.indexOf('async function commitProject'), source.indexOf('async function commitWbs'));
  const updateStart = body.lastIndexOf('assertProjectWriteAccess(actor.effective, projectId)');
  const validationIndex = body.indexOf("await ensurePeople(executor, project.leadId ? [project.leadId] : []);", updateStart);
  const bindIndex = body.indexOf("req.input('leadSicil', sql.Int", updateStart);
  assert.ok(updateStart >= 0 && validationIndex > updateStart && validationIndex < bindIndex);
});
'''
tests.write_text(text)
