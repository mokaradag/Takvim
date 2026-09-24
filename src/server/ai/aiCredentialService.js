import 'server-only';
import {
  AI_CREDENTIAL_SOURCES,
  apiKeyHint,
  normalizeApiKeyInput,
  selectCredentialSource
} from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { getSqlPool, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { boundedExecutor } from '../observability/boundedExecution.js';
import { readAiConfig } from './aiConfig.js';
import { AiError } from './aiErrors.js';
import {
  deleteCredential,
  isMissingAiCredentialSchema,
  readCredentialSecret,
  readCredentialStatus,
  recordCredentialValidation,
  upsertCredential
} from './aiCredentialStore.js';
import { CredentialVaultError, decryptCredential, encryptCredential } from './credentialVault.js';

/**
 * Kişisel yapay zekâ anahtarı hizmeti.
 *
 * Sahip HER ZAMAN güvenilir oturumdaki Sicil'dir: hiçbir işlev istemciden
 * Sicil, kullanıcı adı ya da görünen ad almaz. Tarayıcıya dönen durum anahtarı
 * ya da şifreli hâlini taşımaz; yalnızca var/yok, son dört karakter ve
 * zaman damgaları döner.
 */

function unknownSicil() {
  return new ServerPersistenceError('UNAUTHORIZED', 'Yapılandırılmış Sicil kurumsal personel kaynağında bulunamadı.');
}

function statusView(config, { schemaReady, credential }) {
  const personalKeyStored = Boolean(credential);
  return {
    enabled: config.enabled,
    available: config.available,
    personalKeysSupported: config.available && config.personalKeysSupported && schemaReady,
    defaultKeyConfigured: config.enabled && config.defaultKeyConfigured,
    schemaReady,
    effectiveSource: config.available
      ? selectCredentialSource({ personalKeyStored, defaultKeyConfigured: config.defaultKeyConfigured })
      : AI_CREDENTIAL_SOURCES.MISSING,
    credential: credential ? { configured: true, ...credential } : { configured: false },
    timeouts: { queueTimeoutMs: config.queueTimeoutMs, requestTimeoutMs: config.requestTimeoutMs }
  };
}

export async function loadAiCredentialStatus() {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  const pool = await getSqlPool();
  let status;
  try {
    status = await readCredentialStatus(pool, sicil);
  } catch (error) {
    if (!isMissingAiCredentialSchema(error)) throw error;
    return statusView(config, { schemaReady: false, credential: null });
  }
  if (!status.knownSicil) throw unknownSicil();
  return statusView(config, { schemaReady: true, credential: status.credential });
}

/**
 * Kimlik her denetimden önce doğrulanır. Gönderilen anahtar kurumsal anahtarla
 * KARŞILAŞTIRILMAZ: ret yanıtı, kurumsal anahtarın tahmin edilip
 * doğrulanabildiği bir kâhine dönüşürdü.
 */
export async function saveAiPersonalCredential({ apiKey }) {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  if (!config.enabled) throw new AiError(AI_ERROR_CODES.AI_DISABLED);
  if (!config.available || !config.personalKeysSupported) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'PERSONAL_KEYS_UNSUPPORTED' } });
  }
  const normalized = normalizeApiKeyInput(apiKey);
  if (!normalized.ok) {
    throw new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { message: normalized.message, details: { reason: normalized.reason } });
  }
  const encrypted = encryptCredential({ masterKey: config.masterKey, sicil, apiKey: normalized.value });
  try {
    const credential = await withSqlTransaction(async (transaction) => {
      const status = await readCredentialStatus(transaction, sicil);
      if (!status.knownSicil) throw unknownSicil();
      return upsertCredential(transaction, sicil, { encrypted, hint: apiKeyHint(normalized.value) });
    }, { deadlockRetries: 2 });
    return statusView(config, { schemaReady: true, credential });
  } catch (error) {
    if (isMissingAiCredentialSchema(error)) {
      throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'SCHEMA_MISSING' } });
    }
    throw error;
  }
}

