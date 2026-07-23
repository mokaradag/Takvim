from pathlib import Path
import re
import sys

stage = sys.argv[1] if len(sys.argv) > 1 else 'all'


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(path, old, new, label):
    text = read(path)
    if old not in text:
        raise SystemExit(f'{label}: expected block not found')
    write(path, text.replace(old, new, 1))


def sub_once(path, pattern, replacement, label, flags=0):
    text = read(path)
    updated, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    write(path, updated)


def patch_identity():
    Path('src/server/identity/parseDevelopmentSicil.js').write_text("""export function parseDevelopmentSicil(value) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\\d*$/.test(raw)) return null;
  const sicil = Number(raw);
  return Number.isSafeInteger(sicil) ? sicil : null;
}
""")
    replace_once(
        'src/server/identity/currentUserProvider.js',
        "import { ServerPersistenceError } from '../errors.js';\n",
        "import { ServerPersistenceError } from '../errors.js';\nimport { parseDevelopmentSicil } from './parseDevelopmentSicil.js';\n",
        'identity import'
    )
    sub_once(
        'src/server/identity/currentUserProvider.js',
        r"    const sicil = Number\.parseInt\(process\.env\.MERGEN_ROTA_DEV_SICIL \|\| '', 10\);\n    if \(!Number\.isInteger\(sicil\) \|\| sicil <= 0\) \{\n      throw new ServerPersistenceError\('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış\.'\);\n    \}\n    return sicil;",
        """    const sicil = parseDevelopmentSicil(process.env.MERGEN_ROTA_DEV_SICIL);
    if (sicil == null) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış.');
    }
    return sicil;""",
        'strict identity parsing'
    )


def patch_sync_schema():
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
        'manual corporate collision guard'
    )
    sub_once(
        'src/server/repository/corporateQueries.js',
        r"WHERE NOT EXISTS \(SELECT 1 FROM dbo\.MR_Projects p WITH \(UPDLOCK, HOLDLOCK\) WHERE p\.ProjectCode = source\.ProjectCode\);",
        """WHERE NOT EXISTS (
  SELECT 1
  FROM dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK)
  WHERE p.SourceType = 'CORPORATE' AND p.ProjectCode = source.ProjectCode
);""",
        'corporate-only sync existence check'
    )
    sub_once(
        'database/MR_Create_Durable_Persistence.sql',
        r"            NULLIF\(LTRIM\(RTRIM\(ProjeAdi\)\), N''''\) AS ProjectName",
        "            COALESCE(NULLIF(LTRIM(RTRIM(ProjeAdi)), N''''), NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectName",
        'ProjectName fallback'
    )


