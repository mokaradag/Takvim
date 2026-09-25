import {
  AI_CREDENTIAL_SOURCES,
  AI_CREDENTIAL_UNREADABLE_REASONS,
  AI_CREDENTIAL_VALIDATION,
  credentialSourceLabel
} from '../../domain/ai/aiCredentialPolicy.js';
import { aiErrorMessage, isAiErrorCode } from '../../domain/ai/aiErrorCatalog.js';
import { AI_PROFILE_RESOLUTION_FAILURES, aiProfileLabel } from '../../domain/ai/aiModelRegistry.js';

/**
 * Yapay zekâ ayarlarının saf sunum kuralları.
 *
 * Durum çipi, açıklama metinleri, doğrulama sonucu ve istemci süre sınırları
 * burada türetilir ki bileşen yalnızca çizimle ilgilensin ve kurallar tarayıcı
 * olmadan sınanabilsin.
 */

const CLIENT_FAILURES = Object.freeze({
  REQUEST_TIMEOUT: 'Sunucudan süre sınırında yanıt alınamadı.',
  REQUEST_CANCELLED: 'İstek iptal edildi.',
  NETWORK: 'Sunucuya ulaşılamadı. Bağlantınızı denetleyip yeniden deneyin.',
  INVALID_RESPONSE: 'Sunucudan beklenmeyen bir yanıt alındı. Yeniden deneyin.'
});
/** İstek sarmalayıcısının gövdesiz hata yanıtına koyduğu genel yedek metin. */
const GENERIC_FAILURE = 'İşlem tamamlanamadı.';

/** Sunucu yanıtı beklenirken payı; sunucu kendi süre sınırını her zaman önce uygular. */
const CLIENT_MARGIN_MS = 5000;
const VALIDATION_BUDGET_MS = 15000;
/** Sunucu bütçeyi bildirmediyse kira öncesi rehber denetimi ve dosya kaydının okunması da hesaba katılır. */
const DIRECTORY_PREFLIGHT_BUDGET_MS = 5000;
const REGISTRY_READ_BUDGET_MS = 5000;
const FALLBACK_TIMEOUTS = Object.freeze({ queueTimeoutMs: 20000, requestTimeoutMs: 90000 });
/**
 * Sonucu bilinmeyen anahtar kaydı/kaldırması: tarayıcı süre aşımı, ağ kesintisi,
 * beklenen biçimi taşımayan (ör. vekilin kestiği) 2xx yanıtı ya da sunucunun
 * kendi işlem süre sınırı. Hepsinde değişiklik sunucuda uygulanmış olabilir.
 */
const AMBIGUOUS_MUTATION_CODES = new Set(['REQUEST_TIMEOUT', 'NETWORK', 'INVALID_RESPONSE']);
const SERVER_OPERATION_TIMEOUT = 'CREDENTIAL_OPERATION_TIMEOUT';
const AMBIGUOUS_CAUSES = Object.freeze({
  REQUEST_TIMEOUT: 'Sunucudan süre sınırında yanıt alınamadı.',
  NETWORK: 'Sunucuyla bağlantı kesildi.',
  INVALID_RESPONSE: 'Sunucudan beklenmeyen bir yanıt alındı.',
  [SERVER_OPERATION_TIMEOUT]: 'Anahtar işlemi sunucunun süre sınırında tamamlanamadı.'
});

const PROBE_UNAVAILABLE_MESSAGES = Object.freeze({
  [AI_PROFILE_RESOLUTION_FAILURES.PROFILE_NOT_CONFIGURED]: 'Hızlı sohbet profili bu kurulumda tanımlı değil; deneme isteği gönderilemez.',
  [AI_PROFILE_RESOLUTION_FAILURES.PROFILE_DISABLED]: 'Hızlı sohbet profili bu kurulumda kapalı; deneme isteği gönderilemez.',
  [AI_PROFILE_RESOLUTION_FAILURES.MODEL_UNAVAILABLE]: 'Hızlı sohbet profilinin modeli kapalı; deneme isteği gönderilemez.',
  MODEL_REGISTRY_INVALID: 'Model kaydı okunamadı; deneme isteği gönderilemez. Sistem yöneticinize başvurun.',
  CAPABILITY_MISMATCH: 'Hızlı sohbet profilinin modeli sohbet yeteneği taşımıyor; deneme isteği gönderilemez.'
});

