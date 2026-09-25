import 'server-only';

/**
 * Kişisel yapay zekâ anahtarının SQL metinleri.
 *
 * Her sorgu YALNIZCA güvenilir oturumdan gelen `@sicil` ile çalışır; hiçbir
 * sorgu başka bir Sicil'in satırını okuyamaz ya da değiştiremez. Okuma
 * sorguları kimlik değişmezini (Sicil kurumsal rehberde bulunmalıdır) aynı
 * gidiş-dönüşte denetler.
 *
 * Anahtar malzemesinin KİMLİĞİ `Nonce`'tur: her kayıtta yeni rastgele bir
 * nonce üretilir ve yalnızca anahtar kaydedildiğinde/değiştirildiğinde
 * değişir. Doğrulama sonucu gibi künye yazımları onu değiştirmez; bu yüzden
 * koşullu silme ve doğrulama yazımı `RowVersion`'a (her güncellemede ilerler)
 * değil nonce'a bağlanır. Nonce AES-GCM'nin açık parametresidir, gizli
 * değildir ve tarayıcıya taşınmaz.
 */

const DIRECTORY_CHECK = `
  SELECT CAST(CASE WHEN EXISTS (
    SELECT 1 FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil
  ) THEN 1 ELSE 0 END AS bit) AS KnownSicil;`;

const METADATA_COLUMNS = 'KeyHint, CreatedAt, UpdatedAt, LastValidatedAt, LastValidationStatus';

/**
 * Yalnızca rehber üyeliği; anahtar tablosuna DOKUNMAZ. 0016 uygulanmamış
 * kurulumda da kimlik değişmezi bu sorguyla korunur.
 */
export const AI_CREDENTIAL_DIRECTORY_SQL = DIRECTORY_CHECK;

/** Anahtar tablosunun kurulu olup olmadığı; satır okumaz. */
export const AI_CREDENTIAL_SCHEMA_SQL = `
  SELECT CAST(CASE WHEN OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') IS NULL THEN 0 ELSE 1 END AS bit) AS SchemaReady;`;

/**
 * Durum okuması şifreli metni ve doğrulama etiketini okumaz. `MasterKeyId`
 * (ana anahtar uyuşmazlığını sunucuda bilmek için) ve anahtar kimliği olan
 * nonce (koşullu silme için) yalnızca sunucuda kullanılır.
 */
export const AI_CREDENTIAL_STATUS_SQL = `${DIRECTORY_CHECK}
  SELECT TOP (1) MasterKeyId, Nonce AS KeyNonce, ${METADATA_COLUMNS}
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

/**
 * Yalnızca OKUNAN anahtar silinir: okuma ile silme arasında başka bir sekmede
 * kaydedilen yeni anahtar, nonce'u değiştiği için silinmez. Araya giren bir
 * doğrulama yazımı (künye) silmeyi engellemez.
 */
export const AI_CREDENTIAL_DELETE_SQL = `
  DELETE FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil AND Nonce = @keyNonce;
  SELECT @@ROWCOUNT AS Deleted;`;

/**
 * Doğrulama sonucu yalnızca doğrulanan anahtar hâlâ kayıtlıysa yazılır.
 *
 * Yazılan satırın künyesi `OUTPUT` ile AYNI deyimden döner: güncellemeden
 * sonra ayrı bir okuma, bu arada kaydedilen başka bir anahtarın künyesini
 * doğrulanmış gibi döndürebilirdi. İlk sonuç kümesi boşsa sonuç yazılmamıştır
 * (anahtar değişti ya da kaldırıldı); ikinci küme güncel satırdır.
 */
export const AI_CREDENTIAL_VALIDATION_SQL = `
  UPDATE dbo.MR_AiUserCredentials
  SET LastValidatedAt = SYSUTCDATETIME(), LastValidationStatus = @status
  OUTPUT inserted.KeyHint, inserted.CreatedAt, inserted.UpdatedAt, inserted.LastValidatedAt, inserted.LastValidationStatus
  WHERE Sicil = @sicil AND Nonce = @keyNonce;

  SELECT TOP (1) ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;
