SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

/*
    MERGEN Rota · 0013 — CN43N başarılı eşitleme turu tazeliği.

    Proje bazlı MR_CorporateWbsSyncState.SyncedAt içerik değişikliği zamanıdır.
    Başarılı tam CN43N turu ayrı ve kalıcı bir tekil durumda tutulur.
    Betik yinelenebilir; 0012 uygulandıktan sonra çalıştırılır.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51013, 'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1
        FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0012_system_observability'
    )
        THROW 51013, 'Önce 0012_system_observability göçünü uygulayın.', 1;

    IF OBJECT_ID(N'dbo.MR_CorporateWbsSyncRunState', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_CorporateWbsSyncRunState (
            StateId tinyint NOT NULL,
            LastSuccessfulSyncAt datetime2(3) NOT NULL,
            ProjectCount int NOT NULL,
            NodeCount bigint NOT NULL,
            MergedProjectCount int NOT NULL,
            SkippedProjectCount int NOT NULL,
            UpdatedBySicil int NULL,
            CONSTRAINT PK_MR_CorporateWbsSyncRunState PRIMARY KEY (StateId),
            CONSTRAINT CK_MR_CorporateWbsSyncRunState_StateId CHECK (StateId = 1),
            CONSTRAINT CK_MR_CorporateWbsSyncRunState_Counts CHECK (
                ProjectCount >= 0
                AND NodeCount >= 0
                AND MergedProjectCount >= 0
                AND SkippedProjectCount >= 0
                AND MergedProjectCount + SkippedProjectCount <= ProjectCount
            )
        );
    END;

    DECLARE @RequiredColumns TABLE (
        ColumnName sysname,
        TypeName sysname,
        IsNullable bit,
        Scale tinyint NULL
    );
    INSERT @RequiredColumns(ColumnName, TypeName, IsNullable, Scale) VALUES
        (N'StateId', N'tinyint', 0, NULL),
        (N'LastSuccessfulSyncAt', N'datetime2', 0, 3),
        (N'ProjectCount', N'int', 0, NULL),
        (N'NodeCount', N'bigint', 0, NULL),
        (N'MergedProjectCount', N'int', 0, NULL),
        (N'SkippedProjectCount', N'int', 0, NULL),
        (N'UpdatedBySicil', N'int', 1, NULL);

    IF EXISTS (
        SELECT 1
        FROM @RequiredColumns r
        LEFT JOIN sys.columns c
          ON c.object_id = OBJECT_ID(N'dbo.MR_CorporateWbsSyncRunState', N'U')
         AND c.name = r.ColumnName
        LEFT JOIN sys.types t ON t.user_type_id = c.user_type_id
        WHERE c.column_id IS NULL
           OR t.name <> r.TypeName
           OR c.is_nullable <> r.IsNullable
           OR (r.Scale IS NOT NULL AND c.scale <> r.Scale)
    )
        THROW 51013, '0013: MR_CorporateWbsSyncRunState sütunları eksik veya uyumsuz.', 1;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.key_constraints k
        JOIN sys.index_columns ic
          ON ic.object_id = k.parent_object_id
         AND ic.index_id = k.unique_index_id
         AND ic.key_ordinal = 1
        JOIN sys.columns c
          ON c.object_id = ic.object_id
         AND c.column_id = ic.column_id
        WHERE k.parent_object_id = OBJECT_ID(N'dbo.MR_CorporateWbsSyncRunState', N'U')
          AND k.type = 'PK'
          AND k.name = N'PK_MR_CorporateWbsSyncRunState'
          AND c.name = N'StateId'
    )
        THROW 51013, '0013: MR_CorporateWbsSyncRunState birincil anahtarı eksik veya uyumsuz.', 1;

    IF EXISTS (
        SELECT required.ConstraintName
        FROM (VALUES
            (N'CK_MR_CorporateWbsSyncRunState_StateId'),
            (N'CK_MR_CorporateWbsSyncRunState_Counts')
        ) required(ConstraintName)
        LEFT JOIN sys.check_constraints c
          ON c.parent_object_id = OBJECT_ID(N'dbo.MR_CorporateWbsSyncRunState', N'U')
         AND c.name = required.ConstraintName
        WHERE c.object_id IS NULL OR c.is_disabled = 1 OR c.is_not_trusted = 1
    )
        THROW 51013, '0013: MR_CorporateWbsSyncRunState doğrulama kısıtları eksik veya güvenilmez.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0013_corporate_wbs_sync_freshness'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (
            N'0013_corporate_wbs_sync_freshness',
            N'CN43N başarılı tur tazeliği ile WBS içerik değişikliği zamanını ayırır'
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
