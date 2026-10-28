import { creationEntries, remapCommitIds } from '../../domain/identity/creationIds.js';
import { extractActualId, isActualId } from '../../domain/identity/actualId.js';
import { ACTUAL_ID_ALIAS_STORAGE_KEY, MAX_ACTUAL_ID_ALIASES, actualIdAliasType } from './actualIdAliasStorage.js';
import { AppRepositoryError } from '../contracts/appRepository.js';

function storageError() {
  return new AppRepositoryError({ code: 'MUTATION_FAILED', operation: 'commitChanges',
    message: 'Oluşturma kimliği saklanamadı. Verileri yeniden yükleyin.', details: { code: 'CREATION_ALLOCATION_STORAGE' } });
}

export function createCreationIdStorage(storage, aliasKey = ACTUAL_ID_ALIAS_STORAGE_KEY) {
  const key = `${aliasKey}.creations.v1`;
  const records = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(key) || '[]');
    if (Array.isArray(saved)) for (const record of saved.slice(-MAX_ACTUAL_ID_ALIASES)) {
      if (record && isActualId(record.clientId) && isActualId(record.id) && isActualId(record.proof)
        && ['PROJECT', 'WBS', 'TASK'].includes(record.entityType)) {
        record.clientId = extractActualId(record.clientId);
        record.id = extractActualId(record.id);
        record.proof = extractActualId(record.proof);
        if (extractActualId(record.clientAlias) !== record.clientId) record.clientAlias = record.clientId;
        records.set(`${record.entityType}:${record.clientId}`, record);
      }
    }
  } catch { /* A missing proof must never be replaced for a known server alias. */ }
  return {
    restoreAliases(aliases) {
      for (const record of records.values()) {
        aliases.set(record.id, record.clientAlias || aliases.get(record.clientId) || record.clientId);
        actualIdAliasType(aliases, record.id, record.entityType);
      }
    },
    prepare(changes, aliases) {
      const mappings = new Map();
      for (const [actual, client] of aliases) {
        const original = extractActualId(client);
        const type = actualIdAliasType(aliases, actual);
        if (original !== actual && type) mappings.set(`${type}:${original}`, actual);
      }
      for (const [recordKey, record] of records) mappings.set(recordKey, record.id);
      const prepared = remapCommitIds(changes, mappings);
      for (const { entry, entityType } of creationEntries(prepared)) {
        const record = [...records.values()].find((value) => value.entityType === entityType && value.id === entry.id);
        if (record) entry.creationProof = record.proof;
        else if ([...mappings.values()].includes(entry.id)) throw storageError();
      }
      return prepared;
    },
    remember(allocations, aliases, changes) {
      const originals = new Map(creationEntries(changes).map(({ entry, entityType }) => [`${entityType}:${extractActualId(entry.id)}`, entry.id]));
      for (const record of allocations) {
        if (!isActualId(record.id) || !isActualId(record.clientId) || !isActualId(record.proof)
          || !['PROJECT', 'WBS', 'TASK'].includes(record.entityType)) throw storageError();
        const original = originals.get(`${record.entityType}:${record.clientId}`) || aliases.get(record.clientId) || record.clientId;
        records.set(`${record.entityType}:${record.clientId}`, { ...record, clientAlias: original });
        if (aliases.get(record.clientId) === original) aliases.delete(record.clientId);
        aliases.set(record.id, original);
        actualIdAliasType(aliases, record.id, record.entityType);
      }
      // Save BEFORE submitting the commit. A lost response must replay the same
      // one-use proof, never reserve a replacement and accidentally create twice.
      if (storage) {
        try {
          if (records.size > MAX_ACTUAL_ID_ALIASES) throw storageError();
          storage.setItem(key, JSON.stringify([...records.values()]));
        }
        catch { throw storageError(); }
      }
    },
    complete(changes) {
      const ids = new Set(creationEntries(changes).map(({ entry }) => entry.id));
      for (const [recordKey, record] of records) if (ids.has(record.id)) records.delete(recordKey);
      // Failure to prune an already consumed proof is safe: a later replay
      // rejects before object lookup. It must not turn a known commit into error.
      try { storage?.setItem(key, JSON.stringify([...records.values()])); } catch { /* Keep the acknowledged result. */ }
    }
  };
}
