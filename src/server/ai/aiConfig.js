import 'server-only';
import { normalizeApiKeyInput } from '../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
import { AiError } from './aiErrors.js';

/**
 * Yapay zekâ yapılandırması — YALNIZCA sunucu tarafı.
 *
 * Doğrulama merkezîdir ve kapalı kalacak biçimde başarısız olur: geçersiz bir
 * değer sessizce varsayılana çevrilmez, sorunlu AYARIN ADI `issues` listesine
 * yazılır ve yapay zekâ kullanılamaz sayılır. Değerlerin kendisi (anahtar,
 * adres, yol) hiçbir tanı çıktısına taşınmaz.
 */

const NAMES = Object.freeze({
  ENABLED: 'MERGEN_ROTA_AI_ENABLED',
  BASE_URL: 'MERGEN_ROTA_AI_BASE_URL',
  ALLOW_INSECURE_HTTP: 'MERGEN_ROTA_AI_ALLOW_INSECURE_HTTP',
  DEFAULT_API_KEY: 'MERGEN_ROTA_AI_DEFAULT_API_KEY',
  MASTER_KEY: 'MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY',
  REGISTRY_PATH: 'MERGEN_ROTA_AI_MODEL_REGISTRY_PATH',
  MAX_ACTIVE: 'MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS',
  MAX_QUEUED: 'MERGEN_ROTA_AI_MAX_QUEUED_REQUESTS',
  MAX_ACTIVE_PER_USER: 'MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER',
  MAX_QUEUED_PER_USER: 'MERGEN_ROTA_AI_MAX_QUEUED_PER_USER',
  QUEUE_TIMEOUT_MS: 'MERGEN_ROTA_AI_QUEUE_TIMEOUT_MS',
  REQUEST_TIMEOUT_MS: 'MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS'
});

export const AI_CONFIG_NAMES = NAMES;

/** Kişisel ve kurumsal anahtarın ikisi de yapılandırılmamış. */
export const NO_CREDENTIAL_SOURCE = 'NO_CREDENTIAL_SOURCE';

const INTEGER_SETTINGS = Object.freeze({
  [NAMES.MAX_ACTIVE]: { fallback: 8, min: 1, max: 256 },
  [NAMES.MAX_QUEUED]: { fallback: 32, min: 0, max: 1024 },
  [NAMES.MAX_ACTIVE_PER_USER]: { fallback: 2, min: 1, max: 32 },
  [NAMES.MAX_QUEUED_PER_USER]: { fallback: 2, min: 0, max: 64 },
  [NAMES.QUEUE_TIMEOUT_MS]: { fallback: 20000, min: 100, max: 120000 },
  [NAMES.REQUEST_TIMEOUT_MS]: { fallback: 90000, min: 1000, max: 600000 }
});

function text(env, name) {
  const raw = env[name];
  return raw == null ? '' : String(raw).trim();
}

function parseBoolean(env, name, fallback, issues) {
  const raw = text(env, name);
  if (!raw) return fallback;
  if (/^(1|true|yes|evet)$/i.test(raw)) return true;
  if (/^(0|false|no|hayir|hayır)$/i.test(raw)) return false;
  issues.push(name);
  return false;
}

function parseInteger(env, name, issues) {
  const { fallback, min, max } = INTEGER_SETTINGS[name];
  const raw = text(env, name);
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    issues.push(name);
    return fallback;
  }
  return value;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * OpenAI uyumlu taban adres.
 *
 * Anahtar `Authorization` başlığında taşındığı için düz HTTP yalnızca yerel
 * geri döngü adresinde ya da açık `MERGEN_ROTA_AI_ALLOW_INSECURE_HTTP=true`
 * onayıyla kabul edilir. Adreste kimlik bilgisi, sorgu ya da parça bulunamaz.
 */
