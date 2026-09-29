SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;

/*
    MERGEN Rota · 0018 — Rota AI yanıt kanıtları.

    Rota verisine dayanan (araçlarla yanıtlanan) asistan iletisinin atıf
    yaptığı kanıtlar saklanır:

      · MR_AiMessageEvidence — iletinin kanıtları (R1, R2 …), ileti başına en
        fazla 16 satır.

    Her satır, modele verilen GÜVENLİ araç sonucunun kendisidir (araç adı,
    kanıt türü, etiket, veri zamanı, tamlık/kısaltma bayrakları, özet ve sınırlı
    JSON). SQL metni, yetki ayrıntısı, API anahtarı, ham sağlayıcı akışı ya da
    akıl yürütme SAKLANMAZ. Kanıt iletiye yabancı anahtarla bağlıdır: konuşma
    silindiğinde iletiler ve kanıtları birlikte silinir (ON DELETE CASCADE).

    Betik yinelenebilir ve veriye dokunmaz. 0017 uygulandıktan sonra çalıştırılır.
    Tablo zaten varsa sütunları, fazladan zorunlu sütun bulunmadığı, birincil
    anahtar, yabancı anahtar ve kısıt/varsayılan TANIMLARI doğrulanır; uyumsuz
    yapı göç olarak işaretlenmez, betik açıklayıcı bir hatayla durur.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_Tasks', N'U') IS NULL
        THROW 51018, N'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0017_ai_assistant_conversations'
    )
        THROW 51018, N'Önce 0017_ai_assistant_conversations göçünü uygulayın.', 1;

    IF OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') IS NULL
        CREATE TABLE dbo.MR_AiMessageEvidence (
            MessageId uniqueidentifier NOT NULL,
            Ordinal tinyint NOT NULL,
            ToolName varchar(64) NOT NULL,
            EvidenceType varchar(40) NOT NULL,
            Label nvarchar(200) NOT NULL,
            EntityType varchar(20) NULL,
            EntityId nvarchar(64) NULL,
            GeneratedAt datetime2(3) NOT NULL,
            IsComplete bit NOT NULL,
            IsTruncated bit NOT NULL,
            SummaryJson nvarchar(4000) NOT NULL,
            EvidenceJson nvarchar(max) NOT NULL,
            CreatedAt datetime2(3) NOT NULL
                CONSTRAINT DF_MR_AiMessageEvidence_CreatedAt DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_MR_AiMessageEvidence PRIMARY KEY (MessageId, Ordinal),
            CONSTRAINT FK_MR_AiMessageEvidence_Message FOREIGN KEY (MessageId)
                REFERENCES dbo.MR_AiConversationMessages(MessageId) ON DELETE CASCADE,
            CONSTRAINT CK_MR_AiMessageEvidence_Ordinal CHECK (Ordinal BETWEEN 1 AND 16),
            CONSTRAINT CK_MR_AiMessageEvidence_ToolName CHECK (ToolName LIKE 'rota[_]%'),
            CONSTRAINT CK_MR_AiMessageEvidence_SummaryJson CHECK (ISJSON(SummaryJson) = 1),
            CONSTRAINT CK_MR_AiMessageEvidence_EvidenceJson CHECK (ISJSON(EvidenceJson) = 1 AND DATALENGTH(EvidenceJson) <= 65536)
        );

    -- Tablo bu betikten ÖNCE oluşturulmuş olabilir: yapısı doğrulanmadan göç
    -- uygulanmış sayılmaz (uyumsuz tablo yanıt kaydını çalışma anında düşürürdü).
    DECLARE @RequiredColumns TABLE (ColumnName sysname, TypeName sysname, MaxLength smallint, Scale tinyint, IsNullable bit);
    INSERT @RequiredColumns VALUES
        (N'MessageId', N'uniqueidentifier', 16, 0, 0),
        (N'Ordinal', N'tinyint', 1, 0, 0),
        (N'ToolName', N'varchar', 64, 0, 0),
        (N'EvidenceType', N'varchar', 40, 0, 0),
        (N'Label', N'nvarchar', 400, 0, 0),
        (N'EntityType', N'varchar', 20, 0, 1),
        (N'EntityId', N'nvarchar', 128, 0, 1),
        (N'GeneratedAt', N'datetime2', 7, 3, 0),
        (N'IsComplete', N'bit', 1, 0, 0),
        (N'IsTruncated', N'bit', 1, 0, 0),
        (N'SummaryJson', N'nvarchar', 8000, 0, 0),
        (N'EvidenceJson', N'nvarchar', -1, 0, 0),
        (N'CreatedAt', N'datetime2', 7, 3, 0);
    IF EXISTS (
        SELECT 1 FROM @RequiredColumns r
        LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') AND c.name = r.ColumnName
        WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id) <> r.TypeName OR c.max_length <> r.MaxLength
            OR c.scale <> r.Scale OR c.is_nullable <> r.IsNullable OR c.is_computed <> 0 OR c.is_identity <> 0
    )
        THROW 51018, N'0018: Mevcut MR_AiMessageEvidence sütunları beklenen yapıda değil. Tabloyu düzeltin ya da kaldırıp göçü yeniden çalıştırın.', 1;

    IF EXISTS (
        SELECT 1 FROM sys.columns c
        WHERE c.object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U')
            AND NOT EXISTS (SELECT 1 FROM @RequiredColumns r WHERE r.ColumnName = c.name)
            AND c.is_nullable = 0 AND c.default_object_id = 0 AND c.is_computed = 0 AND c.is_identity = 0
            AND TYPE_NAME(c.user_type_id) <> N'timestamp'
    )
        THROW 51018, N'0018: MR_AiMessageEvidence tablosunda uygulamanın dolduramayacağı fazladan zorunlu sütun var.', 1;

    -- Birincil anahtar: ileti başına sıra numarası tekildir; başka dizin gerekmez
    -- (kanıtlar yalnızca ileti üzerinden okunur).
    DECLARE @RequiredKeyColumns TABLE (KeyOrdinal tinyint, ColumnName sysname);
    INSERT @RequiredKeyColumns VALUES (1, N'MessageId'), (2, N'Ordinal');
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes i
        WHERE i.object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') AND i.name = N'PK_MR_AiMessageEvidence'
            AND i.is_primary_key = 1 AND i.is_disabled = 0 AND i.type = 1
    )
    OR EXISTS (
        SELECT 1 FROM @RequiredKeyColumns r
        LEFT JOIN sys.indexes i ON i.object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') AND i.name = N'PK_MR_AiMessageEvidence'
        LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = r.KeyOrdinal
        LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE c.name IS NULL OR c.name <> r.ColumnName OR ic.is_descending_key <> 0
    )
    OR (
        SELECT COUNT(*) FROM sys.index_columns k
        JOIN sys.indexes i ON i.object_id = k.object_id AND i.index_id = k.index_id
        WHERE i.object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') AND i.name = N'PK_MR_AiMessageEvidence' AND k.key_ordinal > 0
    ) <> 2
        THROW 51018, N'0018: MR_AiMessageEvidence birincil anahtarı eksik ya da beklenen tanımda değil.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys f
        JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
        JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
        JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
        WHERE f.name = N'FK_MR_AiMessageEvidence_Message'
            AND f.parent_object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U')
            AND f.referenced_object_id = OBJECT_ID(N'dbo.MR_AiConversationMessages', N'U')
            AND pc.name = N'MessageId' AND rc.name = N'MessageId'
            AND f.delete_referential_action = 1 AND f.is_disabled = 0 AND f.is_not_trusted = 0
            AND (SELECT COUNT(*) FROM sys.foreign_key_columns k WHERE k.constraint_object_id = f.object_id) = 1
    )
        THROW 51018, N'0018: Kanıt tablosunun iletiye yabancı anahtarı eksik, güvenilmez ya da ON DELETE CASCADE değil.', 1;

    -- Kısıt ve varsayılanların TANIMLARI, aynı ifadelerle kurulan geçici
    -- tablodaki (aynı sunucu normalleştirmesiyle üretilen) tanımlarla karşılaştırılır.
    IF OBJECT_ID(N'tempdb..#MR_AiMessageEvidence_Expected') IS NOT NULL
        DROP TABLE #MR_AiMessageEvidence_Expected;
    CREATE TABLE #MR_AiMessageEvidence_Expected (
        Ordinal tinyint NOT NULL CHECK (Ordinal BETWEEN 1 AND 16),
        ToolName varchar(64) NOT NULL CHECK (ToolName LIKE 'rota[_]%'),
        SummaryJson nvarchar(4000) NOT NULL CHECK (ISJSON(SummaryJson) = 1),
        EvidenceJson nvarchar(max) NOT NULL CHECK (ISJSON(EvidenceJson) = 1 AND DATALENGTH(EvidenceJson) <= 65536),
        CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
    );

    IF EXISTS (
        SELECT 1 FROM (VALUES
            (N'CK_MR_AiMessageEvidence_Ordinal', N'Ordinal'),
            (N'CK_MR_AiMessageEvidence_ToolName', N'ToolName'),
            (N'CK_MR_AiMessageEvidence_SummaryJson', N'SummaryJson'),
            (N'CK_MR_AiMessageEvidence_EvidenceJson', N'EvidenceJson')
        ) AS r(ConstraintName, ColumnName)
        LEFT JOIN sys.check_constraints k
            ON k.parent_object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') AND k.name = r.ConstraintName
        LEFT JOIN tempdb.sys.columns ec
            ON ec.object_id = OBJECT_ID(N'tempdb..#MR_AiMessageEvidence_Expected') AND ec.name = r.ColumnName
        LEFT JOIN tempdb.sys.check_constraints e
            ON e.parent_object_id = OBJECT_ID(N'tempdb..#MR_AiMessageEvidence_Expected')
            AND e.parent_column_id = COALESCE(ec.column_id, 0)
        WHERE k.object_id IS NULL OR k.is_disabled = 1 OR k.is_not_trusted = 1 OR e.object_id IS NULL
            OR k.definition COLLATE Latin1_General_BIN2 <> e.definition COLLATE Latin1_General_BIN2
    )
        THROW 51018, N'0018: Kanıt tablosunun doğrulama kısıtları eksik, devre dışı, güvenilmez ya da beklenen tanımda değil.', 1;

    IF EXISTS (
        SELECT 1
        FROM sys.columns c
        LEFT JOIN sys.default_constraints d ON d.object_id = c.default_object_id
        LEFT JOIN tempdb.sys.columns ec
            ON ec.object_id = OBJECT_ID(N'tempdb..#MR_AiMessageEvidence_Expected') AND ec.name = N'CreatedAt'
        LEFT JOIN tempdb.sys.default_constraints ed ON ed.object_id = ec.default_object_id
        WHERE c.object_id = OBJECT_ID(N'dbo.MR_AiMessageEvidence', N'U') AND c.name = N'CreatedAt'
            AND (c.default_object_id = 0 OR d.object_id IS NULL OR ed.object_id IS NULL
                OR d.definition COLLATE Latin1_General_BIN2 <> ed.definition COLLATE Latin1_General_BIN2)
    )
        THROW 51018, N'0018: Kanıt tablosunun varsayılan değeri eksik ya da beklenen tanımda değil.', 1;

    DROP TABLE #MR_AiMessageEvidence_Expected;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0018_ai_message_evidence'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (
            N'0018_ai_message_evidence',
            N'Rota AI yanıt kanıtları: iletiye bağlı sınırlı ve güvenli araç sonucu görünümü (SQL, yetki ayrıntısı ve anahtar saklanmaz)'
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
