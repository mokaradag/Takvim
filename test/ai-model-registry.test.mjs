/**
 * Yapay zekâ · model ve yetenek kaydı.
 *
 * İş kodu profili ister; profil → model eşlemesi veridir. Model dizisi
 * değiştiğinde yalnızca kayıt belgesi değişir. Bozuk kayıt sessizce
 * varsayılana düşmez.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAiStack, runProbe } from './helpers/aiStack.mjs';

const {
  AI_PROFILES,
  AI_PROFILE_RESOLUTION_FAILURES,
  aiProfileRequirements,
  describeModelRegistry,
  resolveModelProfile,
  validateModelRegistry
} = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiModelRegistryState, loadAiModelRegistry, resetAiModelRegistryForTests } = await import('../src/server/ai/modelRegistryLoader.js');

function registry(overrides = {}) {
  return {
    version: 1,
    models: [
      { id: 'hizli-model', capabilities: ['chat', 'tools'] },
      { id: 'dusunen-model', capabilities: ['chat', 'reasoning'] },
      { id: 'gomme-model', capabilities: ['embedding'], contextTokens: 512 },
      { id: 'kapali-model', capabilities: ['chat'], enabled: false }
    ],
    profiles: {
      'chat.fast': { model: 'hizli-model', maxOutputTokens: 256 },
      'chat.reasoning': { model: 'dusunen-model', timeoutMs: 120000 },
      embedding: { model: 'gomme-model' }
    },
    ...overrides
  };
}

async function tempRegistryFile(t, document) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rota-ai-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ai-models.json');
  await writeFile(file, typeof document === 'string' ? document : JSON.stringify(document), 'utf8');
  return file;
}

test('varsayılan kayıt geçerlidir ve her profil gerekli yetenekleri taşıyan bir modele çözülür', () => {
  const validated = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  for (const profile of Object.values(AI_PROFILES)) {
    const resolved = resolveModelProfile(validated.registry, profile);
    assert.equal(resolved.ok, true, profile);
    for (const capability of aiProfileRequirements(profile)) {
      assert.ok(resolved.route.capabilities.includes(capability), `${profile} → ${capability}`);
    }
  }
  const fast = resolveModelProfile(validated.registry, AI_PROFILES.CHAT_FAST).route;
  assert.equal(fast.provider, 'onprem');
  assert.equal(fast.maxOutputTokens, 512);
  // Aşama 1 en büyük modele ya da en büyük bağlama göre kurulmaz.
  assert.notEqual(fast.model, 'Qwen3.5-397B-A17B-FP8');
  assert.equal(fast.contextTokens, null);
});

test('profil yapılandırılmış modele çözülür; bilinmeyen, eksik ya da kapalı profil kararlı nedenle reddedilir', () => {
  const { registry: parsed } = validateModelRegistry(registry({
    profiles: {
      'chat.fast': { model: 'hizli-model', maxOutputTokens: 256 },
      'chat.general': { model: 'kapali-model', enabled: false },
      embedding: { model: 'gomme-model' }
    }
  }));
  const fast = resolveModelProfile(parsed, 'chat.fast');
  assert.deepEqual(
    { ok: fast.ok, model: fast.route.model, tokens: fast.route.maxOutputTokens, timeout: fast.route.timeoutMs },
    { ok: true, model: 'hizli-model', tokens: 256, timeout: null }
  );
  assert.equal(resolveModelProfile(parsed, 'chat.fastest').reason, AI_PROFILE_RESOLUTION_FAILURES.UNKNOWN_PROFILE);
  assert.equal(resolveModelProfile(parsed, '__proto__').reason, AI_PROFILE_RESOLUTION_FAILURES.UNKNOWN_PROFILE);
  assert.equal(resolveModelProfile(parsed, 'vision').reason, AI_PROFILE_RESOLUTION_FAILURES.PROFILE_NOT_CONFIGURED);
  assert.equal(resolveModelProfile(parsed, 'chat.general').reason, AI_PROFILE_RESOLUTION_FAILURES.PROFILE_DISABLED);
  const summary = describeModelRegistry(parsed);
  assert.deepEqual(summary.find((entry) => entry.profile === 'chat.fast'), {
    profile: 'chat.fast', label: 'Hızlı sohbet', model: 'hizli-model', available: true, reason: null
  });
  assert.equal(summary.find((entry) => entry.profile === 'vision').available, false);
});

test('geçersiz kayıt belgesi bütün sorunlarıyla reddedilir ve değerleri yansıtmaz', () => {
  const secretLookingId = 'sk-bu-bir-anahtar-degil-ama-yansitilmamali';
  const result = validateModelRegistry({
    version: 2,
    models: [
      { id: 'hizli-model', capabilities: ['chat', 'uçan-halı'] },
      { id: 'hizli-model', capabilities: ['chat'] },
      { id: 'uzak-model', provider: 'bulut', capabilities: ['chat'] },
      { id: 'gomme-model', capabilities: ['embedding'], contextTokens: -5 },
      { id: 'bos-yetenek', capabilities: [] },
      { id: ' ', capabilities: ['chat'] }
    ],
    profiles: {
      'chat.fast': { model: secretLookingId },
      embedding: { model: 'hizli-model' },
      'sohbet.super': { model: 'hizli-model' },
      'chat.general': { model: 'gomme-model', maxOutputTokens: 0 }
    }
  });
  assert.equal(result.ok, false);
  const text = result.issues.join('\n');
  for (const expected of [
    'version', 'models[0].capabilities', 'models[1].id', 'models[2].provider', 'models[3].contextTokens',
    'models[4].capabilities', 'models[5].id', 'profiles.chat.fast.model', 'profiles.embedding.model',
    'tanınmayan profil', 'profiles.chat.general.maxOutputTokens'
  ]) {
    assert.ok(text.includes(expected), `${expected} bildirilmelidir:\n${text}`);
  }
  assert.equal(text.includes(secretLookingId), false);
  assert.equal(validateModelRegistry(null).ok, false);
  assert.equal(validateModelRegistry({ version: 1, models: [], profiles: {} }).ok, false);
});

test('etkin profil kapalı modele ya da yeteneği eksik modele bağlanamaz', () => {
  const disabledModel = validateModelRegistry(registry({ profiles: { 'chat.fast': { model: 'kapali-model' } } }));
  assert.match(disabledModel.issues.join('\n'), /profiles\.chat\.fast\.model: etkin profil kapalı bir modele bağlanamaz/);
  const mismatch = validateModelRegistry(registry({ profiles: { 'chat.reasoning': { model: 'hizli-model' } } }));
  assert.match(mismatch.issues.join('\n'), /gerekli yeteneği taşımıyor \(reasoning\)/);
  const disabledProfile = validateModelRegistry(registry({ profiles: { 'chat.fast': { model: 'kapali-model', enabled: false } } }));
  assert.equal(disabledProfile.ok, true);
});

test('model dizisi iş kodu değişmeden değişir: kayıt dosyası profili başka modele yönlendirir', async (t) => {
  const file = await tempRegistryFile(t, registry({ profiles: { 'chat.fast': { model: 'hizli-model', maxOutputTokens: 32 } } }));
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  const probe = await runProbe();
  assert.equal(probe.status, 200);
  assert.equal(probe.body.result.model, 'hizli-model');
  assert.equal(probe.body.result.profile, 'chat.fast');
  assert.equal(provider.calls[0].model, 'hizli-model');
  // Profilin çıktı sınırı çağıranın isteğini daraltır.
  assert.equal(provider.calls[0].maxOutputTokens, 32);
  assert.equal(aiModelRegistryState().source, 'file');
});

test('okunamayan ya da geçersiz kayıt dosyası varsayılana düşmez; yapılandırma hatası verir ve beklemeden sonra yeniden denenir', async (t) => {
  const broken = await tempRegistryFile(t, '{ "version": 1, "models": [ bozuk');
  const { provider, setEnv } = createAiStack(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: broken } });
  const probe = await runProbe();
  assert.equal(probe.status, 503);
  assert.equal(probe.body.error.code, 'AI_CONFIGURATION_ERROR');
  assert.equal(probe.body.error.details.reason, 'MODEL_REGISTRY_INVALID');
  assert.equal(provider.calls.length, 0);
  assert.equal(aiModelRegistryState().status, 'error');
  assert.match(aiModelRegistryState().issues[0], /ayrıştırılamadı/);

  const invalid = await tempRegistryFile(t, registry({ profiles: { 'chat.fast': { model: 'olmayan-model' } } }));
  setEnv({ MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: invalid });
  assert.equal((await runProbe()).body.error.details.reason, 'MODEL_REGISTRY_INVALID');
  assert.match(aiModelRegistryState().issues.join('\n'), /profiles\.chat\.fast\.model/);

  setEnv({ MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: path.join(path.dirname(invalid), 'yok.json') });
  assert.equal((await runProbe()).body.error.details.reason, 'MODEL_REGISTRY_INVALID');
  assert.match(aiModelRegistryState().issues[0], /okunamadı/);
});

test('bozuk kayıt dosyası düzeltildiğinde bekleme süresi dolunca yeniden okunur', async (t) => {
  const file = await tempRegistryFile(t, '[]');
  resetAiModelRegistryForTests();
  t.after(() => resetAiModelRegistryForTests());
  let now = 1000;
  await assert.rejects(loadAiModelRegistry({ path: file, now: () => now }), { code: 'AI_CONFIGURATION_ERROR' });
  await writeFile(file, JSON.stringify(registry()), 'utf8');
  now += 1000;
  await assert.rejects(loadAiModelRegistry({ path: file, now: () => now }), { code: 'AI_CONFIGURATION_ERROR' }, 'bekleme sürerken yeniden okunmaz');
  now += 30000;
  const loaded = await loadAiModelRegistry({ path: file, now: () => now });
  assert.equal(resolveModelProfile(loaded, 'chat.fast').route.model, 'hizli-model');
});

test('kapalı ya da tanımsız yetenek istendiğinde sağlayıcı çağrılmaz', async (t) => {
  const file = await tempRegistryFile(t, registry({ profiles: { 'chat.fast': { model: 'hizli-model', enabled: false } } }));
  const { provider } = createAiStack(t, { env: { MERGEN_ROTA_AI_MODEL_REGISTRY_PATH: file } });
  const probe = await runProbe();
  assert.equal(probe.status, 503);
  assert.equal(probe.body.error.code, 'AI_CONFIGURATION_ERROR');
  assert.equal(probe.body.error.details.reason, 'PROFILE_DISABLED');
  assert.equal(probe.body.error.message, 'İstenen yapay zekâ yeteneği yapılandırılmamış.');
  assert.equal(provider.calls.length, 0);
});

test('iş kodu somut model adı içermez; model adları yalnızca kayıt verisinde durur', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const modelIds = DEFAULT_AI_MODEL_REGISTRY.models.map((model) => model.id);
  const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  }))).flat();
  const files = (await walk(path.join(root, 'src'))).filter((file) => /\.(js|jsx)$/.test(file)
    && !file.endsWith(path.join('server', 'ai', 'defaultModelRegistry.js')));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const id of modelIds) assert.equal(source.includes(`'${id}'`), false, `${path.relative(root, file)} → ${id}`);
  }
});
