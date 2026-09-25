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
import { createAiSqlGate } from './aiSqlGate.js';
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
 * çalışır ve istemcinin iptalini (`request.signal`) izler. İptal ve süre
 * dolması yalnızca kalıcı değişikliğin başlangıç noktasına (commit ya da
 * silme) kadar etkilidir: o noktadan önce vazgeçilen iş geri alınır, sonra
 * vazgeçilen iş ise tamamlanır ve GERÇEK sonucu bildirilir. Böylece hata yanıtı
 * alan bir kayıt sonradan uygulanmaz, uygulanan bir kayıt da hata olarak
 * bildirilmez. Değişiklikten sonra G/Ç yapılmaz: yanıt, değişikliği yapan
 * gidiş-dönüşün sonucundan kurulur.
 *
 * Bu uçların SQL işleri ortak havuzu sınırlı bir kapıdan kullanır (Sicil
 * başına adil); yapay zekâ ayarları trafiği olağan Rota SQL işlerini
 * tüketemez.
 */

function unknownSicil() {
  return new ServerPersistenceError('UNAUTHORIZED', 'Yapılandırılmış Sicil kurumsal personel kaynağında bulunamadı.');
}

function replacedConcurrently() {
  return new ServerPersistenceError(
    'CONFLICT',
    'Bu arada başka bir oturumda yeni bir kişisel anahtar kaydedildi; yeni anahtar kaldırılmadı. Güncel durumu görüp yeniden deneyin.'
  );
}

function credentialOperationTimeout() {
  return new ServerPersistenceError(
    'DATABASE_UNAVAILABLE',
    'Anahtar işlemi süre sınırında tamamlanamadı. Güncel durumu yenileyip yeniden deneyin.',
    { details: { reason: 'CREDENTIAL_OPERATION_TIMEOUT' } }
  );
}

/** Hiç kesilmeyen sinyal: süre sınırı dışında kalan ama kapıya bağlanan sorgular için. */
const NEVER_ABORTED = new AbortController().signal;

function executorFor(pool, signal, track = null) {
  return signal || track ? boundedExecutor(pool, signal || NEVER_ABORTED, { track }) : pool;
}

/**
 * Anahtar işleminin uçtan uca süre sınırı.
 *
 * İş `scope` alır: `scope.signal` süre ve istemci iptalini taşır;
 * `scope.enterCommit()` kalıcı değişiklik başlamadan hemen önce (arada G/Ç
 * olmadan) çağrılır. O
 * anda sinyal kesilmişse işlem fırlatır (iş geri alınır); kesilmemişse bundan
 * sonraki süre dolması ya da iptal, işi yarıda bırakıp hata YANITI üretmez:
 * değişikliğin gerçek sonucu beklenir ve bildirilir.
 */
async function withCredentialDeadline(signal, work) {
  const deadline = createAiDeadline({ timeoutMs: AI_CREDENTIAL_OPERATION_TIMEOUT_MS, parentSignal: signal });
  let committing = false;
  const scope = {
    signal: deadline.signal,
    enterCommit() {
      deadline.signal.throwIfAborted();
      committing = true;
    }
  };
  const pending = Promise.resolve().then(() => work(scope));
  let onAbort = null;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => {
        if (!committing) reject(deadline.signal.reason);
      };
      if (deadline.signal.aborted) onAbort();
      else deadline.signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject);
    });
  } catch (error) {
    // Commit noktasından sonra süre dolması sonucu değiştirmez: asıl hata
    // bildirilir (işlem yinelenirken commit noktası yeniden sınanırsa hariç).
    const failure = deadline.failure();
    if (!failure || (committing && error !== failure)) throw error;
    throw failure.code === AI_ERROR_CODES.AI_TIMEOUT ? credentialOperationTimeout() : failure;
  } finally {
    if (onAbort) deadline.signal.removeEventListener('abort', onAbort);
    deadline.dispose();
  }
}

