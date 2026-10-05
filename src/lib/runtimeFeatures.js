import { PUBLIC_BASE_PATH } from './publicPath.js';

export const RUNTIME_FEATURES_COOKIE = `mergen-rota-ai${encodeURIComponent(PUBLIC_BASE_PATH)}`;

export function readRuntimeFeatures(doc = globalThis.document) {
  const value = String(doc?.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${RUNTIME_FEATURES_COOKIE}=`))?.slice(RUNTIME_FEATURES_COOKIE.length + 1);
  if (value === 'enabled' || value === 'disabled') return { assistant: value === 'enabled' };
  return null;
}
