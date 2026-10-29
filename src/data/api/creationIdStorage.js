import { creationEntries, remapCommitIds } from '../../domain/identity/creationIds.js';
import { extractActualId, isActualId } from '../../domain/identity/actualId.js';
import { ACTUAL_ID_ALIAS_STORAGE_KEY, MAX_ACTUAL_ID_ALIASES, actualIdAliasType,
  loadActualIdAliases, decodeActualIdAliases, encodeActualIdAliases } from './actualIdAliasStorage.js';
import { AppRepositoryError } from '../contracts/appRepository.js';

// Server creationAllocations.js expires proofs after 24 hours. Stop reusing
// them five minutes earlier, including time spent receiving/persisting them.
export const CREATION_ALLOCATION_SERVER_TTL_MS = 24 * 60 * 60 * 1000;
export const CREATION_ALLOCATION_SAFETY_MARGIN_MS = 5 * 60 * 1000;
export const CREATION_ALLOCATION_CLIENT_TTL_MS = CREATION_ALLOCATION_SERVER_TTL_MS - CREATION_ALLOCATION_SAFETY_MARGIN_MS;

function storageError() {
  return new AppRepositoryError({ code: 'MUTATION_FAILED', operation: 'commitChanges',
    message: 'Oluşturma kimliği saklanamadı. Verileri yeniden yükleyin.', details: { code: 'CREATION_ALLOCATION_STORAGE' } });
}

let lockDatabase;
function serializeStorage(key, mutation) {
  if (typeof window !== 'undefined' && window.navigator?.locks) return window.navigator.locks.request(key, mutation);
  // Web Locks requires HTTPS. The existing on-prem HTTP deployment can use an
  // IndexedDB readwrite transaction to serialize the synchronous injected-storage
  // critical section across tabs instead. Never hold it over a network await.
  if (globalThis.indexedDB) {
    lockDatabase ||= new Promise((resolve, reject) => {
      const open = globalThis.indexedDB.open('mergen-rota-creation-locks', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('locks');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => { lockDatabase = null; reject(storageError()); };
    });
    return lockDatabase.then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction('locks', 'readwrite');
      let result, failure;
      transaction.objectStore('locks').get(key).onsuccess = () => {
        try { result = mutation(); } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(failure || storageError());
    }));
  }
  // Non-browser test/server clients have synchronous storage and no competing
  // browser contexts. Browsers lacking both lock mechanisms fail closed.
  if (typeof window === 'undefined' || !window.navigator) return Promise.resolve().then(mutation);
  return Promise.reject(storageError());
}