/** Rehber üyeliği; anahtar tablosuna dokunmaz, 0016 yokken de çalışır. */
async function requireDirectoryMember(executor, sicil) {
  if (!(await readDirectoryMembership(executor, sicil))) throw unknownSicil();
}

/* ── Sınırlı SQL kapıları ────────────────────────────────────── */

/**
 * Sohbet ve doğrulama istekleri kapasite kirasından ÖNCE rehber üyeliğini
 * denetler. Bu denetim uygulamanın ortak SQL havuzunu kullandığı için
 * eşzamanlılığı sınırlıdır: en fazla iki sorgu aynı anda çalışır, sıra 64 ile
 * sınırlıdır ve dolunca istek beklemeden `AI_BUSY` alır. Tek bir Sicil aynı
 * anda bir sorgu çalıştırır ve sırada en fazla sekiz isteği bekler: sırayı tek
 * başına doldurup ötekileri geri çevirtemez. Böylece bir yapay zekâ isteği
 * yığını, kapasite denetimine ulaşmadan olağan anlık görüntü ve kayıt
 * işlerinin SQL bağlantılarını tüketemez.
 */
const directoryGate = createAiSqlGate({
  name: 'directory',
  slots: 2,
  queue: 64,
  perUserActive: 1,
  perUserQueued: 8,
  saturation: 'directory'
});

/**
 * Anahtar durumu, kaydı ve kaldırması (Ayarlar kartı) da ortak havuzu kendi
 * sınırlı kapısından kullanır: çok sayıda eşzamanlı GET/PUT/DELETE, yavaş bir
 * veritabanında havuz bağlantılarını tutamaz.
 */
const credentialGate = createAiSqlGate({
  name: 'credential',
  slots: 2,
  queue: 32,
  perUserActive: 1,
  perUserQueued: 4,
  saturation: 'credential'
});

/**
 * Kapıdan geçen SQL işi. Havuz kapıya girmeden (yer tutmadan ve sinyali
 * izleyerek) alınır: takılı bir bağlantı kurulumu kapıyı kilitleyemez. Yer, iş
 * ve sürücüdeki sorguları gerçekten bitene kadar tutulur.
 */
async function throughGate(gate, sicil, signal, work) {
  const pool = signal ? await raceWithAbort(() => getSqlPool(), signal) : await getSqlPool();
  return gate.run(sicil, signal, (track) => work(executorFor(pool, signal, track), { pool, track }));
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
  await throughGate(directoryGate, sicil, signal, (executor) => requireDirectoryMember(executor, sicil));
}

export function resetAiDirectoryGateForTests() {
  directoryGate.resetForTests();
  credentialGate.resetForTests();
}

/** Yalnızca testler: kapıların doluluğu (etkin, sıradaki, kullanıcı sayısı). */
export function aiSqlGateStatusForTests() {
  return { directory: directoryGate.status(), credential: credentialGate.status() };
}

/* ── Durum künyesi ───────────────────────────────────────────── */

/** Ana anahtar kaldırıldıysa kişisel anahtar kullanımı kapalıdır; eski satır kurumsal anahtarı engellemez. */
function personalKeyInUse(config, stored) {
  return Boolean(stored) && config.personalKeysSupported;
}

/** Şifreli kayıt bu Sicil ve ana anahtarla GERÇEKTEN çözülüyor mu (AES-GCM etiketi)? Düz metin tutulmaz. */
function recordAuthenticates(config, sicil, secret) {
  if (!secret) return false;
  try {
    decryptCredential({ masterKey: config.masterKey, sicil, record: secret });
    return true;
  } catch (error) {
    if (error instanceof CredentialVaultError) return false;
    throw error;
  }
}

/**
 * Tarayıcıya giden anahtar künyesi.
 *
 * Özellik kapalıyken okunabilirlik sınanmaz: ana anahtar okunmaz ve künye
 * (doğrulama sonucu dâhil) olduğu gibi gösterilir. Açıkken kayıt ancak ana
 * anahtar tanımlı, kimliği eşleşiyor ve şifreli kayıt doğrulama etiketinden
 * GEÇİYORSA okunabilirdir; değilse künye `readable: false` ve nedenini taşır
 * ve eski doğrulama sonucu gösterilmez (o sonuç artık kullanılamayan bir
 * anahtarı anlatır). `verified`, kaydın bu istekte şifrelendiğini söyler. Ana
 * anahtar kimliği ve şifreli alanlar tarayıcıya gitmez.
 */
