SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.HR09_projeSorumlu', N'U') IS NULL
        THROW 51000, 'Required source table dbo.HR09_projeSorumlu was not found.', 1;

    -- PPTS rol kodunu düzeltir ve kurumsal proje sorumlusunu PROJECT_MANAGER kaynağına bağlar.
    EXEC(N'CREATE OR ALTER VIEW dbo.MR_V_CorporateProjectAccess AS
        SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')) AS ProjectCode, projeYoneticisiSicil AS Sicil, CAST(''PROJECT_MANAGER'' AS varchar(50)) AS RoleCode, programMdl AS ProgramMd FROM dbo.HR09_projeSorumlu WHERE projeYoneticisiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), teknikYoneticiSicil, ''TECHNICAL_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE teknikYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), kaliteYoneticiSicil, ''QUALITY_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE kaliteYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), tedarikSorumlusuSicil, ''PROCUREMENT_RESPONSIBLE'', programMdl FROM dbo.HR09_projeSorumlu WHERE tedarikSorumlusuSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), TRY_CONVERT(int, LTRIM(RTRIM(value))), ''PPTS'', programMdl FROM dbo.HR09_projeSorumlu CROSS APPLY STRING_SPLIT(pptsSicil, '','') WHERE TRY_CONVERT(int, LTRIM(RTRIM(value))) IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), uretimPlanlamaSorumlusuSicil, ''PRODUCTION_PLANNING_RESPONSIBLE'', programMdl FROM dbo.HR09_projeSorumlu WHERE uretimPlanlamaSorumlusuSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), teslimatYoneticiSicil, ''DELIVERY_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE teslimatYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), riskYoneticiSicil, ''RISK_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE riskYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), konfigYoneticiSicil, ''CONFIGURATION_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE konfigYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), eldYoneticisiSicil, ''LOGISTICS_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE eldYoneticisiSicil IS NOT NULL;');

    -- Var olan kurumsal projelerde proje sorumlusunu kurumsal rol kaynağından yeniler.
    UPDATE project
    SET LeadSicil = manager.Sicil,
        UpdatedAt = SYSUTCDATETIME()
    FROM dbo.MR_Projects project
    OUTER APPLY (
        SELECT TOP (1) access.Sicil
        FROM dbo.MR_V_CorporateProjectAccess access
        WHERE access.ProjectCode = UPPER(project.ProjectCode)
          AND access.RoleCode = 'PROJECT_MANAGER'
        ORDER BY access.Sicil
    ) manager
    WHERE project.SourceType = 'CORPORATE'
      AND ISNULL(project.LeadSicil, -1) <> ISNULL(manager.Sicil, -1);

    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0002_project_portfolio_scaling')
    BEGIN
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0002_project_portfolio_scaling', N'Project type portfolio UX, PPTS role correction and authoritative project managers');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
