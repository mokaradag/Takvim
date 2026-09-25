SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

/*
    MERGEN Rota · 0016 — Kişisel yapay zekâ API anahtarları.

    Tek yapı eklenir:

      · MR_AiUserCredentials — Sicil başına EN FAZLA bir kişisel anahtar

    Anahtarın kendisi SAKLANMAZ. Uygulama anahtarı AES-256-GCM ile şifreler
    (anahtar, sunucudaki MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY değerinden
    HKDF-SHA256 ile türetilir) ve sahibinin Sicil'ini ek doğrulanmış veri olarak
    şifreye bağlar: satır başka bir Sicil'e kopyalanırsa çözülemez. Tabloda
    yalnızca nonce, şifreli metin, doğrulama etiketi, ana anahtar kimliği ve
    gösterim için son dört karakter bulunur.

    Konuşma geçmişi, istem ya da yanıt SAKLANMAZ.

    Betik yinelenebilir ve veriye dokunmaz. 0015 uygulandıktan sonra çalıştırılır.
    Tablo zaten varsa (ör. elle oluşturulmuşsa) sütunları, birincil anahtarı,
    kısıtları ve varsayılanları doğrulanır; uyumsuz tablo göç olarak
    işaretlenmez, betik açıklayıcı bir hatayla durur.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_Tasks', N'U') IS NULL
        THROW 51016, N'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0015_assignment_coordination_and_presence'
    )
        THROW 51016, N'Önce 0015_assignment_coordination_and_presence göçünü uygulayın.', 1;

    IF OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') IS NULL
        CREATE TABLE dbo.MR_AiUserCredentials (
            Sicil int NOT NULL,
            EncryptionVersion tinyint NOT NULL,
            MasterKeyId char(16) NOT NULL,
            Nonce varbinary(12) NOT NULL,
            Ciphertext varbinary(1024) NOT NULL,
            AuthTag varbinary(16) NOT NULL,
            KeyHint varchar(4) NOT NULL,
            CreatedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_AiUserCredentials_CreatedAt DEFAULT SYSUTCDATETIME(),
            UpdatedAt datetime2(7) NOT NULL
                CONSTRAINT DF_MR_AiUserCredentials_UpdatedAt DEFAULT SYSUTCDATETIME(),
            LastValidatedAt datetime2(7) NULL,
            LastValidationStatus varchar(20) NULL,
            RowVersion rowversion NOT NULL,
            CONSTRAINT PK_MR_AiUserCredentials PRIMARY KEY (Sicil),
            CONSTRAINT CK_MR_AiUserCredentials_EncryptionVersion CHECK (EncryptionVersion IN (1)),
            CONSTRAINT CK_MR_AiUserCredentials_Nonce CHECK (DATALENGTH(Nonce) = 12),
            CONSTRAINT CK_MR_AiUserCredentials_AuthTag CHECK (DATALENGTH(AuthTag) = 16),
            CONSTRAINT CK_MR_AiUserCredentials_Ciphertext CHECK (DATALENGTH(Ciphertext) BETWEEN 16 AND 1024),
            CONSTRAINT CK_MR_AiUserCredentials_ValidationStatus
                CHECK (LastValidationStatus IS NULL OR LastValidationStatus IN ('VALID','REJECTED','FORBIDDEN'))
        );

    -- Tablo bu betikten ÖNCE (elle ya da yarım kalmış bir kurulumla) oluşturulmuş
    -- olabilir. Yapısı doğrulanmadan göç uygulanmış sayılmaz: uyumsuz bir tablo
    -- 0016 olarak işaretlenseydi çalışma anındaki sorgular düşer ve sonraki
    -- çalıştırmalar şemayı hiçbir zaman onarmazdı.
    DECLARE @RequiredColumns TABLE (ColumnName sysname, TypeName sysname, MaxLength smallint, Scale tinyint, IsNullable bit);
    INSERT @RequiredColumns VALUES
        (N'Sicil', N'int', 4, 0, 0),
        (N'EncryptionVersion', N'tinyint', 1, 0, 0),
        (N'MasterKeyId', N'char', 16, 0, 0),
        (N'Nonce', N'varbinary', 12, 0, 0),
        (N'Ciphertext', N'varbinary', 1024, 0, 0),
        (N'AuthTag', N'varbinary', 16, 0, 0),
        (N'KeyHint', N'varchar', 4, 0, 0),
        (N'CreatedAt', N'datetime2', 8, 7, 0),
        (N'UpdatedAt', N'datetime2', 8, 7, 0),
        (N'LastValidatedAt', N'datetime2', 8, 7, 1),
        (N'LastValidationStatus', N'varchar', 20, 0, 1),
        (N'RowVersion', N'timestamp', 8, 0, 0);
    IF EXISTS (
        SELECT 1 FROM @RequiredColumns r
        LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') AND c.name = r.ColumnName
        WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id) <> r.TypeName OR c.max_length <> r.MaxLength
            OR c.scale <> r.Scale OR c.is_nullable <> r.IsNullable OR c.is_computed <> 0
    )
        THROW 51016, N'0016: Mevcut MR_AiUserCredentials sütunları beklenen yapıda değil. Tabloyu düzeltin ya da kaldırıp göçü yeniden çalıştırın.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = 1
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') AND i.is_primary_key = 1 AND c.name = N'Sicil'
            AND (SELECT COUNT(*) FROM sys.index_columns k
                 WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.key_ordinal > 0) = 1
    )
        THROW 51016, N'0016: MR_AiUserCredentials birincil anahtarı yalnızca Sicil olmalıdır (Sicil başına tek anahtar).', 1;

    IF EXISTS (
        SELECT 1 FROM (VALUES
            (N'CK_MR_AiUserCredentials_EncryptionVersion'),
            (N'CK_MR_AiUserCredentials_Nonce'),
            (N'CK_MR_AiUserCredentials_AuthTag'),
            (N'CK_MR_AiUserCredentials_Ciphertext'),
            (N'CK_MR_AiUserCredentials_ValidationStatus')
        ) AS r(ConstraintName)
        LEFT JOIN sys.check_constraints k
            ON k.parent_object_id = OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') AND k.name = r.ConstraintName
        WHERE k.object_id IS NULL OR k.is_disabled = 1 OR k.is_not_trusted = 1
    )
        THROW 51016, N'0016: MR_AiUserCredentials doğrulama kısıtları eksik, devre dışı ya da güvenilmez.', 1;

    IF EXISTS (
        SELECT 1 FROM sys.columns c
        WHERE c.object_id = OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U')
            AND c.name IN (N'CreatedAt', N'UpdatedAt') AND c.default_object_id = 0
    )
        THROW 51016, N'0016: MR_AiUserCredentials tarih sütunlarının varsayılan değerleri eksik.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0016_ai_user_credentials'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (
            N'0016_ai_user_credentials',
            N'Sicil başına şifreli kişisel yapay zekâ API anahtarı (AES-256-GCM, düz metin saklanmaz)'
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