/**
 * Kullanıcıya gösterilecek hata metni.
 *
 * İstemci tarafı sonuçlar (süre aşımı, iptal, ağ) her zaman kendi karşılığıyla
 * gösterilir: istek sarmalayıcısının ham iletisi (ör. `REQUEST_TIMEOUT: …`)
 * kullanıcıya taşınmaz. Sunucunun özgül iletisi korunur; yalnızca genel yedek
 * metin katalogdaki karşılığa bırakılır.
 */
export function aiFailureMessage(response) {
  const code = String(response?.code ?? '');
  if (Object.hasOwn(CLIENT_FAILURES, code)) return CLIENT_FAILURES[code];
  const message = typeof response?.message === 'string' ? response.message.trim() : '';
  if (message && message !== GENERIC_FAILURE) return message;
  return isAiErrorCode(code) ? aiErrorMessage(code) : GENERIC_FAILURE;
}

/**
 * Kurumsal anahtara dönüşün durumu. Anahtar SEÇİMİ yalnızca yapılandırmaya ve
 * anahtarın tanımlı olmasına bağlıdır; isteklerin gerçekten ÇALIŞACAĞI ise
 * model kaydı ve sınama profili de kullanılabiliyorsa vaat edilir:
 * `ready` (vaat edilir), `blocked` (anahtar seçilir ama yapılandırma şu anda
 * kullanılamıyor) ya da `none`.
 */
function corporateFallback(status) {
  if (!status?.available || !status.defaultKeyConfigured) return 'none';
  return status.probe?.available === true ? 'ready' : 'blocked';
}

const RUNTIME_BLOCKED = 'ancak yapay zekâ yapılandırması (model kaydı) şu anda kullanılamıyor.';

/** Başlıktaki durum çipi: hangi anahtarın kullanılacağını tek bakışta söyler. */
export function aiAccessChip(status) {
  if (!status) return null;
  if (!status.enabled) return { tone: 'muted', label: 'Kapalı' };
  if (!status.available) return { tone: 'warn', label: 'Yapılandırılmadı' };
  if (status.effectiveSource === AI_CREDENTIAL_SOURCES.PERSONAL) return { tone: 'accent', label: credentialSourceLabel(AI_CREDENTIAL_SOURCES.PERSONAL) };
  if (status.effectiveSource === AI_CREDENTIAL_SOURCES.DEFAULT) return { tone: 'neutral', label: credentialSourceLabel(AI_CREDENTIAL_SOURCES.DEFAULT) };
  return { tone: 'warn', label: 'Anahtar gerekli' };
}

/** Kişisel anahtar yokken kullanıcıya ne olacağını anlatan cümle. */
export function missingKeyDescription(status) {
  const fallback = corporateFallback(status);
  // Saklama yapılandırılmış ama tablo (0016) yok: bilinçli kapatma değil, eksik kurulum.
  if (status?.personalKeysConfigured && status.schemaReady === false) {
    const base = 'Kişisel anahtar tablosu kurulmamış (veritabanı göçü 0016 eksik); kişisel anahtar kaydedilemiyor. Sistem yöneticinize başvurun.';
    if (fallback === 'ready') return `${base} İstekler şimdilik kurumsal anahtarla yapılır.`;
    if (fallback === 'blocked') return `${base} Kurumsal anahtar seçilir; ${RUNTIME_BLOCKED}`;
    return base;
  }
  if (!status?.personalKeysSupported) {
    if (fallback === 'ready') return 'Kişisel anahtar saklama bu kurulumda etkin değil; istekler kurumsal anahtarla yapılır.';
    if (fallback === 'blocked') return `Kişisel anahtar saklama bu kurulumda etkin değil; kurumsal anahtar seçilir ${RUNTIME_BLOCKED}`;
    return 'Kişisel anahtar saklama bu kurulumda etkin değil.';
  }
  if (fallback === 'ready') return 'Tanımlı değil. İstekleriniz kurumsal varsayılan anahtarla yapılır.';
  if (fallback === 'blocked') return `Tanımlı değil. Kurumsal varsayılan anahtar seçilir; ${RUNTIME_BLOCKED}`;
  return 'Tanımlı değil. Yapay zekâ özelliklerini kullanmak için kişisel anahtarınızı ekleyin.';
}

