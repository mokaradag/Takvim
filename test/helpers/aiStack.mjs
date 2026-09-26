/**
 * Yapay zekâ testleri için ortak yığın.
 *
 * Gerçek rota gövdeleri, gerçek kimlik sağlayıcısı (geliştirme kipi), gerçek
 * SQL deposu kodu ve bellek içi SQL Server ikizi kullanılır; yalnızca yapay
 * zekâ sağlayıcısı belirlenimci ikizle değiştirilir. Kimlik ortam değişkeniyle
 * değiştirilir, tıpkı sunucudaki gibi yalnızca sunucu tarafında.
 */
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { createFakeAiProvider } from './fakeAiProvider.mjs';
import { createFakeDatabase, createFakeSqlServerDriver } from './fakeSqlServer.mjs';
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

registerServerOnlyShim();

export const SICIL_A = 900001;
export const SICIL_B = 900002;
export const SICIL_UNKNOWN = 900099;

export const PERSONAL_KEY_A = 'rota-test-personal-alpha-9f3Kq2Lm';
export const PERSONAL_KEY_B = 'rota-test-personal-bravo-4Hn8Zt6W';
export const DEFAULT_KEY = 'rota-test-corporate-default-Xy7Pq3Rs';
export const MASTER_KEY = createHash('sha256').update('mergen-rota/ai-test-master-key').digest('base64url');
export const OTHER_MASTER_KEY = createHash('sha256').update('mergen-rota/ai-test-master-key-rotated').digest('base64url');

const pool = await import('../../src/server/db/pool.js');
const { setCurrentUserProvider } = await import('../../src/server/identity/currentUserProvider.js');
const { resetAiRuntimeForTests, setAiProviderForTests } = await import('../../src/server/ai/aiRuntime.js');
const { resetAiConfigCacheForTests } = await import('../../src/server/ai/aiConfig.js');
const { resetAiModelRegistryForTests } = await import('../../src/server/ai/modelRegistryLoader.js');
const { resetAiTelemetryForTests } = await import('../../src/server/ai/aiTelemetry.js');
const { resetAiCredentialSchemaStateForTests } = await import('../../src/server/ai/aiCredentialStore.js');
const { resetAiDirectoryGateForTests } = await import('../../src/server/ai/aiCredentialService.js');
const { resetTelemetryRegistryForTests } = await import('../../src/server/observability/telemetryRegistry.js');
const { resetOperationalEventBufferForTests } = await import('../../src/server/observability/operationalEventsRepository.js');
const { resetAssistantGenerationsForTests } = await import('../../src/server/ai/assistant/assistantGenerations.js');
const { resetAssistantConversationGateForTests } = await import('../../src/server/ai/assistant/assistantService.js');

export const credentialRoute = await import('../../src/app/api/mergen-rota/ai/credential/route.js');
export const validationRoute = await import('../../src/app/api/mergen-rota/ai/credential/validation/route.js');
export const probeRoute = await import('../../src/app/api/mergen-rota/ai/probe/route.js');
export const assistantRoute = await import('../../src/app/api/mergen-rota/ai/assistant/route.js');
export const conversationsRoute = await import('../../src/app/api/mergen-rota/ai/assistant/conversations/route.js');
export const conversationPageRoute = await import('../../src/app/api/mergen-rota/ai/assistant/conversations/before/[cursor]/route.js');
export const conversationRoute = await import('../../src/app/api/mergen-rota/ai/assistant/conversations/[conversationId]/route.js');
export const turnsRoute = await import('../../src/app/api/mergen-rota/ai/assistant/turns/route.js');

const BASE_ENV = Object.freeze({
  MERGEN_ROTA_DB_SERVER: 'sql.test.internal',
  MERGEN_ROTA_DB_DATABASE: 'MERGEN_Rota',
  MERGEN_ROTA_AUTH_MODE: 'development',
  MERGEN_ROTA_DEV_IDENTITY_ENABLED: 'true',
  MERGEN_ROTA_AI_ENABLED: 'true',
  MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1',
  MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY,
  MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: MASTER_KEY
});

function resetAi() {
  resetAiRuntimeForTests();
  resetAiConfigCacheForTests();
  resetAiModelRegistryForTests();
  resetAiTelemetryForTests();
  resetAiCredentialSchemaStateForTests();
  resetAiDirectoryGateForTests();
  resetTelemetryRegistryForTests();
  resetOperationalEventBufferForTests();
  resetAssistantGenerationsForTests();
  resetAssistantConversationGateForTests();
}

export function defaultPeople() {
  return [
    { Sicil: SICIL_A, DisplayName: 'Deneme Kullanıcı A', Username: 'denemea' },
    { Sicil: SICIL_B, DisplayName: 'Deneme Kullanıcı B', Username: 'denemeb' }
  ];
}

/**
 * Ortamı hazırlar; `env` içindeki `null` değerler değişkeni SİLER.
 * Test bitince ortam, sürücü ve bütün yapay zekâ durumları geri alınır.
 */
