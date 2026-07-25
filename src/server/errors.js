export class ServerPersistenceError extends Error {
  constructor(code, message, { status, details = null, cause = null } = {}) {
    super(message);
    this.name = 'ServerPersistenceError';
    this.code = code;
    this.status = status || ({
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      CONFLICT: 409,
      MUTATION_FAILED: 400,
      DATABASE_UNAVAILABLE: 503
    }[code] ?? 500);
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function safeErrorResponse(error) {
  console.error('MERGEN ROTA SERVER ERROR:', error);
  const known = error instanceof ServerPersistenceError;
  return Response.json({
    error: {
      code: known ? error.code : 'MUTATION_FAILED',
      message: known ? error.message : 'İşlem tamamlanamadı.',
      details: known ? error.details : null
    }
  }, { status: known ? error.status : 500 });
}
