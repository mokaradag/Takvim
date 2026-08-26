/*
  MERGEN Rota — audit soft-deactivation actions

  Project deletion is a recoverable deactivation. Keep that distinction in the
  audit log while making the durable schema accept the action used by the
  repository. The migration is safe to run repeatedly.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_AuditLog', N'U') IS NOT NULL
    BEGIN
        IF OBJECT_ID(N'dbo.CK_MR_AuditLog_Action', N'C') IS NOT NULL
            ALTER TABLE dbo.MR_AuditLog DROP CONSTRAINT CK_MR_AuditLog_Action;

        ALTER TABLE dbo.MR_AuditLog WITH CHECK
            ADD CONSTRAINT CK_MR_AuditLog_Action
            CHECK (ActionCode IN ('CREATE','UPDATE','DELETE','DEACTIVATE'));
        ALTER TABLE dbo.MR_AuditLog CHECK CONSTRAINT CK_MR_AuditLog_Action;
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
