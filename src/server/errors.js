import { sanitizeError } from '../domain/observability/redaction.js';

export class ServerPersistenceError extends Error {
  constructor(code, message, { status, details = null, cause = null } = {}) {
    super(message);
    this.name = 'ServerPersistenceError';
    this.code = code;
    this.status = status || ({
      UNAUTHORIZED: 401,
      SESSION_REQUIRED: 401,
      FORBIDDEN: 403,
      CONFLICT: 409,
      MUTATION_FAILED: 400,
      TASK_ACTUAL_RANGE_INVALID: 400,
      ACTUAL_DATE_RESET_CONFIRMATION_REQUIRED: 400,
      DATABASE_UNAVAILABLE: 503
    }[code] ?? 500);
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function safeErrorResponse(error) {
  const known = error instanceof ServerPersistenceError;
  // Oturum yokluğu yönlendirme akışının beklenen durumudur.
  if (!known || error.code !== 'SESSION_REQUIRED') {
    // Ham hata günlüğe YAZILMAZ: iletisi bağlantı dizesi, jeton ya da adres
    // taşıyabilir ve yığın izi sunucu yollarını açığa çıkarır. Tek kanonik
    // temizleyiciden geçmiş özet yeterlidir (tür, kararlı kod, temiz ileti).
    console.error('MERGEN ROTA SERVER ERROR:', sanitizeError(error));
  }
  return Response.json({
    error: {
      code: known ? error.code : 'MUTATION_FAILED',
      message: known ? error.message : 'İşlem tamamlanamadı.',
      details: known ? error.details : null
    }
  }, { status: known ? error.status : 500 });
}
