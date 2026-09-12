SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

/*
    MERGEN Rota · 0012 — Sistem Yönetimi ve üretim gözlemlenebilirliği.

    Dört yeni tablo ekler:
      • MR_TelemetryOperationSamples — işlem başına 5 dakikalık süre/hata toplamı
      • MR_TelemetryGaugeSamples     — bellek, kuyruk derinliği gibi anlık ölçümler
      • MR_OperationalEvents         — kalıcı işletim olayları (yinelenenler toplanmış)
      • MR_OperationalAlerts         — açık/onaylı/çözülmüş otomatik uyarılar

    Betik YİNELENEBİLİR (idempotent): var olan nesneler yeniden oluşturulmaz.
    Uygulama sırası: 0001 … 0011 uygulandıktan SONRA çalıştırılır.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51012, 'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    -- İşlem toplamları. Her istek için satır YAZILMAZ: uygulama gözlemleri
    -- bellekte beş dakikalık kovalarda toplanır, yalnızca kapanmış kova yazılır.
    IF OBJECT_ID(N'dbo.MR_TelemetryOperationSamples', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_TelemetryOperationSamples (
            BucketStart datetime2(0) NOT NULL,
            Operation nvarchar(100) NOT NULL,
            SampleCount int NOT NULL,
            ErrorCount int NOT NULL CONSTRAINT DF_MR_TelemetryOperation_ErrorCount DEFAULT (0),
            DurationSumMs bigint NOT NULL CONSTRAINT DF_MR_TelemetryOperation_DurationSum DEFAULT (0),
            DurationMaxMs int NOT NULL CONSTRAINT DF_MR_TelemetryOperation_DurationMax DEFAULT (0),
            P50Ms int NULL,
            P95Ms int NULL,
            P99Ms int NULL,
            TopFailureCode varchar(60) NULL,
            CONSTRAINT PK_MR_TelemetryOperationSamples PRIMARY KEY (BucketStart, Operation),
            CONSTRAINT CK_MR_TelemetryOperation_Counts CHECK (SampleCount >= 0 AND ErrorCount >= 0 AND ErrorCount <= SampleCount)
        );
        -- Zaman aralığı sorguları yalnızca bu dizin üzerinden çalışır; 30 günlük
        -- tabloda tarama yapılmaz.
        CREATE INDEX IX_MR_TelemetryOperationSamples_Bucket
            ON dbo.MR_TelemetryOperationSamples(BucketStart)
            INCLUDE (Operation, SampleCount, ErrorCount, DurationSumMs, DurationMaxMs, P50Ms, P95Ms, P99Ms);
    END;

    IF OBJECT_ID(N'dbo.MR_TelemetryGaugeSamples', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_TelemetryGaugeSamples (
            BucketStart datetime2(0) NOT NULL,
            MetricKey varchar(60) NOT NULL,
            SampleCount int NOT NULL,
            ValueAvg float NOT NULL,
            ValueMin float NOT NULL,
            ValueMax float NOT NULL,
            CONSTRAINT PK_MR_TelemetryGaugeSamples PRIMARY KEY (BucketStart, MetricKey),
            CONSTRAINT CK_MR_TelemetryGauge_SampleCount CHECK (SampleCount > 0)
        );
        CREATE INDEX IX_MR_TelemetryGaugeSamples_Metric
            ON dbo.MR_TelemetryGaugeSamples(MetricKey, BucketStart)
            INCLUDE (SampleCount, ValueAvg, ValueMin, ValueMax);
    END;

    -- Kalıcı işletim olayları. Özdeş olaylar yazılmadan ÖNCE tek satırda
    -- toplanır (OccurrenceCount); sekiz yüz aynı hata sekiz yüz satır üretmez.
    IF OBJECT_ID(N'dbo.MR_OperationalEvents', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_OperationalEvents (
            OperationalEventId bigint IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_MR_OperationalEvents PRIMARY KEY,
            OccurredAt datetime2(3) NOT NULL CONSTRAINT DF_MR_OperationalEvents_OccurredAt DEFAULT SYSUTCDATETIME(),
            Severity varchar(10) NOT NULL,
            Component varchar(40) NOT NULL,
            EventCode varchar(60) NOT NULL,
            Summary nvarchar(300) NOT NULL,
            Detail nvarchar(1000) NULL,
            CorrelationId varchar(64) NULL,
            OccurrenceCount int NOT NULL CONSTRAINT DF_MR_OperationalEvents_Occurrences DEFAULT (1),
            ContextJson nvarchar(2000) NULL,
            CONSTRAINT CK_MR_OperationalEvents_Severity CHECK (Severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
            CONSTRAINT CK_MR_OperationalEvents_Occurrences CHECK (OccurrenceCount > 0)
        );
        CREATE INDEX IX_MR_OperationalEvents_OccurredAt
            ON dbo.MR_OperationalEvents(OccurredAt DESC)
            INCLUDE (Severity, Component, EventCode, Summary, OccurrenceCount);
        CREATE INDEX IX_MR_OperationalEvents_Component
            ON dbo.MR_OperationalEvents(Component, OccurredAt DESC)
            INCLUDE (Severity, EventCode);
    END;

    -- Otomatik uyarılar. Etkin uyarı anahtarı BENZERSİZDİR: aynı koşul ikinci
    -- bir satır açamaz, yalnızca sayacı ilerletir. Çözülmüş uyarılar geçmişte
    -- kalır ve koşul yeniden görülürse yeni bir kayıt açılır.
    IF OBJECT_ID(N'dbo.MR_OperationalAlerts', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_OperationalAlerts (
            OperationalAlertId bigint IDENTITY(1, 1) NOT NULL
                CONSTRAINT PK_MR_OperationalAlerts PRIMARY KEY,
            AlertKey varchar(200) NOT NULL,
            Severity varchar(10) NOT NULL,
            Component varchar(40) NOT NULL,
            EventCode varchar(60) NOT NULL,
            Summary nvarchar(300) NOT NULL,
            Detail nvarchar(1000) NULL,
            State varchar(20) NOT NULL CONSTRAINT DF_MR_OperationalAlerts_State DEFAULT ('OPEN'),
            OccurrenceCount int NOT NULL CONSTRAINT DF_MR_OperationalAlerts_Occurrences DEFAULT (1),
            FirstSeenAt datetime2(3) NOT NULL CONSTRAINT DF_MR_OperationalAlerts_FirstSeen DEFAULT SYSUTCDATETIME(),
            LastSeenAt datetime2(3) NOT NULL CONSTRAINT DF_MR_OperationalAlerts_LastSeen DEFAULT SYSUTCDATETIME(),
            AcknowledgedAt datetime2(3) NULL,
            AcknowledgedBySicil int NULL,
            ResolvedAt datetime2(3) NULL,
            CorrelationId varchar(64) NULL,
            ContextJson nvarchar(2000) NULL,
            CONSTRAINT CK_MR_OperationalAlerts_Severity CHECK (Severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
            CONSTRAINT CK_MR_OperationalAlerts_State CHECK (State IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
            CONSTRAINT CK_MR_OperationalAlerts_Occurrences CHECK (OccurrenceCount > 0)
        );
        CREATE UNIQUE INDEX UX_MR_OperationalAlerts_ActiveKey
            ON dbo.MR_OperationalAlerts(AlertKey)
            WHERE State <> 'RESOLVED';
        CREATE INDEX IX_MR_OperationalAlerts_LastSeen
            ON dbo.MR_OperationalAlerts(LastSeenAt DESC)
            INCLUDE (Severity, Component, EventCode, State);
    END;

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0012_system_observability')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0012_system_observability', N'Sistem Yönetimi telemetri toplamları, işletim olayları ve otomatik uyarılar');
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
