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


# P3: reject development Sicil values outside the SQL Server int range.
replace_once(
    'src/server/identity/parseDevelopmentSicil.js',
    "  return Number.isSafeInteger(sicil) ? sicil : null;",
    "  return Number.isSafeInteger(sicil) && sicil <= 2147483647 ? sicil : null;",
    'development Sicil SQL int bound',
)

# P2: represent project-level READ grants as PARTIAL effective access.
authz_path = 'src/server/authorization/authorization.js'
authz = read(authz_path)
old_function = """export function deriveEffectiveAccess({ isSystemAdmin, fullProjectIds = [], partialTaskRows = [] }) {
  const access = new Map();
  if (isSystemAdmin) {
    return { isSystemAdmin: true, access, partialTaskIds: new Set(), fullProjectIds: new Set(fullProjectIds) };
  }
  for (const projectId of fullProjectIds) {
    access.set(projectId, { projectId, accessLevel: 'FULL', reasons: [ACCESS_REASONS.CORPORATE_PROJECT_ROLE] });
  }
  const partialTaskIds = new Set();
  for (const row of partialTaskRows) {
    partialTaskIds.add(row.taskId);
    if (!access.has(row.projectId)) {
      access.set(row.projectId, { projectId: row.projectId, accessLevel: 'PARTIAL', reasons: [row.reason] });
    } else if (access.get(row.projectId).accessLevel === 'PARTIAL') {
      access.get(row.projectId).reasons = [...new Set([...access.get(row.projectId).reasons, row.reason])];
    }
  }
  return {
    isSystemAdmin: false,
    access,
    partialTaskIds,
    fullProjectIds: new Set([...access.values()].filter((entry) => entry.accessLevel === 'FULL').map((entry) => entry.projectId))
  };
}
"""
new_function = """export function deriveEffectiveAccess({ isSystemAdmin, fullProjectIds = [], partialProjectRows = [], partialTaskRows = [] }) {
  const access = new Map();
  if (isSystemAdmin) {
    return { isSystemAdmin: true, access, partialTaskIds: new Set(), fullProjectIds: new Set(fullProjectIds) };
  }
  for (const projectId of fullProjectIds) {
    access.set(projectId, { projectId, accessLevel: 'FULL', reasons: [ACCESS_REASONS.CORPORATE_PROJECT_ROLE] });
  }
  for (const row of partialProjectRows) {
    if (!access.has(row.projectId)) {
      access.set(row.projectId, { projectId: row.projectId, accessLevel: 'PARTIAL', reasons: [row.reason] });
    } else if (access.get(row.projectId).accessLevel === 'PARTIAL') {
      access.get(row.projectId).reasons = [...new Set([...access.get(row.projectId).reasons, row.reason])];
    }
  }
  const partialTaskIds = new Set();
  for (const row of partialTaskRows) {
    partialTaskIds.add(row.taskId);
    if (!access.has(row.projectId)) {
      access.set(row.projectId, { projectId: row.projectId, accessLevel: 'PARTIAL', reasons: [row.reason] });
    } else if (access.get(row.projectId).accessLevel === 'PARTIAL') {
      access.get(row.projectId).reasons = [...new Set([...access.get(row.projectId).reasons, row.reason])];
    }
  }
  return {
    isSystemAdmin: false,
    access,
    partialTaskIds,
    fullProjectIds: new Set([...access.values()].filter((entry) => entry.accessLevel === 'FULL').map((entry) => entry.projectId))
  };
}
"""
if old_function not in authz:
    raise SystemExit('deriveEffectiveAccess function not found')
write(authz_path, authz.replace(old_function, new_function, 1))
print('patched: project-level partial effective access')

