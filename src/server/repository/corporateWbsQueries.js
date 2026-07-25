import 'server-only';

/**
 * CN43N satırlarını proje kodu listesine göre okuyan sorguyu üretir.
 * Şema ve tablo adı yapılandırmadan gelir ve `corporateWbsConfig` içinde
 * sade tanımlayıcı olarak doğrulanır; kod listesi her zaman parametreleştirilir.
 */
export function buildCorporateWbsSourceQuery({ schema, table }, projectCodeCount) {
  const parameters = Array.from({ length: projectCodeCount }, (unused, index) => `@code${index}`).join(', ');
  return `
    SELECT
      LTRIM(RTRIM([Proje tanımı])) AS ProjectCode,
      LTRIM(RTRIM([WBS element])) AS WbsElement,
      LTRIM(RTRIM([Name])) AS Name,
      [Level] AS WbsLevel,
      LTRIM(RTRIM([Status])) AS StatusCode,
      LTRIM(RTRIM([PYP kodu])) AS OutlineCode,
      LTRIM(RTRIM([Proj.type])) AS ElementTypeCode
    FROM [${schema}].[${table}]
    WHERE NULLIF(LTRIM(RTRIM([WBS element])), '') IS NOT NULL
      AND UPPER(LTRIM(RTRIM([Proje tanımı]))) IN (${parameters})
    ORDER BY [Proje tanımı], [Level], [PYP kodu], [WBS element];`;
}

export const CORPORATE_PROJECT_CODES_SQL = `
SELECT ProjectId, ProjectCode, ProjectName
FROM dbo.MR_Projects
WHERE SourceType = 'CORPORATE' AND IsActive = 1 AND NULLIF(LTRIM(RTRIM(ProjectCode)), N'') IS NOT NULL
ORDER BY ProjectCode;`;

/**
 * Tek bir kurumsal projenin CN43N kaynaklı düğümlerini MR_WBS ile eşitler.
 *
 * Eşitleme yalnızca `SourceType = 'CORPORATE'` satırlarına dokunur:
 *   - kök düğüm (SourceKey NULL) MERGEN Rota tarafından üretilir ve korunur,
 *   - yeni elemanlar eklenir, adı/durumu değişenler güncellenir,
 *   - kaynakta kalmayan elemanlar yalnızca alt düğüm ve görev bağı yoksa silinir.
 * Üst bağlar ikinci geçişte kurulur; böylece aynı toplu işte eklenen üst
 * düğümler de çözülebilir.
 */
