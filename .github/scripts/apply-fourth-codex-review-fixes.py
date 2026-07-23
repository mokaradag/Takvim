from pathlib import Path
import re


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


def sub_once(path, pattern, replacement, label, flags=0):
    text = read(path)
    updated, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected one match in {path}, found {count}')
    write(path, updated)
    print(f'patched: {label}')


# P2: require the complete development Sicil environment value to be a positive integer.
Path('src/server/identity/parseDevelopmentSicil.js').write_text("""export function parseDevelopmentSicil(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\\d*$/.test(raw)) return null;
  const sicil = Number(raw);
  return Number.isSafeInteger(sicil) ? sicil : null;
}
""")
print('patched: development Sicil parser')

replace_once(
    'src/server/identity/currentUserProvider.js',
    "import { ServerPersistenceError } from '../errors.js';\n",
    "import { ServerPersistenceError } from '../errors.js';\nimport { parseDevelopmentSicil } from './parseDevelopmentSicil.js';\n",
    'development identity import'
)
sub_once(
    'src/server/identity/currentUserProvider.js',
    r"    const sicil = Number\.parseInt\(process\.env\.MERGEN_ROTA_DEV_SICIL \|\| '', 10\);\n    if \(!Number\.isInteger\(sicil\) \|\| sicil <= 0\) \{\n      throw new ServerPersistenceError\('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış\.'\);\n    \}\n    return sicil;",
    """    const sicil = parseDevelopmentSicil(process.env.MERGEN_ROTA_DEV_SICIL);
    if (sicil == null) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış.');
    }
    return sicil;""",
    'strict development identity parsing'
)

# P2: detect manual/corporate ProjectCode collisions and count only corporate rows as synchronized.
replace_once(
    'src/server/repository/corporateQueries.js',
    "  THROW 51001, 'Corporate project source contains conflicting rows for the same ProjeKodu.', 1;\n\nUPDATE target\n",
    """  THROW 51001, 'Corporate project source contains conflicting rows for the same ProjeKodu.', 1;

IF EXISTS (
  SELECT 1
  FROM dbo.MR_Projects manual WITH (UPDLOCK, HOLDLOCK)
  JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = manual.ProjectCode
  WHERE manual.SourceType = 'MANUAL'
)
  THROW 51002, 'A manual project code conflicts with the corporate project source.', 1;

UPDATE target
""",
    'corporate sync manual collision guard'
)
sub_once(
    'src/server/repository/corporateQueries.js',
    r"WHERE NOT EXISTS \(SELECT 1 FROM dbo\.MR_Projects p WITH \(UPDLOCK, HOLDLOCK\) WHERE p\.ProjectCode = source\.ProjectCode\);",
    """WHERE NOT EXISTS (
  SELECT 1
  FROM dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK)
  WHERE p.SourceType = 'CORPORATE' AND p.ProjectCode = source.ProjectCode
);""",
    'corporate-only synchronized existence check'
)

# P2: keep corporate ProjectName non-null by falling back to normalized ProjectCode.
sub_once(
    'database/MR_Create_Durable_Persistence.sql',
    r"            NULLIF\(LTRIM\(RTRIM\(ProjeAdi\)\), N''''\) AS ProjectName",
    "            COALESCE(NULLIF(LTRIM(RTRIM(ProjeAdi)), N''''), NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectName",
    'corporate ProjectName fallback'
)

repo_path = 'src/server/repository/sqlAppRepository.js'
repo = read(repo_path)

# Reserve current and previously synchronized corporate codes from manual projects.
ensure_match = re.search(r"async function ensurePeople\(executor, sicils\) \{[\s\S]*?\n\}\n\n", repo)
if not ensure_match:
    raise SystemExit('manual code helper: ensurePeople function not found')