context_path = 'src/server/authorization/loadAuthorizationContext.js'
context = read(context_path)
old_grants = """    SELECT DISTINCT p.ProjectId, CAST('CORPORATE_PROJECT_ROLE' AS varchar(30)) AS Reason
    FROM dbo.MR_Projects p
    JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = p.ProjectCode
    WHERE p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil
    UNION
    SELECT pa.ProjectId, CASE WHEN pa.GrantSource = 'OWNER' THEN 'MANUAL_OWNER' ELSE 'MANUAL_GRANT' END
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE p.IsActive = 1 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel = 'FULL';
"""
new_grants = """    SELECT DISTINCT p.ProjectId, CAST('FULL' AS varchar(20)) AS AccessLevel,
      CAST('CORPORATE_PROJECT_ROLE' AS varchar(30)) AS Reason
    FROM dbo.MR_Projects p
    JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = UPPER(p.ProjectCode)
    WHERE p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil
    UNION
    SELECT pa.ProjectId, pa.AccessLevel,
      CASE WHEN pa.GrantSource = 'OWNER' THEN 'MANUAL_OWNER' ELSE 'MANUAL_GRANT' END
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE p.IsActive = 1 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel IN ('FULL', 'READ');
"""
if old_grants not in context:
    raise SystemExit('authorization grant query not found')
context = context.replace(old_grants, new_grants, 1)
old_processing = """  const fullRows = result.recordsets[3] || [];
  const partialRows = (result.recordsets[4] || []).map((row) => ({
    projectId: String(row.ProjectId),
    taskId: String(row.TaskId),
    reason: row.Reason === ACCESS_REASONS.ASSIGNEE ? ACCESS_REASONS.ASSIGNEE : ACCESS_REASONS.EXECUTIVE_SCOPE
  }));
  const effective = deriveEffectiveAccess({
    isSystemAdmin,
    fullProjectIds: fullRows.map((row) => String(row.ProjectId)),
    partialTaskRows: partialRows
  });
"""
new_processing = """  const grantRows = result.recordsets[3] || [];
  const fullRows = grantRows.filter((row) => row.AccessLevel === 'FULL');
  const partialProjectRows = grantRows
    .filter((row) => row.AccessLevel === 'READ')
    .map((row) => ({ projectId: String(row.ProjectId), reason: ACCESS_REASONS.MANUAL_GRANT }));
  const partialRows = (result.recordsets[4] || []).map((row) => ({
    projectId: String(row.ProjectId),
    taskId: String(row.TaskId),
    reason: row.Reason === ACCESS_REASONS.ASSIGNEE ? ACCESS_REASONS.ASSIGNEE : ACCESS_REASONS.EXECUTIVE_SCOPE
  }));
  const effective = deriveEffectiveAccess({
    isSystemAdmin,
    fullProjectIds: fullRows.map((row) => String(row.ProjectId)),
    partialProjectRows,
    partialTaskRows: partialRows
  });
"""
if old_processing not in context:
    raise SystemExit('authorization grant processing not found')
write(context_path, context.replace(old_processing, new_processing, 1))
print('patched: READ grants in authorization/session access')

# P2: canonicalize manual ProjectCode and all case-sensitive project-code joins.
repo_path = 'src/server/repository/sqlAppRepository.js'
repo = read(repo_path)
repo = repo.replace("WHERE reserved.ProjectCode = @projectCode;", "WHERE UPPER(reserved.ProjectCode) = @projectCode;", 1)
repo = repo.replace(
    "const projectCode = project.code == null ? null : (String(project.code).trim() || null);",
    "const projectCode = project.code == null ? null : (String(project.code).trim().toUpperCase() || null);",
    1,
)
repo = repo.replace(
    "JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = p.ProjectCode",
    "JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = UPPER(p.ProjectCode)",
    1,
)
write(repo_path, repo)
print('patched: canonical ProjectCode handling in SQL repository')

sync_path = 'src/server/repository/corporateQueries.js'
sync = read(sync_path)
sync = sync.replace(
    "JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = manual.ProjectCode",
    "JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = UPPER(manual.ProjectCode)",
    1,
)
root_sync = """
UPDATE root
SET Name = source.ProjectName,
    UpdatedAt = SYSUTCDATETIME(),
    UpdatedBySicil = @actorSicil
FROM dbo.MR_WBS root
JOIN dbo.MR_Projects target ON target.ProjectId = root.ProjectId
JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = UPPER(target.ProjectCode)
WHERE target.SourceType = 'CORPORATE'
  AND root.ParentWbsId IS NULL
  AND root.Name <> source.ProjectName
  AND (root.Name = target.ProjectName OR root.Name = target.ProjectCode)
  AND 1 = (
    SELECT COUNT(*) FROM dbo.MR_WBS roots
    WHERE roots.ProjectId = target.ProjectId AND roots.ParentWbsId IS NULL
  );

"""
anchor = "UPDATE target\nSET ProjectName = source.ProjectName,"
if anchor not in sync:
    raise SystemExit('corporate project update anchor not found')
