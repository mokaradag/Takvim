import { creationEntries, remapCommitIds } from '../../domain/identity/creationIds.js';
import { extractActualId, isActualId } from '../../domain/identity/actualId.js';
import { ACTUAL_ID_ALIAS_STORAGE_KEY, MAX_ACTUAL_ID_ALIASES, actualIdAliasType,
  decodeActualIdAliases, encodeActualIdAliases } from './actualIdAliasStorage.js';
import { AppRepositoryError } from '../contracts/appRepository.js';

// Server creationAllocations.js expires proofs after 24 hours. Stop reusing
// them five minutes earlier, including time spent receiving/persisting them.
export const CREATION_ALLOCATION_SERVER_TTL_MS = 24 * 60 * 60 * 1000;
export const CREATION_ALLOCATION_SAFETY_MARGIN_MS = 5 * 60 * 1000;
export const CREATION_ALLOCATION_CLIENT_TTL_MS = CREATION_ALLOCATION_SERVER_TTL_MS - CREATION_ALLOCATION_SAFETY_MARGIN_MS;

function capacityError() {
  return new AppRepositoryError({ code: 'MUTATION_FAILED', operation: 'commitChanges',
    message: 'Oluşturma kimliği saklama sınırına ulaşıldı. Mevcut kayıtları düzenleyebilirsiniz.',
    details: { code: 'CREATION_ALLOCATION_CAPACITY' } });
}

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

