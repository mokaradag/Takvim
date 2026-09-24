import 'server-only';
import { sql } from '../db/pool.js';
import {
  AI_CREDENTIAL_DELETE_SQL,
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

export function isMissingAiCredentialSchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry
    && (MISSING_TABLE_NUMBERS.has(Number(entry.number)) || /Invalid object name/i.test(String(entry.message || '')))
    && String(entry.message || '').includes('MR_AiUserCredentials'));
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Tarayıcıya gidebilecek künye: şifreli alan ve satır sürümü içermez. */
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

export async function readCredentialStatus(executor, sicil) {
  const result = await sicilRequest(executor, sicil).query(AI_CREDENTIAL_STATUS_SQL);
  const row = result.recordsets?.[1]?.[0] || null;
  return { knownSicil: knownSicil(result), credential: credentialMetadata(row) };
}

export async function readCredentialSecret(executor, sicil) {
  const result = await sicilRequest(executor, sicil).query(AI_CREDENTIAL_SECRET_SQL);
  const row = result.recordsets?.[1]?.[0] || null;
  return {
    knownSicil: knownSicil(result),
    record: row ? {
      encryptionVersion: Number(row.EncryptionVersion),
      masterKeyId: String(row.MasterKeyId || ''),
      nonce: row.Nonce,
      ciphertext: row.Ciphertext,
      authTag: row.AuthTag,
      rowVersion: row.RowVersion
    } : null,
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
  const result = await request.query(AI_CREDENTIAL_UPSERT_SQL);
  const recordsets = result.recordsets || [];
  return credentialMetadata(recordsets[recordsets.length - 1]?.[0] || null);
}

export async function deleteCredential(executor, sicil) {
  const result = await sicilRequest(executor, sicil).query(AI_CREDENTIAL_DELETE_SQL);
  const recordsets = result.recordsets || [];
  return { deleted: Number(recordsets[recordsets.length - 1]?.[0]?.Deleted || 0) > 0 };
}

export async function recordCredentialValidation(executor, sicil, { rowVersion, status }) {
  const request = sicilRequest(executor, sicil);
  request.input('rowVersion', sql.Binary(8), rowVersion);
  request.input('status', sql.VarChar(20), status);
  const result = await request.query(AI_CREDENTIAL_VALIDATION_SQL);
  const recordsets = result.recordsets || [];
  return credentialMetadata(recordsets[recordsets.length - 1]?.[0] || null);
}
