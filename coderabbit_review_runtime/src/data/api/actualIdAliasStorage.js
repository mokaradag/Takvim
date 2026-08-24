import { extractActualId } from '../../domain/identity/actualId.js';

export const ACTUAL_ID_ALIAS_STORAGE_KEY = 'mergen-rota.actual-id-aliases.v1';
export const MAX_ACTUAL_ID_ALIASES = 5000;

function actualUuid(value) {
  return extractActualId(value);
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
  if (!storage) return aliases;

  try {
    const raw = storage.getItem(storageKey);
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
  if (!storage) return false;

  const values = [];
  for (const [actual, clientId] of aliases instanceof Map ? aliases : []) {
    const alias = validAlias(actual, clientId);
    if (alias) values.push(alias);
  }

  try {
    storage.setItem(storageKey, JSON.stringify(values.slice(-MAX_ACTUAL_ID_ALIASES)));
    return true;
  } catch {
    return false;
  }
}
