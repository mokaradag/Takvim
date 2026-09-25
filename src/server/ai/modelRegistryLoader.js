import 'server-only';
import { open } from 'node:fs/promises';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { describeModelRegistry, validateModelRegistry } from '../../domain/ai/aiModelRegistry.js';
import { AiError } from './aiErrors.js';
import { DEFAULT_AI_MODEL_REGISTRY } from './defaultModelRegistry.js';

/**
 * Model kaydının yüklenmesi.
 *
 * Kayıt süreç başına bir kez okunur; değişiklik yeniden başlatmayla geçerli
 * olur. Dosya okuması SÜRE SINIRLIDIR ve tek uçuştur: erişilemeyen bir UNC
 * paylaşımı istekleri bekletmez. Bozuk ya da okunamayan dosya sessizce
 * varsayılana düşmez; yapılandırma hatası olarak bildirilir ve kısa bir
 * beklemeden sonra yeniden denenir.
 */

const STATE_KEY = Symbol.for('mergen-rota.ai-model-registry');
/** Dosya kaydının okunma bütçesi; istemci süre hesabı da bu değeri kullanır. */
export const AI_MODEL_REGISTRY_READ_TIMEOUT_MS = 5000;
const FILE_RETRY_AFTER_FAILURE_MS = 30000;
const MAX_FILE_BYTES = 256 * 1024;
const UTF8_BOM = '﻿';

function emptyState() {
  return {
    key: null, source: null, status: 'idle', registry: null, issues: [], loadedAt: null, retryAt: 0,
    inFlight: null, fileOperation: null
  };
}

function state() {
  globalThis[STATE_KEY] ||= emptyState();
  return globalThis[STATE_KEY];
}

function registryUnavailable(source) {
  return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
    details: { reason: 'MODEL_REGISTRY_INVALID', registrySource: source }
  });
}

/**
 * Boyut sınırı OKUNAN BAYTLARA uygulanır: `stat` ile okuma arasında büyüyen ya
 * da değiştirilen dosya sınırı aşamaz. Denetim ve okuma aynı dosya tanıtıcısı
 * üzerinden yapılır; sınırın bir bayt fazlası okunursa dosya reddedilir.
 */
async function readBoundedFile(path, signal) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('REGISTRY_FILE_INVALID');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      if (signal.aborted) throw new Error('REGISTRY_FILE_TIMEOUT');
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw new Error('REGISTRY_FILE_INVALID');
    const text = buffer.subarray(0, total).toString('utf8');
    // Windows düzenleyicilerinin eklediği UTF-8 BOM geçerli bir belgeyi bozmaz.
    return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Süre sınırlı okuma.
 *
 * Süre dolunca çağıran hemen serbest kalır; ancak açma/okuma sistem çağrısı
 * iptal edilemez. Alttaki işlem GERÇEKTEN bitene kadar `fileOperation`
 * işareti durur ve yeni okuma başlatılmaz: erişilemeyen bir paylaşımda takılı
 * işlemler iş parçacığı havuzunda (SQL sürücüsünün de kullandığı) birikmez.
 */
function readRegistryFile(current, path) {
  const controller = new AbortController();
  let timer;
  const read = readBoundedFile(path, controller.signal);
  current.fileOperation = read;
  // Süre dolduktan sonra gelen ret sahipsiz kalmaz; işaret ancak işlem bitince kalkar.
  read.catch(() => {}).finally(() => {
    const holder = state();
    if (holder.fileOperation === read) holder.fileOperation = null;
  });
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('REGISTRY_FILE_TIMEOUT'));
    }, AI_MODEL_REGISTRY_READ_TIMEOUT_MS);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

function settle(current, { source, registry = null, issues = [], now }) {
  current.source = source;
  current.registry = registry;
  current.issues = issues;
  current.status = registry ? 'ready' : 'error';
  current.loadedAt = new Date(now).toISOString();
  current.retryAt = registry ? 0 : now + FILE_RETRY_AFTER_FAILURE_MS;
}

/**
 * Aynı nesnede yinelenen alan adı. `JSON.parse` yinelenen alanın yalnızca son
 * değerini tutar: bir birleştirme/düzenleme hatası daha önceki bir güvenlik
 * sınırını ya da profil eşlemesini sessizce değiştirebilirdi. Metin önceden
 * `JSON.parse` ile doğrulandığı için tarayıcı yalnızca iyi biçimli JSON görür.
 */
export function findDuplicateJsonKey(text) {
  const stack = [];
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      index = end;
    } else if (char === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (char === '[') {
      stack.push(null);
      expectKey = false;
    } else if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
    } else if (char === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return null;
}

async function loadFromFile(current, path, now) {
  let document;
  let text;
  try {
    text = await readRegistryFile(current, path);
    document = JSON.parse(text);
  } catch (error) {
    const unreadable = error instanceof SyntaxError ? 'JSON olarak ayrıştırılamadı' : 'okunamadı ya da süre sınırında yanıt vermedi';
    settle(current, { source: 'file', issues: [`$: kayıt dosyası ${unreadable}`], now: now() });
    throw registryUnavailable('file');
  }
  const duplicate = findDuplicateJsonKey(text);
  if (duplicate != null) {
    settle(current, { source: 'file', issues: [`$: aynı nesnede yinelenen alan adı: "${String(duplicate).slice(0, 60)}"`], now: now() });
    throw registryUnavailable('file');
  }
  const validated = validateModelRegistry(document);
  settle(current, { source: 'file', registry: validated.ok ? validated.registry : null, issues: validated.ok ? [] : validated.issues, now: now() });
  if (!validated.ok) throw registryUnavailable('file');
  return validated.registry;
}

/** Etkin model kaydı; `path` verilmezse depo içindeki varsayılan belge kullanılır. */
export async function loadAiModelRegistry({ path = null, now = Date.now } = {}) {
  let current = state();
  const key = path ? `file:${path}` : 'default';
  if (current.key !== key) {
    // Önceki yolun hâlâ süren dosya işlemi unutulmaz.
    globalThis[STATE_KEY] = { ...emptyState(), key, fileOperation: current.fileOperation };
    current = globalThis[STATE_KEY];
  }
  if (current.status === 'ready') return current.registry;
  if (current.inFlight) return current.inFlight;
  if (!path) {
    const validated = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY);
    settle(current, { source: 'default', registry: validated.ok ? validated.registry : null, issues: validated.ok ? [] : validated.issues, now: now() });
    if (!validated.ok) throw registryUnavailable('default');
    return validated.registry;
  }
  if (current.status === 'error' && now() < current.retryAt) throw registryUnavailable('file');
  // Süre aşımına uğramış önceki okuma hâlâ sürüyorsa yenisi başlatılmaz.
  if (current.fileOperation) throw registryUnavailable('file');
  const job = loadFromFile(current, path, now).finally(() => {
    current.inFlight = null;
  });
  current.inFlight = job;
  return job;
}

/** Yüklenmiş kayıt (G/Ç yapmaz); henüz hazır değilse `null`. Tarayıcıya gitmez. */
export function cachedAiModelRegistry() {
  const current = state();
  return current.status === 'ready' ? current.registry : null;
}

/** Sağlık görünümü için ÖNBELLEKTEKİ durum; hiçbir G/Ç yapmaz. */
export function aiModelRegistryState() {
  const current = state();
  return {
    source: current.source,
    status: current.inFlight ? 'loading' : current.status,
    issues: [...current.issues],
    loadedAt: current.loadedAt,
    profiles: describeModelRegistry(current.registry)
  };
}

export function resetAiModelRegistryForTests() {
  globalThis[STATE_KEY] = emptyState();
}
