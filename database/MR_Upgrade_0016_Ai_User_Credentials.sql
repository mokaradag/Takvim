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
