SET NOCOUNT ON;
SET XACT_ABORT ON;
/* Filtrelenmiş dizinlerin (UX_MR_AiConversationMessages_Turn / _Reply)
   gerektirdiği oturum seçeneklerinin TAMAMI. İstemci aracı bunlardan birini
   farklı açarsa dizin oluşturulamaz ve göç geri alınır. */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET NUMERIC_ROUNDABORT OFF;

/*
    MERGEN Rota · 0017 — Rota AI konuşma geçmişi.

    İki yapı eklenir:

      · MR_AiConversations        — Sicil'e ait konuşma (başlık, son etkinlik)
      · MR_AiConversationMessages — konuşmanın sıralı kullanıcı/asistan iletileri

    Her konuşmanın sahibi oturumdaki güvenilir Sicil'dir (OwnerSicil); uygulama
    her okuma, yazma ve silmeyi bu Sicil ile sınırlar. Yalnızca kullanıcıya
    görünen ileti metni saklanır: model akıl yürütmesi, ham akış olayları,
    istek nesneleri ve API anahtarı SAKLANMAZ. Tamamlanmamış (durdurulan,
    kesilen, başarısız) yanıt asistan iletisi olarak yazılmaz; yanıtsız kalan
    kullanıcı iletisi yeniden denenebilir turdur.

    Kimlik ve tekillik:
      · (OwnerSicil, OriginTurnId)       — ilk turun yeniden gönderimi ikinci konuşma açmaz
      · (ConversationId, ClientTurnId)   — aynı tur ikinci kullanıcı iletisi üretmez
      · ReplyToMessageId                 — bir kullanıcı turuna en fazla bir yanıt

    Betik yinelenebilir ve veriye dokunmaz. 0016 uygulandıktan sonra çalıştırılır.
    Tablolar zaten varsa (ör. elle oluşturulmuşsa) sütunları, fazladan zorunlu
    sütun bulunmadığı, anahtar ve dizinleri (tekillik, anahtar sütunları, süzgeç),
    yabancı anahtar ve kısıt/varsayılan TANIMLARI doğrulanır; uyumsuz yapı göç
    olarak işaretlenmez, betik açıklayıcı bir hatayla durur.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_Tasks', N'U') IS NULL
        THROW 51017, N'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0016_ai_user_credentials'
    )
        THROW 51017, N'Önce 0016_ai_user_credentials göçünü uygulayın.', 1;

    IF OBJECT_ID(N'dbo.MR_AiConversations', N'U') IS NULL
        CREATE TABLE dbo.MR_AiConversations (
            ConversationId uniqueidentifier NOT NULL,
            OwnerSicil int NOT NULL,
            Title nvarchar(120) NOT NULL,
            OriginTurnId uniqueidentifier NOT NULL,
            MessageCount int NOT NULL
                CONSTRAINT DF_MR_AiConversations_MessageCount DEFAULT (0),
            CreatedAt datetime2(3) NOT NULL
                CONSTRAINT DF_MR_AiConversations_CreatedAt DEFAULT SYSUTCDATETIME(),
            UpdatedAt datetime2(3) NOT NULL
                CONSTRAINT DF_MR_AiConversations_UpdatedAt DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_MR_AiConversations PRIMARY KEY (ConversationId),
            CONSTRAINT CK_MR_AiConversations_Title CHECK (LEN(Title) > 0),
            CONSTRAINT CK_MR_AiConversations_MessageCount CHECK (MessageCount >= 0)
        );

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_AiConversations') AND name = N'UX_MR_AiConversations_OwnerOrigin'
    )
        CREATE UNIQUE INDEX UX_MR_AiConversations_OwnerOrigin
            ON dbo.MR_AiConversations(OwnerSicil, OriginTurnId);

    /* Son konuşmalar listesi (anahtar kümesi sayfalaması) tam tablo taraması yapmaz. */
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_AiConversations') AND name = N'IX_MR_AiConversations_OwnerRecent'
    )
        CREATE INDEX IX_MR_AiConversations_OwnerRecent
            ON dbo.MR_AiConversations(OwnerSicil, UpdatedAt DESC, ConversationId DESC)
            INCLUDE (Title, CreatedAt, MessageCount);

    IF OBJECT_ID(N'dbo.MR_AiConversationMessages', N'U') IS NULL
        CREATE TABLE dbo.MR_AiConversationMessages (
            MessageId uniqueidentifier NOT NULL,
            ConversationId uniqueidentifier NOT NULL,
            Sequence int NOT NULL,
            Role varchar(10) NOT NULL,
            Content nvarchar(max) NOT NULL,
            ClientTurnId uniqueidentifier NULL,
            ReplyToMessageId uniqueidentifier NULL,
            Mode varchar(10) NULL,
            FinishReason varchar(40) NULL,
            CreatedAt datetime2(3) NOT NULL
                CONSTRAINT DF_MR_AiConversationMessages_CreatedAt DEFAULT SYSUTCDATETIME(),
            CONSTRAINT PK_MR_AiConversationMessages PRIMARY KEY NONCLUSTERED (MessageId),
            CONSTRAINT UX_MR_AiConversationMessages_Sequence UNIQUE CLUSTERED (ConversationId, Sequence),
            CONSTRAINT FK_MR_AiConversationMessages_Conversation FOREIGN KEY (ConversationId)
                REFERENCES dbo.MR_AiConversations(ConversationId) ON DELETE CASCADE,
            CONSTRAINT CK_MR_AiConversationMessages_Role CHECK (Role IN ('user','assistant')),
            CONSTRAINT CK_MR_AiConversationMessages_Mode CHECK (Mode IS NULL OR Mode IN ('standard','deep')),
            CONSTRAINT CK_MR_AiConversationMessages_Content CHECK (DATALENGTH(Content) BETWEEN 2 AND 128000),
            CONSTRAINT CK_MR_AiConversationMessages_Sequence CHECK (Sequence > 0),
            CONSTRAINT CK_MR_AiConversationMessages_Shape CHECK (
                (Role = 'user' AND ClientTurnId IS NOT NULL AND ReplyToMessageId IS NULL AND Mode IS NULL AND FinishReason IS NULL)
                OR (Role = 'assistant' AND ClientTurnId IS NULL AND ReplyToMessageId IS NOT NULL))
        );

    /* Aynı tur (yeniden gönderim, çift tıklama) ikinci kullanıcı iletisi üretmez. */
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_AiConversationMessages') AND name = N'UX_MR_AiConversationMessages_Turn'
    )
        CREATE UNIQUE INDEX UX_MR_AiConversationMessages_Turn
            ON dbo.MR_AiConversationMessages(ConversationId, ClientTurnId)
            WHERE ClientTurnId IS NOT NULL;

    /* Bir kullanıcı turuna en fazla bir tamamlanmış yanıt. */
    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_AiConversationMessages') AND name = N'UX_MR_AiConversationMessages_Reply'
    )
        CREATE UNIQUE INDEX UX_MR_AiConversationMessages_Reply
            ON dbo.MR_AiConversationMessages(ReplyToMessageId)
            WHERE ReplyToMessageId IS NOT NULL;

    -- Tablolar bu betikten ÖNCE (elle ya da yarım kalmış bir kurulumla)
    -- oluşturulmuş olabilir. Yapısı doğrulanmadan göç uygulanmış sayılmaz:
    -- uyumsuz bir yapı 0017 olarak işaretlenseydi çalışma anındaki sorgular düşer,
    -- tekillik varsayımları (yinelenmeyen tur, tek yanıt) sessizce bozulurdu.
    DECLARE @RequiredColumns TABLE (TableName sysname, ColumnName sysname, TypeName sysname, MaxLength smallint, Scale tinyint, IsNullable bit);
    INSERT @RequiredColumns VALUES
        (N'MR_AiConversations', N'ConversationId', N'uniqueidentifier', 16, 0, 0),
        (N'MR_AiConversations', N'OwnerSicil', N'int', 4, 0, 0),
        (N'MR_AiConversations', N'Title', N'nvarchar', 240, 0, 0),
        (N'MR_AiConversations', N'OriginTurnId', N'uniqueidentifier', 16, 0, 0),
        (N'MR_AiConversations', N'MessageCount', N'int', 4, 0, 0),
        (N'MR_AiConversations', N'CreatedAt', N'datetime2', 7, 3, 0),
        (N'MR_AiConversations', N'UpdatedAt', N'datetime2', 7, 3, 0),
        (N'MR_AiConversationMessages', N'MessageId', N'uniqueidentifier', 16, 0, 0),
        (N'MR_AiConversationMessages', N'ConversationId', N'uniqueidentifier', 16, 0, 0),
        (N'MR_AiConversationMessages', N'Sequence', N'int', 4, 0, 0),
        (N'MR_AiConversationMessages', N'Role', N'varchar', 10, 0, 0),
        (N'MR_AiConversationMessages', N'Content', N'nvarchar', -1, 0, 0),
        (N'MR_AiConversationMessages', N'ClientTurnId', N'uniqueidentifier', 16, 0, 1),
        (N'MR_AiConversationMessages', N'ReplyToMessageId', N'uniqueidentifier', 16, 0, 1),
        (N'MR_AiConversationMessages', N'Mode', N'varchar', 10, 0, 1),
        (N'MR_AiConversationMessages', N'FinishReason', N'varchar', 40, 0, 1),
        (N'MR_AiConversationMessages', N'CreatedAt', N'datetime2', 7, 3, 0);
    -- Uygulama kimlikleri ve öteki sütunları kendisi yazar: IDENTITY ya da
    -- hesaplanan bir sütun ilk kayıtta INSERT'i düşürür.
    IF EXISTS (
        SELECT 1 FROM @RequiredColumns r
        LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND c.name = r.ColumnName
        WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id) <> r.TypeName OR c.max_length <> r.MaxLength
            OR c.scale <> r.Scale OR c.is_nullable <> r.IsNullable OR c.is_computed <> 0 OR c.is_identity <> 0
    )
        THROW 51017, N'0017: Mevcut MR_AiConversations / MR_AiConversationMessages sütunları beklenen yapıda değil. Tabloları düzeltin ya da kaldırıp göçü yeniden çalıştırın.', 1;

    -- Uygulamanın INSERT'i yalnızca yukarıdaki sütunları verir: fazladan eklenmiş,
    -- boş geçilemeyen ve varsayılanı olmayan bir sütun her kaydı düşürürdü.
    IF EXISTS (
        SELECT 1 FROM sys.columns c
        WHERE c.object_id IN (OBJECT_ID(N'dbo.MR_AiConversations', N'U'), OBJECT_ID(N'dbo.MR_AiConversationMessages', N'U'))
            AND NOT EXISTS (
                SELECT 1 FROM @RequiredColumns r
                WHERE OBJECT_ID(N'dbo.' + r.TableName, N'U') = c.object_id AND r.ColumnName = c.name
            )
            AND c.is_nullable = 0 AND c.default_object_id = 0 AND c.is_computed = 0 AND c.is_identity = 0
            AND TYPE_NAME(c.user_type_id) <> N'timestamp'
    )
        THROW 51017, N'0017: Konuşma tablolarında uygulamanın dolduramayacağı fazladan zorunlu sütun var.', 1;

    -- Anahtarlar ve dizinler: tekillik, anahtar sütunlarının sırası ve yönü.
    DECLARE @RequiredIndexColumns TABLE (TableName sysname, IndexName sysname, IsUnique bit, KeyOrdinal tinyint, ColumnName sysname, IsDescending bit);
    INSERT @RequiredIndexColumns VALUES
        (N'MR_AiConversations', N'PK_MR_AiConversations', 1, 1, N'ConversationId', 0),
        (N'MR_AiConversations', N'UX_MR_AiConversations_OwnerOrigin', 1, 1, N'OwnerSicil', 0),
        (N'MR_AiConversations', N'UX_MR_AiConversations_OwnerOrigin', 1, 2, N'OriginTurnId', 0),
        (N'MR_AiConversations', N'IX_MR_AiConversations_OwnerRecent', 0, 1, N'OwnerSicil', 0),
        (N'MR_AiConversations', N'IX_MR_AiConversations_OwnerRecent', 0, 2, N'UpdatedAt', 1),
        (N'MR_AiConversations', N'IX_MR_AiConversations_OwnerRecent', 0, 3, N'ConversationId', 1),
        (N'MR_AiConversationMessages', N'PK_MR_AiConversationMessages', 1, 1, N'MessageId', 0),
        (N'MR_AiConversationMessages', N'UX_MR_AiConversationMessages_Sequence', 1, 1, N'ConversationId', 0),
        (N'MR_AiConversationMessages', N'UX_MR_AiConversationMessages_Sequence', 1, 2, N'Sequence', 0),
        (N'MR_AiConversationMessages', N'UX_MR_AiConversationMessages_Turn', 1, 1, N'ConversationId', 0),
        (N'MR_AiConversationMessages', N'UX_MR_AiConversationMessages_Turn', 1, 2, N'ClientTurnId', 0),
        (N'MR_AiConversationMessages', N'UX_MR_AiConversationMessages_Reply', 1, 1, N'ReplyToMessageId', 0);
    IF EXISTS (
        SELECT 1 FROM @RequiredIndexColumns r
        LEFT JOIN sys.indexes i ON i.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND i.name = r.IndexName
        LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = r.KeyOrdinal
        LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.index_id IS NULL OR i.is_disabled = 1 OR i.is_hypothetical = 1 OR i.is_unique <> r.IsUnique
            OR c.name IS NULL OR c.name <> r.ColumnName OR ic.is_descending_key <> r.IsDescending
            OR (r.IndexName NOT IN (N'UX_MR_AiConversationMessages_Turn', N'UX_MR_AiConversationMessages_Reply')
                AND (i.has_filter = 1 OR i.filter_definition IS NOT NULL))
    )
        THROW 51017, N'0017: Konuşma tablolarının anahtarları ya da dizinleri eksik, devre dışı ya da beklenen tanımda değil.', 1;

    IF EXISTS (
        SELECT 1 FROM (SELECT DISTINCT TableName, IndexName FROM @RequiredIndexColumns) r
        JOIN sys.indexes i ON i.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND i.name = r.IndexName
        WHERE (SELECT COUNT(*) FROM sys.index_columns k WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.key_ordinal > 0)
            <> (SELECT COUNT(*) FROM @RequiredIndexColumns x WHERE x.TableName = r.TableName AND x.IndexName = r.IndexName)
    )
        THROW 51017, N'0017: Konuşma dizinlerinden biri fazladan anahtar sütunu taşıyor.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys f
        JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
        JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
        JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
        WHERE f.name = N'FK_MR_AiConversationMessages_Conversation'
            AND f.parent_object_id = OBJECT_ID(N'dbo.MR_AiConversationMessages', N'U')
            AND f.referenced_object_id = OBJECT_ID(N'dbo.MR_AiConversations', N'U')
            AND pc.name = N'ConversationId' AND rc.name = N'ConversationId'
            AND f.delete_referential_action = 1 AND f.is_disabled = 0 AND f.is_not_trusted = 0
            AND (SELECT COUNT(*) FROM sys.foreign_key_columns k WHERE k.constraint_object_id = f.object_id) = 1
    )
        THROW 51017, N'0017: İleti tablosunun konuşmaya yabancı anahtarı eksik, güvenilmez ya da ON DELETE CASCADE değil.', 1;

    -- Kısıtların, dizin süzgeçlerinin ve varsayılanların yalnızca ADLARI değil
    -- TANIMLARI da doğrulanır: beklenen tanımlar aynı ifadelerle kurulan geçici
    -- tablolarda aynı sunucunun normalleştirmesiyle üretilir. Geçici tablolarda
    -- kısıt adı verilmez (tempdb'de oturumlar arası ad çakışması olmaz).
    IF OBJECT_ID(N'tempdb..#MR_AiConversations_Expected') IS NOT NULL
        DROP TABLE #MR_AiConversations_Expected;
    CREATE TABLE #MR_AiConversations_Expected (
        Title nvarchar(120) NOT NULL CHECK (LEN(Title) > 0),
        MessageCount int NOT NULL DEFAULT (0) CHECK (MessageCount >= 0),
        CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
    );
    IF OBJECT_ID(N'tempdb..#MR_AiConversationMessages_Expected') IS NOT NULL
        DROP TABLE #MR_AiConversationMessages_Expected;
    CREATE TABLE #MR_AiConversationMessages_Expected (
        ConversationId uniqueidentifier NOT NULL,
        Sequence int NOT NULL CHECK (Sequence > 0),
        Role varchar(10) NOT NULL CHECK (Role IN ('user','assistant')),
        Content nvarchar(max) NOT NULL CHECK (DATALENGTH(Content) BETWEEN 2 AND 128000),
        ClientTurnId uniqueidentifier NULL,
        ReplyToMessageId uniqueidentifier NULL,
        Mode varchar(10) NULL CHECK (Mode IS NULL OR Mode IN ('standard','deep')),
        CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
    );
    CREATE UNIQUE INDEX UX_Turn ON #MR_AiConversationMessages_Expected(ConversationId, ClientTurnId) WHERE ClientTurnId IS NOT NULL;
    CREATE UNIQUE INDEX UX_Reply ON #MR_AiConversationMessages_Expected(ReplyToMessageId) WHERE ReplyToMessageId IS NOT NULL;
    -- Birden çok sütuna bağlı tablo düzeyi kısıt kendi geçici tablosunda kurulur.
    IF OBJECT_ID(N'tempdb..#MR_AiConversationMessages_Shape') IS NOT NULL
        DROP TABLE #MR_AiConversationMessages_Shape;
    CREATE TABLE #MR_AiConversationMessages_Shape (
        Role varchar(10) NOT NULL,
        ClientTurnId uniqueidentifier NULL,
        ReplyToMessageId uniqueidentifier NULL,
        Mode varchar(10) NULL,
        FinishReason varchar(40) NULL,
        CHECK (
            (Role = 'user' AND ClientTurnId IS NOT NULL AND ReplyToMessageId IS NULL AND Mode IS NULL AND FinishReason IS NULL)
            OR (Role = 'assistant' AND ClientTurnId IS NULL AND ReplyToMessageId IS NOT NULL))
    );

    IF EXISTS (
        SELECT 1 FROM (VALUES
            (N'MR_AiConversations', N'CK_MR_AiConversations_Title', N'#MR_AiConversations_Expected', N'Title'),
            (N'MR_AiConversations', N'CK_MR_AiConversations_MessageCount', N'#MR_AiConversations_Expected', N'MessageCount'),
            (N'MR_AiConversationMessages', N'CK_MR_AiConversationMessages_Sequence', N'#MR_AiConversationMessages_Expected', N'Sequence'),
            (N'MR_AiConversationMessages', N'CK_MR_AiConversationMessages_Role', N'#MR_AiConversationMessages_Expected', N'Role'),
            (N'MR_AiConversationMessages', N'CK_MR_AiConversationMessages_Content', N'#MR_AiConversationMessages_Expected', N'Content'),
            (N'MR_AiConversationMessages', N'CK_MR_AiConversationMessages_Mode', N'#MR_AiConversationMessages_Expected', N'Mode'),
            (N'MR_AiConversationMessages', N'CK_MR_AiConversationMessages_Shape', N'#MR_AiConversationMessages_Shape', NULL)
        ) AS r(TableName, ConstraintName, ExpectedTable, ColumnName)
        LEFT JOIN sys.check_constraints k
            ON k.parent_object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND k.name = r.ConstraintName
        LEFT JOIN tempdb.sys.columns ec
            ON ec.object_id = OBJECT_ID(N'tempdb..' + r.ExpectedTable) AND ec.name = r.ColumnName
        LEFT JOIN tempdb.sys.check_constraints e
            ON e.parent_object_id = OBJECT_ID(N'tempdb..' + r.ExpectedTable)
            AND e.parent_column_id = COALESCE(ec.column_id, 0)
        WHERE k.object_id IS NULL OR k.is_disabled = 1 OR k.is_not_trusted = 1 OR e.object_id IS NULL
            OR k.definition COLLATE Latin1_General_BIN2 <> e.definition COLLATE Latin1_General_BIN2
    )
        THROW 51017, N'0017: Konuşma tablolarının doğrulama kısıtları eksik, devre dışı, güvenilmez ya da beklenen tanımda değil.', 1;

    IF EXISTS (
        SELECT 1 FROM (VALUES (N'UX_MR_AiConversationMessages_Turn', N'UX_Turn'), (N'UX_MR_AiConversationMessages_Reply', N'UX_Reply')) AS r(IndexName, ExpectedIndex)
        LEFT JOIN sys.indexes i
            ON i.object_id = OBJECT_ID(N'dbo.MR_AiConversationMessages', N'U') AND i.name = r.IndexName
        LEFT JOIN tempdb.sys.indexes e
            ON e.object_id = OBJECT_ID(N'tempdb..#MR_AiConversationMessages_Expected') AND e.name = r.ExpectedIndex
        WHERE i.index_id IS NULL OR e.index_id IS NULL OR i.has_filter = 0
            OR i.filter_definition COLLATE Latin1_General_BIN2 <> e.filter_definition COLLATE Latin1_General_BIN2
    )
        THROW 51017, N'0017: Tur ve yanıt tekilliği dizinleri beklenen süzgeçle tanımlı değil.', 1;

    IF EXISTS (
        SELECT 1 FROM (VALUES
            (N'MR_AiConversations', N'MessageCount', N'#MR_AiConversations_Expected'),
            (N'MR_AiConversations', N'CreatedAt', N'#MR_AiConversations_Expected'),
            (N'MR_AiConversations', N'UpdatedAt', N'#MR_AiConversations_Expected'),
            (N'MR_AiConversationMessages', N'CreatedAt', N'#MR_AiConversationMessages_Expected')
        ) AS r(TableName, ColumnName, ExpectedTable)
        LEFT JOIN sys.columns c
            ON c.object_id = OBJECT_ID(N'dbo.' + r.TableName, N'U') AND c.name = r.ColumnName
        LEFT JOIN sys.default_constraints d ON d.object_id = c.default_object_id
        LEFT JOIN tempdb.sys.columns ec
            ON ec.object_id = OBJECT_ID(N'tempdb..' + r.ExpectedTable) AND ec.name = r.ColumnName
        LEFT JOIN tempdb.sys.default_constraints ed ON ed.object_id = ec.default_object_id
        WHERE c.default_object_id = 0 OR d.object_id IS NULL OR ed.object_id IS NULL
            OR d.definition COLLATE Latin1_General_BIN2 <> ed.definition COLLATE Latin1_General_BIN2
    )
        THROW 51017, N'0017: Konuşma tablolarının varsayılan değerleri eksik ya da beklenen tanımda değil.', 1;

    DROP TABLE #MR_AiConversations_Expected;
    DROP TABLE #MR_AiConversationMessages_Expected;
    DROP TABLE #MR_AiConversationMessages_Shape;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0017_ai_assistant_conversations'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (
            N'0017_ai_assistant_conversations',
            N'Rota AI konuşma geçmişi: Sicil sahipli konuşmalar ve sıralı iletiler (akıl yürütme ve ham akış saklanmaz)'
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
