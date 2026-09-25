import 'server-only';
import { sql } from '../db/pool.js';
import {
  AI_CREDENTIAL_DELETE_SQL,
  AI_CREDENTIAL_DIRECTORY_SQL,
  AI_CREDENTIAL_SCHEMA_SQL,
  AI_CREDENTIAL_SECRET_SQL,
  AI_CREDENTIAL_STATUS_SQL,
  AI_CREDENTIAL_UPSERT_SQL,
  AI_CREDENTIAL_VALIDATION_SQL
} from './aiCredentialQueries.js';

/**
 * Kişisel yapay zekâ anahtarının kalıcılığı.
 *
 * Tabloda anahtarın kendisi DEĞİL, yalnızca şifreli hâli (nonce, şifreli
 * metin, doğrulama etiketi) ve gösterim künyesi durur. Şifreli alanlar bu
 * modülden yalnızca çözümleyiciye döner; tarayıcıya giden künyede yer almaz.
 */

const MISSING_TABLE_NUMBERS = new Set([207, 208]);
const SCHEMA_STATE_KEY = Symbol.for('mergen-rota.ai-credential-schema');

export function isMissingAiCredentialSchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry
    && (MISSING_TABLE_NUMBERS.has(Number(entry.number)) || /Invalid object name/i.test(String(entry.message || '')))
    && String(entry.message || '').includes('MR_AiUserCredentials'));
}

function schemaState() {
  globalThis[SCHEMA_STATE_KEY] ||= { ready: null, observedAt: null };
  return globalThis[SCHEMA_STATE_KEY];
}

function noteSchema(ready) {
  const current = schemaState();
  current.ready = ready;
  current.observedAt = new Date().toISOString();
}

/**
 * Anahtar tablosunun son GÖZLENEN durumu (G/Ç yapmaz). Sağlık görünümü,
 * kurumsal anahtar yokken tablonun kurulu olduğunu doğrulamadan "sağlıklı"
 * demez. `ready: null` henüz gözlem yapılmadığını söyler.
 */
export function aiCredentialSchemaState() {
  return { ...schemaState() };
}

export function resetAiCredentialSchemaStateForTests() {
  globalThis[SCHEMA_STATE_KEY] = { ready: null, observedAt: null };
}

