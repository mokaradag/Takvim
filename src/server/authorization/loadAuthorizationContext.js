import 'server-only';
import { getSqlPool, sql } from '../db/pool.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { ServerPersistenceError } from '../errors.js';
import { ACCESS_REASONS, deriveEffectiveAccess } from './authorization.js';

function personFromRow(row) {
  return {
    id: String(row.Sicil),
    employeeNo: String(row.Sicil),
    name: row.DisplayName || String(row.Sicil),
    username: row.Username || null,
    role: row.JobTitle || '',
    team: row.Team || '',
    organization: {
      sector: row.Sector || null,
      directorate: row.Directorate || null,
      department: row.Department || null,
      unit: row.Unit || null
    },
    color: '#64748b'
  };
}

export async function loadAuthorizationContext(executor = null) {
  const sicil = await getTrustedCurrentSicil();
  const pool = executor || await getSqlPool();
  const request = pool.request();
  request.input('sicil', sql.Int, sicil);
  const result = await request.query(`
    SELECT TOP (1) Sicil, DisplayName, Username, JobTitle, Team, Sector, Directorate, Department, Unit
    FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil;

    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM dbo.MR_UserRoles
      WHERE Sicil = @sicil AND RoleCode = 'SYSTEM_ADMIN' AND IsActive = 1
    ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsSystemAdmin;

    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM dbo.MR_V_ExecutiveScope WHERE ManagerSicil = @sicil
    ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS IsExecutive;

    SELECT DISTINCT p.ProjectId, CAST('FULL' AS varchar(20)) AS AccessLevel,
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

    SELECT DISTINCT t.ProjectId, t.TaskId,
      CASE WHEN ta.Sicil = @sicil THEN 'ASSIGNEE' ELSE 'EXECUTIVE_SCOPE' END AS Reason
    FROM dbo.MR_Tasks t
    JOIN dbo.MR_TaskAssignees ta ON ta.TaskId = t.TaskId
    WHERE ta.Sicil = @sicil
       OR EXISTS (
         SELECT 1 FROM dbo.MR_V_ExecutiveScope es
         WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
       );
  `);

  const personRow = result.recordsets[0]?.[0];
  if (!personRow) throw new ServerPersistenceError('UNAUTHORIZED', 'Yapılandırılmış Sicil kurumsal personel kaynağında bulunamadı.');
  const isSystemAdmin = Boolean(result.recordsets[1]?.[0]?.IsSystemAdmin);
  const isExecutive = Boolean(result.recordsets[2]?.[0]?.IsExecutive);
  const grantRows = result.recordsets[3] || [];
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

  for (const row of fullRows) {
    const projectId = String(row.ProjectId);
    effective.access.set(projectId, {
      projectId,
      accessLevel: 'FULL',
      reasons: [row.Reason]
    });
    effective.fullProjectIds.add(projectId);
  }

  return {
    sicil,
    currentUser: personFromRow(personRow),
    isSystemAdmin,
    isExecutive,
    canCreateProjects: isSystemAdmin || isExecutive,
    effective
  };
}
