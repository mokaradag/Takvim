import 'server-only';
import { AI_ERROR_CODES, aiErrorDefinition } from '../../domain/ai/aiErrorCatalog.js';
import { ServerPersistenceError } from '../errors.js';

const MAX_RETRY_AFTER_MS = 300000;

/**
 * Yapay zekâ hata türü; var olan `ServerPersistenceError` sözleşmesini izler.
 * İleti katalogdan ya da SABİT bir metinden gelir; sağlayıcının ya da
 * istisnanın ham metni hiçbir zaman taşınmaz.
 */
export class AiError extends ServerPersistenceError {
  constructor(code, { message = null, details = null, retryAfterMs = null, cause = null } = {}) {
    const definition = aiErrorDefinition(code);
    const safeRetryAfter = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(MAX_RETRY_AFTER_MS, Math.round(retryAfterMs))
      : null;
    super(definition.code, message || definition.message, {
      status: definition.status,
      details: {
        retryable: definition.retryable,
        ...(safeRetryAfter != null ? { retryAfterMs: safeRetryAfter } : {}),
        ...(details || {})
      },
      cause
    });
    this.name = 'AiError';
    this.retryable = definition.retryable;
    this.serviceFailure = definition.serviceFailure;
    this.retryAfterMs = safeRetryAfter;
  }
}

export function isAiError(error) {
  return error instanceof AiError;
}

/** Oturum/yetki/veritabanı hataları kodunu korur; geri kalan her şey AI_INTERNAL_ERROR olur. */
export function toAiFailure(error) {
  if (error instanceof ServerPersistenceError) return error;
  return new AiError(AI_ERROR_CODES.AI_INTERNAL_ERROR, { cause: error });
}
