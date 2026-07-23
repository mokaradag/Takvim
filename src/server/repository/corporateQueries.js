import 'server-only';

export const CORPORATE_PROJECTS_SQL = `
SELECT ProjectTypeCode, ProjectTypeName, ProjectCode, ProjectName
FROM dbo.MR_V_CorporateProjects
ORDER BY ProjectCode;`;

export const PEOPLE_DIRECTORY_SQL = `
SELECT Sicil, DisplayName, Username, JobTitle, Team, Sector, Directorate, Department, Unit
FROM dbo.MR_V_PeopleDirectory
ORDER BY DisplayName, Sicil;`;

export const CORPORATE_PROJECT_ACCESS_SQL = `
SELECT DISTINCT ProjectCode, Sicil, RoleCode, ProgramMd
FROM dbo.MR_V_CorporateProjectAccess
WHERE Sicil = @sicil;`;

export const EXECUTIVE_SCOPE_SQL = `
SELECT DISTINCT EmployeeSicil, ScopeType
FROM dbo.MR_V_ExecutiveScope
WHERE ManagerSicil = @sicil;`;

export const CORPORATE_PROJECT_SYNC_SQL = `
SET XACT_ABORT ON;

IF EXISTS (
  SELECT ProjectCode
  FROM dbo.MR_V_CorporateProjects
  GROUP BY ProjectCode
  HAVING COUNT(*) > 1
)
  THROW 51001, 'Corporate project source contains conflicting rows for the same ProjeKodu.', 1;

UPDATE target
SET ProjectName = source.ProjectName,
    ProjectTypeCode = source.ProjectTypeCode,
    ProjectTypeName = source.ProjectTypeName,
    IsActive = 1,
    UpdatedAt = SYSUTCDATETIME(),
    UpdatedBySicil = @actorSicil
FROM dbo.MR_Projects target
JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = target.ProjectCode
WHERE target.SourceType = 'CORPORATE'
  AND (
    ISNULL(target.ProjectName, N'') <> ISNULL(source.ProjectName, N'') OR
    ISNULL(target.ProjectTypeCode, N'') <> ISNULL(source.ProjectTypeCode, N'') OR
    ISNULL(target.ProjectTypeName, N'') <> ISNULL(source.ProjectTypeName, N'') OR
    target.IsActive = 0
  );

DECLARE @Inserted TABLE(ProjectId uniqueidentifier, ProjectCode nvarchar(255), ProjectName nvarchar(1000));
INSERT dbo.MR_Projects(SourceType, ProjectCode, ProjectName, ProjectTypeCode, ProjectTypeName, CalendarId, CreatedBySicil, UpdatedBySicil)
OUTPUT inserted.ProjectId, inserted.ProjectCode, inserted.ProjectName INTO @Inserted
SELECT 'CORPORATE', source.ProjectCode, source.ProjectName, source.ProjectTypeCode, source.ProjectTypeName, calendar.CalendarId, @actorSicil, @actorSicil
FROM dbo.MR_V_CorporateProjects source
CROSS APPLY (SELECT TOP (1) CalendarId FROM dbo.MR_Calendars WHERE IsDefault = 1 AND IsActive = 1 ORDER BY CreatedAt) calendar
WHERE NOT EXISTS (SELECT 1 FROM dbo.MR_Projects p WHERE p.ProjectCode = source.ProjectCode);

INSERT dbo.MR_WBS(ProjectId, ParentWbsId, Code, Name, SortOrder, CreatedBySicil, UpdatedBySicil)
SELECT ProjectId, NULL, N'1', ProjectName, 0, @actorSicil, @actorSicil
FROM @Inserted;

UPDATE p
SET IsActive = 0, UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
FROM dbo.MR_Projects p
WHERE p.SourceType = 'CORPORATE'
  AND p.IsActive = 1
  AND NOT EXISTS (SELECT 1 FROM dbo.MR_V_CorporateProjects source WHERE source.ProjectCode = p.ProjectCode);
`;
