SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

-- Uygulama çalışanları durdurulduktan ve güncel 0010 uygulandıktan sonra çalıştırılır.
BEGIN TRY
    BEGIN TRANSACTION;
    IF OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions', N'U') IS NULL
        THROW 51011, 'Önce güncel 0010 Outlook yükseltmesini uygulayın.', 1;

    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'CompletionSuspended') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD CompletionSuspended bit NOT NULL
            CONSTRAINT DF_MR_Outlook_CompletionSuspended DEFAULT (0) WITH VALUES;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'CompletionDate') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD CompletionDate date NULL;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'LastCancellationReason') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD LastCancellationReason varchar(60) NULL;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'DeliveredMethod') IS NULL
    BEGIN
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD DeliveredMethod varchar(10) NULL;
        EXEC(N'UPDATE dbo.MR_TaskOutlookSubscriptions
            SET DeliveredMethod = CASE WHEN IsActive = 1 THEN ''REQUEST'' ELSE ''CANCEL'' END
            WHERE DeliveredSequence IS NOT NULL;');
    END;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'PendingDate') IS NULL
    BEGIN
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD PendingDate date NULL;
        EXEC(N'UPDATE s SET PendingDate = CASE
            WHEN COALESCE(t.TargetFinish, t.PlannedFinish) IS NOT NULL
              THEN COALESCE(t.TargetFinish, t.PlannedFinish)
            ELSE s.DeliveredDate END
            FROM dbo.MR_TaskOutlookSubscriptions s LEFT JOIN dbo.MR_Tasks t ON t.TaskId = s.TaskId
            WHERE s.PendingSequence IS NOT NULL AND s.PendingMethod = ''REQUEST'';');
    END;

    -- 0011 öncesinden kalan tamamlanmış etkin aboneliklerde gerçek tamamlanma anı
    -- bilinmez. SQL Server host saat dilimine bağlı bir gün yazmamak için yükseltme
    -- anının UTC günü ilk gözlem günü olarak bir kez saklanır; çalışma zamanındaki
    -- yeni tamamlanmalar görev/proje/varsayılan Rota takviminin saat dilimini kullanır.
    -- Açık kaldırma isteği ise kullanıcı niyetidir; tamamlanma askısına çevrilmez.
    EXEC(N'UPDATE s
        SET CompletionSuspended = 1,
            CompletionDate = COALESCE(s.CompletionDate, CONVERT(date, SYSUTCDATETIME())),
            LastCancellationReason = COALESCE(s.LastCancellationReason, ''TASK_COMPLETED''),
            PendingMethod = COALESCE(s.PendingMethod, ''REQUEST''),
            QueueSeq = CASE WHEN s.PendingMethod IS NULL THEN s.QueueSeq + 1 ELSE s.QueueSeq END,
            AttemptCount = CASE WHEN s.PendingMethod IS NULL THEN 0 ELSE s.AttemptCount END,
            NextAttemptAt = CASE WHEN s.PendingMethod IS NULL THEN NULL ELSE s.NextAttemptAt END,
            LastFailureCode = CASE WHEN s.PendingMethod IS NULL THEN NULL ELSE s.LastFailureCode END
        FROM dbo.MR_TaskOutlookSubscriptions s
        JOIN dbo.MR_Tasks t ON t.TaskId = s.TaskId
        WHERE s.IsActive = 1 AND s.CancelRequested = 0
          AND s.CompletionSuspended = 0 AND t.Status = ''done'';');

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0011_outlook_completion_lifecycle')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0011_outlook_completion_lifecycle', N'Outlook tamamlanma, yeniden açılma ve iptal nedeni');
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
