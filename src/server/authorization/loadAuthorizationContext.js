import 'server-only';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { getSqlPool, sql } from '../db/pool.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { ServerPersistenceError } from '../errors.js';
import { ACCESS_REASONS, deriveEffectiveAccess, hasTaskAssignmentScope } from './authorization.js';

// Yetki haritası kanonik (küçük harf) proje kimlikleriyle kurulur. Aksi hâlde
// SQL Server'ın büyük harfli GUID metni ile istemciden gelen kanonik kimlik
// eşleşmez ve yazma yetkisi olan kullanıcı "tam yazma yetkiniz yok" hatası alır.
function rowId(value) {
  return value == null ? null : (canonicalActualId(value) ?? String(value));
}

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

    SELECT p.ProjectId, CAST('FULL' AS varchar(20)) AS AccessLevel,
      CAST('SYSTEM_ADMIN' AS varchar(30)) AS Reason
    FROM dbo.MR_Projects p
    WHERE p.IsActive = 1
      AND EXISTS (
        SELECT 1
        FROM dbo.MR_UserRoles ur
        WHERE ur.Sicil = @sicil AND ur.RoleCode = 'SYSTEM_ADMIN' AND ur.IsActive = 1
      )
    UNION
    SELECT DISTINCT p.ProjectId, CAST('FULL' AS varchar(20)) AS AccessLevel,
      CAST('CORPORATE_PROJECT_ROLE' AS varchar(30)) AS Reason
    FROM dbo.MR_Projects p
    JOIN dbo.MR_V_CorporateProjectAccess a ON a.ProjectCode = UPPER(p.ProjectCode)
    WHERE p.SourceType = 'CORPORATE' AND p.IsActive = 1 AND a.Sicil = @sicil
    UNION
    SELECT p.ProjectId, CAST('FULL' AS varchar(20)) AS AccessLevel,
      CAST('MANUAL_PROJECT_LEAD' AS varchar(30)) AS Reason
    FROM dbo.MR_Projects p
    WHERE p.SourceType = 'MANUAL' AND p.IsActive = 1 AND p.LeadSicil = @sicil
    UNION
    SELECT pa.ProjectId, pa.AccessLevel,
      CASE WHEN pa.GrantSource = 'OWNER' THEN 'MANUAL_OWNER' ELSE 'MANUAL_GRANT' END
    FROM dbo.MR_ProjectAccess pa
    JOIN dbo.MR_Projects p ON p.ProjectId = pa.ProjectId
    WHERE p.IsActive = 1 AND pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel IN ('FULL', 'READ');

    SELECT DISTINCT t.ProjectId, t.TaskId,
      CASE WHEN ta.Sicil = @sicil THEN 'ASSIGNEE' ELSE 'EXECUTIVE_SCOPE' END AS Reason
    FROM dbo.MR_Tasks t
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
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
    .map((row) => ({ projectId: rowId(row.ProjectId), reason: ACCESS_REASONS.MANUAL_GRANT }));
  const partialRows = (result.recordsets[4] || []).map((row) => ({
    projectId: rowId(row.ProjectId),
    taskId: rowId(row.TaskId),
    reason: row.Reason === ACCESS_REASONS.ASSIGNEE ? ACCESS_REASONS.ASSIGNEE : ACCESS_REASONS.EXECUTIVE_SCOPE
  }));
  const effective = deriveEffectiveAccess({
    isSystemAdmin,
    fullProjectIds: fullRows.map((row) => rowId(row.ProjectId)),
    partialProjectRows,
    partialTaskRows: partialRows
  });

  const fullReasonsByProject = new Map();
  for (const row of fullRows) {
    const projectId = rowId(row.ProjectId);
    if (!fullReasonsByProject.has(projectId)) fullReasonsByProject.set(projectId, new Set());
    fullReasonsByProject.get(projectId).add(row.Reason);
  }
  for (const [projectId, reasons] of fullReasonsByProject) {
    effective.access.set(projectId, {
      projectId,
      accessLevel: 'FULL',
      reasons: [...reasons].sort()
    });
    effective.fullProjectIds.add(projectId);
  }

  return {
    sicil,
    currentUser: personFromRow(personRow),
    isSystemAdmin,
    isExecutive,
    canCreateProjects: isSystemAdmin || isExecutive,
    // Görev atama kapsamı: yöneticiler kendi personeline HERHANGİ bir etkin
    // CN43N projesi altında görev tanımlayabilir (bkz. authorization.js ·
    // hasTaskAssignmentScope). Görev görünürlüğü bundan etkilenmez.
    canAssignAllCorporateProjects: hasTaskAssignmentScope({ isSystemAdmin, isExecutive }),
    effective
  };
}
