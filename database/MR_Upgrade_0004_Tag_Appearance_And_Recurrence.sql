SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
    MERGEN Rota — 0004 yukseltme gocu.

    Temiz kurulum betigi (MR_Create_Durable_Persistence.sql) herhangi bir MR_*
    nesnesi varsa bilerek durur. Dolayisiyla MEVCUT bir kalici veritabani yeni
    sutunlari o betikten ALAMAZ: uygulama yeni surume gectiginde etiket
    gorunumu ve tekrar alanlarini hemen okuyup yazdigi icin "invalid column"
    hatalari alinirdi. Bu betik ayni semayi yerinde, YINELENEBILIR bicimde
    uygular: birden cok kez calistirilabilir, veri donusumu gerektirmez ve
    varsayilan davranisi degistirmez (tum yeni sutunlar NULL kabul eder).

    Calistirma sirasi: uygulama surumu dagitilmadan ONCE.
*/

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51000, 'MERGEN Rota durable schema was not found. Run MR_Create_Durable_Persistence.sql first.', 1;

    -- 1. Etiket gorunumu: renk ve simge anahtarlari.
    IF COL_LENGTH(N'dbo.MR_ProjectTags', N'ColorToken') IS NULL
        ALTER TABLE dbo.MR_ProjectTags ADD ColorToken varchar(20) NULL;
    IF COL_LENGTH(N'dbo.MR_ProjectTags', N'IconKey') IS NULL
        ALTER TABLE dbo.MR_ProjectTags ADD IconKey varchar(40) NULL;

    -- 2. Tekrarlayan gorev alanlari.
    IF COL_LENGTH(N'dbo.MR_Tasks', N'RecurrenceRule') IS NULL
        ALTER TABLE dbo.MR_Tasks ADD RecurrenceRule nvarchar(400) NULL;
    IF COL_LENGTH(N'dbo.MR_Tasks', N'RecurrenceParentTaskId') IS NULL
        ALTER TABLE dbo.MR_Tasks ADD RecurrenceParentTaskId uniqueidentifier NULL;
    IF COL_LENGTH(N'dbo.MR_Tasks', N'RecurrenceOccurrenceDate') IS NULL
        ALTER TABLE dbo.MR_Tasks ADD RecurrenceOccurrenceDate date NULL;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

IF XACT_STATE() <> 0 COMMIT TRANSACTION;
GO