helper = """async function assertManualProjectCodeAvailable(executor, projectCode) {
  if (!projectCode) return;
  const req = request(executor);
  req.input('projectCode', sql.NVarChar(255), projectCode);
  const result = await req.query(`
    SELECT TOP (1) reserved.ProjectCode
    FROM (
      SELECT ProjectCode FROM dbo.MR_V_CorporateProjects
      UNION
      SELECT ProjectCode FROM dbo.MR_Projects WHERE SourceType = 'CORPORATE'
    ) reserved
    WHERE reserved.ProjectCode = @projectCode;
  `);
  if (result.recordset.length) {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Kurumsal proje kodu manuel proje için kullanılamaz.');
  }
}

"""
repo = repo[:ensure_match.end()] + helper + repo[ensure_match.end():]
print('patched: manual ProjectCode reservation helper')

# Track whether the caller has any FULL/admin scope so partial-only users receive a constrained people directory.
needle = "      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);\n\n    SELECT p.*, v.AccessLevel"
replacement = """      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);

    DECLARE @HasFullScope bit = CASE
      WHEN @isAdmin = 1 OR EXISTS (SELECT 1 FROM @VisibleProjects WHERE AccessLevel = 'FULL') THEN 1
      ELSE 0
    END;

    SELECT p.*, v.AccessLevel"""
if needle not in repo:
    raise SystemExit('partial people filter: visible-project tail not found')
repo = repo.replace(needle, replacement, 1)
print('patched: full-scope marker')

people_pattern = re.compile(
    r"    SELECT Sicil, DisplayName, Username, JobTitle, Team, Sector, Directorate, Department, Unit\n"
    r"    FROM dbo\.MR_V_PeopleDirectory\n"
    r"    ORDER BY DisplayName, Sicil;"
)
people_replacement = """    SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector, pd.Directorate, pd.Department, pd.Unit
    FROM dbo.MR_V_PeopleDirectory pd
    WHERE @HasFullScope = 1
       OR pd.Sicil = @sicil
       OR EXISTS (
         SELECT 1
         FROM dbo.MR_Projects p
         JOIN @VisibleProjects v ON v.ProjectId = p.ProjectId
         WHERE p.LeadSicil = pd.Sicil
       )
       OR EXISTS (
         SELECT 1
         FROM dbo.MR_TaskAssignees visibleAssignee
         JOIN dbo.MR_Tasks visibleTask ON visibleTask.TaskId = visibleAssignee.TaskId
         JOIN @VisibleProjects visibleProject ON visibleProject.ProjectId = visibleTask.ProjectId
         WHERE visibleAssignee.Sicil = pd.Sicil
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
       )
    ORDER BY pd.DisplayName, pd.Sicil;"""
repo, count = people_pattern.subn(people_replacement, repo, count=1)
if count != 1:
    raise SystemExit(f'partial people filter: expected one directory query, found {count}')
print('patched: partial people directory filter')

# Normalize manual codes before validation/persistence and reject codes reserved by corporate data.
project_start = "async function commitProject(executor, actor, project, rootWbs, correlationId) {\n  const projectId = uuid(project.id);\n"
if project_start not in repo:
    raise SystemExit('manual code validation: commitProject start not found')
repo = repo.replace(
    project_start,
    project_start + "  const projectCode = project.code == null ? null : (String(project.code).trim() || null);\n",
    1
)
print('patched: normalized manual ProjectCode')

create_validation = "    assertCanCreateManualProject(actor);\n    await ensurePeople(executor, project.leadId ? [project.leadId] : []);"
if create_validation not in repo:
    raise SystemExit('manual code validation: create path not found')
repo = repo.replace(
    create_validation,
    "    assertCanCreateManualProject(actor);\n    await assertManualProjectCodeAvailable(executor, projectCode);\n    await ensurePeople(executor, project.leadId ? [project.leadId] : []);",
    1
)
print('patched: manual create code validation')

update_validation = "  assertProjectWriteAccess(actor.effective, projectId);\n  await ensurePeople(executor, project.leadId ? [project.leadId] : []);"
if update_validation not in repo:
    raise SystemExit('manual code validation: update path not found')
repo = repo.replace(
    update_validation,
    "  assertProjectWriteAccess(actor.effective, projectId);\n  if (before.SourceType === 'MANUAL') {\n    await assertManualProjectCodeAvailable(executor, projectCode);\n  }\n  await ensurePeople(executor, project.leadId ? [project.leadId] : []);",
    1
)
print('patched: manual update code validation')