function credentialView(config, record, sicil) {
  if (!record?.credential) return { configured: false };
  if (!config.enabled) {
    return { configured: true, ...record.credential, readable: false, unreadableReason: AI_CREDENTIAL_UNREADABLE_REASONS.AI_DISABLED };
  }
  let unreadableReason = null;
  if (!config.masterKey) unreadableReason = AI_CREDENTIAL_UNREADABLE_REASONS.PERSONAL_KEYS_DISABLED;
  else if (record.masterKeyId && record.masterKeyId !== masterKeyId(config.masterKey)) {
    unreadableReason = AI_CREDENTIAL_UNREADABLE_REASONS.MASTER_KEY_CHANGED;
  } else if (!record.verified && !recordAuthenticates(config, sicil, record.secret)) {
    unreadableReason = AI_CREDENTIAL_UNREADABLE_REASONS.RECORD_INVALID;
  }
  return unreadableReason
    ? { configured: true, ...record.credential, lastValidatedAt: null, lastValidationStatus: null, readable: false, unreadableReason }
    : { configured: true, ...record.credential, readable: true };
}

/** Eşzamanlı: `probe` G/Ç'den önce hazırlanır, künye değişiklikten sonra G/Ç yapmadan kurulur. */
function statusView(config, { schemaReady, record, probe }, sicil) {
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
    credential: credentialView(config, record, sicil),
    timeouts: {
      queueTimeoutMs: config.queueTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      validationBudgetMs: aiValidationBudgetMs(config)
    },
    probe
  };
}

