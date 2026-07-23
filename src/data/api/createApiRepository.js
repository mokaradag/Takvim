import { AppRepositoryError, REPOSITORY_ERROR_CODES } from '../contracts/appRepository.js';

const CODE_BY_STATUS = {
  401: REPOSITORY_ERROR_CODES.UNAUTHORIZED,
  403: REPOSITORY_ERROR_CODES.FORBIDDEN,
  409: REPOSITORY_ERROR_CODES.CONFLICT,
  503: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE
};

async function requestJson(url, init, operation) {
  let response;
  try {
    response = await fetch(url, { ...init, cache: 'no-store', headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  } catch (cause) {
    throw new AppRepositoryError({ code: REPOSITORY_ERROR_CODES.DATABASE_UNAVAILABLE, message: 'Gerçek Sistem sunucusuna ulaşılamadı.', operation, cause });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppRepositoryError({
      code: body?.error?.code || CODE_BY_STATUS[response.status] || REPOSITORY_ERROR_CODES.MUTATION_FAILED,
      message: body?.error?.message || 'Gerçek Sistem işlemi tamamlanamadı.',
      operation,
      details: body?.error?.details || null
    });
  }
  return body;
}

export function createApiRepository({ basePath = '/api/mergen-rota' } = {}) {
  return {
    kind: 'actual-api',
    loadSessionContext() {
      return requestJson(`${basePath}/session`, { method: 'GET' }, 'loadSessionContext');
    },
    loadSnapshot() {
      return requestJson(`${basePath}/snapshot`, { method: 'GET' }, 'loadSnapshot');
    },
    commitChanges(changes) {
      return requestJson(`${basePath}/commit`, { method: 'POST', body: JSON.stringify({ changes }) }, 'commitChanges');
    },
    async flush() {}
  };
}
