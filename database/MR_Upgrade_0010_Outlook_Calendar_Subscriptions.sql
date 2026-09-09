SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

/*
    MERGEN Rota — 0010 yukseltme gocu: Outlook takvim abonelikleri.

    Temiz kurulum betigi (MR_Create_Durable_Persistence.sql) herhangi bir MR_*
    nesnesi varsa bilerek durur; dolayisiyla MEVCUT bir kalici veritabani yeni
    tabloyu o betikten ALAMAZ. Bu betik ayni semayi yerinde ve YINELENEBILIR
    bicimde uygular: birden cok kez calistirilabilir, mevcut veriyi degistirmez
    ve varsayilan davranisi genisletmez.

    Calistirma sirasi: uygulama surumu dagitilmadan ONCE.

    Tek tablo eklenir:

      MR_TaskOutlookSubscriptions   Gorev + Sicil iliskisinin KALICI Outlook
                                    takvim aboneligi. Benzersiz kisit
                                    (TaskId, UserSicil) uzerindedir: cift
                                    tiklama, ikinci sekme ya da ikinci uygulama
                                    ornegi ayni gorev icin ikinci bir randevu
                                    acamaz.

    Tablo ayni zamanda dayanikli bir GONDERIM KUYRUGUDUR (outbox):
    PendingMethod dolu olan satirlar zamanlanmis turda islenir. Gorev kaydi
    hicbir kosulda SMTP'ye bagli degildir; kuyruk kaydi kalicilik islemiyle
    birlikte yazilir, gonderim ayri ve yeniden denenebilir.

    YABANCI ANAHTAR YOKTUR (MR_TaskReminderLog ve 0008 sonrasi
    MR_TaskScheduleChangeRequests ile ayni gerekce): gorev silindiginde
    aboneligin YASAMASI gerekir, cunku Outlook'a gonderilecek IPTAL daveti
    degismez UID'yi ve son teslim edilen kunyeyi bu satirdan okur.
*/

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51000, 'MERGEN Rota durable schema was not found. Run MR_Create_Durable_Persistence.sql first.', 1;

    IF OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_TaskOutlookSubscriptions (
            SubscriptionId bigint IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_MR_TaskOutlookSubscriptions PRIMARY KEY,
            TaskId uniqueidentifier NOT NULL,
            ProjectId uniqueidentifier NULL,
            /* Kimlik SICIL'dir; tam ad kullanilmaz (ayni ad birden cok kisiye ait olabilir). */
            UserSicil int NOT NULL,
            /* Randevunun DEGISMEZ iCalendar kimligi. */
            CalendarUid nvarchar(200) NOT NULL,
            /* Ayrilmis en yuksek revizyon numarasi (iCalendar SEQUENCE). */
            [Sequence] int NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_Sequence DEFAULT (0),
            IsActive bit NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_IsActive DEFAULT (1),
            /* Kuyruk sayaci: teslimat surerken gelen yeni degisiklik kaybolmaz. */
            QueueSeq bigint NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_QueueSeq DEFAULT (1),
            /* NULL = bekleyen is yok. REQUEST = guncelleme, CANCEL = iptal. */
            PendingMethod varchar(10) NULL,
            PendingSequence int NULL,
            PendingPayloadHash char(64) NULL,
            /* Son BASARIYLA teslim edilen revizyon ve icerik parmak izi. */
            DeliveredSequence int NULL,
            DeliveredPayloadHash char(64) NULL,
            DeliveredSummary nvarchar(400) NULL,
            DeliveredDate date NULL,
            AttemptCount int NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_Attempts DEFAULT (0),
            NextAttemptAt datetime2(3) NULL,
            InFlightSince datetime2(3) NULL,
            LeaseToken uniqueidentifier NULL,
            LeaseExpiresAt datetime2(3) NULL,
            CalendarAttendee nvarchar(320) NULL,
            CalendarOrganizer nvarchar(320) NULL,
            LastDeliveredAt datetime2(3) NULL,
            LastFailureCode varchar(60) NULL,
            CreatedBySicil int NULL,
            CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_CreatedAt DEFAULT SYSUTCDATETIME(),
            UpdatedAt datetime2(3) NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_UpdatedAt DEFAULT SYSUTCDATETIME(),
            RowVersion rowversion NOT NULL,
            CONSTRAINT CK_MR_TaskOutlookSubs_PendingMethod
                CHECK (PendingMethod IS NULL OR PendingMethod IN ('REQUEST', 'CANCEL')),
            CONSTRAINT CK_MR_TaskOutlookSubs_Sequence CHECK ([Sequence] >= 0),
            CONSTRAINT CK_MR_TaskOutlookSubs_Attempts CHECK (AttemptCount >= 0)
        );
    END;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'LeaseToken') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD LeaseToken uniqueidentifier NULL;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'LeaseExpiresAt') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD LeaseExpiresAt datetime2(3) NULL;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'CalendarAttendee') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD CalendarAttendee nvarchar(320) NULL;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'CalendarOrganizer') IS NULL
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD CalendarOrganizer nvarchar(320) NULL;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'CancelRequested') IS NULL
    BEGIN
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD CancelRequested bit NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_CancelRequested DEFAULT 0;
        EXEC(N'UPDATE dbo.MR_TaskOutlookSubscriptions SET CancelRequested = 1 WHERE PendingMethod = ''CANCEL'';');
    END;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'ForceResend') IS NULL
    BEGIN
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD ForceResend bit NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_ForceResend DEFAULT 0;
    END;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'DeliveryMayHaveEscaped') IS NULL
    BEGIN
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD DeliveryMayHaveEscaped bit NOT NULL CONSTRAINT DF_MR_TaskOutlookSubs_MayHaveEscaped DEFAULT 0;
        EXEC(N'UPDATE dbo.MR_TaskOutlookSubscriptions SET DeliveryMayHaveEscaped = 1 WHERE PendingSequence IS NOT NULL OR DeliveredSequence IS NOT NULL;');
    END;
    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'LastValidatedAt') IS NULL
    BEGIN
        ALTER TABLE dbo.MR_TaskOutlookSubscriptions ADD LastValidatedAt datetime2(3) NULL;
    END;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

