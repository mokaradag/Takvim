const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export const ACTUAL_ID_ALIAS_STORAGE_KEY = 'mergen-rota.actual-id-aliases.v1';
export const MAX_ACTUAL_ID_ALIASES = 5000;

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function actualUuid(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  const match = normalized.match(UUID_SUFFIX);
  const candidate = (match ? match[1] : normalized).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : null;
}

function validAlias(actual, clientId) {
  const normalizedActual = actualUuid(actual);
  const normalizedClient = clientId == null ? '' : String(clientId).trim();
  return normalizedActual && normalizedClient !== normalizedActual && actualUuid(normalizedClient) === normalizedActual
    ? [normalizedActual, normalizedClient]
    : null;
}

export function loadActualIdAliases(storage, storageKey = ACTUAL_ID_ALIAS_STORAGE_KEY) {
  const aliases = new Map();
  const target = resolveStorage(storage);
  if (!target) return aliases;

  try {
    const raw = target.getItem(storageKey);
    if (!raw) return aliases;
    const values = JSON.parse(raw);
    if (!Array.isArray(values)) return aliases;

    for (const entry of values.slice(-MAX_ACTUAL_ID_ALIASES)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const alias = validAlias(entry[0], entry[1]);
      if (alias) aliases.set(alias[0], alias[1]);
    }
  } catch {
    return new Map();
  }

  return aliases;
}

export function persistActualIdAliases(aliases, storage, storageKey = ACTUAL_ID_ALIAS_STORAGE_KEY) {
  const target = resolveStorage(storage);
  if (!target) return false;

  const values = [];
  for (const [actual, clientId] of aliases instanceof Map ? aliases : []) {
    const alias = validAlias(actual, clientId);
    if (alias) values.push(alias);
  }

  try {
    target.setItem(storageKey, JSON.stringify(values.slice(-MAX_ACTUAL_ID_ALIASES)));
    return true;
  } catch {
    return false;
  }
}
