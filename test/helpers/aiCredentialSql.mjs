/**
 * `MR_AiUserCredentials` (0016) için bellek içi SQL ikizi.
 *
 * Gerçek sorgu metinleri (`src/server/ai/aiCredentialQueries.js`) tanınır ve
 * Sicil başına tek satır tutulur. Her deyimin parametreleri saklanır ki testler
 * düz metin anahtarın veritabanına hiçbir yoldan gitmediğini doğrulayabilsin.
 * Tablo dizisi sahte veritabanı kurulurken açılır (`createFakeDatabase`): işlem
 * anlık görüntüsü ilk kayıttan önce de tabloyu kapsar ve geri alma onu da geri
 * alır. Anahtar kimliği, SQL Server'daki gibi her kayıtta yenilenen `Nonce`'tur.
 */

let rowVersionCounter = 0;

function nextRowVersion() {
  rowVersionCounter += 1;
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(rowVersionCounter, 4);
  return buffer;
}

function missingSchemaError() {
  const error = new Error("Invalid object name 'dbo.MR_AiUserCredentials'.");
  error.number = 208;
  return error;
}

function metadataRow(row) {
  return row ? [{
    KeyHint: row.KeyHint,
    CreatedAt: row.CreatedAt,
    UpdatedAt: row.UpdatedAt,
    LastValidatedAt: row.LastValidatedAt,
    LastValidationStatus: row.LastValidationStatus,
    RowVersion: row.RowVersion
  }] : [];
}

function logStatement(db, sqlText, params) {
  // Günlük dizi DEĞİLDİR: işlem geri alındığında sahte veritabanının tablo
  // anlık görüntüsüne girmez, geri alınan deyimler de denetlenebilir kalır.
  db.aiCredentialLog ||= { statements: [] };
  db.aiCredentialLog.statements.push({ sql: sqlText, params: { ...params } });
}

export function runAiCredentialQuery(db, sqlText, params) {
  const sicil = Number(params.sicil);
  const knownSicil = [{ KnownSicil: db.people.some((person) => Number(person.Sicil) === sicil) ? 1 : 0 }];
  // Yalnızca rehber üyeliği: anahtar tablosuna dokunmaz, 0016 yokken de çalışır.
  if (sqlText.includes('AS KnownSicil') && !sqlText.includes('MR_AiUserCredentials')) {
    logStatement(db, sqlText, params);
    return [knownSicil];
  }
  if (!sqlText.includes('MR_AiUserCredentials')) return null;
  if (sqlText.includes('AS SchemaReady')) {
    logStatement(db, sqlText, params);
    return [[{ SchemaReady: db.aiCredentialSchemaMissing ? 0 : 1 }]];
  }
  if (db.aiCredentialSchemaMissing) throw missingSchemaError();
  // İsteğe bağlı tabloda eksik yetki (şema var ama erişilemiyor).
  if (db.aiCredentialPermissionDenied) {
    const error = new Error("The SELECT permission was denied on the object 'MR_AiUserCredentials'.");
    error.number = 229;
    throw error;
  }
  logStatement(db, sqlText, params);

  const find = () => db.aiUserCredentials.find((row) => row.Sicil === sicil) || null;
  const sameKey = (row) => row && Buffer.isBuffer(params.keyNonce) && Buffer.from(row.Nonce).equals(params.keyNonce);

  if (sqlText.includes('SELECT TOP (1) EncryptionVersion')) {
    const row = find();
    return [knownSicil, row ? [{ ...row }] : []];
  }
  if (sqlText.includes('SELECT TOP (1) MasterKeyId')) {
    const row = find();
    return [knownSicil, row ? [{ MasterKeyId: row.MasterKeyId, KeyNonce: Buffer.from(row.Nonce), ...metadataRow(row)[0] }] : []];
  }
  if (sqlText.includes('UPDATE dbo.MR_AiUserCredentials WITH (UPDLOCK, HOLDLOCK)')) {
    const now = new Date();
    const values = {
      EncryptionVersion: params.encryptionVersion,
      MasterKeyId: params.masterKeyId,
      Nonce: Buffer.from(params.nonce),
      Ciphertext: Buffer.from(params.ciphertext),
      AuthTag: Buffer.from(params.authTag),
      KeyHint: params.keyHint,
      UpdatedAt: now,
      LastValidatedAt: null,
      LastValidationStatus: null,
      RowVersion: nextRowVersion()
    };
    const existing = find();
    if (existing) Object.assign(existing, values);
    else db.aiUserCredentials.push({ Sicil: sicil, CreatedAt: now, ...values });
    // Test kancası: yazımdan hemen sonra (işlem kapanmadan) istemci vazgeçebilir.
    db.aiCredentialHooks?.afterUpsert?.(find());
    return [metadataRow(find())];
  }
  if (sqlText.includes('DELETE FROM dbo.MR_AiUserCredentials')) {
    // Test kancası: okuma ile silme arasına başka bir oturumun kaydı girebilir.
    db.aiCredentialHooks?.beforeDelete?.(find(), { nextRowVersion });
    // Yalnızca okunan anahtar (nonce) silinir; araya giren yeni kayıt korunur.
    const before = db.aiUserCredentials.length;
    db.aiUserCredentials = db.aiUserCredentials.filter((row) => !(row.Sicil === sicil && sameKey(row)));
    return [[{ Deleted: before - db.aiUserCredentials.length }]];
  }
  if (sqlText.includes('SET LastValidatedAt = SYSUTCDATETIME()')) {
    const row = find();
    const written = [];
    if (sameKey(row)) {
      // Künye yazımı satır sürümünü ilerletir ama anahtar kimliğini (nonce) değiştirmez.
      row.LastValidatedAt = new Date();
      row.LastValidationStatus = params.status;
      row.RowVersion = nextRowVersion();
      written.push(metadataRow(row)[0]);
    }
    // Test kancası: `OUTPUT` ile sonraki okuma arasına başka bir kayıt girebilir.
    db.aiCredentialHooks?.afterValidationUpdate?.(find(), { nextRowVersion });
    return [written, metadataRow(find())];
  }
  throw new Error(`Fake SQL Server: desteklenmeyen yapay zekâ anahtarı deyimi: ${sqlText.trim().slice(0, 120)}`);
}