sync = sync.replace(anchor, root_sync + "UPDATE target\nSET ProjectCode = source.ProjectCode,\n    ProjectName = source.ProjectName,", 1)
sync = sync.replace(
    "JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = target.ProjectCode",
    "JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = UPPER(target.ProjectCode)",
    1,
)
sync = sync.replace(
    "WHERE p.SourceType = 'CORPORATE' AND p.ProjectCode = source.ProjectCode",
    "WHERE p.SourceType = 'CORPORATE' AND UPPER(p.ProjectCode) = source.ProjectCode",
    1,
)
sync = sync.replace(
    "AND NOT EXISTS (SELECT 1 FROM dbo.MR_V_CorporateProjects source WHERE source.ProjectCode = p.ProjectCode);",
    "AND NOT EXISTS (SELECT 1 FROM dbo.MR_V_CorporateProjects source WHERE source.ProjectCode = UPPER(p.ProjectCode));",
    1,
)
write(sync_path, sync)
print('patched: corporate sync canonicalization and root WBS rename')

# P2: canonical source project codes and deterministic HR02 duplicate selection.
sql_path = 'database/MR_Create_Durable_Persistence.sql'
sql = read(sql_path)
sql = sql.replace(
    "NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''') AS ProjectCode,",
    "UPPER(NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectCode,",
    1,
)
# Canonicalize all HR09 project-code projections inside the corporate access view.
start = sql.index("EXEC(N'CREATE VIEW dbo.MR_V_CorporateProjectAccess AS")
end = sql.index("EXEC(N'CREATE VIEW dbo.MR_V_PeopleDirectory AS", start)
access_view = sql[start:end]
access_view = access_view.replace(
    "NULLIF(LTRIM(RTRIM(projeKodu)), N'''') AS ProjectCode",
    "UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')) AS ProjectCode",
)
access_view = access_view.replace(
    "NULLIF(LTRIM(RTRIM(projeKodu)), N'''')",
    "UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N''''))",
)
sql = sql[:start] + access_view + sql[end:]
old_rank = """                   ROW_NUMBER() OVER (PARTITION BY sicil ORDER BY CASE WHEN NULLIF(LTRIM(RTRIM(birim)), N'''') IS NULL THEN 1 ELSE 0 END, kullanici_adi, ad_soyad) AS rn
"""
new_rank = """                   ROW_NUMBER() OVER (
                       PARTITION BY sicil
                       ORDER BY CASE WHEN NULLIF(LTRIM(RTRIM(birim)), N'''') IS NULL THEN 1 ELSE 0 END,
                                COALESCE(LTRIM(RTRIM(kullanici_adi)), N''''),
                                COALESCE(LTRIM(RTRIM(ad_soyad)), N''''),
                                COALESCE(LTRIM(RTRIM(unvan)), N''''),
                                COALESCE(LTRIM(RTRIM(sektor)), N''''),
                                COALESCE(LTRIM(RTRIM(direktorluk)), N''''),
                                COALESCE(LTRIM(RTRIM(mudurluk)), N''''),
                                COALESCE(LTRIM(RTRIM(birim)), N'''')
                   ) AS rn
"""
if old_rank not in sql:
    raise SystemExit('people-directory ranking expression not found')
sql = sql.replace(old_rank, new_rank, 1)
write(sql_path, sql)
print('patched: canonical source ProjectCode and deterministic HR02 ranking')

# Regression coverage for all five findings.
test_path = 'test/codex-p2-regressions.test.mjs'
tests = read(test_path)
import_anchor = "import { parseDevelopmentSicil } from '../src/server/identity/parseDevelopmentSicil.js';\n"
if "deriveEffectiveAccess" not in tests:
    tests = tests.replace(
        import_anchor,
        import_anchor + "import { ACCESS_REASONS, deriveEffectiveAccess } from '../src/server/authorization/authorization.js';\n",
        1,
    )
