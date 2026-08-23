const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

function assertApplicationPath(value, label) {
  const raw = String(value ?? '').trim();
  if (ABSOLUTE_URL.test(raw) || raw.startsWith('//') || raw.includes('\\')) {
    throw new Error(`${label} must be an application-relative path.`);
  }
  return raw;
}

/**
 * Browser-visible deployment prefix. The reverse proxy may expose Rota below
 * `/rota` while stripping that prefix before forwarding to Next.js.
 */
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

/** Prefix a browser-facing Rota path exactly once. */
export function publicRotaPath(value = '/', basePath = PUBLIC_BASE_PATH) {
  const prefix = normalizePublicBasePath(basePath);
  const raw = assertApplicationPath(value || '/', 'Rota path');
  const path = raw.startsWith('/') ? raw : `/${raw}`;

  if (!prefix) return path;
  if (path === prefix || path.startsWith(`${prefix}/`)) return path;
  return path === '/' ? `${prefix}/` : `${prefix}${path}`;
}
