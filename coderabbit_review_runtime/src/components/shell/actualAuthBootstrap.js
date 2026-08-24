import { publicRotaPath } from '../../lib/publicPath.js';

export const ACTUAL_AUTH_STATUS_ENDPOINT = publicRotaPath('/api/mergen-rota/auth/status');
export const ACTUAL_AUTH_LOGIN_ENDPOINT = publicRotaPath('/api/mergen-rota/auth/login');
export const ACTUAL_APP_ROOT = publicRotaPath('/');

export function corporateLoginHref(returnTo = ACTUAL_APP_ROOT) {
  return `${ACTUAL_AUTH_LOGIN_ENDPOINT}?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function hasCorporateSession({ fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Kurumsal oturum denetimi için fetch gereklidir.');
  }

  const response = await fetchImpl(ACTUAL_AUTH_STATUS_ENDPOINT, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Kurumsal oturum durumu alınamadı.');
    error.code = payload?.error?.code || 'AUTH_STATUS_FAILED';
    throw error;
  }

  return payload?.authenticated === true;
}