export function removalConsequence(status) {
  // Özellik kapalıyken anahtar eklenemez ve eklenen anahtar özelliği açmaz.
  if (status && !status.enabled) return 'Yapay zekâ özellikleri bu kurulumda kapalı; anahtar kaldırılır ve özellikler kapalı kalır.';
  const fallback = corporateFallback(status);
  if (fallback === 'ready') return 'Kaldırıldıktan sonra istekleriniz kurumsal varsayılan anahtarla yapılır.';
  if (fallback === 'blocked') return `Kaldırıldıktan sonra kurumsal varsayılan anahtar seçilir; ${RUNTIME_BLOCKED}`;
  if (status?.enabled && !status.available) {
    return 'Kaldırıldıktan sonra da yapay zekâ, yapılandırma düzeltilene kadar kullanılamaz.';
  }
  return 'Kaldırıldıktan sonra yeni bir anahtar ekleyene kadar yapay zekâ özellikleri kullanılamaz.';
}

/**
 * Kayıtlı kişisel anahtarın kullanılamadığı durumun açıklaması; kullanılıyorsa `null`.
 *
 * Kişisel anahtar kullanımı kapatıldıysa (ana anahtar tanımsız) kayıt yok
 * sayılır; ana anahtar değiştiyse kayıt çözülemez ve yeniden kaydedilmelidir.
 */
export function storedKeyNotice(status) {
  const credential = status?.credential;
  if (!credential?.configured || !status?.enabled) return null;
  if (credential.readable !== false) return null;
  switch (credential.unreadableReason) {
    case AI_CREDENTIAL_UNREADABLE_REASONS.PERSONAL_KEYS_DISABLED:
      return corporateFallback(status) === 'ready'
        ? 'Kişisel anahtar kullanımı bu kurulumda kapalı; kayıtlı anahtarınız kullanılmıyor, istekler kurumsal anahtarla yapılır.'
        : 'Kişisel anahtar kullanımı bu kurulumda kapalı; kayıtlı anahtarınız kullanılmıyor.';
    case AI_CREDENTIAL_UNREADABLE_REASONS.RECORD_INVALID:
      return 'Kayıtlı anahtar okunamıyor (şifreli kayıt doğrulanamadı). Anahtarı yeniden kaydedin.';
    default:
      return 'Kayıtlı anahtar okunamıyor (sunucunun şifreleme anahtarı değişti). Anahtarı yeniden kaydedin.';
  }
}

/** Sonucu bilinmeyen işlemin nedeni; sonucu belli işlemde `null`. */
function ambiguousCause(response) {
  const code = String(response?.code ?? '');
  if (AMBIGUOUS_MUTATION_CODES.has(code)) return code;
  return response?.error?.details?.reason === SERVER_OPERATION_TIMEOUT ? SERVER_OPERATION_TIMEOUT : null;
}

/** Anahtar kaydı ya da kaldırması sonucu bilinmeden mi bitti (süre aşımı, ağ, bozuk yanıt)? */
export function isAmbiguousMutation(response) {
  return ambiguousCause(response) != null;
}

/**
 * Sonucu bilinmeyen işlemden sonra güncel durum yeniden okunur; bildirim
 * gerçek nedeni ve okumanın sonucunu söyler. Güncel durum da okunamadıysa
 * kart "yüklendi" demez; `null` döner ve kart durumu çözülmemiş gösterir.
 */
export function ambiguousMutationNotice(action, response, { reconciled = true } = {}) {
  const subject = action === 'remove' ? 'Anahtarın kaldırılıp kaldırılmadığı' : 'Anahtarın kaydedilip kaydedilmediği';
  const cause = AMBIGUOUS_CAUSES[ambiguousCause(response)] || AMBIGUOUS_CAUSES.REQUEST_TIMEOUT;
  return reconciled
    ? { tone: 'warn', text: `${cause} ${subject} doğrulanamadı; güncel durum yeniden yüklendi.` }
    : { tone: 'fail', text: `${cause} ${subject} doğrulanamadı ve güncel durum da okunamadı. Yeniden deneyin.` };
}