IF XACT_STATE() <> 0 COMMIT TRANSACTION;
GO

/* Dizinler ve goc kaydi tablo derlendikten SONRA. */
BEGIN TRY
    BEGIN TRANSACTION;

    /* GO bir ISTEMCI toplu is ayracidir, islem siniri DEGILDIR: sqlcmd ve SSMS,
       -b verilmedikce ilk toplu is hata verse bile bir sonrakini calistirir.
       Bu toplu is bu yuzden kendi on kosulunu dogrular. */
    IF OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions', N'U') IS NULL
        THROW 51010, 'MR_TaskOutlookSubscriptions is missing. The first batch of MR_Upgrade_0010 did not complete.', 1;

    IF COL_LENGTH(N'dbo.MR_TaskOutlookSubscriptions', N'LastValidatedAt') IS NULL
        THROW 51010, 'Outlook lifecycle columns are missing. Run the complete migration.', 1;

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MR_TaskOutlookSubs_Revalidation'
        AND object_id = OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions'))
        CREATE INDEX IX_MR_TaskOutlookSubs_Revalidation
        ON dbo.MR_TaskOutlookSubscriptions(LastValidatedAt, SubscriptionId)
        INCLUDE (LeaseExpiresAt) WHERE IsActive = 1 AND PendingMethod IS NULL;

    /* KOPYA randevuyu onleyen benzersiz kisit: ayni gorev/kullanici ikilisi
       icin ikinci bir satir olusamaz. Eszamanli iki istek yarissa bile
       yalnizca biri ekler. */
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name = N'UX_MR_TaskOutlookSubs_Task_User'
                     AND object_id = OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions'))
        CREATE UNIQUE INDEX UX_MR_TaskOutlookSubs_Task_User
            ON dbo.MR_TaskOutlookSubscriptions(TaskId, UserSicil);

    /* Kuyruk taramasi: yalnizca bekleyen isler indekslenir. */
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name = N'IX_MR_TaskOutlookSubs_Pending'
                     AND object_id = OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions'))
        CREATE INDEX IX_MR_TaskOutlookSubs_Pending
            ON dbo.MR_TaskOutlookSubscriptions(NextAttemptAt, SubscriptionId)
            INCLUDE (TaskId, UserSicil, PendingMethod, AttemptCount)
            WHERE PendingMethod IS NOT NULL;

    /* Arayuzun "eklendi" durumu tek kullanicinin etkin abonelikleridir. */
    IF NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE name = N'IX_MR_TaskOutlookSubs_User_Active'
                     AND object_id = OBJECT_ID(N'dbo.MR_TaskOutlookSubscriptions'))
        CREATE INDEX IX_MR_TaskOutlookSubs_User_Active
            ON dbo.MR_TaskOutlookSubscriptions(UserSicil, IsActive)
            INCLUDE (TaskId, PendingMethod, DeliveredSequence, LastFailureCode);

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0010_outlook_calendar_subscriptions')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0010_outlook_calendar_subscriptions', N'Gorev/Sicil Outlook takvim abonelikleri ve dayanikli gonderim kuyrugu');
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

IF XACT_STATE() <> 0 COMMIT TRANSACTION;
