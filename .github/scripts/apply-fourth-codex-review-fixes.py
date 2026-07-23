from pathlib import Path


def replace_once(path, old, new):
    file_path = Path(path)
    text = file_path.read_text()
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}: {old[:140]!r}')
    file_path.write_text(text.replace(old, new, 1))


# P2: require the complete development Sicil environment value to be a positive integer.
identity_parser = Path('src/server/identity/parseDevelopmentSicil.js')
identity_parser.write_text("""export function parseDevelopmentSicil(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\\d*$/.test(raw)) return null;
  const sicil = Number(raw);
  return Number.isSafeInteger(sicil) ? sicil : null;
}
""")

replace_once(
    'src/server/identity/currentUserProvider.js',
    """import 'server-only';
import { ServerPersistenceError } from '../errors.js';
""",
    """import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { parseDevelopmentSicil } from './parseDevelopmentSicil.js';
"""
)
replace_once(
    'src/server/identity/currentUserProvider.js',
    """    const sicil = Number.parseInt(process.env.MERGEN_ROTA_DEV_SICIL || '', 10);
    if (!Number.isInteger(sicil) || sicil <= 0) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış.');
    }
    return sicil;
""",
    """    const sicil = parseDevelopmentSicil(process.env.MERGEN_ROTA_DEV_SICIL);
    if (sicil == null) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış.');
    }
    return sicil;
"""
)

# P2: detect manual/corporate ProjectCode collisions and count only corporate rows as synchronized.
replace_once(
    'src/server/repository/corporateQueries.js',
    """  THROW 51001, 'Corporate project source contains conflicting rows for the same ProjeKodu.', 1;

UPDATE target
""",
    """  THROW 51001, 'Corporate project source contains conflicting rows for the same ProjeKodu.', 1;

IF EXISTS (
  SELECT 1
  FROM dbo.MR_Projects manual WITH (UPDLOCK, HOLDLOCK)
  JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = manual.ProjectCode
  WHERE manual.SourceType = 'MANUAL'
)
  THROW 51002, 'A manual project code conflicts with the corporate project source.', 1;

UPDATE target
"""
)
replace_once(
    'src/server/repository/corporateQueries.js',
    """WHERE NOT EXISTS (SELECT 1 FROM dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK) WHERE p.ProjectCode = source.ProjectCode);
""",
    """WHERE NOT EXISTS (
  SELECT 1
  FROM dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK)
  WHERE p.SourceType = 'CORPORATE' AND p.ProjectCode = source.ProjectCode
);
"""
)

# P2: keep corporate ProjectName non-null by falling back to the normalized ProjectCode.
replace_once(
    'database/MR_Create_Durable_Persistence.sql',
    """            NULLIF(LTRIM(RTRIM(ProjeAdi)), N'''') AS ProjectName
""",
    """            COALESCE(NULLIF(LTRIM(RTRIM(ProjeAdi)), N''''), NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectName
"""
)

repo = Path('src/server/repository/sqlAppRepository.js')
text = repo.read_text()

# Reserve current and previously synchronized corporate codes from manual projects.
ensure_people_block = """async function ensurePeople(executor, sicils) {
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
manual_code_helper = ensure_people_block + """async function assertManualProjectCodeAvailable(executor, projectCode) {
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
if ensure_people_block not in text:
    raise SystemExit('ensurePeople block not found')
text = text.replace(ensure_people_block, manual_code_helper, 1)

# Track whether the caller has any FULL/admin scope so partial-only users receive a constrained people directory.
visible_tail = """      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);

    SELECT p.*, v.AccessLevel
"""
visible_replacement = """      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);

    DECLARE @HasFullScope bit = CASE
      WHEN @isAdmin = 1 OR EXISTS (SELECT 1 FROM @VisibleProjects WHERE AccessLevel = 'FULL') THEN 1
      ELSE 0
    END;

    SELECT p.*, v.AccessLevel
"""
if visible_tail not in text:
    raise SystemExit('visible project tail not found')
text = text.replace(visible_tail, visible_replacement, 1)

people_query = """    SELECT Sicil, DisplayName, Username, JobTitle, Team, Sector, Directorate, Department, Unit
    FROM dbo.MR_V_PeopleDirectory
    ORDER BY DisplayName, Sicil;
"""
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
    ORDER BY pd.DisplayName, pd.Sicil;
"""
if people_query not in text:
    raise SystemExit('people directory query not found')
text = text.replace(people_query, people_replacement, 1)

# Normalize manual codes before validation/persistence and reject codes reserved by corporate data.
project_start = """async function commitProject(executor, actor, project, rootWbs, correlationId) {
  const projectId = uuid(project.id);
  const before = await projectRow(executor, projectId);
"""
project_start_replacement = """async function commitProject(executor, actor, project, rootWbs, correlationId) {
  const projectId = uuid(project.id);
  const projectCode = project.code == null ? null : (String(project.code).trim() || null);
  const before = await projectRow(executor, projectId);
"""
if project_start not in text:
    raise SystemExit('commitProject start not found')
text = text.replace(project_start, project_start_replacement, 1)

create_validation = """    assertCanCreateManualProject(actor);
    await ensurePeople(executor, project.leadId ? [project.leadId] : []);
"""
create_validation_replacement = """    assertCanCreateManualProject(actor);
    await assertManualProjectCodeAvailable(executor, projectCode);
    await ensurePeople(executor, project.leadId ? [project.leadId] : []);
"""
if create_validation not in text:
    raise SystemExit('manual create validation block not found')
text = text.replace(create_validation, create_validation_replacement, 1)

update_validation = """  assertProjectWriteAccess(actor.effective, projectId);
  await ensurePeople(executor, project.leadId ? [project.leadId] : []);
"""
update_validation_replacement = """  assertProjectWriteAccess(actor.effective, projectId);
  if (before.SourceType === 'MANUAL') {
    await assertManualProjectCodeAvailable(executor, projectCode);
  }
  await ensurePeople(executor, project.leadId ? [project.leadId] : []);
"""
if update_validation not in text:
    raise SystemExit('manual update validation block not found')
text = text.replace(update_validation, update_validation_replacement, 1)

if text.count("req.input('projectCode', sql.NVarChar(255), project.code || null);") != 2:
    raise SystemExit('unexpected projectCode bind count')
text = text.replace("req.input('projectCode', sql.NVarChar(255), project.code || null);", "req.input('projectCode', sql.NVarChar(255), projectCode);")
repo.write_text(text)

# Regression tests for all four new findings.
tests = Path('test/codex-p2-regressions.test.mjs')
test_text = tests.read_text()
if "parseDevelopmentSicil" not in test_text.split('\n', 20)[0:20].__str__():
    test_text = test_text.replace(
        "import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';\n",
        "import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';\nimport { parseDevelopmentSicil } from '../src/server/identity/parseDevelopmentSicil.js';\n",
        1
    )

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

if "development identity rejects partial, decimal" not in test_text:
    test_text += additions

tests.write_text(test_text)
