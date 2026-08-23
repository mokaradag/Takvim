SET NOCOUNT ON;
SET XACT_ABORT ON;

/*
    MERGEN Rota — 0005 yukseltme gocu: gorev hatirlatma e-postalari.

    Temiz kurulum betigi (MR_Create_Durable_Persistence.sql) herhangi bir MR_*
    nesnesi varsa bilerek durur; dolayisiyla MEVCUT bir kalici veritabani yeni
    tablolari o betikten ALAMAZ. Bu betik ayni semayi yerinde ve YINELENEBILIR
    bicimde uygular: birden cok kez calistirilabilir, mevcut veriyi degistirmez
    ve varsayilan davranisi genisletmez (otomatik gonderim KAPALI gelir).

    Calistirma sirasi: uygulama surumu dagitilmadan ONCE.

    Iki tablo eklenir:

      MR_ReminderSettings   Tek satirlik yonetici yapilandirmasi: otomatik
                            gonderim acik/kapali, hatirlatma penceresi, siklik
                            ve e-posta sablonu (konu + govde).

      MR_TaskReminderLog    KALICI gonderim gecmisi. Otomatik gonderimde
                            (TaskId, SlotKey) benzersizdir: zamanlayici saatte
                            bir calissa, iki uygulama ornegi ayni anda baslasa
                            ya da sunucu yeniden baslasa bile ayni hatirlatma
                            araligi icin ikinci ileti gonderilemez.

    DC01_userr tablosu MERGEN Rota veritabaninda ZATEN vardir; bu betik onu
    olusturmaz, degistirmez ve silmez. Yalnizca okunur.
*/

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51000, 'MERGEN Rota durable schema was not found. Run MR_Create_Durable_Persistence.sql first.', 1;

    IF OBJECT_ID(N'dbo.MR_ReminderSettings', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_ReminderSettings (
            SettingsId tinyint NOT NULL CONSTRAINT PK_MR_ReminderSettings PRIMARY KEY,
            AutomaticEnabled bit NOT NULL CONSTRAINT DF_MR_ReminderSettings_Enabled DEFAULT (0),
            WindowValue int NOT NULL CONSTRAINT DF_MR_ReminderSettings_WindowValue DEFAULT (7),
            WindowUnit varchar(10) NOT NULL CONSTRAINT DF_MR_ReminderSettings_WindowUnit DEFAULT ('day'),
            FrequencyValue int NOT NULL CONSTRAINT DF_MR_ReminderSettings_FreqValue DEFAULT (2),
            FrequencyUnit varchar(10) NOT NULL CONSTRAINT DF_MR_ReminderSettings_FreqUnit DEFAULT ('day'),
            SubjectTemplate nvarchar(400) NOT NULL,
            BodyTemplate nvarchar(max) NOT NULL,
            UpdatedAt datetime2(3) NOT NULL CONSTRAINT DF_MR_ReminderSettings_UpdatedAt DEFAULT SYSUTCDATETIME(),
            UpdatedBySicil int NULL,
            RowVersion rowversion NOT NULL,
            CONSTRAINT CK_MR_ReminderSettings_Single CHECK (SettingsId = 1),
            CONSTRAINT CK_MR_ReminderSettings_WindowUnit CHECK (WindowUnit IN ('day', 'hour')),
            CONSTRAINT CK_MR_ReminderSettings_FreqUnit CHECK (FrequencyUnit IN ('day', 'hour')),
            CONSTRAINT CK_MR_ReminderSettings_WindowValue CHECK (WindowValue > 0),
            CONSTRAINT CK_MR_ReminderSettings_FreqValue CHECK (FrequencyValue > 0)
        );
    END;

    IF OBJECT_ID(N'dbo.MR_TaskReminderLog', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_TaskReminderLog (
            TaskReminderLogId bigint IDENTITY(1, 1) NOT NULL CONSTRAINT PK_MR_TaskReminderLog PRIMARY KEY,
            TaskId uniqueidentifier NOT NULL,
            ProjectId uniqueidentifier NULL,
            ReminderKind varchar(20) NOT NULL,
            SlotKey nvarchar(200) NOT NULL,
            Status varchar(20) NOT NULL,
            RecipientCount int NOT NULL CONSTRAINT DF_MR_TaskReminderLog_Count DEFAULT (0),
            RecipientDigest nvarchar(400) NULL,
            FailureCode varchar(60) NULL,
            RequestedBySicil int NULL,
            CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_MR_TaskReminderLog_CreatedAt DEFAULT SYSUTCDATETIME(),
            CompletedAt datetime2(3) NULL,
            CONSTRAINT CK_MR_TaskReminderLog_Kind CHECK (ReminderKind IN ('MANUAL', 'AUTOMATIC')),
            CONSTRAINT CK_MR_TaskReminderLog_Status CHECK (Status IN ('PENDING', 'SENT', 'FAILED'))
        );
    END;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

IF XACT_STATE() <> 0 COMMIT TRANSACTION;
GO

/* Dizinler, varsayilan sablon ve goc kaydi tablolar derlendikten SONRA. */
BEGIN TRY
    BEGIN TRANSACTION;

    /* Kopya gonderimi ONLEYEN benzersiz dizin. Elle gonderimler haric tutulur:
       kullanici ayni goreve bilerek ikinci bir hatirlatma gonderebilir. */
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_MR_TaskReminderLog_AutomaticSlot' AND object_id = OBJECT_ID(N'dbo.MR_TaskReminderLog'))
        CREATE UNIQUE INDEX UX_MR_TaskReminderLog_AutomaticSlot
            ON dbo.MR_TaskReminderLog(TaskId, SlotKey)
            WHERE ReminderKind = 'AUTOMATIC';

    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_MR_TaskReminderLog_Task_Created' AND object_id = OBJECT_ID(N'dbo.MR_TaskReminderLog'))
        CREATE INDEX IX_MR_TaskReminderLog_Task_Created
            ON dbo.MR_TaskReminderLog(TaskId, CreatedAt DESC);

    /* Varsayilan sablon: yonetici hicbir sey degistirmese bile ozellik ilk
       gunden calisir. Govde satir ici stillerle yazilir; Outlook modern CSS
       kurallarinin cogunu yok sayar. */
    IF NOT EXISTS (SELECT 1 FROM dbo.MR_ReminderSettings WHERE SettingsId = 1)
        INSERT dbo.MR_ReminderSettings(SettingsId, AutomaticEnabled, WindowValue, WindowUnit, FrequencyValue, FrequencyUnit, SubjectTemplate, BodyTemplate)
        VALUES (
            1, 0, 7, 'day', 2, 'day',
            N'{{app_name}} · Görev hatırlatması: {{task_name}} ({{remaining_duration}})',
            N'<h2 style="margin: 0 0 12px; font-size: 18px; color: #1f2937;">Görev hatırlatması</h2>
<p style="margin: 0 0 14px; color: #374151; line-height: 1.55;">
Sayın {{assignees}},<br />
aşağıdaki görevin termin tarihine <strong>{{remaining_duration}}</strong>.
Durumu gözden geçirip gerekirse güncellemenizi rica ederiz.
</p>
<table style="border-collapse: collapse; width: 100%; margin: 0 0 14px;">
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb; width: 170px;"><strong>Görev</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{task_name}}</td></tr>
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Proje</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{project_code}} · {{project_name}}</td></tr>
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Kısa açıklama</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{keyword}}</td></tr>
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Sorumlular</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{assignees}}</td></tr>
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Termin</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{due_date}} ({{remaining_duration}})</td></tr>
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Öncelik</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{priority}}</td></tr>
<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Durum</strong></td>
<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{status}}</td></tr>
</table>
<p style="margin: 0 0 6px; color: #374151;"><strong>Açıklama</strong></p>
<p style="margin: 0 0 16px; color: #4b5563; line-height: 1.55;">{{description}}</p>
<p style="margin: 0; color: #6b7280; font-size: 12px;">
Bu ileti {{app_name}} tarafından {{today}} tarihinde otomatik olarak hazırlanmıştır.
</p>'
        );

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0005_task_reminders')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0005_task_reminders', N'Task reminder e-mail settings, template and persistent send history');
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

IF XACT_STATE() <> 0 COMMIT TRANSACTION;
