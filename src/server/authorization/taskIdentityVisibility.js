import 'server-only';

/** Canonical task-person identity policy; aliases are fixed application SQL. */
export function taskIdentityVisibleSql(person = 'candidate.Sicil') {
  return `(
    EXISTS (SELECT 1 FROM dbo.MR_UserRoles ur WHERE ur.Sicil = @sicil AND ur.RoleCode = 'SYSTEM_ADMIN' AND ur.IsActive = 1)
    OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
    OR EXISTS (SELECT 1 FROM dbo.MR_V_CorporateProjectAccess a
      WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil)
    OR EXISTS (SELECT 1 FROM dbo.MR_ProjectAccess pa
      WHERE pa.ProjectId = p.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1 AND pa.AccessLevel IN ('FULL', 'READ'))
    OR t.CreatedBySicil = @sicil
    OR ${person} = @sicil
    OR EXISTS (SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ${person})
  )`;
}
