SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

BEGIN TRY
    BEGIN TRANSACTION;
    IF OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests', N'U') IS NULL
        THROW 51000, 'Önce 0007 tarih talebi yükseltmesini çalıştırın.', 1;

    IF COL_LENGTH(N'dbo.MR_TaskScheduleChangeRequests', N'TaskTitleSnapshot') IS NULL
        ALTER TABLE dbo.MR_TaskScheduleChangeRequests ADD
            TaskTitleSnapshot nvarchar(1000) NULL,
            ProjectIdSnapshot uniqueidentifier NULL,
            ProjectNameSnapshot nvarchar(1000) NULL,
            ProjectCodeSnapshot nvarchar(100) NULL;

    EXEC(N'UPDATE r SET TaskTitleSnapshot = t.Title, ProjectIdSnapshot = t.ProjectId,
        ProjectNameSnapshot = p.ProjectName, ProjectCodeSnapshot = p.ProjectCode
        FROM dbo.MR_TaskScheduleChangeRequests r
        JOIN dbo.MR_Tasks t ON t.TaskId = r.TaskId
        JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
        WHERE r.TaskTitleSnapshot IS NULL;');

    IF OBJECT_ID(N'dbo.FK_MR_TaskScheduleChangeRequests_Tasks', N'F') IS NOT NULL
        ALTER TABLE dbo.MR_TaskScheduleChangeRequests DROP CONSTRAINT FK_MR_TaskScheduleChangeRequests_Tasks;

    IF OBJECT_ID(N'dbo.MR_ScheduleRequestNotifications', N'U') IS NULL
        CREATE TABLE dbo.MR_ScheduleRequestNotifications (
            RequestId uniqueidentifier NOT NULL,
            Sicil int NOT NULL,
            ReadVersion binary(8) NULL,
            DismissedVersion binary(8) NULL,
            UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_ScheduleRequestNotifications_UpdatedAt DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_MR_ScheduleRequestNotifications PRIMARY KEY (RequestId, Sicil),
            CONSTRAINT FK_MR_ScheduleRequestNotifications_Request FOREIGN KEY (RequestId)
                REFERENCES dbo.MR_TaskScheduleChangeRequests(RequestId)
        );

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0008_request_notifications')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0008_request_notifications', N'Talep geçmişinden ayrı bildirim durumu ve kalıcı görev künyesi');
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