# Strengthen the existing identity regression with SQL int boundaries.
tests = tests.replace(
    "  assert.equal(parseDevelopmentSicil(' 18068 '), 18068);\n",
    "  assert.equal(parseDevelopmentSicil(' 18068 '), 18068);\n  assert.equal(parseDevelopmentSicil('2147483647'), 2147483647);\n  assert.equal(parseDevelopmentSicil('2147483648'), null);\n",
    1,
)
additions = r'''

test('ProjectCode is canonicalized across manual writes, corporate sources, sync, and access joins', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /String\(project\.code\)\.trim\(\)\.toUpperCase\(\)/);
  assert.match(repository, /WHERE UPPER\(reserved\.ProjectCode\) = @projectCode/);
  assert.match(repository, /a\.ProjectCode = UPPER\(p\.ProjectCode\)/);

  const sync = read('src/server/repository/corporateQueries.js');
  assert.match(sync, /source\.ProjectCode = UPPER\(manual\.ProjectCode\)/);
  assert.match(sync, /SET ProjectCode = source\.ProjectCode/);
  assert.match(sync, /UPPER\(p\.ProjectCode\) = source\.ProjectCode/);

  const createSql = read('database/MR_Create_Durable_Persistence.sql');
  assert.match(createSql, /UPPER\(NULLIF\(LTRIM\(RTRIM\(ProjeKodu\)\)/i);
  const accessView = createSql.match(/CREATE VIEW dbo\.MR_V_CorporateProjectAccess AS([\s\S]*?);'\);/i)?.[0] || '';
  assert.match(accessView, /UPPER\(NULLIF\(LTRIM\(RTRIM\(projeKodu\)\)/i);
});

test('corporate sync updates the single default root WBS only while it tracks the prior project name or code', () => {
  const sync = read('src/server/repository/corporateQueries.js');
  const rootUpdate = sync.slice(sync.indexOf('UPDATE root'), sync.indexOf('UPDATE target'));
  assert.match(rootUpdate, /root\.ParentWbsId IS NULL/);
  assert.match(rootUpdate, /root\.Name = target\.ProjectName OR root\.Name = target\.ProjectCode/);
  assert.match(rootUpdate, /SELECT COUNT\(\*\) FROM dbo\.MR_WBS roots/);
  assert.match(rootUpdate, /SET Name = source\.ProjectName/);
});

test('project-level READ grants appear as PARTIAL session access while FULL access still wins', () => {
  const effective = deriveEffectiveAccess({
    isSystemAdmin: false,
    fullProjectIds: ['full-project'],
    partialProjectRows: [
      { projectId: 'read-project', reason: ACCESS_REASONS.MANUAL_GRANT },
      { projectId: 'full-project', reason: ACCESS_REASONS.MANUAL_GRANT }
    ],
    partialTaskRows: []
  });
  assert.equal(effective.access.get('read-project')?.accessLevel, 'PARTIAL');
  assert.equal(effective.access.get('full-project')?.accessLevel, 'FULL');

  const context = read('src/server/authorization/loadAuthorizationContext.js');
  assert.match(context, /pa\.AccessLevel IN \('FULL', 'READ'\)/);
  assert.match(context, /partialProjectRows/);
  assert.match(context, /row\.AccessLevel === 'READ'/);
});

test('HR02 people directory duplicate ranking has deterministic projected-field tie breakers', () => {
  const source = read('database/MR_Create_Durable_Persistence.sql');
  const view = source.match(/CREATE VIEW dbo\.MR_V_PeopleDirectory AS([\s\S]*?);'\);/i)?.[0] || '';
  const order = view.match(/ROW_NUMBER\(\) OVER \([\s\S]*?\) AS rn/i)?.[0] || '';
  for (const field of ['kullanici_adi', 'ad_soyad', 'unvan', 'sektor', 'direktorluk', 'mudurluk', 'birim']) {
    assert.match(order, new RegExp(field, 'i'));
  }
});
'''
if "ProjectCode is canonicalized across manual writes" not in tests:
    tests += additions
write(test_path, tests)
print('patched: fifth Codex regression coverage')
