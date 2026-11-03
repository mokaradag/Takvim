const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

function assertApplicationPath(value, label) {
  const raw = String(value ?? '').trim();
  if (ABSOLUTE_URL.test(raw) || raw.startsWith('//') || raw.includes('\\')) {
    throw new Error(`${label} must be an application-relative path.`);
  }
  return raw;
}

/* Tarayıcıya görünen dağıtım öneki. Ters vekil Rota uygulamasını /rota altında sunarken Next.js öncesinde öneki kaldırabilir. */
export function normalizePublicBasePath(value) {
  const raw = assertApplicationPath(value, 'NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH');
  if (!raw || raw === '/') return '';
  if (raw.includes('?') || raw.includes('#') || raw.split('/').includes('..')) {
    throw new Error('NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH must be a plain path prefix.');
  }
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

export const PUBLIC_BASE_PATH = normalizePublicBasePath(
  process.env.NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH || ''
);

/* Tarayıcıya yönelik Rota yolu tam bir kez öneklenir. */
export function publicRotaPath(value = '/', basePath = PUBLIC_BASE_PATH) {
  const prefix = normalizePublicBasePath(basePath);
  const raw = assertApplicationPath(value || '/', 'Rota path');
  const path = raw.startsWith('/') ? raw : `/${raw}`;

  if (!prefix) return path;
  if (path === prefix || path.startsWith(`${prefix}/`)) return path;
  return path === '/' ? `${prefix}/` : `${prefix}${path}`;
}
