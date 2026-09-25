import 'server-only';
import {
  AI_CREDENTIAL_OPERATION_TIMEOUT_MS,
  AI_CREDENTIAL_SOURCES,
  AI_CREDENTIAL_UNREADABLE_REASONS,
  apiKeyHint,
  normalizeApiKeyInput,
  selectCredentialSource
} from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { getSqlPool, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';
import { boundedExecutor } from '../observability/boundedExecution.js';
import { readAiConfig, requireAiAvailable } from './aiConfig.js';
import { aiValidationBudgetMs, createAiDeadline, raceWithAbort } from './aiDeadline.js';
import { AiError } from './aiErrors.js';
import { describeAiProbe } from './aiProbeProfile.js';
import {
  deleteCredential,
  isMissingAiCredentialSchema,
  readCredentialSchema,
  readCredentialSecret,
  readCredentialStatus,
  readDirectoryMembership,
  recordCredentialValidation,
  upsertCredential
} from './aiCredentialStore.js';
import { CredentialVaultError, decryptCredential, encryptCredential, masterKeyId } from './credentialVault.js';

/**
 * Kişisel yapay zekâ anahtarı hizmeti.
 *
 * Sahip HER ZAMAN güvenilir oturumdaki Sicil'dir: hiçbir işlev istemciden
 * Sicil, kullanıcı adı ya da görünen ad almaz. Tarayıcıya dönen durum anahtarı
 * ya da şifreli hâlini taşımaz; yalnızca var/yok, son dört karakter ve
 * zaman damgaları döner.
 *
 * Durum okuma, kaydetme ve kaldırma tek bir uçtan uca süre sınırı altında
 * çalışır ve istemcinin iptalini (`request.signal`) izler: istemcinin
 * vazgeçtiği bir kayıt işlemi geri alınır, sonradan gelen bir yeniden denemeyi
 * ezemez.
 */

function unknownSicil() {
  return new ServerPersistenceError('UNAUTHORIZED', 'Yapılandırılmış Sicil kurumsal personel kaynağında bulunamadı.');
}

function replacedConcurrently() {
  return new ServerPersistenceError(
    'CONFLICT',
    'Kişisel anahtar bu arada başka bir oturumda değiştirildi; yeni anahtar kaldırılmadı. Güncel durumu görüp yeniden deneyin.'
  );
}

function credentialOperationTimeout() {
  return new ServerPersistenceError(
    'DATABASE_UNAVAILABLE',
    'Anahtar işlemi süre sınırında tamamlanamadı. Güncel durumu yenileyip yeniden deneyin.',
    { details: { reason: 'CREDENTIAL_OPERATION_TIMEOUT' } }
  );
}

function executorFor(pool, signal) {
  return signal ? boundedExecutor(pool, signal) : pool;
}

/**
 * Anahtar işleminin uçtan uca süre sınırı. İş, süre ve istemci iptalini
 * taşıyan sinyali alır; SQL sorguları bu sinyalle sınırlanır.
 */
async function withCredentialDeadline(signal, work) {
  const deadline = createAiDeadline({ timeoutMs: AI_CREDENTIAL_OPERATION_TIMEOUT_MS, parentSignal: signal });
  try {
    return await raceWithAbort(() => work(deadline.signal), deadline.signal);
  } catch (error) {
    const failure = deadline.failure();
    if (!failure) throw error;
    throw failure.code === AI_ERROR_CODES.AI_TIMEOUT ? credentialOperationTimeout() : failure;
  } finally {
    deadline.dispose();
  }
}

/** Rehber üyeliği; anahtar tablosuna dokunmaz, 0016 yokken de çalışır. */
async function requireDirectoryMember(executor, sicil) {
  if (!(await readDirectoryMembership(executor, sicil))) throw unknownSicil();
}

/* ── Kira öncesi rehber denetimi ─────────────────────────────── */

/**
 * Sohbet ve doğrulama istekleri kapasite kirasından ÖNCE rehber üyeliğini
 * denetler. Bu denetim uygulamanın ortak SQL havuzunu kullandığı için
 * eşzamanlılığı sınırlıdır: en fazla `DIRECTORY_SLOTS` sorgu aynı anda çalışır,
 * sıra `DIRECTORY_QUEUE` ile sınırlıdır ve dolunca istek beklemeden `AI_BUSY`
 * alır. Böylece bir yapay zekâ isteği yığını, kapasite denetimine ulaşmadan
 * olağan anlık görüntü ve kayıt işlerinin SQL bağlantılarını tüketemez.
 */
const DIRECTORY_GATE_KEY = Symbol.for('mergen-rota.ai-directory-gate');
const DIRECTORY_SLOTS = 2;
const DIRECTORY_QUEUE = 64;
const DIRECTORY_BUSY_RETRY_AFTER_MS = 2000;

function directoryGate() {
  globalThis[DIRECTORY_GATE_KEY] ||= { active: 0, waiters: [] };
  return globalThis[DIRECTORY_GATE_KEY];
}

function acquireDirectorySlot(signal) {
  const gate = directoryGate();
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (gate.active < DIRECTORY_SLOTS) {
    gate.active += 1;
    return Promise.resolve(gate);
  }
  if (gate.waiters.length >= DIRECTORY_QUEUE) {
    return Promise.reject(new AiError(AI_ERROR_CODES.AI_BUSY, {
      retryAfterMs: DIRECTORY_BUSY_RETRY_AFTER_MS,
      details: { scope: 'global', saturation: 'directory' }
    }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = gate.waiters.indexOf(waiter);
      if (index >= 0) gate.waiters.splice(index, 1);
      reject(signal.reason);
    };
    // Serbest kalan yer doğrudan bu bekleyene devredilir; sayaç değişmez.
    const waiter = {
      admit() {
        signal?.removeEventListener?.('abort', onAbort);
        resolve(gate);
      }
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    gate.waiters.push(waiter);
  });
}

function releaseDirectorySlot(gate) {
  const next = gate.waiters.shift();
  if (next) next.admit();
  else gate.active -= 1;
}

/**
 * Güvenilir Sicil'in kurumsal rehberde bulunduğunu doğrular.
 *
 * Ağ geçidi bunu yapılandırma, profil ve gövde kararlarından ÖNCE ve kendi
 * süre sınırıyla çağırır: rehberde olmayan bir kimlik dağıtımın durumunu
 * (kapalı, hatalı yapılandırma, profil) öğrenemez ve kapasite ya da kayıt işi
 * tetikleyemez.
 */
export async function assertAiDirectoryMember(sicil, { signal = null } = {}) {
  const gate = await acquireDirectorySlot(signal);
  try {
    await requireDirectoryMember(executorFor(await getSqlPool(), signal), sicil);
  } finally {
    releaseDirectorySlot(gate);
  }
}

export function resetAiDirectoryGateForTests() {
  globalThis[DIRECTORY_GATE_KEY] = { active: 0, waiters: [] };
}

/* ── Durum künyesi ───────────────────────────────────────────── */

/** Ana anahtar kaldırıldıysa kişisel anahtar kullanımı kapalıdır; eski satır kurumsal anahtarı engellemez. */
function personalKeyInUse(config, stored) {
  return Boolean(stored) && config.personalKeysSupported;
}

/**
 * Tarayıcıya giden anahtar künyesi.
 *
 * Kayıt çözülemiyorsa künye `readable: false` ve nedenini taşır: ana anahtar
 * hiç tanımlı değilse kişisel anahtar kullanımı kapalıdır, başka bir ana
 * anahtarla yazılmışsa ana anahtar değişmiştir. İki durumda da eski doğrulama
 * sonucu gösterilmez (o sonuç artık kullanılamayan bir anahtarı anlatır). Ana
 * anahtar kimliği tarayıcıya gitmez.
 */
function credentialView(config, record) {
  if (!record?.credential) return { configured: false };
  let unreadableReason = null;
  if (!config.masterKey) unreadableReason = AI_CREDENTIAL_UNREADABLE_REASONS.PERSONAL_KEYS_DISABLED;
  else if (record.masterKeyId && record.masterKeyId !== masterKeyId(config.masterKey)) {
    unreadableReason = AI_CREDENTIAL_UNREADABLE_REASONS.MASTER_KEY_CHANGED;
  }
  return unreadableReason
    ? { configured: true, ...record.credential, lastValidatedAt: null, lastValidationStatus: null, readable: false, unreadableReason }
    : { configured: true, ...record.credential, readable: true };
}

async function statusView(config, { schemaReady, record }) {
  return {
    enabled: config.enabled,
    available: config.available,
    personalKeysSupported: config.available && config.personalKeysSupported && schemaReady,
    // Ana anahtar tanımlı mı (saklama yapılandırılmış mı)? Tablo eksikliğini
    // bilinçli kapatmadan ayırmak için; gizli değer taşımaz.
    personalKeysConfigured: config.available && config.personalKeysSupported,
    defaultKeyConfigured: config.enabled && config.defaultKeyConfigured,
    schemaReady,
    effectiveSource: config.available
      ? selectCredentialSource({
        personalKeyStored: personalKeyInUse(config, record?.credential),
        defaultKeyConfigured: config.defaultKeyConfigured
      })
      : AI_CREDENTIAL_SOURCES.MISSING,
    credential: credentialView(config, record),
    timeouts: {
      queueTimeoutMs: config.queueTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      validationBudgetMs: aiValidationBudgetMs(config)
    },
    probe: await describeAiProbe(config)
  };
}

export async function loadAiCredentialStatus({ signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  return withCredentialDeadline(signal, async (bounded) => {
    const executor = executorFor(await getSqlPool(), bounded);
    let status;
    try {
      status = await readCredentialStatus(executor, sicil);
    } catch (error) {
      if (!isMissingAiCredentialSchema(error)) throw error;
      // Tablo yokken de kimlik değişmezi korunur.
      await requireDirectoryMember(executor, sicil);
      return statusView(config, { schemaReady: false, record: null });
    }
    if (!status.knownSicil) throw unknownSicil();
    return statusView(config, { schemaReady: true, record: status });
  });
}

/**
 * Kişisel anahtarı kaydeder.
 *
 * Kimlik ve rehber üyeliği gövde OKUNMADAN doğrulanır: `readApiKey` gövdeyi
 * ancak bu denetimlerden sonra okur, böylece kimliği doğrulanmamış çağıran
 * gövde ve biçim kararlarını yoklayamaz. Gönderilen anahtar kurumsal anahtarla
 * KARŞILAŞTIRILMAZ: ret yanıtı, kurumsal anahtarın tahmin edilip
 * doğrulanabildiği bir kâhine dönüşürdü.
 */
export async function saveAiPersonalCredential({ readApiKey, signal = null }) {
  const sicil = await getTrustedCurrentSicil();
  return withCredentialDeadline(signal, async (bounded) => {
    await requireDirectoryMember(executorFor(await getSqlPool(), bounded), sicil);
    const config = requireAiAvailable(readAiConfig());
    if (!config.personalKeysSupported) {
      throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'PERSONAL_KEYS_UNSUPPORTED' } });
    }
    const normalized = normalizeApiKeyInput(await readApiKey());
    if (!normalized.ok) {
      throw new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { message: normalized.message, details: { reason: normalized.reason } });
    }
    const encrypted = encryptCredential({ masterKey: config.masterKey, sicil, apiKey: normalized.value });
    let credential;
    try {
      credential = await withSqlTransaction(async (transaction) => {
        const executor = boundedExecutor(transaction, bounded);
        const status = await readCredentialStatus(executor, sicil);
        if (!status.knownSicil) throw unknownSicil();
        const saved = await upsertCredential(executor, sicil, { encrypted, hint: apiKeyHint(normalized.value) });
        // İstemci vazgeçtiyse ya da süre dolduysa işlem geri alınır: bırakılmış
        // bir kayıt, sonradan gelen yeniden denemeyi ezemez.
        bounded.throwIfAborted();
        return saved;
      }, { deadlockRetries: 2 });
    } catch (error) {
      if (isMissingAiCredentialSchema(error)) {
        throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'SCHEMA_MISSING' } });
      }
      throw error;
    }
    return statusView(config, { schemaReady: true, record: { credential, masterKeyId: encrypted.masterKeyId } });
  });
}