export function formatAiTimestamp(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatAiSeconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${(value / 1000).toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} sn`;
}

/** Son açık doğrulamanın okunur özeti; hiç doğrulanmadıysa `null`. */
export function validationSummary(credential) {
  const at = credential?.lastValidatedAt;
  switch (credential?.lastValidationStatus) {
    case AI_CREDENTIAL_VALIDATION.VALID:
      return { tone: 'ok', text: `Doğrulandı (${formatAiTimestamp(at)})` };
    case AI_CREDENTIAL_VALIDATION.REJECTED:
      return { tone: 'fail', text: `Reddedildi (${formatAiTimestamp(at)})` };
    case AI_CREDENTIAL_VALIDATION.FORBIDDEN:
      return { tone: 'warn', text: `Yetkisi yetersiz (${formatAiTimestamp(at)})` };
    default:
      return null;
  }
}

/** Doğrulama yanıtının bildirimi; `validation` sunucunun `{ status, stale }` yanıtıdır. */
export function validationNotice(validation) {
  if (validation?.stale || !validation?.status) {
    return { tone: 'neutral', text: 'Anahtar doğrulama sırasında değiştirildi; sonuç yeni anahtara uygulanmadı. Gerekirse yeniden doğrulayın.' };
  }
  if (validation.status === AI_CREDENTIAL_VALIDATION.VALID) return { tone: 'ok', text: 'Anahtar yapay zekâ hizmeti tarafından kabul edildi.' };
  if (validation.status === AI_CREDENTIAL_VALIDATION.REJECTED) {
    return { tone: 'fail', text: 'Anahtar reddedildi. Geçerli bir anahtarla değiştirin; istekler kurumsal anahtara aktarılmaz.' };
  }
  return { tone: 'warn', text: 'Anahtar tanındı ancak yetkisi yetersiz. Anahtarın yetkilerini denetleyin.' };
}

export function probeSummary(result) {
  const reported = result?.model ? String(result.model) : null;
  const configured = result?.configuredModel ? String(result.configuredModel) : null;
  return {
    source: credentialSourceLabel(result?.credentialSource),
    profile: aiProfileLabel(result?.profile),
    // Yalnızca sağlayıcının bildirdiği model "yanıtlayan" sayılır; bildirilmediyse
    // yapılandırılan model onun yerine yazılmaz.
    model: reported ?? 'Sağlayıcı bildirmedi',
    modelReported: reported != null,
    // Ağ geçidi isteği başka bir modele yönlendirdiyse ya da yanıtlayan model
    // bilinmiyorsa yapılandırılan model ayrıca görünür.
    configuredModel: configured && configured !== reported ? configured : null,
    duration: formatAiSeconds(result?.durationMs),
    queueWait: Number(result?.queueWaitMs) > 0 ? formatAiSeconds(result.queueWaitMs) : null
  };
}

function timeoutsOf(status) {
  return { ...FALLBACK_TIMEOUTS, ...(status?.timeouts || {}) };
}

/**
 * İstemci süresi sunucunun GERÇEK sınama bütçesinden uzundur: sonucu sunucu
 * belirler. Bütçe (kayıt okuması + sıra + `chat.fast` süre sınırı) sunucudan
 * gelir; bilinmiyorsa en kötü durum varsayılır.
 */
export function probeTimeoutMs(status) {
  const budget = Number(status?.probe?.budgetMs);
  if (Number.isFinite(budget) && budget > 0) return budget + CLIENT_MARGIN_MS;
  const { queueTimeoutMs, requestTimeoutMs } = timeoutsOf(status);
  return DIRECTORY_PREFLIGHT_BUDGET_MS + REGISTRY_READ_BUDGET_MS + queueTimeoutMs + requestTimeoutMs + CLIENT_MARGIN_MS;
}

/** Doğrulamanın bütçesi (rehber denetimi + sıra + doğrulama) sunucudan gelir; bilinmiyorsa en kötü durum varsayılır. */
export function validationTimeoutMs(status) {
  const budget = Number(status?.timeouts?.validationBudgetMs);
  if (Number.isFinite(budget) && budget > 0) return budget + CLIENT_MARGIN_MS;
  const { queueTimeoutMs, requestTimeoutMs } = timeoutsOf(status);
  return DIRECTORY_PREFLIGHT_BUDGET_MS + queueTimeoutMs + Math.min(VALIDATION_BUDGET_MS, requestTimeoutMs) + CLIENT_MARGIN_MS;
}

/**
 * Sınama yalnızca kullanılabilir bir anahtar ve çözülebildiği sunucuca
 * BİLDİRİLMİŞ `chat.fast` profili varken açılır; eksik alan kapalı sayılır.
 */
export function canRunAiProbe(status) {
  const source = status?.effectiveSource;
  return Boolean(status?.available)
    && (source === AI_CREDENTIAL_SOURCES.PERSONAL || source === AI_CREDENTIAL_SOURCES.DEFAULT)
    && status.probe?.available === true
    && !(source === AI_CREDENTIAL_SOURCES.PERSONAL && status.credential?.readable !== true);
}

/** Sınama profile bağlı bir nedenle kapalıysa açıklaması; değilse `null`. */
export function probeUnavailableMessage(status) {
  if (!status?.available || status.probe?.available !== false) return null;
  return PROBE_UNAVAILABLE_MESSAGES[status.probe.reason] || 'Deneme isteği bu kurulumda kullanılamıyor. Sistem yöneticinize başvurun.';
}
