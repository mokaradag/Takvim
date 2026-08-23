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

    IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_MR_Tasks_RecurrenceParent')
        ALTER TABLE dbo.MR_Tasks ADD CONSTRAINT FK_MR_Tasks_RecurrenceParent
            FOREIGN KEY (RecurrenceParentTaskId) REFERENCES dbo.MR_Tasks(TaskId);

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
