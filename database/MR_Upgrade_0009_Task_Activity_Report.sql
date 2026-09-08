SET XACT_ABORT ON;
BEGIN TRY
    BEGIN TRANSACTION;
    IF OBJECT_ID(N'dbo.MR_AuditLog', N'U') IS NULL
        THROW 51000, N'Önce kalıcı veritabanı kurulmalıdır.', 1;
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.MR_AuditLog') AND name = N'IX_MR_AuditLog_Type_Occurred')
        CREATE INDEX IX_MR_AuditLog_Type_Occurred ON dbo.MR_AuditLog(EntityType, OccurredAt DESC, AuditId DESC)
            INCLUDE (ActorSicil, ProjectId, EntityId, CorrelationId, ActionCode);
    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0009_task_activity_report')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0009_task_activity_report', N'Görev hareket raporu için tür ve tarih aralığı dizini');
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