/**
 * Kişisel anahtarı kaldırır.
 *
 * Yalnızca OKUNAN anahtar silinir. Okuma ile silme arasında başka bir oturumda
 * kaydedilen yeni anahtar silinmez; çağıran `CONFLICT` alır.
 */
export async function removeAiPersonalCredential({ signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  return withCredentialDeadline(signal, async (bounded) => {
    const executor = executorFor(await getSqlPool(), bounded);
    let status;
    try {
      status = await readCredentialStatus(executor, sicil);
    } catch (error) {
      if (!isMissingAiCredentialSchema(error)) throw error;
      await requireDirectoryMember(executor, sicil);
      return statusView(config, { schemaReady: false, record: null });
    }
    if (!status.knownSicil) throw unknownSicil();
    if (status.credential) {
      const { deleted } = await deleteCredential(executor, sicil, { keyNonce: status.keyNonce });
      if (!deleted && (await readCredentialStatus(executor, sicil)).credential) throw replacedConcurrently();
    }
    return statusView(config, { schemaReady: true, record: null });
  });
}

/* ── Çalışma zamanı ──────────────────────────────────────────── */

function unreadablePersonalKey() {
  return new AiError(AI_ERROR_CODES.AI_KEY_INVALID, {
    message: 'Kayıtlı kişisel anahtarınız okunamadı. Anahtarı yeniden kaydedin.',
    details: { credentialSource: AI_CREDENTIAL_SOURCES.PERSONAL, reason: 'CREDENTIAL_UNREADABLE' }
  });
}

async function readSecretRecord(sicil, signal) {
  const executor = executorFor(await getSqlPool(), signal);
  try {
    const lookup = await readCredentialSecret(executor, sicil);
    if (!lookup.knownSicil) throw unknownSicil();
    return lookup;
  } catch (error) {
    if (!isMissingAiCredentialSchema(error)) throw error;
    // Tablo yoksa hiç kimsenin kişisel anahtarı olamaz; kimlik değişmezi yine
    // de ayrı ve tabloya dokunmayan bir sorguyla korunur.
    await requireDirectoryMember(executor, sicil);
    return { record: null, credential: null };
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
 * yokken ya da kişisel anahtar kullanımı yapılandırmayla kapatıldığında
 * (ana anahtar tanımsız) kullanılır. Kullanım kapalıyken kişisel anahtar
 * tablosuna hiç gidilmez: o isteğe bağlı tablodaki bir sorun (yetki, şema)
 * kurumsal anahtarla çalışan kurulumu durduramaz. Rehber üyeliği ağ geçidinde,
 * bu çağrıdan önce doğrulanmıştır.
 */
export async function resolveAiCredential({ sicil, config, signal = null }) {
  const lookup = config.personalKeysSupported ? await readSecretRecord(sicil, signal) : { record: null };
  const source = selectCredentialSource({
    personalKeyStored: personalKeyInUse(config, lookup.record),
    defaultKeyConfigured: config.defaultKeyConfigured
  });
  if (source === AI_CREDENTIAL_SOURCES.PERSONAL) {
    return { source, apiKey: decryptPersonal(config, sicil, lookup.record) };
  }
  if (source === AI_CREDENTIAL_SOURCES.DEFAULT) return { source, apiKey: config.defaultApiKey };
  throw new AiError(AI_ERROR_CODES.AI_KEY_MISSING, { details: { credentialSource: AI_CREDENTIAL_SOURCES.MISSING } });
}

/**
 * Açık doğrulama yalnızca KİŞİSEL anahtarı sınar; kurumsal anahtara hiç
 * dokunmaz. `keyNonce`, doğrulanan anahtar malzemesinin kimliğidir.
 */
export async function readPersonalCredentialForValidation({ sicil, config, signal = null }) {
  const lookup = await readSecretRecord(sicil, signal);
  if (!lookup.record) {
    throw new AiError(AI_ERROR_CODES.AI_KEY_MISSING, {
      message: 'Doğrulanacak kişisel API anahtarı yok.',
      details: { credentialSource: AI_CREDENTIAL_SOURCES.PERSONAL, reason: 'NO_PERSONAL_KEY' }
    });
  }
  return { apiKey: decryptPersonal(config, sicil, lookup.record), keyNonce: lookup.record.nonce };
}

/** Doğrulama sonucunu yazar; `recorded: false` sonucun bu arada değişen anahtara uygulanmadığını söyler. */
export async function storeCredentialValidation({ sicil, keyNonce, status, signal = null }) {
  return recordCredentialValidation(executorFor(await getSqlPool(), signal), sicil, { keyNonce, status });
}

/** Yönetici bağlantı testi için: anahtar tablosu kurulu mu (satır okumadan)? */
export async function checkAiCredentialSchema({ signal = null } = {}) {
  return readCredentialSchema(executorFor(await getSqlPool(), signal));
}