export async function loadAiCredentialStatus({ signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  return withCredentialDeadline(signal, async (scope) => {
    // Kimlik ve rehber üyeliği anahtar tablosuna dokunulmadan ÖNCE doğrulanır:
    // rehberde olmayan Sicil tablonun durumunu (yetki, şema) öğrenemez.
    const observed = await throughGate(credentialGate, sicil, scope.signal, async (executor) => {
      await requireDirectoryMember(executor, sicil);
      try {
        return { schemaReady: true, record: await readCredentialStatus(executor, sicil) };
      } catch (error) {
        // Tablo yoksa kimsenin kişisel anahtarı yoktur. Kişisel anahtar
        // kullanımı kapalıyken (kurumsal kip, özellik kapalı) bu isteğe bağlı
        // tablonun HİÇBİR sorunu (ör. yetki) durumu bozmaz: tablo okunamadı sayılır.
        if (!isMissingAiCredentialSchema(error) && config.personalKeysSupported) throw error;
        return { schemaReady: false, record: null };
      }
    });
    return statusView(config, { ...observed, probe: await describeAiProbe(config) }, sicil);
  });
}

/**
 * Kişisel anahtarı kaydeder.
 *
 * Kimlik ve rehber üyeliği gövde OKUNMADAN doğrulanır: `readApiKey` gövdeyi
 * ancak bu denetimlerden sonra ve işlemin süre sınırıyla (`signal`) okur;
 * kimliği doğrulanmamış çağıran gövde ve biçim kararlarını yoklayamaz, gövdeyi
 * yavaşça gönderen istemci işi süre sınırının ötesinde tutamaz. Gönderilen
 * anahtar kurumsal anahtarla KARŞILAŞTIRILMAZ: ret yanıtı, kurumsal anahtarın
 * tahmin edilip doğrulanabildiği bir kâhine dönüşürdü.
 *
 * Commit'ten önce vazgeçilen kayıt geri alınır; commit başladıktan sonra
 * sonucu beklenir. Yanıt, kaydı yazan deyimin döndürdüğü künyeden kurulur.
 */
export async function saveAiPersonalCredential({ readApiKey, signal = null }) {
  const sicil = await getTrustedCurrentSicil();
  return withCredentialDeadline(signal, async (scope) => {
    await throughGate(credentialGate, sicil, scope.signal, (executor) => requireDirectoryMember(executor, sicil));
    const config = requireAiAvailable(readAiConfig());
    if (!config.personalKeysSupported) {
      throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'PERSONAL_KEYS_UNSUPPORTED' } });
    }
    const normalized = normalizeApiKeyInput(await readApiKey(scope.signal));
    if (!normalized.ok) {
      throw new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { message: normalized.message, details: { reason: normalized.reason } });
    }
    // Yanıtın kayıt dışı kısmı değişiklikten ÖNCE hazırlanır: commit'ten sonra
    // başarısız olabilecek bir iş kalmaz.
    const probe = await describeAiProbe(config);
    const encrypted = encryptCredential({ masterKey: config.masterKey, sicil, apiKey: normalized.value });
    let credential;
    try {
      // İstemci vazgeçtiyse ya da süre dolduysa işlem commit'ten hemen önce geri
      // alınır; değilse commit başlar ve artık iptal edilmez.
      credential = await throughGate(credentialGate, sicil, scope.signal, (_executor, { track }) => withSqlTransaction(async (transaction) => {
        const running = [];
        const executor = boundedExecutor(transaction, scope.signal, {
          track: (query) => {
            running.push(query);
            track(query);
          }
        });
        let saved;
        try {
          saved = await upsertCredential(executor, sicil, { encrypted, hint: apiKeyHint(normalized.value) });
        } catch (error) {
          // Geri alma, sürücüde hâlâ çalışan (iptal edilmeye çalışılan) deyim
          // bitmeden denenmez.
          await Promise.allSettled(running);
          throw error;
        }
        // Commit noktası: işlev döner dönmez (arada G/Ç olmadan) commit başlar.
        scope.enterCommit();
        return saved;
      }, { deadlockRetries: 2 }));
    } catch (error) {
      if (isMissingAiCredentialSchema(error)) {
        throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'SCHEMA_MISSING' } });
      }
      throw error;
    }
    return statusView(config, {
      schemaReady: true,
      record: { credential, masterKeyId: encrypted.masterKeyId, verified: true },
      probe
    }, sicil);
  });
}

/**
 * Kişisel anahtarı kaldırır.
 *
 * Yalnızca OKUNAN anahtar silinir. Silme ve ardından güncel satırın okunması
 * tek gidiş-dönüştür: okumadan önce ya da silmeden hemen sonra başka bir
 * oturumda kaydedilen anahtar varsa çağıran `CONFLICT` alır; yanıt "anahtar
 * yok" derken yeni anahtar sessizce etkin kalmaz. Silme deyimi gönderildikten
 * sonra iptal ya da süre dolması sonucu değiştirmez; gerçek sonuç bildirilir.
 */
export async function removeAiPersonalCredential({ signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  const config = readAiConfig();
  return withCredentialDeadline(signal, async (scope) => {
    await throughGate(credentialGate, sicil, scope.signal, (executor) => requireDirectoryMember(executor, sicil));
    const probe = await describeAiProbe(config);
    const outcome = await throughGate(credentialGate, sicil, scope.signal, async (executor, { pool, track }) => {
      let status;
      try {
        status = await readCredentialStatus(executor, sicil);
      } catch (error) {
        if (!isMissingAiCredentialSchema(error)) throw error;
        return { schemaReady: false, current: null };
      }
      scope.enterCommit();
      // Silme gönderildikten sonra süre sınırı sonucu kesmez; deyim yine de kapıya bağlıdır.
      const { current } = await deleteCredential(executorFor(pool, null, track), sicil, { keyNonce: status.keyNonce });
      return { schemaReady: true, current };
    });
    if (outcome.current) throw replacedConcurrently();
    return statusView(config, { schemaReady: outcome.schemaReady, record: null, probe }, sicil);
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
