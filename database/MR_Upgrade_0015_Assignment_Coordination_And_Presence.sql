SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

/*
    MERGEN Rota · 0015 — Atama koordinasyonu, görev bildirimleri, posta
    kuyruğu ve kullanıcı varlığı.

    Dört kalıcı yapı eklenir:

      · MR_TaskAssignmentCoordinations       — kurum dışı atama talebi/koordinasyonu
      · MR_AssignmentCoordinationRecipients  — alıcı (yönetici/sorumlu/talep eden)
                                               kümesi ve okundu/temizlendi sürümü
      · MR_TaskNotifications                 — zil bildirimleri (atandı/kaldırıldı)
      · MR_TaskMailOutbox                    — isteğe bağlı e-posta niyeti
      · MR_UserPresence                      — Sicil başına TEK nabız satırı

    Talep edilen sorumlu ONAYLANANA kadar MR_TaskAssignees'e YAZILMAZ: iş yükü,
    Özet, Kanban, hatırlatma ve Outlook yalnızca gerçek sorumluyu görür.

    Betik yinelenebilir ve veriye dokunmaz. 0014 uygulandıktan sonra çalıştırılır.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_Tasks', N'U') IS NULL
        THROW 51015, N'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0014_task_creator_index'
    )
        THROW 51015, N'Önce 0014_task_creator_index göçünü uygulayın.', 1;

    IF OBJECT_ID(N'dbo.MR_TaskAssignmentCoordinations', N'U') IS NULL
        CREATE TABLE dbo.MR_TaskAssignmentCoordinations (
            CoordinationId uniqueidentifier NOT NULL
                CONSTRAINT DF_MR_TaskAssignmentCoordinations_Id DEFAULT NEWSEQUENTIALID(),
            TaskId uniqueidentifier NOT NULL,
            RequesterSicil int NOT NULL,
            RequestedAssigneeSicil int NOT NULL,
            SuggestedAssigneeSicil int NULL,
            Mode varchar(20) NOT NULL,
            Status varchar(25) NOT NULL,
            RequesterMessage nvarchar(2000) NULL,
            DecisionMessage nvarchar(2000) NULL,
            DecisionBySicil int NULL,
            OriginalAssigneeSicils nvarchar(2000) NULL,
            TaskTitleSnapshot nvarchar(1000) NULL,
            ProjectIdSnapshot uniqueidentifier NULL,
            ProjectNameSnapshot nvarchar(1000) NULL,
            ProjectCodeSnapshot nvarchar(100) NULL,
            AssigneeNameSnapshot nvarchar(1000) NULL,
            AssigneeOrgSnapshot nvarchar(1000) NULL,
            TargetFinishSnapshot date NULL,
            CreatedAgainstTaskVersion binary(8) NULL,
            CorrelationId uniqueidentifier NULL,
            CreatedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_TaskAssignmentCoordinations_CreatedAt DEFAULT SYSUTCDATETIME(),
            DecidedAt datetime2(7) NULL,
            RowVersion rowversion NOT NULL,
            CONSTRAINT PK_MR_TaskAssignmentCoordinations PRIMARY KEY (CoordinationId),
            CONSTRAINT CK_MR_TaskAssignmentCoordinations_Mode
                CHECK (Mode IN ('REQUEST','NOTICE')),
            CONSTRAINT CK_MR_TaskAssignmentCoordinations_Status
                CHECK (Status IN ('PENDING','APPROVED','REJECTED','CHANGE_REQUESTED',
                                  'CANCELLATION_REQUESTED','CANCELLED','STALE'))
        );

    /* Aynı görev + aynı kişi için AÇIK tek kayıt: yinelenen talep eskisini
       CANCELLED yapar, geçmiş silinmez. */
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskAssignmentCoordinations')
          AND name = N'UX_MR_TaskAssignmentCoordinations_OpenRequest'
    )
        CREATE UNIQUE INDEX UX_MR_TaskAssignmentCoordinations_OpenRequest
            ON dbo.MR_TaskAssignmentCoordinations(TaskId, RequestedAssigneeSicil)
            WHERE Status IN ('PENDING','CANCELLATION_REQUESTED');

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskAssignmentCoordinations')
          AND name = N'IX_MR_TaskAssignmentCoordinations_TaskStatus'
    )
        CREATE INDEX IX_MR_TaskAssignmentCoordinations_TaskStatus
            ON dbo.MR_TaskAssignmentCoordinations(TaskId, Status)
            INCLUDE (RequestedAssigneeSicil, RequesterSicil);

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskAssignmentCoordinations')
          AND name = N'IX_MR_TaskAssignmentCoordinations_RequesterStatus'
    )
        CREATE INDEX IX_MR_TaskAssignmentCoordinations_RequesterStatus
            ON dbo.MR_TaskAssignmentCoordinations(RequesterSicil, Status, CreatedAt DESC);

    IF OBJECT_ID(N'dbo.MR_AssignmentCoordinationRecipients', N'U') IS NULL
        CREATE TABLE dbo.MR_AssignmentCoordinationRecipients (
            CoordinationId uniqueidentifier NOT NULL,
            Sicil int NOT NULL,
            RecipientRole varchar(20) NOT NULL,
            ReadVersion binary(8) NULL,
            DismissedVersion binary(8) NULL,
            UpdatedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_AssignmentCoordinationRecipients_UpdatedAt DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_MR_AssignmentCoordinationRecipients PRIMARY KEY (CoordinationId, Sicil),
            CONSTRAINT CK_MR_AssignmentCoordinationRecipients_Role
                CHECK (RecipientRole IN ('MANAGER','ASSIGNEE','REQUESTER')),
            CONSTRAINT FK_MR_AssignmentCoordinationRecipients_Coordination FOREIGN KEY (CoordinationId)
                REFERENCES dbo.MR_TaskAssignmentCoordinations(CoordinationId)
        );

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_AssignmentCoordinationRecipients')
          AND name = N'IX_MR_AssignmentCoordinationRecipients_Sicil'
    )
        CREATE INDEX IX_MR_AssignmentCoordinationRecipients_Sicil
            ON dbo.MR_AssignmentCoordinationRecipients(Sicil, CoordinationId);

    IF OBJECT_ID(N'dbo.MR_TaskNotifications', N'U') IS NULL
        CREATE TABLE dbo.MR_TaskNotifications (
            NotificationId uniqueidentifier NOT NULL
                CONSTRAINT DF_MR_TaskNotifications_Id DEFAULT NEWSEQUENTIALID(),
            RecipientSicil int NOT NULL,
            Kind varchar(30) NOT NULL,
            TaskId uniqueidentifier NULL,
            ActorSicil int NULL,
            ActorNameSnapshot nvarchar(1000) NULL,
            TaskTitleSnapshot nvarchar(1000) NULL,
            ProjectIdSnapshot uniqueidentifier NULL,
            ProjectNameSnapshot nvarchar(1000) NULL,
            ProjectCodeSnapshot nvarchar(100) NULL,
            TargetFinishSnapshot date NULL,
            PrioritySnapshot varchar(20) NULL,
            TaskCount int NOT NULL CONSTRAINT DF_MR_TaskNotifications_TaskCount DEFAULT 1,
            EventKey nvarchar(200) NOT NULL,
            OccurredAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_TaskNotifications_OccurredAt DEFAULT SYSUTCDATETIME(),
            /* Satır yazıldıktan sonra DEĞİŞMEZ; okundu/temizlendi işaretleri
               tek yönlüdür ve bu yüzden sürüm kapısı gerektirmez. */
            ReadAt datetime2(7) NULL,
            DismissedAt datetime2(7) NULL,
            RowVersion rowversion NOT NULL,
            CONSTRAINT PK_MR_TaskNotifications PRIMARY KEY (NotificationId),
            CONSTRAINT CK_MR_TaskNotifications_Kind
                CHECK (Kind IN ('TASK_ASSIGNED','TASK_UNASSIGNED'))
        );

    /* Aynı olay iki kez yazılmaz: yeniden denenen bir yazma yinelenen zil
       bildirimi üretmez. */
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskNotifications')
          AND name = N'UX_MR_TaskNotifications_RecipientEvent'
    )
        CREATE UNIQUE INDEX UX_MR_TaskNotifications_RecipientEvent
            ON dbo.MR_TaskNotifications(RecipientSicil, EventKey);

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskNotifications')
          AND name = N'IX_MR_TaskNotifications_RecipientOccurred'
    )
        CREATE INDEX IX_MR_TaskNotifications_RecipientOccurred
            ON dbo.MR_TaskNotifications(RecipientSicil, OccurredAt DESC);

    IF OBJECT_ID(N'dbo.MR_TaskMailOutbox', N'U') IS NULL
        CREATE TABLE dbo.MR_TaskMailOutbox (
            MailId bigint IDENTITY(1,1) NOT NULL,
            Kind varchar(30) NOT NULL,
            TaskId uniqueidentifier NULL,
            RecipientSicil int NOT NULL,
            PayloadJson nvarchar(max) NOT NULL,
            Status varchar(20) NOT NULL CONSTRAINT DF_MR_TaskMailOutbox_Status DEFAULT 'PENDING',
            AttemptCount int NOT NULL CONSTRAINT DF_MR_TaskMailOutbox_AttemptCount DEFAULT 0,
            NextAttemptAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_TaskMailOutbox_NextAttemptAt DEFAULT SYSUTCDATETIME(),
            LeaseExpiresAt datetime2(7) NULL,
            LastFailureCode varchar(60) NULL,
            DedupeKey nvarchar(200) NOT NULL,
            CreatedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_TaskMailOutbox_CreatedAt DEFAULT SYSUTCDATETIME(),
            UpdatedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_TaskMailOutbox_UpdatedAt DEFAULT SYSUTCDATETIME(),
            SentAt datetime2(7) NULL,
            CONSTRAINT PK_MR_TaskMailOutbox PRIMARY KEY (MailId),
            CONSTRAINT CK_MR_TaskMailOutbox_Status
                CHECK (Status IN ('PENDING','SENT','FAILED'))
        );

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskMailOutbox')
          AND name = N'UX_MR_TaskMailOutbox_DedupeKey'
    )
        CREATE UNIQUE INDEX UX_MR_TaskMailOutbox_DedupeKey
            ON dbo.MR_TaskMailOutbox(DedupeKey);

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_TaskMailOutbox')
          AND name = N'IX_MR_TaskMailOutbox_Due'
    )
        CREATE INDEX IX_MR_TaskMailOutbox_Due
            ON dbo.MR_TaskMailOutbox(Status, NextAttemptAt)
            INCLUDE (RecipientSicil, AttemptCount);

    /* Sicil başına TEK satır: sekme sayısı, istek sayısı ya da örnek sayısı
       tablo boyutunu büyütmez. */
    IF OBJECT_ID(N'dbo.MR_UserPresence', N'U') IS NULL
        CREATE TABLE dbo.MR_UserPresence (
            Sicil int NOT NULL,
            FirstSeenAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_UserPresence_FirstSeenAt DEFAULT SYSUTCDATETIME(),
            SessionStartedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_UserPresence_SessionStartedAt DEFAULT SYSUTCDATETIME(),
            LastSeenAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_UserPresence_LastSeenAt DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_MR_UserPresence PRIMARY KEY (Sicil)
        );

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_UserPresence') AND name = N'IX_MR_UserPresence_LastSeenAt'
    )
        CREATE INDEX IX_MR_UserPresence_LastSeenAt ON dbo.MR_UserPresence(LastSeenAt DESC) INCLUDE (Sicil);

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0015_assignment_coordination_and_presence'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (
            N'0015_assignment_coordination_and_presence',
            N'Kurum dışı atama koordinasyonu, görev bildirimleri, dayanıklı posta kuyruğu ve kullanıcı varlığı'
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
