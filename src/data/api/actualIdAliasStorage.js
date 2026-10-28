import { extractActualId } from '../../domain/identity/actualId.js';

export const ACTUAL_ID_ALIAS_STORAGE_KEY = 'mergen-rota.actual-id-aliases.v1';
export const MAX_ACTUAL_ID_ALIASES = 5000;
const entityTypes = new WeakMap();
const TYPES = new Set(['PROJECT', 'WBS', 'TASK']);

export function actualIdAliasType(aliases, actual, type) {
  if (TYPES.has(type)) {
    if (!entityTypes.has(aliases)) entityTypes.set(aliases, new Map());
    entityTypes.get(aliases).set(actual, type);
  }
  return entityTypes.get(aliases)?.get(actual);
}

function actualUuid(value) {
  return extractActualId(value);
}

function validAlias(actual, clientId, type) {
  const normalizedActual = actualUuid(actual);
  const normalizedClient = clientId == null ? '' : String(clientId).trim();
  return normalizedActual && normalizedClient !== normalizedActual && actualUuid(normalizedClient)
    && (actualUuid(normalizedClient) === normalizedActual || TYPES.has(type))
    ? [normalizedActual, normalizedClient, ...(TYPES.has(type) ? [type] : [])]
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
      if (!Array.isArray(entry) || ![2, 3].includes(entry.length)) continue;
      const alias = validAlias(entry[0], entry[1], entry[2]);
      if (alias) {
        aliases.set(alias[0], alias[1]);
        actualIdAliasType(aliases, alias[0], alias[2]);
      }
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
    const alias = validAlias(actual, clientId, actualIdAliasType(aliases, actual));
    if (alias) values.push(alias);
  }

  try {
    storage.setItem(storageKey, JSON.stringify(values.slice(-MAX_ACTUAL_ID_ALIASES)));
    return true;
  } catch {
    return false;
  }
}
