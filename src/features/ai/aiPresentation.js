import {
  AI_CREDENTIAL_SOURCES,
  AI_CREDENTIAL_VALIDATION,
  credentialSourceLabel
} from '../../domain/ai/aiCredentialPolicy.js';
import { aiErrorMessage, isAiErrorCode } from '../../domain/ai/aiErrorCatalog.js';
import { aiProfileLabel } from '../../domain/ai/aiModelRegistry.js';

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
  NETWORK: 'Sunucuya ulaşılamadı. Bağlantınızı denetleyip yeniden deneyin.'
});

/** Sunucu yanıtı beklenirken payı; sunucu kendi süre sınırını her zaman önce uygular. */
const CLIENT_MARGIN_MS = 5000;
const VALIDATION_BUDGET_MS = 15000;
const FALLBACK_TIMEOUTS = Object.freeze({ queueTimeoutMs: 20000, requestTimeoutMs: 90000 });

export function aiFailureMessage(response) {
  if (response?.message) return response.message;
  const code = response?.code;
  if (Object.hasOwn(CLIENT_FAILURES, String(code))) return CLIENT_FAILURES[code];
  return isAiErrorCode(code) ? aiErrorMessage(code) : 'İşlem tamamlanamadı.';
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
    return status?.defaultKeyConfigured
      ? 'Kişisel anahtar saklama bu kurulumda etkin değil; istekler kurumsal anahtarla yapılır.'
      : 'Kişisel anahtar saklama bu kurulumda etkin değil.';
  }
  return status.defaultKeyConfigured
    ? 'Tanımlı değil. İstekleriniz kurumsal varsayılan anahtarla yapılır.'
    : 'Tanımlı değil. Yapay zekâ özelliklerini kullanmak için kişisel anahtarınızı ekleyin.';
}

export function removalConsequence(status) {
  return status?.defaultKeyConfigured
    ? 'Kaldırıldıktan sonra istekleriniz kurumsal varsayılan anahtarla yapılır.'
    : 'Kaldırıldıktan sonra yeni bir anahtar ekleyene kadar yapay zekâ özellikleri kullanılamaz.';
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

export function validationNotice(status) {
  if (status === AI_CREDENTIAL_VALIDATION.VALID) return { tone: 'ok', text: 'Anahtar yapay zekâ hizmeti tarafından kabul edildi.' };
  if (status === AI_CREDENTIAL_VALIDATION.REJECTED) {
    return { tone: 'fail', text: 'Anahtar reddedildi. Geçerli bir anahtarla değiştirin; istekler kurumsal anahtara aktarılmaz.' };
  }
  return { tone: 'warn', text: 'Anahtar tanındı ancak yetkisi yetersiz. Anahtarın yetkilerini denetleyin.' };
}

export function probeSummary(result) {
  return {
    source: credentialSourceLabel(result?.credentialSource),
    profile: aiProfileLabel(result?.profile),
    model: String(result?.model || '—'),
    duration: formatAiSeconds(result?.durationMs),
    queueWait: Number(result?.queueWaitMs) > 0 ? formatAiSeconds(result.queueWaitMs) : null
  };
}

function timeoutsOf(status) {
  return { ...FALLBACK_TIMEOUTS, ...(status?.timeouts || {}) };
}

/** İstemci süresi sunucu sınırlarının toplamından uzundur: sonucu sunucu belirler. */
export function probeTimeoutMs(status) {
  const { queueTimeoutMs, requestTimeoutMs } = timeoutsOf(status);
  return queueTimeoutMs + requestTimeoutMs + CLIENT_MARGIN_MS;
}

export function validationTimeoutMs(status) {
  const { queueTimeoutMs, requestTimeoutMs } = timeoutsOf(status);
  return queueTimeoutMs + Math.min(VALIDATION_BUDGET_MS, requestTimeoutMs) + CLIENT_MARGIN_MS;
}

export function canRunAiProbe(status) {
  return Boolean(status?.available) && status.effectiveSource !== AI_CREDENTIAL_SOURCES.MISSING;
}
