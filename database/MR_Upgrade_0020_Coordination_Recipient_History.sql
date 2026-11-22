SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0019_creation_allocations')
        THROW 51020, N'0020 öncesinde 0019 yükseltmesini uygulayın.', 1;

    -- Yalnızca koordinasyon karar yolunda denetlenen işlemler alıcı rolünü
    -- doğrular. Başka bir işlem kaydı otomatik kapatıp son karar Sicilini
    -- değiştirebilir; okundu izi veya son karar Sicili tek başına yeterli değildir.
    UPDATE r
    SET RecipientRole = 'MANAGER'
    FROM dbo.MR_AssignmentCoordinationRecipients AS r
    JOIN dbo.MR_TaskAssignmentCoordinations AS c ON c.CoordinationId = r.CoordinationId
    WHERE r.RecipientRole = 'REQUESTER'
      AND r.Sicil <> c.RequesterSicil
      AND EXISTS (
        SELECT 1
        FROM dbo.MR_AuditLog AS a
        WHERE a.EntityType = 'TASK_ASSIGNMENT_COORDINATION'
          AND a.EntityId = LOWER(CONVERT(nvarchar(36), c.CoordinationId))
          AND a.ActionCode = 'UPDATE'
          AND a.ActorSicil = r.Sicil
      );

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WITH (UPDLOCK, HOLDLOCK)
                   WHERE MigrationId = N'0020_coordination_recipient_history')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0020_coordination_recipient_history', N'Eski atama koordinasyonu karar alıcılarının rolünü düzeltir');

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
