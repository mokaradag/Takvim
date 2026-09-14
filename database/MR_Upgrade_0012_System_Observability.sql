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

    -- Göç tablosunun VARLIĞI sıranın doğru olduğunu kanıtlamaz: 0010'da duran
    -- bir veritabanında bu betik 0012 nesnelerini kurup 0012 kaydını yazar ve
    -- 0011 sessizce eksik kalırdı.
    IF NOT EXISTS (
        SELECT 1
        FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0011_outlook_completion_lifecycle'
    )
        THROW 51012, 'Önce 0011_outlook_completion_lifecycle göçünü uygulayın.', 1;

    -- İşlem toplamları. Her istek için satır YAZILMAZ: uygulama gözlemleri
    -- bellekte beş dakikalık kovalarda toplanır, yalnızca kapanmış kova yazılır.
    -- InstanceId anahtarın PARÇASIDIR: birden çok uygulama süreci aynı kovaya
    -- yazdığında satırlar birbirinin yüzdeliklerini ezmez ve süreç ölçümleri
    -- tek bir seriye karışmaz. LastFlushId, başarıyla yazılmış bir boşaltmanın
    -- belirsiz hata sonrası yeniden gönderilmesinde sayıların İKİNCİ kez
    -- toplanmasını engeller.
    IF OBJECT_ID(N'dbo.MR_TelemetryOperationSamples', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.MR_TelemetryOperationSamples (
            BucketStart datetime2(0) NOT NULL,
            Operation nvarchar(100) NOT NULL,
            InstanceId varchar(64) NOT NULL CONSTRAINT DF_MR_TelemetryOperation_Instance DEFAULT ('default'),
            SampleCount int NOT NULL,
            ErrorCount int NOT NULL CONSTRAINT DF_MR_TelemetryOperation_ErrorCount DEFAULT (0),
            DurationSumMs bigint NOT NULL CONSTRAINT DF_MR_TelemetryOperation_DurationSum DEFAULT (0),
            DurationMaxMs int NOT NULL CONSTRAINT DF_MR_TelemetryOperation_DurationMax DEFAULT (0),
            P50Ms int NULL,
            P95Ms int NULL,
            P99Ms int NULL,
            TopFailureCode varchar(60) NULL,
            LastFlushId varchar(64) NULL,
            CONSTRAINT PK_MR_TelemetryOperationSamples PRIMARY KEY (BucketStart, Operation, InstanceId),
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
            InstanceId varchar(64) NOT NULL CONSTRAINT DF_MR_TelemetryGauge_Instance DEFAULT ('default'),
            SampleCount int NOT NULL,
            ValueAvg float NOT NULL,
            ValueMin float NOT NULL,
            ValueMax float NOT NULL,
            LastFlushId varchar(64) NULL,
            CONSTRAINT PK_MR_TelemetryGaugeSamples PRIMARY KEY (BucketStart, MetricKey, InstanceId),
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
            -- Aynı sorunun kararlı parmak izi: bellekteki birleştirme yalnızca
            -- tek turu kapsar; tur sınırında bölünen yineleme burada da tek
            -- satırda toplanır.
            AggregationKey varchar(200) NULL,
            CONSTRAINT CK_MR_OperationalEvents_Severity CHECK (Severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
            CONSTRAINT CK_MR_OperationalEvents_Occurrences CHECK (OccurrenceCount > 0)
        );
        CREATE INDEX IX_MR_OperationalEvents_OccurredAt
            ON dbo.MR_OperationalEvents(OccurredAt DESC)
            INCLUDE (Severity, Component, EventCode, Summary, OccurrenceCount);
        CREATE INDEX IX_MR_OperationalEvents_Component
            ON dbo.MR_OperationalEvents(Component, OccurredAt DESC)
            INCLUDE (Severity, EventCode);
        -- Toplama araması yalnızca bu dizin üzerinden çalışır.
        CREATE INDEX IX_MR_OperationalEvents_Aggregate
            ON dbo.MR_OperationalEvents(AggregationKey, OccurredAt DESC)
            INCLUDE (OccurrenceCount);
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

    -- Mevcut nesneler de aynı sözleşmeyi sağlamalıdır; uyumsuz şema başarı sayılmaz.
    DECLARE @RequiredColumns TABLE (
        TableName sysname, ColumnName sysname, TypeName sysname,
        MaxLength smallint, Scale tinyint, IsNullable bit, IsIdentity bit
    );
    INSERT @RequiredColumns VALUES
        (N'MR_TelemetryOperationSamples', N'BucketStart', N'datetime2', 6, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'Operation', N'nvarchar', 200, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'InstanceId', N'varchar', 64, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'SampleCount', N'int', 4, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'ErrorCount', N'int', 4, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'DurationSumMs', N'bigint', 8, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'DurationMaxMs', N'int', 4, 0, 0, 0),
        (N'MR_TelemetryOperationSamples', N'P50Ms', N'int', 4, 0, 1, 0),
        (N'MR_TelemetryOperationSamples', N'P95Ms', N'int', 4, 0, 1, 0),
        (N'MR_TelemetryOperationSamples', N'P99Ms', N'int', 4, 0, 1, 0),
        (N'MR_TelemetryOperationSamples', N'TopFailureCode', N'varchar', 60, 0, 1, 0),
        (N'MR_TelemetryOperationSamples', N'LastFlushId', N'varchar', 64, 0, 1, 0),
        (N'MR_TelemetryGaugeSamples', N'BucketStart', N'datetime2', 6, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'MetricKey', N'varchar', 60, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'InstanceId', N'varchar', 64, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'SampleCount', N'int', 4, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'ValueAvg', N'float', 8, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'ValueMin', N'float', 8, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'ValueMax', N'float', 8, 0, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'LastFlushId', N'varchar', 64, 0, 1, 0),
        (N'MR_OperationalEvents', N'OperationalEventId', N'bigint', 8, 0, 0, 1),
        (N'MR_OperationalEvents', N'OccurredAt', N'datetime2', 7, 3, 0, 0),
        (N'MR_OperationalEvents', N'Severity', N'varchar', 10, 0, 0, 0),
        (N'MR_OperationalEvents', N'Component', N'varchar', 40, 0, 0, 0),
        (N'MR_OperationalEvents', N'EventCode', N'varchar', 60, 0, 0, 0),
        (N'MR_OperationalEvents', N'Summary', N'nvarchar', 600, 0, 0, 0),
        (N'MR_OperationalEvents', N'Detail', N'nvarchar', 2000, 0, 1, 0),
        (N'MR_OperationalEvents', N'CorrelationId', N'varchar', 64, 0, 1, 0),
        (N'MR_OperationalEvents', N'OccurrenceCount', N'int', 4, 0, 0, 0),
        (N'MR_OperationalEvents', N'ContextJson', N'nvarchar', 4000, 0, 1, 0),
        (N'MR_OperationalEvents', N'AggregationKey', N'varchar', 200, 0, 1, 0),
        (N'MR_OperationalAlerts', N'OperationalAlertId', N'bigint', 8, 0, 0, 1),
        (N'MR_OperationalAlerts', N'AlertKey', N'varchar', 200, 0, 0, 0),
        (N'MR_OperationalAlerts', N'Severity', N'varchar', 10, 0, 0, 0),
        (N'MR_OperationalAlerts', N'Component', N'varchar', 40, 0, 0, 0),
        (N'MR_OperationalAlerts', N'EventCode', N'varchar', 60, 0, 0, 0),
        (N'MR_OperationalAlerts', N'Summary', N'nvarchar', 600, 0, 0, 0),
        (N'MR_OperationalAlerts', N'Detail', N'nvarchar', 2000, 0, 1, 0),
        (N'MR_OperationalAlerts', N'State', N'varchar', 20, 0, 0, 0),
        (N'MR_OperationalAlerts', N'OccurrenceCount', N'int', 4, 0, 0, 0),
        (N'MR_OperationalAlerts', N'FirstSeenAt', N'datetime2', 7, 3, 0, 0),
        (N'MR_OperationalAlerts', N'LastSeenAt', N'datetime2', 7, 3, 0, 0),
        (N'MR_OperationalAlerts', N'AcknowledgedAt', N'datetime2', 7, 3, 1, 0),
        (N'MR_OperationalAlerts', N'AcknowledgedBySicil', N'int', 4, 0, 1, 0),
        (N'MR_OperationalAlerts', N'ResolvedAt', N'datetime2', 7, 3, 1, 0),
        (N'MR_OperationalAlerts', N'CorrelationId', N'varchar', 64, 0, 1, 0),
        (N'MR_OperationalAlerts', N'ContextJson', N'nvarchar', 4000, 0, 1, 0);

    IF EXISTS (
        SELECT 1 FROM @RequiredColumns r
        LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND c.name = r.ColumnName
        WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id) <> r.TypeName
            OR (r.TypeName <> N'datetime2' AND c.max_length <> r.MaxLength) OR c.scale <> r.Scale
            OR c.is_nullable <> r.IsNullable OR c.is_identity <> r.IsIdentity OR c.is_computed <> 0
    )
        THROW 51012, '0012: Mevcut telemetri sütunları uyumsuz. Şemayı düzeltip göçü yeniden çalıştırın.', 1;

    DECLARE @RequiredIndexes TABLE (
        TableName sysname, IndexName sysname, IsUnique bit, IsPrimaryKey bit, FilterDefinition nvarchar(200)
    );
    INSERT @RequiredIndexes VALUES
        (N'MR_TelemetryOperationSamples', N'PK_MR_TelemetryOperationSamples', 1, 1, NULL),
        (N'MR_TelemetryGaugeSamples', N'PK_MR_TelemetryGaugeSamples', 1, 1, NULL),
        (N'MR_OperationalEvents', N'PK_MR_OperationalEvents', 1, 1, NULL),
        (N'MR_OperationalAlerts', N'PK_MR_OperationalAlerts', 1, 1, NULL),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', 0, 0, NULL),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', 0, 0, NULL),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', 0, 0, NULL),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Component', 0, 0, NULL),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Aggregate', 0, 0, NULL),
        (N'MR_OperationalAlerts', N'UX_MR_OperationalAlerts_ActiveKey', 1, 0, N'state<>''resolved'''),
        (N'MR_OperationalAlerts', N'IX_MR_OperationalAlerts_LastSeen', 0, 0, NULL);
    IF EXISTS (
        SELECT 1 FROM @RequiredIndexes r
        LEFT JOIN sys.indexes i ON i.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND i.name = r.IndexName
        WHERE i.index_id IS NULL OR i.is_disabled = 1 OR i.is_hypothetical = 1
            OR i.is_unique <> r.IsUnique OR i.is_primary_key <> r.IsPrimaryKey
            OR ISNULL(LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(i.filter_definition,
                N' ', N''), N'[', N''), N']', N''), N'(', N''), N')', N'')), N'') <> ISNULL(r.FilterDefinition, N'')
    )
        THROW 51012, '0012: Gerekli telemetri dizini eksik veya uyumsuz.', 1;

    DECLARE @RequiredIndexColumns TABLE (
        TableName sysname, IndexName sysname, ColumnName sysname, KeyOrdinal int, IsDescending bit, IsIncluded bit
    );
    INSERT @RequiredIndexColumns VALUES
        (N'MR_TelemetryOperationSamples', N'PK_MR_TelemetryOperationSamples', N'BucketStart', 1, 0, 0),
        (N'MR_TelemetryOperationSamples', N'PK_MR_TelemetryOperationSamples', N'Operation', 2, 0, 0),
        (N'MR_TelemetryOperationSamples', N'PK_MR_TelemetryOperationSamples', N'InstanceId', 3, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'PK_MR_TelemetryGaugeSamples', N'BucketStart', 1, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'PK_MR_TelemetryGaugeSamples', N'MetricKey', 2, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'PK_MR_TelemetryGaugeSamples', N'InstanceId', 3, 0, 0),
        (N'MR_OperationalEvents', N'PK_MR_OperationalEvents', N'OperationalEventId', 1, 0, 0),
        (N'MR_OperationalAlerts', N'PK_MR_OperationalAlerts', N'OperationalAlertId', 1, 0, 0),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'BucketStart', 1, 0, 0),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'Operation', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'SampleCount', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'ErrorCount', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'DurationSumMs', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'DurationMaxMs', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'P50Ms', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'P95Ms', 0, 0, 1),
        (N'MR_TelemetryOperationSamples', N'IX_MR_TelemetryOperationSamples_Bucket', N'P99Ms', 0, 0, 1),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', N'MetricKey', 1, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', N'BucketStart', 2, 0, 0),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', N'SampleCount', 0, 0, 1),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', N'ValueAvg', 0, 0, 1),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', N'ValueMin', 0, 0, 1),
        (N'MR_TelemetryGaugeSamples', N'IX_MR_TelemetryGaugeSamples_Metric', N'ValueMax', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', N'OccurredAt', 1, 1, 0),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', N'Severity', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', N'Component', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', N'EventCode', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', N'Summary', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_OccurredAt', N'OccurrenceCount', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Component', N'Component', 1, 0, 0),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Component', N'OccurredAt', 2, 1, 0),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Component', N'Severity', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Component', N'EventCode', 0, 0, 1),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Aggregate', N'AggregationKey', 1, 0, 0),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Aggregate', N'OccurredAt', 2, 1, 0),
        (N'MR_OperationalEvents', N'IX_MR_OperationalEvents_Aggregate', N'OccurrenceCount', 0, 0, 1),
        (N'MR_OperationalAlerts', N'UX_MR_OperationalAlerts_ActiveKey', N'AlertKey', 1, 0, 0),
        (N'MR_OperationalAlerts', N'IX_MR_OperationalAlerts_LastSeen', N'LastSeenAt', 1, 1, 0),
        (N'MR_OperationalAlerts', N'IX_MR_OperationalAlerts_LastSeen', N'Severity', 0, 0, 1),
        (N'MR_OperationalAlerts', N'IX_MR_OperationalAlerts_LastSeen', N'Component', 0, 0, 1),
        (N'MR_OperationalAlerts', N'IX_MR_OperationalAlerts_LastSeen', N'EventCode', 0, 0, 1),
        (N'MR_OperationalAlerts', N'IX_MR_OperationalAlerts_LastSeen', N'State', 0, 0, 1);
    IF EXISTS (
        SELECT 1 FROM @RequiredIndexColumns r
        WHERE NOT EXISTS (
            SELECT 1 FROM sys.indexes i
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE i.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND i.name = r.IndexName
                AND c.name = r.ColumnName AND ic.key_ordinal = r.KeyOrdinal
                AND ic.is_descending_key = r.IsDescending AND ic.is_included_column = r.IsIncluded
        )
    ) OR EXISTS (
        SELECT 1 FROM @RequiredIndexes r
        JOIN sys.indexes i ON i.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND i.name = r.IndexName
        WHERE (SELECT COUNT(*) FROM sys.index_columns ic
               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0)
            <> (SELECT COUNT(*) FROM @RequiredIndexColumns c
                WHERE c.TableName = r.TableName AND c.IndexName = r.IndexName AND c.KeyOrdinal > 0)
    )
        THROW 51012, '0012: Telemetri dizin sütunları veya anahtar sırası uyumsuz.', 1;

    DECLARE @RequiredChecks TABLE (
        TableName sysname, ConstraintName sysname, Definition nvarchar(500),
        ExpandedDefinition nvarchar(500), ReversedDefinition nvarchar(500)
    );
    INSERT @RequiredChecks VALUES
        (N'MR_TelemetryOperationSamples', N'CK_MR_TelemetryOperation_Counts', N'samplecount>=0anderrorcount>=0anderrorcount<=samplecount', N'samplecount>=0anderrorcount>=0anderrorcount<=samplecount', N'samplecount>=0anderrorcount>=0anderrorcount<=samplecount'),
        (N'MR_TelemetryGaugeSamples', N'CK_MR_TelemetryGauge_SampleCount', N'samplecount>0', N'samplecount>0', N'samplecount>0'),
        (N'MR_OperationalEvents', N'CK_MR_OperationalEvents_Severity', N'severityin''info'',''warning'',''error'',''critical''', N'severity=''info''orseverity=''warning''orseverity=''error''orseverity=''critical''', N'severity=''critical''orseverity=''error''orseverity=''warning''orseverity=''info'''),
        (N'MR_OperationalEvents', N'CK_MR_OperationalEvents_Occurrences', N'occurrencecount>0', N'occurrencecount>0', N'occurrencecount>0'),
        (N'MR_OperationalAlerts', N'CK_MR_OperationalAlerts_Severity', N'severityin''info'',''warning'',''error'',''critical''', N'severity=''info''orseverity=''warning''orseverity=''error''orseverity=''critical''', N'severity=''critical''orseverity=''error''orseverity=''warning''orseverity=''info'''),
        (N'MR_OperationalAlerts', N'CK_MR_OperationalAlerts_State', N'statein''open'',''acknowledged'',''resolved''', N'state=''open''orstate=''acknowledged''orstate=''resolved''', N'state=''resolved''orstate=''acknowledged''orstate=''open'''),
        (N'MR_OperationalAlerts', N'CK_MR_OperationalAlerts_Occurrences', N'occurrencecount>0', N'occurrencecount>0', N'occurrencecount>0');
    IF EXISTS (
        SELECT 1 FROM @RequiredChecks r
        LEFT JOIN sys.check_constraints c ON c.parent_object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND c.name = r.ConstraintName
        WHERE c.object_id IS NULL OR c.is_disabled = 1 OR c.is_not_trusted = 1
            OR LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.definition,
                N' ', N''), N'[', N''), N']', N''), N'(', N''), N')', N''))
                NOT IN (r.Definition, r.ExpandedDefinition, r.ReversedDefinition)
    )
        THROW 51012, '0012: Telemetri doğrulama kısıtları eksik veya uyumsuz.', 1;

    DECLARE @RequiredDefaults TABLE (TableName sysname, ColumnName sysname, Definition nvarchar(200));
    INSERT @RequiredDefaults VALUES
        (N'MR_TelemetryOperationSamples', N'InstanceId', N'''default'''),
        (N'MR_TelemetryOperationSamples', N'ErrorCount', N'0'),
        (N'MR_TelemetryOperationSamples', N'DurationSumMs', N'0'),
        (N'MR_TelemetryOperationSamples', N'DurationMaxMs', N'0'),
        (N'MR_TelemetryGaugeSamples', N'InstanceId', N'''default'''),
        (N'MR_OperationalEvents', N'OccurredAt', N'sysutcdatetime'),
        (N'MR_OperationalEvents', N'OccurrenceCount', N'1'),
        (N'MR_OperationalAlerts', N'State', N'''open'''),
        (N'MR_OperationalAlerts', N'OccurrenceCount', N'1'),
        (N'MR_OperationalAlerts', N'FirstSeenAt', N'sysutcdatetime'),
        (N'MR_OperationalAlerts', N'LastSeenAt', N'sysutcdatetime');
    IF EXISTS (
        SELECT 1 FROM @RequiredDefaults r
        JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND c.name = r.ColumnName
        LEFT JOIN sys.default_constraints d ON d.object_id = c.default_object_id
        WHERE d.object_id IS NULL OR LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(d.definition,
            N' ', N''), N'[', N''), N']', N''), N'(', N''), N')', N'')) <> r.Definition
    )
        THROW 51012, '0012: Telemetri varsayılan değerleri eksik veya uyumsuz.', 1;

    IF NOT EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0012_system_observability')
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0012_system_observability', N'Sistem Yönetimi telemetri toplamları, işletim olayları ve otomatik uyarılar');
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