/* Kisitlar ve dizinler yeni sutunlar derlendikten SONRA eklenir. */
BEGIN TRY
    BEGIN TRANSACTION;

    /* GO bir ISTEMCI toplu is ayracidir, islem siniri DEGILDIR: sqlcmd ve SSMS,
       -b verilmedikce ilk toplu is hata verse bile bir sonrakini calistirir.
       Bu toplu is bu yuzden kendi on kosulunu dogrular; aksi halde birinci
       toplu isin hatasi, hic olusmamis nesnelere karsi ikinci ve alakasiz bir
       hata daha uretiyordu. */
    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51000, 'MERGEN Rota durable schema was not found. Run MR_Create_Durable_Persistence.sql first.', 1;

    IF COL_LENGTH(N'dbo.MR_Tasks', N'RecurrenceParentTaskId') IS NULL
        OR COL_LENGTH(N'dbo.MR_Tasks', N'RecurrenceOccurrenceDate') IS NULL
        THROW 51001, 'Recurrence columns are missing. The first batch of MR_Upgrade_0004 did not complete.', 1;

    /* Benzersiz dizin, ONCEDEN olusmus yinelenen yinelemelerde basarisiz olur.
       SQL Server iletisi yalnizca dizini adlandirir; catisan satirlar burada
       acikca bildirilir ki operator duzeltebilsin. */
    IF EXISTS (
        SELECT 1
        FROM dbo.MR_Tasks
        WHERE RecurrenceParentTaskId IS NOT NULL AND RecurrenceOccurrenceDate IS NOT NULL
        GROUP BY RecurrenceParentTaskId, RecurrenceOccurrenceDate
        HAVING COUNT(*) > 1
    )
    BEGIN
        DECLARE @conflicts nvarchar(max) = (
            SELECT STRING_AGG(CONVERT(nvarchar(100), RecurrenceParentTaskId)
                + N' @ ' + CONVERT(nvarchar(10), RecurrenceOccurrenceDate, 23), N', ')
            FROM (
                SELECT RecurrenceParentTaskId, RecurrenceOccurrenceDate
                FROM dbo.MR_Tasks
                WHERE RecurrenceParentTaskId IS NOT NULL AND RecurrenceOccurrenceDate IS NOT NULL
                GROUP BY RecurrenceParentTaskId, RecurrenceOccurrenceDate
                HAVING COUNT(*) > 1
            ) duplicates
        );
        DECLARE @conflictMessage nvarchar(2048) =
            N'Duplicate recurrence occurrences block UX_MR_Tasks_RecurrenceOccurrence: '
            + ISNULL(@conflicts, N'(unknown)');
        THROW 51002, @conflictMessage, 1;
    END;

    -- Yineleme sablonu AYNI projede olmalidir (bkz. MR_Create_Durable_Persistence.sql).
    -- Yalnizca TaskId'ye bakan eski yabanci anahtar varsa birakilir ve yerine
    -- bilesik anahtar konur; once cakisan satirlar RAPORLANIR ki kisitlama
    -- eklenirken cikan hata anlasilmaz olmasin.
    IF EXISTS (
        SELECT 1
        FROM dbo.MR_Tasks child
        JOIN dbo.MR_Tasks parent ON parent.TaskId = child.RecurrenceParentTaskId
        WHERE child.RecurrenceParentTaskId IS NOT NULL
          AND parent.ProjectId <> child.ProjectId
    )
    BEGIN
        DECLARE @crossProject nvarchar(2000) = (
            SELECT STRING_AGG(CONVERT(nvarchar(60), child.TaskId), N', ')
            FROM (
                SELECT TOP (25) child.TaskId
                FROM dbo.MR_Tasks child
                JOIN dbo.MR_Tasks parent ON parent.TaskId = child.RecurrenceParentTaskId
                WHERE child.RecurrenceParentTaskId IS NOT NULL
                  AND parent.ProjectId <> child.ProjectId
                ORDER BY child.TaskId
            ) child
        );
        DECLARE @crossProjectMessage nvarchar(2048) =
            N'Cross-project recurrence parents block FK_MR_Tasks_RecurrenceParent: '
            + ISNULL(@crossProject, N'(unknown)');
        THROW 51003, @crossProjectMessage, 1;
    END;

    IF EXISTS (
        SELECT 1
        FROM sys.foreign_keys fk
        WHERE fk.name = N'FK_MR_Tasks_RecurrenceParent'
          AND (SELECT COUNT(*) FROM sys.foreign_key_columns c WHERE c.constraint_object_id = fk.object_id) = 1
    )
        ALTER TABLE dbo.MR_Tasks DROP CONSTRAINT FK_MR_Tasks_RecurrenceParent;

    IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UX_MR_Tasks_Id_Project')
        ALTER TABLE dbo.MR_Tasks ADD CONSTRAINT UX_MR_Tasks_Id_Project UNIQUE (TaskId, ProjectId);

    IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MR_Tasks_RecurrenceParent')
        ALTER TABLE dbo.MR_Tasks ADD CONSTRAINT FK_MR_Tasks_RecurrenceParent
            FOREIGN KEY (RecurrenceParentTaskId, ProjectId) REFERENCES dbo.MR_Tasks(TaskId, ProjectId);

    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_MR_Tasks_Recurrence')
        ALTER TABLE dbo.MR_Tasks ADD CONSTRAINT CK_MR_Tasks_Recurrence
            CHECK (RecurrenceParentTaskId IS NULL OR RecurrenceRule IS NULL);

    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_MR_Tasks_RecurrenceOccurrence')
        ALTER TABLE dbo.MR_Tasks ADD CONSTRAINT CK_MR_Tasks_RecurrenceOccurrence
            CHECK (RecurrenceOccurrenceDate IS NULL OR RecurrenceParentTaskId IS NOT NULL);

    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_MR_Tasks_RecurrenceSelf')
        ALTER TABLE dbo.MR_Tasks ADD CONSTRAINT CK_MR_Tasks_RecurrenceSelf
            CHECK (RecurrenceParentTaskId IS NULL OR RecurrenceParentTaskId <> TaskId);

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MR_Tasks_RecurrenceParent' AND object_id = OBJECT_ID(N'dbo.MR_Tasks'))
        CREATE INDEX IX_MR_Tasks_RecurrenceParent ON dbo.MR_Tasks(RecurrenceParentTaskId)
            WHERE RecurrenceParentTaskId IS NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_MR_Tasks_RecurrenceOccurrence' AND object_id = OBJECT_ID(N'dbo.MR_Tasks'))
        CREATE UNIQUE INDEX UX_MR_Tasks_RecurrenceOccurrence
            ON dbo.MR_Tasks(RecurrenceParentTaskId, RecurrenceOccurrenceDate)
            WHERE RecurrenceParentTaskId IS NOT NULL AND RecurrenceOccurrenceDate IS NOT NULL;

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0004_tag_appearance_and_recurrence')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0004_tag_appearance_and_recurrence', N'Project tag colour/icon columns and recurring task definition columns');
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

IF XACT_STATE() <> 0 COMMIT TRANSACTION;