export function createAiStack(t, { env = {}, sicil = SICIL_A, seed = {}, provider = null } = {}) {
  const previousEnv = { ...process.env };
  for (const [key, value] of Object.entries({ ...BASE_ENV, MERGEN_ROTA_DEV_SICIL: String(sicil), ...env })) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  const db = createFakeDatabase({ people: defaultPeople(), systemAdminSicils: [SICIL_A], ...seed });
  pool.setSqlDriverForTests(createFakeSqlServerDriver(db));
  pool.resetSqlPoolForTests();
  setCurrentUserProvider(null);
  resetAi();
  const fake = provider || createFakeAiProvider();
  setAiProviderForTests(fake);

  t.after(() => {
    setAiProviderForTests(null);
    resetAi();
    pool.setSqlDriverForTests(null);
    pool.resetSqlPoolForTests();
    setCurrentUserProvider(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  return {
    db,
    provider: fake,
    useSicil(next) {
      process.env.MERGEN_ROTA_DEV_SICIL = String(next);
    },
    setEnv(values) {
      for (const [key, value] of Object.entries(values)) {
        if (value == null) delete process.env[key];
        else process.env[key] = String(value);
      }
    }
  };
}

export function aiRequest(path, { method = 'GET', body, headers = {}, signal } = {}) {
  return new Request(`http://localhost/api/mergen-rota/ai${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    ...(signal ? { signal } : {})
  });
}

export async function readJson(response) {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, headers: response.headers };
}

export async function saveKey(apiKey, options = {}) {
  return readJson(await credentialRoute.PUT(aiRequest('/credential', { method: 'PUT', body: { apiKey }, ...options })));
}

export async function credentialStatus() {
  return readJson(await credentialRoute.GET(aiRequest('/credential')));
}

export async function removeKey() {
  return readJson(await credentialRoute.DELETE(aiRequest('/credential', { method: 'DELETE' })));
}

export async function validateKey(options = {}) {
  return readJson(await validationRoute.POST(aiRequest('/credential/validation', { method: 'POST', ...options })));
}

export async function runProbe(options = {}) {
  return readJson(await probeRoute.POST(aiRequest('/probe', { method: 'POST', ...options })));
}

/* ── Rota AI sohbet uçları ─────────────────────────────────── */

/**
 * Akış yanıtını olay dizisine çevirir (testin kendi, bağımsız ayrıştırıcısı).
 * Yorum satırları (canlı tutma) ayrıca sayılır.
 */
export function parseSseText(text) {
  const events = [];
  let comments = 0;
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith(':'))) {
      comments += 1;
      continue;
    }
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
    const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    events.push({ event, data: data ? JSON.parse(data) : null });
  }
  return { events, comments };
}

export async function readSse(response) {
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, ...parseSseText(text) };
}

export function turnRequest(body, { headers = {}, signal } = {}) {
  return aiRequest('/assistant/turns', { method: 'POST', body, headers, signal });
}

/** Tur gönderir; akış tamamlanınca olaylar döner (hata yanıtında JSON gövdesi). */
export async function sendTurn(body, options = {}) {
  const response = await turnsRoute.POST(turnRequest({ mode: 'standard', conversationId: null, ...body }, options));
  if (String(response.headers.get('content-type') || '').startsWith('text/event-stream')) return readSse(response);
  return readJson(response);
}

export async function listAssistantConversations(cursor = null) {
  if (cursor == null) return readJson(await conversationsRoute.GET(aiRequest('/assistant/conversations')));
  return readJson(await conversationPageRoute.GET(aiRequest(`/assistant/conversations/before/${cursor}`), { params: { cursor } }));
}

export async function loadAssistantConversation(conversationId) {
  return readJson(await conversationRoute.GET(aiRequest(`/assistant/conversations/${conversationId}`), { params: { conversationId } }));
}

export async function deleteAssistantConversation(conversationId, options = {}) {
  return readJson(await conversationRoute.DELETE(
    aiRequest(`/assistant/conversations/${conversationId}`, { method: 'DELETE', ...options }),
    { params: { conversationId } }
  ));
}

export async function assistantReadiness() {
  return readJson(await assistantRoute.GET(aiRequest('/assistant')));
}

/**
 * Konsola yazılan her satırı yakalar; test sonunda özgün yöntemler geri gelir.
 *
 * Değerler gerçek konsolun yazdığı biçimde (`util.inspect`) kaydedilir: `Error`
 * nesnelerinin iletisi ve yığın izi (JSON'da görünmez) sızıntı denetimine
 * girer; döngüsel nesne ya da BigInt yakalayıcıyı düşürmez.
 */
export function captureConsole(t) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = console[method];
    console[method] = (...args) => {
      lines.push(args.map((value) => (typeof value === 'string' ? value : inspect(value, { depth: 10, breakLength: Infinity }))).join(' '));
    };
  }
  t.after(() => Object.assign(console, originals));
  return lines;
}