function parseBaseUrl(env, allowInsecureHttp, issues) {
  const raw = text(env, NAMES.BASE_URL);
  let url = null;
  try {
    url = raw ? new URL(raw) : null;
  } catch {
    url = null;
  }
  const secureEnough = url && (url.protocol === 'https:'
    || (url.protocol === 'http:' && (allowInsecureHttp || isLoopbackHost(url.hostname))));
  if (!secureEnough || url.username || url.password || url.search || url.hash) {
    issues.push(NAMES.BASE_URL);
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Örnek dosyadaki `<AD>` biçimli yer tutucu; gerçek anahtar yerine bırakılmış demektir. */
const PLACEHOLDER_PATTERN = /^<[^<>]*>$/;

/**
 * Kurumsal anahtar, kişisel anahtarla AYNI biçim kuralından geçer; ayrıca
 * yalnızca bütünüyle yer tutucu olan değer reddedilir. İkinci bir anahtar
 * dilbilgisi, kişisel olarak kabul edilen bir anahtarı kurumsal olarak
 * reddedip bütün yapılandırmayı kullanılamaz kılardı.
 */
function parseDefaultApiKey(env, issues) {
  const raw = text(env, NAMES.DEFAULT_API_KEY);
  if (!raw) return null;
  const normalized = normalizeApiKeyInput(raw);
  if (!normalized.ok || PLACEHOLDER_PATTERN.test(normalized.value)) {
    issues.push(NAMES.DEFAULT_API_KEY);
    return null;
  }
  return normalized.value;
}

/**
 * Ana şifreleme anahtarı: tam 32 rastgele baytın base64/base64url yazımı.
 *
 * Parola benzeri serbest metin kabul edilmez; zayıf bir parolayı anahtara
 * çevirmek, şifrelemenin gücünü o parolaya indirirdi.
 */
function parseMasterKey(env, issues) {
  const raw = text(env, NAMES.MASTER_KEY);
  if (!raw) return null;
  const bytes = /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)
    ? Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    : Buffer.alloc(0);
  if (bytes.length !== 32 || bytes.every((byte) => byte === bytes[0])) {
    issues.push(NAMES.MASTER_KEY);
    return null;
  }
  return bytes;
}

function parseRegistryPath(env, issues) {
  const raw = text(env, NAMES.REGISTRY_PATH);
  if (!raw) return null;
  const absolute = /^(?:\\\\[^\\]+\\[^\\]+|[a-z]:[\\/]|\/)/i.test(raw);
  if (!absolute || !/\.json$/i.test(raw)) {
    issues.push(NAMES.REGISTRY_PATH);
    return null;
  }
  return raw;
}

function disabledConfig(issues) {
  return Object.freeze({
    enabled: false,
    available: false,
    issues: Object.freeze([...new Set(issues)]),
    baseUrl: null,
    defaultApiKey: null,
    masterKey: null,
    registryPath: null,
    personalKeysSupported: false,
    defaultKeyConfigured: false,
    insecureHttpAllowed: false,
    limits: Object.freeze({
      maxActive: INTEGER_SETTINGS[NAMES.MAX_ACTIVE].fallback,
      maxQueued: INTEGER_SETTINGS[NAMES.MAX_QUEUED].fallback,
      maxActivePerUser: INTEGER_SETTINGS[NAMES.MAX_ACTIVE_PER_USER].fallback,
      maxQueuedPerUser: INTEGER_SETTINGS[NAMES.MAX_QUEUED_PER_USER].fallback
    }),
    queueTimeoutMs: INTEGER_SETTINGS[NAMES.QUEUE_TIMEOUT_MS].fallback,
    requestTimeoutMs: INTEGER_SETTINGS[NAMES.REQUEST_TIMEOUT_MS].fallback
  });
}

export function parseAiConfig(env = process.env) {
  const issues = [];
  const enabled = parseBoolean(env, NAMES.ENABLED, false, issues);
  if (!enabled) return disabledConfig(issues);

  const allowInsecureHttp = parseBoolean(env, NAMES.ALLOW_INSECURE_HTTP, false, issues);
  const baseUrl = parseBaseUrl(env, allowInsecureHttp, issues);
  const defaultApiKey = parseDefaultApiKey(env, issues);
  const masterKey = parseMasterKey(env, issues);
  const registryPath = parseRegistryPath(env, issues);
  const limits = Object.freeze({
    maxActive: parseInteger(env, NAMES.MAX_ACTIVE, issues),
    maxQueued: parseInteger(env, NAMES.MAX_QUEUED, issues),
    maxActivePerUser: parseInteger(env, NAMES.MAX_ACTIVE_PER_USER, issues),
    maxQueuedPerUser: parseInteger(env, NAMES.MAX_QUEUED_PER_USER, issues)
  });
  if (limits.maxActivePerUser > limits.maxActive) issues.push(NAMES.MAX_ACTIVE_PER_USER);
  if (limits.maxQueuedPerUser > limits.maxQueued) issues.push(NAMES.MAX_QUEUED_PER_USER);
  const queueTimeoutMs = parseInteger(env, NAMES.QUEUE_TIMEOUT_MS, issues);
  const requestTimeoutMs = parseInteger(env, NAMES.REQUEST_TIMEOUT_MS, issues);
  if (!text(env, NAMES.DEFAULT_API_KEY) && !text(env, NAMES.MASTER_KEY)) issues.push(NO_CREDENTIAL_SOURCE);
  const uniqueIssues = Object.freeze([...new Set(issues)]);

  return Object.freeze({
    enabled: true,
    available: uniqueIssues.length === 0,
    issues: uniqueIssues,
    baseUrl,
    defaultApiKey,
    masterKey,
    registryPath,
    personalKeysSupported: masterKey != null,
    defaultKeyConfigured: defaultApiKey != null,
    insecureHttpAllowed: allowInsecureHttp,
    limits,
    queueTimeoutMs,
    requestTimeoutMs
  });
}

/**
 * Yapay zekâ kullanılabilir mi? Değilse kararlı hata fırlatır.
 *
 * Bilinçli olarak kapatılmış özellik `AI_DISABLED` olur; geçersiz bir
 * `MERGEN_ROTA_AI_ENABLED` değeri (ör. `tru`) ise kapalı sayılır ama
 * yapılandırma hatasıdır ve öyle bildirilir.
 */
export function requireAiAvailable(config) {
  if (!config.enabled) {
    if (config.issues.length) {
      throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'CONFIGURATION_INVALID' } });
    }
    throw new AiError(AI_ERROR_CODES.AI_DISABLED);
  }
  if (!config.available) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'CONFIGURATION_INVALID' } });
  }
  return config;
}

let cachedSignature = null;
let cachedConfig = null;

/** Süreç ortamından okunan yapılandırma; değerler değişmedikçe yeniden ayrıştırılmaz. */
export function readAiConfig() {
  const signature = Object.values(NAMES).map((name) => process.env[name] ?? '').join('\u0000');
  if (signature !== cachedSignature || !cachedConfig) {
    cachedConfig = parseAiConfig(process.env);
    cachedSignature = signature;
  }
  return cachedConfig;
}

/** Yönetim ekranı ve istemci için GİZLİ DEĞER TAŞIMAYAN özet. */
export function aiConfigurationSummary(config) {
  return {
    enabled: config.enabled,
    available: config.available,
    issues: [...config.issues],
    baseUrlConfigured: Boolean(config.baseUrl),
    insecureHttpAllowed: config.insecureHttpAllowed,
    defaultKeyConfigured: config.defaultKeyConfigured,
    personalKeysSupported: config.personalKeysSupported,
    registrySource: config.registryPath ? 'file' : 'default',
    limits: { ...config.limits },
    queueTimeoutMs: config.queueTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs
  };
}

export function resetAiConfigCacheForTests() {
  cachedSignature = null;
  cachedConfig = null;
}