export function createCreationIdStorage(storage, aliasKey = ACTUAL_ID_ALIAS_STORAGE_KEY, { now = Date.now } = {}) {
  const key = `${aliasKey}.creations.v1`;
  let memory = { records: new Map(), aliases: new Map() };

  function read() {
    if (!storage) return { records: new Map(memory.records), aliases: decodeActualIdAliases(encodeActualIdAliases(memory.aliases)) };
    const saved = JSON.parse(storage.getItem(key) || '[]');
    // Migrate the old two-map format on the first successful durable mutation.
    // Thereafter the envelope is authoritative: stale tabs cannot resurrect
    // completed records or abandoned aliases from an older map snapshot.
    const legacy = Array.isArray(saved);
    if (!legacy && (saved?.version !== 2 || !Array.isArray(saved.pending) || !Array.isArray(saved.aliases))) throw storageError();
    const state = { records: new Map(), aliases: legacy ? loadActualIdAliases(storage, aliasKey) : decodeActualIdAliases(saved.aliases) };
    for (const value of (legacy ? saved : saved.pending)) {
      if (!value || !isActualId(value.clientId) || !isActualId(value.id) || !isActualId(value.proof)
        || !['PROJECT', 'WBS', 'TASK'].includes(value.entityType)) continue;
      const record = { ...value, clientId: extractActualId(value.clientId), id: extractActualId(value.id), proof: extractActualId(value.proof) };
      if (extractActualId(record.clientAlias) !== record.clientId) record.clientAlias = record.clientId;
      state.records.set(`${record.entityType}:${record.clientId}`, record);
      state.aliases.set(record.id, record.clientAlias);
      actualIdAliasType(state.aliases, record.id, record.entityType);
    }
    return state;
  }

  function abandon(state, recordKey, record) {
    state.records.delete(recordKey);
    if (state.aliases.get(record.id) === record.clientAlias && actualIdAliasType(state.aliases, record.id) === record.entityType) state.aliases.delete(record.id);
  }

  function mappingsFor(state) {
    return new Map([...state.aliases].filter(([actual]) => actualIdAliasType(state.aliases, actual))
      .map(([actual, client]) => [`${actualIdAliasType(state.aliases, actual)}:${extractActualId(client)}`, actual]));
  }

  function prune(state, changes = {}) {
    const time = now();
    for (const [recordKey, record] of state.records) {
      if (!Number.isFinite(record.allocatedAt) || record.allocatedAt > time
        || time - record.allocatedAt >= CREATION_ALLOCATION_CLIENT_TTL_MS || !isActualId(record.projectId)) abandon(state, recordKey, record);
    }
    const mappings = mappingsFor(state);
    for (const { entry, entityType } of creationEntries(changes)) {
      const recordKey = `${entityType}:${extractActualId(entry.id)}`;
      const record = state.records.get(recordKey) || [...state.records.values()].find((value) => value.entityType === entityType && value.id === entry.id);
      if (!record) continue;
      const projectId = entityType === 'PROJECT' ? record.id
        : mappings.get(`PROJECT:${extractActualId(entry.projectId)}`) || extractActualId(entry.projectId);
      if (extractActualId(record.projectId) !== projectId) abandon(state, `${record.entityType}:${record.clientId}`, record);
    }
  }

  function publish(state, aliases) {
    for (const actual of aliases.keys()) actualIdAliasType(aliases, actual, null);
    aliases.clear();
    for (const [actual, client] of state.aliases) {
      aliases.set(actual, client);
      actualIdAliasType(aliases, actual, actualIdAliasType(state.aliases, actual));
    }
    memory = state;
  }

  function mutate(aliases, mutation) {
    return serializeStorage(key, () => {
      const state = read();
      // Formatting aliases collected for this request are safe to merge. Typed
      // creation aliases come only from the fresh durable lifecycle snapshot.
      for (const [actual, client] of aliases) if (!actualIdAliasType(aliases, actual)
        && extractActualId(client) === actual && !state.aliases.has(actual)) state.aliases.set(actual, client);
      const result = mutation(state);
      if (state.records.size > MAX_ACTUAL_ID_ALIASES) throw storageError();
      // One atomic write contains both proofs and aliases, including removals.
      // No locally reusable state is published before this write succeeds.
      storage?.setItem(key, JSON.stringify({ version: 2, pending: [...state.records.values()], aliases: encodeActualIdAliases(state.aliases) }));
      publish(state, aliases);
      return result;
    }).catch(() => { throw storageError(); });
  }

  function prepareFrom(changes, state) {
    const mappings = mappingsFor(state);
    const prepared = remapCommitIds(changes, mappings);
    for (const { entry, entityType } of creationEntries(prepared)) {
      // Proofs are attached only from a current, fully bound pending record.
      delete entry.creationProof;
      const record = [...state.records.values()].find((value) => value.entityType === entityType && value.id === entry.id);
      if (record) entry.creationProof = record.proof;
      else if ([...mappings.values()].includes(entry.id)) throw storageError();
    }
    return prepared;
  }

  return {
    restoreAliases(aliases) {
      try { const state = read(); prune(state); publish(state, aliases); } catch { /* Creation-dependent commits will fail closed. */ }
    },
    async prepare(changes, aliases) {
      try {
        return await mutate(aliases, (state) => { prune(state, changes); return prepareFrom(changes, state); });
      } catch (error) {
        if (creationEntries(changes).length) throw error;
        // Storage availability must not block versioned edits/deletions.
        return remapCommitIds(changes, mappingsFor({ aliases }));
      }
    },
    remember(allocations, aliases, changes, allocatedAt = now()) {
      const originals = new Map(creationEntries(changes).map(({ entry, entityType }) => [`${entityType}:${extractActualId(entry.id)}`, entry.id]));
      return mutate(aliases, (state) => {
        prune(state);
        for (const value of allocations) {
          if (!isActualId(value.id) || !isActualId(value.clientId) || !isActualId(value.proof) || !isActualId(value.projectId)
            || !['PROJECT', 'WBS', 'TASK'].includes(value.entityType)) throw storageError();
          const record = { ...value, clientId: extractActualId(value.clientId), id: extractActualId(value.id), proof: extractActualId(value.proof), allocatedAt };
          const recordKey = `${record.entityType}:${record.clientId}`;
          // A competing tab may already have remembered or completed this draft.
          // Keep its pending proof; never replace a durable completed identity.
          if (state.records.has(recordKey)) continue;
          if (mappingsFor(state).has(recordKey)) throw storageError();
          record.clientAlias = originals.get(recordKey) || record.clientId;
          state.records.set(recordKey, record);
          if (state.aliases.get(record.clientId) === record.clientAlias) state.aliases.delete(record.clientId);
          state.aliases.set(record.id, record.clientAlias);
          actualIdAliasType(state.aliases, record.id, record.entityType);
        }
      });
    },
    async complete(changes, aliases) {
      try {
        await mutate(aliases, (state) => {
          for (const { entry, entityType } of creationEntries(changes)) {
            for (const [recordKey, record] of state.records) if (record.entityType === entityType && record.id === entry.id
              && record.proof === entry.creationProof) state.records.delete(recordKey);
          }
          prune(state);
        });
      } catch { /* Keep the acknowledged commit; a consumed proof cannot create twice. */ }
    }
  };
}
