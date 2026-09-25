import 'server-only';

/**
 * Kişisel yapay zekâ anahtarının SQL metinleri.
 *
 * Her sorgu YALNIZCA güvenilir oturumdan gelen `@sicil` ile çalışır; hiçbir
 * sorgu başka bir Sicil'in satırını okuyamaz ya da değiştiremez. Kimlik
 * değişmezi (Sicil kurumsal rehberde bulunmalıdır) anahtar tablosuna
 * dokunulmadan ÖNCE ayrı bir rehber sorgusuyla denetlenir; çalışma zamanındaki
 * gizli kayıt okuması onu ayrıca aynı gidiş-dönüşte yineler.
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
const SECRET_COLUMNS = 'EncryptionVersion, MasterKeyId, Nonce, Ciphertext, AuthTag';

/**
 * Yalnızca rehber üyeliği; anahtar tablosuna DOKUNMAZ. 0016 uygulanmamış
 * kurulumda da kimlik değişmezi bu sorguyla korunur.
 */
export const AI_CREDENTIAL_DIRECTORY_SQL = DIRECTORY_CHECK;

/**
 * Anahtar tablosu KULLANILABİLİR mi? Satır okumaz.
 *
 * Aynı adlı bir nesnenin varlığı yetmez: 0016 göçü tabloyu yapısını
 * doğruladıktan sonra işaretler; bu yüzden göç kaydı ve uygulamanın okuyup
 * yazdığı sütunların türü ve boş geçilebilirliği birlikte denetlenir. Elle ya
 * da yarım kurulmuş bir tablo "hazır" görünmez.
 */
export const AI_CREDENTIAL_SCHEMA_SQL = `
  SELECT CAST(CASE WHEN OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') IS NOT NULL
    AND EXISTS (SELECT 1 FROM dbo.MR_SchemaMigrations WHERE MigrationId = N'0016_ai_user_credentials')
    AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        (N'Sicil', N'int', 0), (N'EncryptionVersion', N'tinyint', 0), (N'MasterKeyId', N'char', 0),
        (N'Nonce', N'varbinary', 0), (N'Ciphertext', N'varbinary', 0), (N'AuthTag', N'varbinary', 0),
        (N'KeyHint', N'varchar', 0), (N'CreatedAt', N'datetime2', 0), (N'UpdatedAt', N'datetime2', 0),
        (N'LastValidatedAt', N'datetime2', 1), (N'LastValidationStatus', N'varchar', 1)
      ) AS r(ColumnName, TypeName, IsNullable)
      LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.MR_AiUserCredentials', N'U') AND c.name = r.ColumnName
      WHERE c.column_id IS NULL OR TYPE_NAME(c.user_type_id) <> r.TypeName OR c.is_nullable <> r.IsNullable
        OR c.is_computed <> 0 OR c.is_identity <> 0)
    THEN 1 ELSE 0 END AS bit) AS SchemaReady;`;

/**
 * Durum okuması YALNIZCA anahtar tablosuna gider: rehber üyeliği bu okumadan
 * ÖNCE, ayrı ve tabloya dokunmayan sorguyla doğrulanır. Şifreli alanlar
 * sunucuda kaydın bütünlüğünü (AES-GCM doğrulama etiketi) sınamak için okunur;
 * `MasterKeyId` ve anahtar kimliği olan nonce da yalnızca sunucuda kullanılır.
 * Hiçbiri tarayıcıya giden künyeye girmez.
 */
export const AI_CREDENTIAL_STATUS_SQL = `
  SELECT TOP (1) ${SECRET_COLUMNS}, ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;

export const AI_CREDENTIAL_SECRET_SQL = `${DIRECTORY_CHECK}
  SELECT TOP (1) ${SECRET_COLUMNS}, ${METADATA_COLUMNS}
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
 * doğrulama yazımı (künye) silmeyi engellemez. `@keyNonce` boşsa (okumada
 * anahtar yoktu) hiçbir satır silinmez.
 *
 * Silmeden SONRAKİ güncel satır aynı gidiş-dönüşte döner: silmeden önce ya da
 * hemen sonra başka bir oturumda kaydedilen anahtar, yanıt "anahtar yok"
 * derken sessizce etkin kalmaz.
 */
export const AI_CREDENTIAL_DELETE_SQL = `
  DELETE FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil AND Nonce = @keyNonce;
  SELECT @@ROWCOUNT AS Deleted;
  SELECT TOP (1) Nonce AS KeyNonce, ${METADATA_COLUMNS}
  FROM dbo.MR_AiUserCredentials WHERE Sicil = @sicil;`;

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