/** Tabloya dokunan her sorgu şema gözlemi bırakır. */
async function observeSchema(pending) {
  try {
    const result = await pending;
    noteSchema(true);
    return result;
  } catch (error) {
    if (isMissingAiCredentialSchema(error)) noteSchema(false);
    throw error;
  }
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Tarayıcıya gidebilecek künye: şifreli alan, ana anahtar kimliği ve satır sürümü içermez. */
function credentialMetadata(row) {
  if (!row) return null;
  return {
    hint: String(row.KeyHint || ''),
    createdAt: isoOrNull(row.CreatedAt),
    updatedAt: isoOrNull(row.UpdatedAt),
    lastValidatedAt: isoOrNull(row.LastValidatedAt),
    lastValidationStatus: row.LastValidationStatus || null
  };
}

function sicilRequest(executor, sicil) {
  const request = executor.request();
  request.input('sicil', sql.Int, sicil);
  return request;
}

function knownSicil(result) {
  return Boolean(result.recordsets?.[0]?.[0]?.KnownSicil);
}

/** Yalnızca rehber üyeliği; anahtar tablosu olmasa da çalışır. */
export async function readDirectoryMembership(executor, sicil) {
  const result = await sicilRequest(executor, sicil).query(AI_CREDENTIAL_DIRECTORY_SQL);
  return knownSicil(result);
}

/**
 * Anahtar tablosu kurulu mu? Satır okumaz; sonuç şema gözlemi olarak saklanır.
 *
 * Doğrulama BAŞARISIZ olursa (yetki, bağlantı, süre aşımı) önceki başarılı
 * gözlem korunmaz: durum "bilinmiyor"a döner ki sağlık görünümü eski bir
 * `ready: true` ile sağlıklı demesin.
 */
export async function readCredentialSchema(executor) {
  let result;
  try {
    result = await executor.request().query(AI_CREDENTIAL_SCHEMA_SQL);
  } catch (error) {
    noteSchema(null);
    throw error;
  }
  const ready = Boolean(result.recordset?.[0]?.SchemaReady ?? result.recordsets?.[0]?.[0]?.SchemaReady);
  noteSchema(ready);
  return ready;
}

function secretRecord(row) {
  return row ? {
    encryptionVersion: Number(row.EncryptionVersion),
    masterKeyId: String(row.MasterKeyId || ''),
    nonce: row.Nonce,
    ciphertext: row.Ciphertext,
    authTag: row.AuthTag
  } : null;
}

function lastRow(result) {
  const recordsets = result.recordsets || [];
  return recordsets[recordsets.length - 1]?.[0] || null;
}

/**
 * Durum künyesi; yalnızca anahtar tablosunu okur (rehber üyeliği önceden
 * doğrulanır). `keyNonce` (anahtar kimliği; koşullu silme), `masterKeyId` (ana
 * anahtar uyuşmazlığı) ve `secret` (kaydın bütünlüğünü sınamak için) yalnızca
 * sunucuda kullanılır; künyeye girmez.
 */
export async function readCredentialStatus(executor, sicil) {
  const row = lastRow(await observeSchema(sicilRequest(executor, sicil).query(AI_CREDENTIAL_STATUS_SQL)));
  return {
    credential: credentialMetadata(row),
    keyNonce: row?.Nonce ?? null,
    masterKeyId: row ? String(row.MasterKeyId || '') : null,
    secret: secretRecord(row)
  };
}

export async function readCredentialSecret(executor, sicil) {
  const result = await observeSchema(sicilRequest(executor, sicil).query(AI_CREDENTIAL_SECRET_SQL));
  const row = result.recordsets?.[1]?.[0] || null;
  return {
    knownSicil: knownSicil(result),
    record: secretRecord(row),
    credential: credentialMetadata(row)
  };
}

export async function upsertCredential(executor, sicil, { encrypted, hint }) {
  const request = sicilRequest(executor, sicil);
  request.input('encryptionVersion', sql.TinyInt, encrypted.encryptionVersion);
  request.input('masterKeyId', sql.Char(16), encrypted.masterKeyId);
  request.input('nonce', sql.VarBinary(12), encrypted.nonce);
  request.input('ciphertext', sql.VarBinary(1024), encrypted.ciphertext);
  request.input('authTag', sql.VarBinary(16), encrypted.authTag);
  request.input('keyHint', sql.VarChar(4), hint);
  const result = await observeSchema(request.query(AI_CREDENTIAL_UPSERT_SQL));
  const recordsets = result.recordsets || [];
  return credentialMetadata(recordsets[recordsets.length - 1]?.[0] || null);
}

/**
 * Yalnızca okunan anahtarı (`keyNonce`; yoksa hiçbir satırı) siler; araya giren
 * yeni kayıt korunur. `current`, silmeden sonra aynı gidiş-dönüşte okunan
 * güncel satırın künyesidir (yoksa `null`).
 */
export async function deleteCredential(executor, sicil, { keyNonce }) {
  const request = sicilRequest(executor, sicil);
  request.input('keyNonce', sql.VarBinary(12), keyNonce ?? null);
  const result = await observeSchema(request.query(AI_CREDENTIAL_DELETE_SQL));
  const [deleted = [], current = []] = result.recordsets || [];
  return { deleted: Number(deleted[0]?.Deleted || 0) > 0, current: credentialMetadata(current[0] || null) };
}

/**
 * Doğrulama sonucunu yazar. `recorded: false`, doğrulanan anahtarın bu arada
 * değiştirildiğini ya da kaldırıldığını söyler ve dönen künye güncel satırındır.
 * `recorded: true` ise künye, sonucun GERÇEKTEN yazıldığı satırdan (`OUTPUT`)
 * gelir.
 */
export async function recordCredentialValidation(executor, sicil, { keyNonce, status }) {
  const request = sicilRequest(executor, sicil);
  request.input('keyNonce', sql.VarBinary(12), keyNonce);
  request.input('status', sql.VarChar(20), status);
  const result = await observeSchema(request.query(AI_CREDENTIAL_VALIDATION_SQL));
  const [written = [], current = []] = result.recordsets || [];
  const recorded = written.length > 0;
  return { recorded, credential: credentialMetadata((recorded ? written[0] : current[0]) || null) };
}
