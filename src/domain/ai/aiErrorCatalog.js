/**
 * Yapay zekâ hata sınıflandırması — sunucu ile istemcinin ortak sözlüğü.
 *
 * Sağlayıcının ham hatası arayüze taşınmaz; her sonuç bu kararlı kodlardan
 * birine indirgenir. `serviceFailure`, sonucun hizmet sağlığını mı yoksa
 * kullanıcı/istemci kararını mı anlattığını söyler (bkz. docs/AI-PLATFORM.md).
 */

export const AI_ERROR_CODES = Object.freeze({
  AI_DISABLED: 'AI_DISABLED',
  AI_KEY_MISSING: 'AI_KEY_MISSING',
  AI_KEY_INVALID: 'AI_KEY_INVALID',
  AI_UNAUTHORIZED: 'AI_UNAUTHORIZED',
  AI_RATE_LIMITED: 'AI_RATE_LIMITED',
  AI_BUSY: 'AI_BUSY',
  AI_QUEUE_TIMEOUT: 'AI_QUEUE_TIMEOUT',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_CANCELLED: 'AI_CANCELLED',
  AI_PROVIDER_UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',
  AI_PROVIDER_RESPONSE_INVALID: 'AI_PROVIDER_RESPONSE_INVALID',
  AI_REQUEST_INVALID: 'AI_REQUEST_INVALID',
  AI_CONFIGURATION_ERROR: 'AI_CONFIGURATION_ERROR',
  AI_INTERNAL_ERROR: 'AI_INTERNAL_ERROR'
});

const DEFINITIONS = Object.freeze({
  AI_DISABLED: {
    status: 503, retryable: false, serviceFailure: false,
    message: 'Yapay zekâ özellikleri bu kurulumda kapalı.'
  },
  AI_KEY_MISSING: {
    status: 409, retryable: false, serviceFailure: false,
    message: 'Yapay zekâ için kullanılabilir bir API anahtarı yok. Ayarlar sayfasından kişisel anahtarınızı ekleyin.'
  },
  AI_KEY_INVALID: {
    status: 422, retryable: false, serviceFailure: false,
    message: 'API anahtarı yapay zekâ hizmeti tarafından reddedildi. Anahtarı denetleyip yeniden kaydedin.'
  },
  AI_UNAUTHORIZED: {
    status: 403, retryable: false, serviceFailure: false,
    message: 'API anahtarının bu yapay zekâ yeteneğini kullanma yetkisi yok.'
  },
  AI_RATE_LIMITED: {
    status: 429, retryable: true, serviceFailure: true,
    message: 'Yapay zekâ hizmeti istek sınırına ulaştı. Kısa bir süre sonra yeniden deneyin.'
  },
  AI_BUSY: {
    status: 503, retryable: true, serviceFailure: true,
    message: 'Yapay zekâ hizmeti şu anda yoğun. Birkaç saniye sonra yeniden deneyin.'
  },
  AI_QUEUE_TIMEOUT: {
    status: 503, retryable: true, serviceFailure: true,
    message: 'İstek sırada beklerken süre doldu. Birkaç saniye sonra yeniden deneyin.'
  },
  AI_TIMEOUT: {
    status: 504, retryable: true, serviceFailure: true,
    message: 'Yapay zekâ hizmeti süre sınırında yanıt vermedi.'
  },
  AI_CANCELLED: {
    status: 499, retryable: false, serviceFailure: false,
    message: 'İstek iptal edildi.'
  },
  AI_PROVIDER_UNAVAILABLE: {
    status: 502, retryable: true, serviceFailure: true,
    message: 'Yapay zekâ hizmetine şu anda ulaşılamıyor.'
  },
  AI_PROVIDER_RESPONSE_INVALID: {
    status: 502, retryable: false, serviceFailure: true,
    message: 'Yapay zekâ hizmetinden geçersiz bir yanıt alındı.'
  },
  AI_REQUEST_INVALID: {
    status: 400, retryable: false, serviceFailure: false,
    message: 'Yapay zekâ isteği geçersiz.'
  },
  AI_CONFIGURATION_ERROR: {
    status: 503, retryable: false, serviceFailure: true,
    message: 'Yapay zekâ yapılandırması eksik ya da hatalı. Sistem yöneticinize başvurun.'
  },
  AI_INTERNAL_ERROR: {
    status: 500, retryable: false, serviceFailure: true,
    message: 'Yapay zekâ isteği beklenmeyen bir nedenle tamamlanamadı.'
  }
});

export function isAiErrorCode(code) {
  return Object.hasOwn(DEFINITIONS, String(code ?? ''));
}

/** Tanınmayan kod güvenli yedeğe (AI_INTERNAL_ERROR) düşer. */
export function aiErrorDefinition(code) {
  const key = isAiErrorCode(code) ? String(code) : AI_ERROR_CODES.AI_INTERNAL_ERROR;
  return { code: key, ...DEFINITIONS[key] };
}

export function aiErrorMessage(code) {
  return aiErrorDefinition(code).message;
}