export async function removeAiPersonalCredential() {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  const pool = await getSqlPool();
  try {
    const status = await readCredentialStatus(pool, sicil);
    if (!status.knownSicil) throw unknownSicil();
    if (status.credential) await deleteCredential(pool, sicil);
  } catch (error) {
    if (!isMissingAiCredentialSchema(error)) throw error;
    return statusView(config, { schemaReady: false, credential: null });
  }
  return statusView(config, { schemaReady: true, credential: null });
}

function unreadablePersonalKey() {
  return new AiError(AI_ERROR_CODES.AI_KEY_INVALID, {
    message: 'Kayıtlı kişisel anahtarınız okunamadı. Anahtarı yeniden kaydedin.',
    details: { credentialSource: AI_CREDENTIAL_SOURCES.PERSONAL, reason: 'CREDENTIAL_UNREADABLE' }
  });
}

async function readSecretRecord(sicil, signal) {
  const pool = await getSqlPool();
  try {
    const lookup = await readCredentialSecret(signal ? boundedExecutor(pool, signal) : pool, sicil);
    if (!lookup.knownSicil) throw unknownSicil();
    return lookup;
  } catch (error) {
    // Tablo yoksa hiç kimsenin kişisel anahtarı olamaz.
    if (isMissingAiCredentialSchema(error)) return { record: null, credential: null };
    throw error;
  }
}

function decryptPersonal(config, sicil, record) {
  if (!config.masterKey) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
      details: { credentialSource: AI_CREDENTIAL_SOURCES.PERSONAL, reason: 'PERSONAL_KEYS_UNSUPPORTED' }
    });
  }
  try {
    return decryptCredential({ masterKey: config.masterKey, sicil, record });
  } catch (error) {
    if (error instanceof CredentialVaultError) throw unreadablePersonalKey();
    throw error;
  }
}

/**
 * Çalışma zamanı kimlik bilgisi çözümü.
 *
 * Kişisel anahtar KAYITLIYSA yalnızca o döner; çözülemezse hata verilir ve
 * kurumsal anahtara GEÇİLMEZ. Kurumsal anahtar yalnızca kişisel kayıt hiç
 * yokken kullanılır.
 */
export async function resolveAiCredential({ sicil, config, signal = null }) {
  const lookup = await readSecretRecord(sicil, signal);
  const source = selectCredentialSource({
    personalKeyStored: Boolean(lookup.record),
    defaultKeyConfigured: config.defaultKeyConfigured
  });
  if (source === AI_CREDENTIAL_SOURCES.PERSONAL) {
    return { source, apiKey: decryptPersonal(config, sicil, lookup.record) };
  }
  if (source === AI_CREDENTIAL_SOURCES.DEFAULT) return { source, apiKey: config.defaultApiKey };
  throw new AiError(AI_ERROR_CODES.AI_KEY_MISSING, { details: { credentialSource: AI_CREDENTIAL_SOURCES.MISSING } });
}

/** Açık doğrulama yalnızca KİŞİSEL anahtarı sınar; kurumsal anahtara hiç dokunmaz. */
export async function readPersonalCredentialForValidation({ sicil, config, signal = null }) {
  const lookup = await readSecretRecord(sicil, signal);
  if (!lookup.record) {
    throw new AiError(AI_ERROR_CODES.AI_KEY_MISSING, {
      message: 'Doğrulanacak kişisel API anahtarı yok.',
      details: { credentialSource: AI_CREDENTIAL_SOURCES.PERSONAL, reason: 'NO_PERSONAL_KEY' }
    });
  }
  return { apiKey: decryptPersonal(config, sicil, lookup.record), rowVersion: lookup.record.rowVersion };
}

export async function storeCredentialValidation({ sicil, rowVersion, status }) {
  const pool = await getSqlPool();
  return recordCredentialValidation(pool, sicil, { rowVersion, status });
}
