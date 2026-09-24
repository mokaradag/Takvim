import 'server-only';

/**
 * Kişisel yapay zekâ anahtarının SQL metinleri.
 *
 * Her sorgu YALNIZCA güvenilir oturumdan gelen `@sicil` ile çalışır; hiçbir
 * sorgu başka bir Sicil'in satırını okuyamaz ya da değiştiremez. Okuma
 * sorguları kimlik değişmezini (Sicil kurumsal rehberde bulunmalıdır) aynı
 * gidiş-dönüşte denetler.
 */

const DIRECTORY_CHECK = `
  SELECT CAST(CASE WHEN EXISTS (
    SELECT 1 FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil
  ) THEN 1 ELSE 0 END AS bit) AS KnownSicil;`;

const METADATA_COLUMNS = 'KeyHint, CreatedAt, UpdatedAt, LastValidatedAt, LastValidationStatus, RowVersion';

export const AI_CREDENTIAL_STATUS_SQL = `${DIRECTORY_CHECK}
  SELECT TOP (1) ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;

export const AI_CREDENTIAL_SECRET_SQL = `${DIRECTORY_CHECK}
  SELECT TOP (1) EncryptionVersion, MasterKeyId, Nonce, Ciphertext, AuthTag, ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;

/** Tek satır / Sicil. Aynı Sicil'in eşzamanlı iki ilk kaydı işlem ve kilitle sıraya girer. */
export const AI_CREDENTIAL_UPSERT_SQL = `
  UPDATE dbo.MR_AiUserCredentials WITH (UPDLOCK, HOLDLOCK)
  SET EncryptionVersion = @encryptionVersion, MasterKeyId = @masterKeyId,
      Nonce = @nonce, Ciphertext = @ciphertext, AuthTag = @authTag, KeyHint = @keyHint,
      UpdatedAt = SYSUTCDATETIME(), LastValidatedAt = NULL, LastValidationStatus = NULL
  WHERE Sicil = @sicil;
  IF @@ROWCOUNT = 0
    INSERT dbo.MR_AiUserCredentials(Sicil, EncryptionVersion, MasterKeyId, Nonce, Ciphertext, AuthTag, KeyHint)
    VALUES (@sicil, @encryptionVersion, @masterKeyId, @nonce, @ciphertext, @authTag, @keyHint);

  SELECT TOP (1) ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;

export const AI_CREDENTIAL_DELETE_SQL = `
  DELETE FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;
  SELECT @@ROWCOUNT AS Deleted;`;

/** Doğrulama sonucu yalnızca doğrulanan anahtar hâlâ kayıtlıysa yazılır. */
export const AI_CREDENTIAL_VALIDATION_SQL = `
  UPDATE dbo.MR_AiUserCredentials
  SET LastValidatedAt = SYSUTCDATETIME(), LastValidationStatus = @status
  WHERE Sicil = @sicil AND RowVersion = @rowVersion;

  SELECT TOP (1) ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;