export function createCreationIdStorage(storage, aliasKey = ACTUAL_ID_ALIAS_STORAGE_KEY, { now = Date.now, accountId = null, validateAccount = () => {} } = {}) {
  let owner = accountId;
  const storageKey = () => {
    if (!owner) throw storageError();
    return `${aliasKey}.account.${owner}.creations.v1`;
  };
  let memory = { records: new Map(), aliases: new Map() };

  function read() {
    if (!storage) return { records: new Map(memory.records), aliases: decodeActualIdAliases(encodeActualIdAliases(memory.aliases)) };
    const saved = JSON.parse(storage.getItem(storageKey()) || 'null');
    if (saved == null) return { records: new Map(), aliases: new Map() };
    // Unscoped legacy envelopes have no verifiable owner and are never restored.
    if (saved?.version !== 2 || !Array.isArray(saved.pending) || !Array.isArray(saved.aliases)
      || saved.pending.length > MAX_ACTUAL_ID_ALIASES || saved.aliases.length > MAX_ACTUAL_ID_ALIASES * 2) throw storageError();
    const state = { records: new Map(), aliases: decodeActualIdAliases(saved.aliases) };
    for (const value of saved.pending) {
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
    (state.removedAliases ||= new Set()).add(record.id);
    if (state.aliases.get(record.id) === record.clientAlias && actualIdAliasType(state.aliases, record.id) === record.entityType) state.aliases.delete(record.id);
  }

  function mappingsFor(state) {
    return new Map([...state.aliases].filter(([actual]) => actualIdAliasType(state.aliases, actual))
      .map(([actual, client]) => [`${actualIdAliasType(state.aliases, actual)}:${extractActualId(client)}`, actual]));
  }

  function reconciliationRecords(state, changes) {
    const mappings = mappingsFor(state), time = now();
    const entries = creationEntries(changes);
    const candidates = entries.flatMap(({ entry, entityType }) => {
      const record = state.records.get(`${entityType}:${extractActualId(entry.id)}`)
        || [...state.records.values()].find((value) => value.entityType === entityType && value.id === entry.id);
      if (!record) return [];
      const projectId = entityType === 'PROJECT' ? record.id
        : mappings.get(`PROJECT:${extractActualId(entry.projectId)}`) || extractActualId(entry.projectId);
      return !Number.isFinite(record.allocatedAt) || record.allocatedAt > time
        || time - record.allocatedAt >= CREATION_ALLOCATION_CLIENT_TTL_MS
        || extractActualId(record.projectId) !== projectId ? [record] : [];
    });
    const replacingProjects = new Set(candidates.filter((record) => record.entityType === 'PROJECT').map((record) => record.id));
    for (const { entry, entityType } of entries) {
      const record = state.records.get(`${entityType}:${extractActualId(entry.id)}`);
      if (record && replacingProjects.has(extractActualId(record.projectId)) && !candidates.includes(record)) candidates.push(record);
    }
    return candidates;
  }

  function publish(state, aliases) {
    // Durable compaction may retire completed aliases, but an existing live
    // client can still hold those IDs. Keep its verified immutable mappings in
    // the SAME alias map until that client state is discarded. Fresh clients
    // load retired rows under their canonical server IDs from the snapshot.
    const currentMappings = mappingsFor(state);
    const live = [...aliases].filter(([actual, client]) => {
      const type = actualIdAliasType(aliases, actual);
      const replacement = currentMappings.get(`${type}:${extractActualId(client)}`);
      return type && !state.removedAliases?.has(actual) && (!replacement || replacement === actual);
    }).map(([actual, client]) => [actual, client, actualIdAliasType(aliases, actual)]);
    for (const actual of aliases.keys()) actualIdAliasType(aliases, actual, null);
    aliases.clear();
    for (const [actual, client, type] of live) {
      aliases.set(actual, client);
      actualIdAliasType(aliases, actual, type);
    }
    for (const [actual, client] of state.aliases) {
      aliases.set(actual, client);
      actualIdAliasType(aliases, actual, actualIdAliasType(state.aliases, actual));
    }
    memory = state;
  }

  function mutate(aliases, mutation) {
    const account = owner;
    return serializeStorage(storageKey(), () => {
      validateAccount();
      if (owner !== account) throw storageError();
      const state = read();
      // Formatting aliases collected for this request are safe to merge. Typed
      // creation aliases come only from the fresh durable lifecycle snapshot.
      for (const [actual, client] of aliases) if (!actualIdAliasType(aliases, actual)
        && extractActualId(client) === actual && !state.aliases.has(actual)) state.aliases.set(actual, client);
      const result = mutation(state);
      if (state.records.size > MAX_ACTUAL_ID_ALIASES) throw capacityError();
      // One atomic write contains both proofs and aliases, including removals.
      // No locally reusable state is published before this write succeeds.
      storage?.setItem(storageKey(), JSON.stringify({ version: 2, pending: [...state.records.values()],
        aliases: encodeActualIdAliases(state.aliases, { pendingIds: new Set([...state.records.values()].map((record) => record.id)) }) }));
      publish(state, aliases);
      return result;
    }).catch((error) => { if (error?.details?.code === 'CREATION_ALLOCATION_CAPACITY') throw error; throw storageError(); });
  }

  function prepareFrom(changes, state, aliases) {
    const mappings = new Map([...mappingsFor({ aliases }), ...mappingsFor(state)]);
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
    setAccount(account, aliases) {
      if (owner === account) return;
      owner = account;
      memory = { records: new Map(), aliases: new Map() };
      for (const actual of aliases.keys()) actualIdAliasType(aliases, actual, null);
      aliases.clear();
      publish(memory, aliases);
    },
    restoreAliases(aliases) {
      try { const state = read(); publish(state, aliases); } catch { /* Creation-dependent commits will fail closed. */ }
    },
    prepareExisting(changes, aliases) {
      return remapCommitIds(changes, mappingsFor({ aliases }));
    },
    reconciliationRecords(changes, aliases) {
      return mutate(aliases, (state) => reconciliationRecords(state, changes));
    },
    release(records, aliases) {
      return mutate(aliases, (state) => {
        for (const record of records) {
          const recordKey = `${record.entityType}:${record.clientId}`;
          if (state.records.get(recordKey)?.proof === record.proof) abandon(state, recordKey, record);
        }
      });
    },
    retireProofs(records, aliases) {
      return mutate(aliases, (state) => {
        for (const record of records) {
          const recordKey = `${record.entityType}:${record.clientId}`;
          if (state.records.get(recordKey)?.proof === record.proof) state.records.delete(recordKey);
        }
      });
    },
    async prepare(changes, aliases) {
      try {
        return await mutate(aliases, (state) => {
          if (reconciliationRecords(state, changes).length) throw storageError();
          const mappings = new Map([...mappingsFor({ aliases }), ...mappingsFor(state)]);
          const needed = creationEntries(changes).filter(({ entry, entityType }) => !mappings.has(`${entityType}:${extractActualId(entry.id)}`)).length;
          if (state.records.size + needed > MAX_ACTUAL_ID_ALIASES) throw capacityError();
          return prepareFrom(changes, state, aliases);
        });
      } catch (error) {
        if (creationEntries(changes).length) throw error;
        // Storage availability must not block versioned edits/deletions.
        return remapCommitIds(changes, mappingsFor({ aliases }));
      }
    },
    remember(allocations, aliases, changes, allocatedAt = now()) {
      const originals = new Map(creationEntries(changes).map(({ entry, entityType }) => [`${entityType}:${extractActualId(entry.id)}`, entry.id]));
      return mutate(aliases, (state) => {
        for (const value of allocations) {
          if (!isActualId(value.id) || !isActualId(value.clientId) || !isActualId(value.proof) || !isActualId(value.projectId)
            || !['PROJECT', 'WBS', 'TASK'].includes(value.entityType)) throw storageError();
          const record = { ...value, clientId: extractActualId(value.clientId), id: extractActualId(value.id), proof: extractActualId(value.proof), allocatedAt };
          const recordKey = `${record.entityType}:${record.clientId}`;
          // A competing tab may already have remembered or completed this draft.
          // Keep its pending proof; never replace a durable completed identity.
          if (state.records.has(recordKey)) continue;
          if (mappingsFor(state).has(recordKey) || mappingsFor({ aliases }).has(recordKey)) throw storageError();
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
        });
      } catch { /* Keep the acknowledged commit; a consumed proof cannot create twice. */ }
    }
  };
}