export const CORPORATE_WBS_MERGE_SQL = `
SET XACT_ABORT ON;

DECLARE @Source TABLE(
  SourceKey nvarchar(255) NOT NULL PRIMARY KEY,
  Name nvarchar(1000) NOT NULL,
  WbsLevel int NULL,
  OutlineCode nvarchar(255) NULL,
  StatusCode nvarchar(100) NULL,
  ElementTypeCode nvarchar(10) NULL,
  ParentSourceKey nvarchar(255) NULL,
  SortOrder int NULL
);

INSERT @Source(SourceKey, Name, WbsLevel, OutlineCode, StatusCode, ElementTypeCode, ParentSourceKey, SortOrder)
SELECT payload.SourceKey, payload.Name, payload.WbsLevel, payload.OutlineCode,
       payload.StatusCode, payload.ElementTypeCode, payload.ParentSourceKey, payload.SortOrder
FROM OPENJSON(@payload) WITH (
  SourceKey nvarchar(255) '$.sourceKey',
  Name nvarchar(1000) '$.name',
  WbsLevel int '$.level',
  OutlineCode nvarchar(255) '$.outlineCode',
  StatusCode nvarchar(100) '$.statusCode',
  ElementTypeCode nvarchar(10) '$.elementTypeCode',
  ParentSourceKey nvarchar(255) '$.parentSourceKey',
  SortOrder int '$.sortOrder'
) payload;

DECLARE @RootWbsId uniqueidentifier = (
  SELECT TOP (1) WbsId
  FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK)
  WHERE ProjectId = @projectId AND ParentWbsId IS NULL
  ORDER BY SortOrder, Code
);

IF @RootWbsId IS NULL
BEGIN
  SET @RootWbsId = NEWID();
  INSERT dbo.MR_WBS(WbsId, ProjectId, ParentWbsId, Code, Name, SortOrder, SourceType, CreatedBySicil, UpdatedBySicil)
  VALUES(@RootWbsId, @projectId, NULL, @projectCode, @projectName, 0, 'CORPORATE', @actorSicil, @actorSicil);
END;

UPDATE target
SET Name = source.Name,
    Code = source.SourceKey,
    WbsLevel = source.WbsLevel,
    OutlineCode = source.OutlineCode,
    StatusCode = source.StatusCode,
    ElementTypeCode = source.ElementTypeCode,
    SortOrder = source.SortOrder,
    UpdatedAt = SYSUTCDATETIME(),
    UpdatedBySicil = @actorSicil
FROM dbo.MR_WBS target
JOIN @Source source ON source.SourceKey = target.SourceKey
WHERE target.ProjectId = @projectId
  AND target.SourceType = 'CORPORATE'
  AND (
    ISNULL(target.Name, N'') <> ISNULL(source.Name, N'') OR
    ISNULL(target.Code, N'') <> ISNULL(source.SourceKey, N'') OR
    ISNULL(target.WbsLevel, -1) <> ISNULL(source.WbsLevel, -1) OR
    ISNULL(target.OutlineCode, N'') <> ISNULL(source.OutlineCode, N'') OR
    ISNULL(target.StatusCode, N'') <> ISNULL(source.StatusCode, N'') OR
    ISNULL(target.ElementTypeCode, N'') <> ISNULL(source.ElementTypeCode, N'') OR
    ISNULL(target.SortOrder, -1) <> ISNULL(source.SortOrder, -1)
  );

INSERT dbo.MR_WBS(
  WbsId, ProjectId, ParentWbsId, Code, Name, SortOrder,
  SourceType, SourceKey, OutlineCode, WbsLevel, StatusCode, ElementTypeCode,
  CreatedBySicil, UpdatedBySicil
)
SELECT NEWID(), @projectId, @RootWbsId, source.SourceKey, source.Name, source.SortOrder,
       'CORPORATE', source.SourceKey, source.OutlineCode, source.WbsLevel, source.StatusCode, source.ElementTypeCode,
       @actorSicil, @actorSicil
FROM @Source source
WHERE NOT EXISTS (
  SELECT 1 FROM dbo.MR_WBS existing
  WHERE existing.ProjectId = @projectId AND existing.SourceKey = source.SourceKey
);

UPDATE target
SET ParentWbsId = COALESCE(parent.WbsId, @RootWbsId),
    UpdatedAt = SYSUTCDATETIME(),
    UpdatedBySicil = @actorSicil
FROM dbo.MR_WBS target
JOIN @Source source ON source.SourceKey = target.SourceKey
LEFT JOIN dbo.MR_WBS parent
  ON parent.ProjectId = @projectId AND parent.SourceKey = source.ParentSourceKey
WHERE target.ProjectId = @projectId
  AND target.SourceType = 'CORPORATE'
  AND target.ParentWbsId <> COALESCE(parent.WbsId, @RootWbsId);

DELETE target
FROM dbo.MR_WBS target
WHERE target.ProjectId = @projectId
  AND target.SourceType = 'CORPORATE'
  AND target.SourceKey IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM @Source source WHERE source.SourceKey = target.SourceKey)
  AND NOT EXISTS (SELECT 1 FROM dbo.MR_WBS child WHERE child.ParentWbsId = target.WbsId)
  AND NOT EXISTS (SELECT 1 FROM dbo.MR_Tasks task WHERE task.WbsId = target.WbsId);
`;
