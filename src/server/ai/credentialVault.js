import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Kişisel API anahtarlarının şifrelenmesi.
 *
 * AES-256-GCM (kimlik doğrulamalı şifreleme) kullanılır; anahtar, ana
 * gizli değerden HKDF-SHA256 ile türetilir ve başka hiçbir amaçla paylaşılmaz.
 * Kaydın SAHİBİ olan Sicil ek doğrulanmış veri (AAD) olarak şifreye bağlanır:
 * veritabanında A'nın satırı B'nin satırına kopyalansa bile çözme başarısız
 * olur. Her şifrelemede yeni rastgele 96 bitlik nonce üretilir.
 */

export const CREDENTIAL_ENCRYPTION_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = Buffer.from('mergen-rota/ai-credential/v1', 'utf8');

export const CREDENTIAL_VAULT_FAILURES = Object.freeze({
  MASTER_KEY_MISMATCH: 'MASTER_KEY_MISMATCH',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  MALFORMED: 'MALFORMED'
});

export class CredentialVaultError extends Error {
  constructor(reason) {
    super('Kişisel API anahtarı çözülemedi.');
    this.name = 'CredentialVaultError';
    this.code = reason;
  }
}

function assertMasterKey(masterKey) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new CredentialVaultError(CREDENTIAL_VAULT_FAILURES.MALFORMED);
  }
}

function assertSicil(sicil) {
  if (!Number.isSafeInteger(sicil) || sicil <= 0) throw new CredentialVaultError(CREDENTIAL_VAULT_FAILURES.MALFORMED);
}

function derive(masterKey, purpose, length) {
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, purpose, length));
}

function associatedData(sicil) {
  return Buffer.from(`mergen-rota:ai-credential:v${CREDENTIAL_ENCRYPTION_VERSION}:sicil:${sicil}`, 'utf8');
}

/**
 * Ana anahtarın gizli olmayan kimliği.
 *
 * Tek yönlü türetilir; ana anahtar değiştirildiğinde eski kayıtların neden
 * çözülemediği (anahtar uyuşmazlığı mı, bozulma mı) ayırt edilebilir.
 */
export function masterKeyId(masterKey) {
  assertMasterKey(masterKey);
  return derive(masterKey, 'key-id', 8).toString('hex');
}

export function encryptCredential({ masterKey, sicil, apiKey }) {
  assertMasterKey(masterKey);
  assertSicil(sicil);
  const key = derive(masterKey, 'encryption', 32);
  const nonce = randomBytes(NONCE_BYTES);
  try {
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(sicil));
    const ciphertext = Buffer.concat([cipher.update(String(apiKey), 'utf8'), cipher.final()]);
    return {
      encryptionVersion: CREDENTIAL_ENCRYPTION_VERSION,
      masterKeyId: masterKeyId(masterKey),
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag()
    };
  } finally {
    key.fill(0);
  }
}

export function decryptCredential({ masterKey, sicil, record }) {
  assertMasterKey(masterKey);
  assertSicil(sicil);
  if (Number(record?.encryptionVersion) !== CREDENTIAL_ENCRYPTION_VERSION) {
    throw new CredentialVaultError(CREDENTIAL_VAULT_FAILURES.UNSUPPORTED_VERSION);
  }
  const { nonce, ciphertext, authTag } = record;
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES
    || !Buffer.isBuffer(authTag) || authTag.length !== TAG_BYTES
    || !Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
    throw new CredentialVaultError(CREDENTIAL_VAULT_FAILURES.MALFORMED);
  }
  if (record.masterKeyId !== masterKeyId(masterKey)) {
    throw new CredentialVaultError(CREDENTIAL_VAULT_FAILURES.MASTER_KEY_MISMATCH);
  }
  const key = derive(masterKey, 'encryption', 32);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(sicil));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialVaultError(CREDENTIAL_VAULT_FAILURES.AUTHENTICATION_FAILED);
  } finally {
    key.fill(0);
  }
}