bind = "req.input('projectCode', sql.NVarChar(255), project.code || null);"
if repo.count(bind) != 2:
    raise SystemExit(f'manual code validation: expected two projectCode bindings, found {repo.count(bind)}')
repo = repo.replace(bind, "req.input('projectCode', sql.NVarChar(255), projectCode);")
print('patched: normalized projectCode bindings')
write(repo_path, repo)

# Regression tests for all four new findings.
tests_path = 'test/codex-p2-regressions.test.mjs'
tests = read(tests_path)
import_line = "import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';\n"
parser_import = "import { parseDevelopmentSicil } from '../src/server/identity/parseDevelopmentSicil.js';\n"
if parser_import not in tests:
    if import_line not in tests:
        raise SystemExit('test import anchor not found')
    tests = tests.replace(import_line, import_line + parser_import, 1)

additions = r'''

test('development identity rejects partial, decimal, non-positive, blank, and unsafe Sicil strings', () => {
  assert.equal(parseDevelopmentSicil('18068'), 18068);
  assert.equal(parseDevelopmentSicil(' 18068 '), 18068);
  for (const invalid of ['18068abc', '18068.5', '0', '-1', '', '   ', '9007199254740992']) {
    assert.equal(parseDevelopmentSicil(invalid), null, `expected ${JSON.stringify(invalid)} to be rejected`);
  }
  const providerSource = read('src/server/identity/currentUserProvider.js');
  assert.doesNotMatch(providerSource, /Number\.parseInt/);
  assert.match(providerSource, /parseDevelopmentSicil\(process\.env\.MERGEN_ROTA_DEV_SICIL\)/);
});

test('manual project codes cannot silently suppress or collide with corporate synchronization', () => {
  const sync = read('src/server/repository/corporateQueries.js');
  assert.match(sync, /FROM dbo\.MR_Projects manual WITH \(UPDLOCK, HOLDLOCK\)[\s\S]*manual\.SourceType = 'MANUAL'/);
  assert.match(sync, /THROW 51002, 'A manual project code conflicts with the corporate project source\.'/);
  assert.match(sync, /WHERE p\.SourceType = 'CORPORATE' AND p\.ProjectCode = source\.ProjectCode/);

  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /async function assertManualProjectCodeAvailable\(executor, projectCode\)/);
  assert.match(repository, /SELECT ProjectCode FROM dbo\.MR_V_CorporateProjects[\s\S]*SELECT ProjectCode FROM dbo\.MR_Projects WHERE SourceType = 'CORPORATE'/);
  assert.ok((repository.match(/await assertManualProjectCodeAvailable\(executor, projectCode\);/g) || []).length >= 2);
});

test('partial-only snapshots constrain the people directory to authorized project context', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /DECLARE @HasFullScope bit = CASE[\s\S]*AccessLevel = 'FULL'/);
  assert.match(source, /FROM dbo\.MR_V_PeopleDirectory pd\s+WHERE @HasFullScope = 1\s+OR pd\.Sicil = @sicil/s);
  assert.match(source, /WHERE p\.LeadSicil = pd\.Sicil/);
  assert.match(source, /WHERE visibleAssignee\.Sicil = pd\.Sicil[\s\S]*visibilityGate\.Sicil = @sicil/s);
  assert.match(source, /es\.ManagerSicil = @sicil AND es\.EmployeeSicil = visibilityGate\.Sicil/);
});

test('corporate project view always supplies a usable ProjectName', () => {
  const source = read('database/MR_Create_Durable_Persistence.sql');
  assert.ok(source.includes("COALESCE(NULLIF(LTRIM(RTRIM(ProjeAdi)), N''''), NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectName"));
  assert.match(source, /WHERE NULLIF\(LTRIM\(RTRIM\(ProjeKodu\)\), N''''\) IS NOT NULL/);
});
'''
if "development identity rejects partial, decimal" not in tests:
    tests += additions
write(tests_path, tests)
print('patched: fourth Codex regression tests')
