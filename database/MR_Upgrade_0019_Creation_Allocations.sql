SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

-- Apply before deploying the server-issued creation-ID protocol. No entity or
-- personnel foreign keys: allocations precede entity creation and grant no access.
BEGIN TRY
    BEGIN TRANSACTION;
    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0018_ai_message_evidence')
        THROW 51019, 'Apply migration 0018 before 0019.', 1;
    IF OBJECT_ID(N'dbo.MR_CreationAllocations', N'U') IS NULL BEGIN
    CREATE TABLE dbo.MR_CreationAllocations (
        Proof uniqueidentifier NOT NULL,
        Sicil int NOT NULL,
        EntityType varchar(7) NOT NULL,
        EntityId uniqueidentifier NOT NULL,
        ProjectId uniqueidentifier NOT NULL,
        ExpiresAt datetime2(3) NOT NULL,
        CONSTRAINT PK_MR_CreationAllocations PRIMARY KEY (Proof),
        CONSTRAINT UQ_MR_CreationAllocations_Entity UNIQUE (EntityId),
        CONSTRAINT CK_MR_CreationAllocations_Type CHECK (EntityType IN ('PROJECT', 'WBS', 'TASK'))
    );
    CREATE INDEX IX_MR_CreationAllocations_Owner ON dbo.MR_CreationAllocations(Sicil, ExpiresAt);
    END;

    DECLARE @Columns TABLE (Name sysname, Type sysname, Length smallint, Scale tinyint);
    INSERT @Columns VALUES (N'Proof', N'uniqueidentifier', 16, 0), (N'Sicil', N'int', 4, 0),
        (N'EntityType', N'varchar', 7, 0), (N'EntityId', N'uniqueidentifier', 16, 0),
        (N'ProjectId', N'uniqueidentifier', 16, 0), (N'ExpiresAt', N'datetime2', 7, 3);
    IF EXISTS (SELECT 1 FROM @Columns r LEFT JOIN sys.columns c
        ON c.object_id = OBJECT_ID(N'dbo.MR_CreationAllocations') AND c.name = r.Name
        WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id) <> r.Type OR c.max_length <> r.Length
            OR c.scale <> r.Scale OR c.is_nullable <> 0 OR c.is_computed <> 0 OR c.is_identity <> 0)
        OR EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'dbo.MR_CreationAllocations')
            AND c.name NOT IN (SELECT Name FROM @Columns))
        THROW 51019, '0019: Incompatible MR_CreationAllocations columns.', 1;

    DECLARE @Indexes TABLE (Name sysname, Ordinal int, ColumnName sysname, IsUnique bit, IsPrimary bit);
    INSERT @Indexes VALUES (N'PK_MR_CreationAllocations', 1, N'Proof', 1, 1),
        (N'UQ_MR_CreationAllocations_Entity', 1, N'EntityId', 1, 0),
        (N'IX_MR_CreationAllocations_Owner', 1, N'Sicil', 0, 0),
        (N'IX_MR_CreationAllocations_Owner', 2, N'ExpiresAt', 0, 0);
    IF EXISTS (SELECT 1 FROM @Indexes r
        LEFT JOIN sys.indexes i ON i.object_id = OBJECT_ID(N'dbo.MR_CreationAllocations') AND i.name = r.Name
        LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = r.Ordinal
        LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.index_id IS NULL OR i.is_disabled = 1 OR i.has_filter = 1 OR i.is_unique <> r.IsUnique
            OR i.is_primary_key <> r.IsPrimary OR c.name IS NULL OR c.name <> r.ColumnName OR ic.is_descending_key <> 0
            OR (SELECT COUNT(*) FROM sys.index_columns k WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.key_ordinal > 0)
                <> (SELECT COUNT(*) FROM @Indexes e WHERE e.Name = r.Name))
        THROW 51019, '0019: Incompatible MR_CreationAllocations indexes.', 1;

    CREATE TABLE #MR_CreationAllocationType (EntityType varchar(7) CHECK (EntityType IN ('PROJECT', 'WBS', 'TASK')));
    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints c
        JOIN tempdb.sys.check_constraints e ON e.parent_object_id = OBJECT_ID(N'tempdb..#MR_CreationAllocationType')
        WHERE c.parent_object_id = OBJECT_ID(N'dbo.MR_CreationAllocations') AND c.name = N'CK_MR_CreationAllocations_Type'
            AND c.is_disabled = 0 AND c.is_not_trusted = 0
            AND c.definition COLLATE Latin1_General_BIN2 = e.definition COLLATE Latin1_General_BIN2)
        THROW 51019, '0019: Incompatible allocation type constraint.', 1;
    DROP TABLE #MR_CreationAllocationType;

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0019_creation_allocations')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0019_creation_allocations', N'Caller-bound, expiring one-use server creation IDs');
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