def patch_repository():
    path = 'src/server/repository/sqlAppRepository.js'
    text = read(path)

    match = re.search(r"async function ensurePeople\(executor, sicils\) \{[\s\S]*?\n\}\n\n", text)
    if not match:
        raise SystemExit('manual code helper: ensurePeople not found')
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
    text = text[:match.end()] + helper + text[match.end():]

    anchor = "      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);\n\n    SELECT p.*, v.AccessLevel"
    if anchor not in text:
        raise SystemExit('full-scope marker anchor not found')
    text = text.replace(anchor, """      AND NOT EXISTS (SELECT 1 FROM @VisibleProjects v WHERE v.ProjectId = t.ProjectId);

    DECLARE @HasFullScope bit = CASE
      WHEN @isAdmin = 1 OR EXISTS (SELECT 1 FROM @VisibleProjects WHERE AccessLevel = 'FULL') THEN 1
      ELSE 0
    END;

    SELECT p.*, v.AccessLevel""", 1)

    people = """    SELECT Sicil, DisplayName, Username, JobTitle, Team, Sector, Directorate, Department, Unit
    FROM dbo.MR_V_PeopleDirectory
    ORDER BY DisplayName, Sicil;"""
    if people not in text:
        raise SystemExit('people directory query not found')
    text = text.replace(people, """    SELECT pd.Sicil, pd.DisplayName, pd.Username, pd.JobTitle, pd.Team, pd.Sector, pd.Directorate, pd.Department, pd.Unit
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
    ORDER BY pd.DisplayName, pd.Sicil;""", 1)

    start = "async function commitProject(executor, actor, project, rootWbs, correlationId) {\n  const projectId = uuid(project.id);\n"
    if start not in text:
        raise SystemExit('commitProject start not found')
    text = text.replace(start, start + "  const projectCode = project.code == null ? null : (String(project.code).trim() || null);\n", 1)

    create_anchor = "    assertCanCreateManualProject(actor);\n    await ensurePeople(executor, project.leadId ? [project.leadId] : []);"
    if create_anchor not in text:
        raise SystemExit('manual create validation anchor not found')
    text = text.replace(create_anchor, "    assertCanCreateManualProject(actor);\n    await assertManualProjectCodeAvailable(executor, projectCode);\n    await ensurePeople(executor, project.leadId ? [project.leadId] : []);", 1)

    update_anchor = "  assertProjectWriteAccess(actor.effective, projectId);\n  await ensurePeople(executor, project.leadId ? [project.leadId] : []);"
    if update_anchor not in text:
        raise SystemExit('manual update validation anchor not found')
    text = text.replace(update_anchor, "  assertProjectWriteAccess(actor.effective, projectId);\n  if (before.SourceType === 'MANUAL') {\n    await assertManualProjectCodeAvailable(executor, projectCode);\n  }\n  await ensurePeople(executor, project.leadId ? [project.leadId] : []);", 1)

    bind = "req.input('projectCode', sql.NVarChar(255), project.code || null);"
    if text.count(bind) != 2:
        raise SystemExit(f'expected two projectCode binds, found {text.count(bind)}')
    text = text.replace(bind, "req.input('projectCode', sql.NVarChar(255), projectCode);")
    write(path, text)


def patch_tests():
    path = 'test/codex-p2-regressions.test.mjs'
    text = read(path)
    anchor = "import { createApiRepository, toActualUuid } from '../src/data/api/createApiRepository.js';\n"
    parser_import = "import { parseDevelopmentSicil } from '../src/server/identity/parseDevelopmentSicil.js';\n"
    if parser_import not in text:
        if anchor not in text:
            raise SystemExit('test import anchor not found')
        text = text.replace(anchor, anchor + parser_import, 1)
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
  assert.ok((repository.match(/await assertManualProjectCodeAvailable\(executor, projectCode\);/g) || []).length >= 2);
});

test('partial-only snapshots constrain the people directory to authorized project context', () => {
  const source = read('src/server/repository/sqlAppRepository.js');
  assert.match(source, /DECLARE @HasFullScope bit = CASE[\s\S]*AccessLevel = 'FULL'/);
  assert.match(source, /FROM dbo\.MR_V_PeopleDirectory pd\s+WHERE @HasFullScope = 1\s+OR pd\.Sicil = @sicil/s);
  assert.match(source, /WHERE p\.LeadSicil = pd\.Sicil/);
  assert.match(source, /WHERE visibleAssignee\.Sicil = pd\.Sicil[\s\S]*visibilityGate\.Sicil = @sicil/s);
});

test('corporate project view always supplies a usable ProjectName', () => {
  const source = read('database/MR_Create_Durable_Persistence.sql');
  assert.ok(source.includes("COALESCE(NULLIF(LTRIM(RTRIM(ProjeAdi)), N''''), NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectName"));
});
'''
    if "development identity rejects partial, decimal" not in text:
        text += additions
    write(path, text)


stages = {
    'identity': patch_identity,
    'sync': patch_sync_schema,
    'repository': patch_repository,
    'tests': patch_tests,
}
if stage == 'all':
    for fn in stages.values():
        fn()
elif stage in stages:
    stages[stage]()
else:
    raise SystemExit(f'unknown stage: {stage}')
