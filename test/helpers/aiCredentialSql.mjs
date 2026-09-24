/**
 * `MR_AiUserCredentials` (0016) için bellek içi SQL ikizi.
 *
 * Gerçek sorgu metinleri (`src/server/ai/aiCredentialQueries.js`) tanınır ve
 * Sicil başına tek satır tutulur. Her deyimin parametreleri saklanır ki testler
 * düz metin anahtarın veritabanına hiçbir yoldan gitmediğini doğrulayabilsin.
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

export function runAiCredentialQuery(db, sqlText, params) {
  if (!sqlText.includes('MR_AiUserCredentials')) return null;
  if (db.aiCredentialSchemaMissing) throw missingSchemaError();
  db.aiUserCredentials ||= [];
  // Günlük dizi DEĞİLDİR: işlem geri alındığında sahte veritabanının tablo
  // anlık görüntüsüne girmez, geri alınan deyimler de denetlenebilir kalır.
  db.aiCredentialLog ||= { statements: [] };
  db.aiCredentialLog.statements.push({ sql: sqlText, params: { ...params } });

  const sicil = Number(params.sicil);
  const knownSicil = [{ KnownSicil: db.people.some((person) => Number(person.Sicil) === sicil) ? 1 : 0 }];
  const find = () => db.aiUserCredentials.find((row) => row.Sicil === sicil) || null;

  if (sqlText.includes('SELECT TOP (1) EncryptionVersion')) {
    const row = find();
    return [knownSicil, row ? [{ ...row }] : []];
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
    return [metadataRow(find())];
  }
  if (sqlText.includes('DELETE FROM dbo.MR_AiUserCredentials')) {
    const before = db.aiUserCredentials.length;
    db.aiUserCredentials = db.aiUserCredentials.filter((row) => row.Sicil !== sicil);
    return [[{ Deleted: before - db.aiUserCredentials.length }]];
  }
  if (sqlText.includes('SET LastValidatedAt = SYSUTCDATETIME()')) {
    const row = find();
    if (row && Buffer.isBuffer(params.rowVersion) && row.RowVersion.equals(params.rowVersion)) {
      row.LastValidatedAt = new Date();
      row.LastValidationStatus = params.status;
      row.RowVersion = nextRowVersion();
    }
    return [metadataRow(find())];
  }
  if (sqlText.includes('SELECT TOP (1) KeyHint')) return [knownSicil, metadataRow(find())];
  throw new Error(`Fake SQL Server: desteklenmeyen yapay zekâ anahtarı deyimi: ${sqlText.trim().slice(0, 120)}`);
}
