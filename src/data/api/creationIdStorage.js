import { CREATION_COLLECTIONS, creationEntries, remapCommitIds } from '../../domain/identity/creationIds.js';
import { extractActualId, isActualId } from '../../domain/identity/actualId.js';
import { ACTUAL_ID_ALIAS_STORAGE_KEY, MAX_ACTUAL_ID_ALIASES, actualIdAliasType,
  decodeActualIdAliases, encodeActualIdAliases } from './actualIdAliasStorage.js';
import { AppRepositoryError } from '../contracts/appRepository.js';

// Sunucu creationAllocations.js kanıtları 24 saatte bitirir; bu yüzden yeniden kullanım
// alım ve kayıt süresi dahil beş dakika daha erken bırakılır.
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
  // Web Locks HTTPS ister; mevcut kurum içi HTTP dağıtımı bunun yerine
  // IndexedDB yazma işlemiyle eşzamanlı depo kritik bölümünü
  // sekmeler arasında serileştirir. Kilit ağ bekleyişi boyunca tutulmaz.
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
  // Tarayıcı dışı sınama ve sunucu istemcisi eşzamanlı depoya sahiptir;
  // rakip tarayıcı bağlamı yoktur. İki kilidi de olmayan tarayıcı erişimi kapatır.
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
    // Kapsamsız eski zarfın doğrulanabilir sahibi yoktur ve geri yüklenmez.
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
    const byId = new Map([...state.records.values()].map((record) => [`${record.entityType}:${record.id}`, record]));
    const entries = creationEntries(changes);
    const candidates = entries.flatMap(({ entry, entityType }) => {
      const record = state.records.get(`${entityType}:${extractActualId(entry.id)}`)
        || byId.get(`${entityType}:${entry.id}`);
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
    // Kalıcı sıkıştırma tamamlanmış eşlemeyi kaldırabilir; mevcut canlı istemci
    // bu kimlikleri hâlâ taşıyabilir. Doğrulanmış değişmez eşlemeleri
    // istemci durumu atılana kadar aynı haritada kalır. Yeni istemci
    // kaldırılmış satırı görüntüden kanonik sunucu kimliğiyle yükler.
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
      // Bu istek için toplanan biçim eşlemeleri güvenle birleştirilebilir.
      // Türlü oluşturma eşlemeleri yalnızca güncel kalıcı yaşam döngüsü görüntüsünden gelir.
      for (const [actual, client] of aliases) if (!actualIdAliasType(aliases, actual)
        && extractActualId(client) === actual && !state.aliases.has(actual)) state.aliases.set(actual, client);
      const result = mutation(state);
      if (state.records.size > MAX_ACTUAL_ID_ALIASES) throw capacityError();
      // Tek atomik yazma kaldırmalar dahil kanıt ve eşlemeleri içerir.
      // Bu yazma başarılı olmadan yeniden kullanılabilir yerel durum yayımlanmaz.
      storage?.setItem(storageKey(), JSON.stringify({ version: 2, pending: [...state.records.values()],
        aliases: encodeActualIdAliases(state.aliases, { pendingIds: new Set([...state.records.values()].map((record) => record.id)) }) }));
      publish(state, aliases);
      return result;
    }).catch((error) => { if (error?.code === 'UNAUTHORIZED' || error?.details?.code === 'CREATION_ALLOCATION_CAPACITY') throw error; throw storageError(); });
  }

  function prepareFrom(changes, state, aliases) {
    const mappings = new Map([...mappingsFor({ aliases }), ...mappingsFor(state)]);
    const mapped = new Set(mappings.values());
    const byId = new Map([...state.records.values()].map((record) => [`${record.entityType}:${record.id}`, record]));
    const prepared = remapCommitIds(changes, mappings);
    for (const { entry, entityType } of creationEntries(prepared)) {
      // Kanıt yalnızca güncel ve tam bağlı bekleyen kayıttan eklenir.
      delete entry.creationProof;
      const record = byId.get(`${entityType}:${entry.id}`);
      if (record) entry.creationProof = record.proof;
      else if (mapped.has(entry.id)) throw storageError();
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
      try { const state = read(); publish(state, aliases); } catch { /* Oluşturmaya bağlı kayıtlar erişimi kapatır.*/ }
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
          // Yalnızca bu işlemle ilgisiz süresi dolmuş kanıt kaldırılır. Türlü eşleme
          // korunur; belirsiz eski taslak hiçbir zaman ikinci kimlik alamaz.
          const referenced = new Set();
          const reference = (type, id) => { if (id) referenced.add(`${type}:${extractActualId(id)}`); };
          const translated = remapCommitIds(changes, mappings);
          for (const [collection, type] of CREATION_COLLECTIONS) {
            for (const entry of translated[collection] || []) {
              reference(type, entry.id); reference('PROJECT', entry.projectId);
              reference('WBS', entry.wbsId); reference('WBS', entry.parentId);
              reference('TASK', entry.recurrenceParentId);
              for (const dependency of entry.deps || []) reference('TASK', dependency.predecessorId);
            }
            for (const entry of translated[collection.replace('Upserts', 'Deletes')] || []) reference(type, typeof entry === 'string' ? entry : entry.id);
          }
          const time = now();
          for (const [key, record] of state.records) {
            if (Number.isFinite(record.allocatedAt) && time - record.allocatedAt >= CREATION_ALLOCATION_SERVER_TTL_MS
              && !referenced.has(`${record.entityType}:${record.id}`)) state.records.delete(key);
          }
          const needed = creationEntries(changes).filter(({ entry, entityType }) => !mappings.has(`${entityType}:${extractActualId(entry.id)}`)).length;
          if (state.records.size + needed > MAX_ACTUAL_ID_ALIASES) throw capacityError();
          return prepareFrom(changes, state, aliases);
        });
      } catch (error) {
        if (error?.code === 'UNAUTHORIZED' || creationEntries(changes).length) throw error;
        // Depo kullanılamaması sürümlü düzenleme veya silmeyi engellememelidir.
        return remapCommitIds(changes, mappingsFor({ aliases }));
      }
    },
    remember(allocations, aliases, changes, allocatedAt = now()) {
      const originals = new Map(creationEntries(changes).map(({ entry, entityType }) => [`${entityType}:${extractActualId(entry.id)}`, entry.id]));
      return mutate(aliases, (state) => {
        const stateMappings = mappingsFor(state), liveMappings = mappingsFor({ aliases });
        const unused = [];
        for (const value of allocations) {
          if (!isActualId(value.id) || !isActualId(value.clientId) || !isActualId(value.proof) || !isActualId(value.projectId)
            || !['PROJECT', 'WBS', 'TASK'].includes(value.entityType)) throw storageError();
          const record = { ...value, clientId: extractActualId(value.clientId), id: extractActualId(value.id), proof: extractActualId(value.proof), allocatedAt };
          const recordKey = `${record.entityType}:${record.clientId}`;
          // Rakip sekme bu taslağı zaten hatırlamış veya tamamlamış olabilir.
          // Bekleyen kanıtı korunur; kalıcı tamamlanmış kimlik değiştirilmez.
          if (state.records.has(recordKey)) {
            if (state.records.get(recordKey).proof !== record.proof) unused.push(record);
            continue;
          }
          if (stateMappings.has(recordKey) || liveMappings.has(recordKey)) throw storageError();
          record.clientAlias = originals.get(recordKey) || record.clientId;
          state.records.set(recordKey, record);
          if (state.aliases.get(record.clientId) === record.clientAlias) state.aliases.delete(record.clientId);
          state.aliases.set(record.id, record.clientAlias);
          actualIdAliasType(state.aliases, record.id, record.entityType);
        }
        return unused;
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
      } catch { /** Onaylı kayıt korunur; tüketilmiş kanıt iki kez oluşturamaz. */ }
    }
  };
}
