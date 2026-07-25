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

IF EXISTS (
  SELECT 1
  FROM dbo.MR_Projects manual WITH (UPDLOCK, HOLDLOCK)
  JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = UPPER(manual.ProjectCode)
  WHERE manual.SourceType = 'MANUAL'
)
  THROW 51002, 'A manual project code conflicts with the corporate project source.', 1;

IF NOT EXISTS (
  SELECT 1
  FROM dbo.MR_Calendars WITH (UPDLOCK, HOLDLOCK)
  WHERE IsDefault = 1 AND IsActive = 1
)
  THROW 51003, 'An active default calendar is required before corporate project synchronization.', 1;

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

UPDATE target
SET ProjectCode = source.ProjectCode,
    ProjectName = source.ProjectName,
    ProjectTypeCode = source.ProjectTypeCode,
    ProjectTypeName = source.ProjectTypeName,
    LeadSicil = manager.Sicil,
    IsActive = 1,
    UpdatedAt = SYSUTCDATETIME(),
    UpdatedBySicil = @actorSicil
FROM dbo.MR_Projects target
JOIN dbo.MR_V_CorporateProjects source ON source.ProjectCode = UPPER(target.ProjectCode)
OUTER APPLY (
  SELECT TOP (1) access.Sicil
  FROM dbo.MR_V_CorporateProjectAccess access
  WHERE access.ProjectCode = source.ProjectCode
    AND access.RoleCode = 'PROJECT_MANAGER'
  ORDER BY access.Sicil
) manager
WHERE target.SourceType = 'CORPORATE'
  AND (
    ISNULL(target.ProjectName, N'') <> ISNULL(source.ProjectName, N'') OR
    ISNULL(target.ProjectTypeCode, N'') <> ISNULL(source.ProjectTypeCode, N'') OR
    ISNULL(target.ProjectTypeName, N'') <> ISNULL(source.ProjectTypeName, N'') OR
    ISNULL(target.LeadSicil, -1) <> ISNULL(manager.Sicil, -1) OR
    target.IsActive = 0
  );

DECLARE @Inserted TABLE(ProjectId uniqueidentifier, ProjectCode nvarchar(255), ProjectName nvarchar(1000));
INSERT dbo.MR_Projects(
  SourceType, ProjectCode, ProjectName, ProjectTypeCode, ProjectTypeName,
  LeadSicil, CalendarId, CreatedBySicil, UpdatedBySicil
)
OUTPUT inserted.ProjectId, inserted.ProjectCode, inserted.ProjectName INTO @Inserted
SELECT
  'CORPORATE', source.ProjectCode, source.ProjectName, source.ProjectTypeCode, source.ProjectTypeName,
  manager.Sicil, calendar.CalendarId, @actorSicil, @actorSicil
FROM dbo.MR_V_CorporateProjects source
CROSS APPLY (
  SELECT TOP (1) CalendarId
  FROM dbo.MR_Calendars
  WHERE IsDefault = 1 AND IsActive = 1
  ORDER BY CreatedAt
) calendar
OUTER APPLY (
  SELECT TOP (1) access.Sicil
  FROM dbo.MR_V_CorporateProjectAccess access
  WHERE access.ProjectCode = source.ProjectCode
    AND access.RoleCode = 'PROJECT_MANAGER'
  ORDER BY access.Sicil
) manager
WHERE NOT EXISTS (
  SELECT 1
  FROM dbo.MR_Projects p WITH (UPDLOCK, HOLDLOCK)
  WHERE p.SourceType = 'CORPORATE' AND UPPER(p.ProjectCode) = source.ProjectCode
);

-- Kurumsal projenin kök düğümü proje kodunu taşır. CN43N eşitlemesi kök düğümün
-- altına gerçek WBS elemanlarını (WBS element kodlarıyla) ekler; kök kodun proje
-- kodu olması, kaynaktan gelen eleman kodlarıyla çakışmasını da engeller.
INSERT dbo.MR_WBS(ProjectId, ParentWbsId, Code, Name, SortOrder, SourceType, CreatedBySicil, UpdatedBySicil)
SELECT ProjectId, NULL, LEFT(ProjectCode, 100), ProjectName, 0, 'CORPORATE', @actorSicil, @actorSicil
FROM @Inserted;

UPDATE p
SET IsActive = 0, UpdatedAt = SYSUTCDATETIME(), UpdatedBySicil = @actorSicil
FROM dbo.MR_Projects p
WHERE p.SourceType = 'CORPORATE'
  AND p.IsActive = 1
  AND NOT EXISTS (SELECT 1 FROM dbo.MR_V_CorporateProjects source WHERE source.ProjectCode = UPPER(p.ProjectCode));
`;
