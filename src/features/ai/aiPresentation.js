import {
  AI_CREDENTIAL_SOURCES,
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
/** Sunucu bütçeyi bildirmediyse dosya kaydının okunma bütçesi de hesaba katılır. */
const REGISTRY_READ_BUDGET_MS = 5000;
const FALLBACK_TIMEOUTS = Object.freeze({ queueTimeoutMs: 20000, requestTimeoutMs: 90000 });

const PROBE_UNAVAILABLE_MESSAGES = Object.freeze({
  [AI_PROFILE_RESOLUTION_FAILURES.PROFILE_NOT_CONFIGURED]: 'Hızlı sohbet profili bu kurulumda tanımlı değil; deneme isteği gönderilemez.',
  [AI_PROFILE_RESOLUTION_FAILURES.PROFILE_DISABLED]: 'Hızlı sohbet profili bu kurulumda kapalı; deneme isteği gönderilemez.',
  [AI_PROFILE_RESOLUTION_FAILURES.MODEL_UNAVAILABLE]: 'Hızlı sohbet profilinin modeli kapalı; deneme isteği gönderilemez.',
  MODEL_REGISTRY_INVALID: 'Model kaydı okunamadı; deneme isteği gönderilemez. Sistem yöneticinize başvurun.'
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

/** Kurumsal anahtara dönüş ancak yapılandırma kullanılabilir ve anahtar tanımlıysa vaat edilir. */
function corporateFallbackAvailable(status) {
  return Boolean(status?.available && status.defaultKeyConfigured);
}

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
  if (!status?.personalKeysSupported) {
    return corporateFallbackAvailable(status)
      ? 'Kişisel anahtar saklama bu kurulumda etkin değil; istekler kurumsal anahtarla yapılır.'
      : 'Kişisel anahtar saklama bu kurulumda etkin değil.';
  }
  return corporateFallbackAvailable(status)
    ? 'Tanımlı değil. İstekleriniz kurumsal varsayılan anahtarla yapılır.'
    : 'Tanımlı değil. Yapay zekâ özelliklerini kullanmak için kişisel anahtarınızı ekleyin.';
}

export function removalConsequence(status) {
  if (corporateFallbackAvailable(status)) return 'Kaldırıldıktan sonra istekleriniz kurumsal varsayılan anahtarla yapılır.';
  if (status?.enabled && !status.available) {
    return 'Kaldırıldıktan sonra da yapay zekâ, yapılandırma düzeltilene kadar kullanılamaz.';
  }
  return 'Kaldırıldıktan sonra yeni bir anahtar ekleyene kadar yapay zekâ özellikleri kullanılamaz.';
}

/**
 * Kayıtlı kişisel anahtarın kullanılamadığı durumun açıklaması; kullanılıyorsa `null`.
 *
 * Ana anahtar değiştiyse kayıt çözülemez; kişisel anahtar kullanımı
 * kapatıldıysa (ana anahtar tanımsız) kayıt yok sayılır.
 */
export function storedKeyNotice(status) {
  const credential = status?.credential;
  if (!credential?.configured || !status?.enabled) return null;
  if (credential.readable === false) {
    return 'Kayıtlı anahtar okunamıyor (sunucunun şifreleme anahtarı değişti). Anahtarı yeniden kaydedin.';
  }
  if (status.available && status.schemaReady !== false && !status.personalKeysSupported) {
    return corporateFallbackAvailable(status)
      ? 'Kişisel anahtar kullanımı bu kurulumda kapalı; kayıtlı anahtarınız kullanılmıyor, istekler kurumsal anahtarla yapılır.'
      : 'Kişisel anahtar kullanımı bu kurulumda kapalı; kayıtlı anahtarınız kullanılmıyor.';
  }
  return null;
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
  const model = String(result?.model || '—');
  const configured = result?.configuredModel ? String(result.configuredModel) : null;
  return {
    source: credentialSourceLabel(result?.credentialSource),
    profile: aiProfileLabel(result?.profile),
    model,
    // Ağ geçidi isteği başka bir modele yönlendirdiyse bu açıkça görünür.
    configuredModel: configured && configured !== model ? configured : null,
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
  return REGISTRY_READ_BUDGET_MS + queueTimeoutMs + requestTimeoutMs + CLIENT_MARGIN_MS;
}

export function validationTimeoutMs(status) {
  const { queueTimeoutMs, requestTimeoutMs } = timeoutsOf(status);
  return queueTimeoutMs + Math.min(VALIDATION_BUDGET_MS, requestTimeoutMs) + CLIENT_MARGIN_MS;
}

/** Sınama yalnızca kullanılabilir bir anahtar ve çözülebilen `chat.fast` profili varken açılır. */
export function canRunAiProbe(status) {
  return Boolean(status?.available)
    && status.effectiveSource !== AI_CREDENTIAL_SOURCES.MISSING
    && status.probe?.available !== false
    && !(status.effectiveSource === AI_CREDENTIAL_SOURCES.PERSONAL && status.credential?.readable === false);
}

/** Sınama profile bağlı bir nedenle kapalıysa açıklaması; değilse `null`. */
export function probeUnavailableMessage(status) {
  if (!status?.available || status.probe?.available !== false) return null;
  return PROBE_UNAVAILABLE_MESSAGES[status.probe.reason] || 'Deneme isteği bu kurulumda kullanılamıyor. Sistem yöneticinize başvurun.';
}
