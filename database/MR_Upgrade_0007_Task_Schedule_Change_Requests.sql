/*
  MERGEN Rota — kalıcı görev tarih değişikliği talebi akışı

  Betik tekrar çalıştırılabilir. Var olan görev ve denetim verilerine dokunmaz;
  yalnızca talep tablosunu ve sorgu dizinlerini ekler.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_TaskScheduleChangeRequests (
            RequestId uniqueidentifier NOT NULL CONSTRAINT DF_MR_TaskScheduleChangeRequests_Id DEFAULT NEWSEQUENTIALID(),
            TaskId uniqueidentifier NOT NULL,
            RequesterSicil int NOT NULL,
            DecisionOwnerSicil int NOT NULL,
            OriginalPlannedStart date NULL,
            ProposedPlannedStart date NULL,
            OriginalPlannedFinish date NULL,
            ProposedPlannedFinish date NULL,
            OriginalTargetFinish date NULL,
            ProposedTargetFinish date NULL,
            RequesterMessage nvarchar(2000) NOT NULL,
            Status varchar(20) NOT NULL,
            CreatedAgainstTaskVersion binary(8) NOT NULL,
            CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_TaskScheduleChangeRequests_CreatedAt DEFAULT SYSUTCDATETIME(),
            DecidedAt datetime2(7) NULL,
            DecisionBySicil int NULL,
            DecisionMessage nvarchar(2000) NULL,
            RowVersion rowversion NOT NULL,
            CONSTRAINT PK_MR_TaskScheduleChangeRequests PRIMARY KEY (RequestId),
            CONSTRAINT FK_MR_TaskScheduleChangeRequests_Tasks FOREIGN KEY (TaskId)
                REFERENCES dbo.MR_Tasks(TaskId) ON DELETE CASCADE,
            CONSTRAINT CK_MR_TaskScheduleChangeRequests_Status
                CHECK (Status IN ('PENDING','ACCEPTED','REJECTED','CANCELLED','STALE')),
            CONSTRAINT CK_MR_TaskScheduleChangeRequests_PlannedDates
                CHECK (ProposedPlannedStart IS NULL OR ProposedPlannedFinish IS NULL OR ProposedPlannedFinish >= ProposedPlannedStart)
        );
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests')
            AND name = N'UX_MR_TaskScheduleChangeRequests_RequesterPending'
    )
        CREATE UNIQUE INDEX UX_MR_TaskScheduleChangeRequests_RequesterPending
            ON dbo.MR_TaskScheduleChangeRequests(TaskId, RequesterSicil)
            WHERE Status = 'PENDING';

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests')
            AND name = N'IX_MR_TaskScheduleChangeRequests_OwnerStatus'
    )
        CREATE INDEX IX_MR_TaskScheduleChangeRequests_OwnerStatus
            ON dbo.MR_TaskScheduleChangeRequests(DecisionOwnerSicil, Status, CreatedAt DESC);

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests')
            AND name = N'IX_MR_TaskScheduleChangeRequests_RequesterStatus'
    )
        CREATE INDEX IX_MR_TaskScheduleChangeRequests_RequesterStatus
            ON dbo.MR_TaskScheduleChangeRequests(RequesterSicil, Status, CreatedAt DESC);

    IF NOT EXISTS (
        SELECT 1
        FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0007_task_schedule_change_requests'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0007_task_schedule_change_requests', N'Kalıcı görev tarih değişikliği talebi ve karar akışı');

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
