/**
 * Anlamsal model sınırı sınamaları için gerçek ağ geçidi: kapasite denetimi,
 * yapılandırma ve kayıt gerçektir; yalnızca sağlayıcı (süreç içi ikiz),
 * güvenilir Sicil ve kimlik bilgisi sınama değerleridir. Kayıt bir işlev de
 * olabilir: her çağrıda güncel değeri okunur (model değişimi sınamaları).
 */
import assert from 'node:assert/strict';
import { createFakeAiProvider } from './fakeAiProvider.mjs';
import { DEFAULT_KEY } from './aiStack.mjs';

const { createAiAdmissionController } = await import('../../src/server/ai/admissionController.js');
const { createAiGateway } = await import('../../src/server/ai/aiGateway.js');
const { parseAiConfig } = await import('../../src/server/ai/aiConfig.js');
const { validateModelRegistry } = await import('../../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../../src/server/ai/defaultModelRegistry.js');
const { resetAiTelemetryForTests } = await import('../../src/server/ai/aiTelemetry.js');
const { resetTelemetryRegistryForTests } = await import('../../src/server/observability/telemetryRegistry.js');

export const DEFAULT_REGISTRY = validateModelRegistry(DEFAULT_AI_MODEL_REGISTRY).registry;

/** Varsayılan kaydın değiştirilmiş, doğrulanmış kopyası. */
export function registryWith({ models = (model) => model, profiles = {} } = {}) {
  const validated = validateModelRegistry({
    ...DEFAULT_AI_MODEL_REGISTRY,
    models: DEFAULT_AI_MODEL_REGISTRY.models.map(models),
    profiles: { ...DEFAULT_AI_MODEL_REGISTRY.profiles, ...profiles }
  });
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  return validated.registry;
}

export function semanticGatewayFor(t, { provider = createFakeAiProvider(), registry = DEFAULT_REGISTRY, env = {}, random = () => 0 } = {}) {
  resetAiTelemetryForTests();
  resetTelemetryRegistryForTests();
  t.after(() => {
    resetAiTelemetryForTests();
    resetTelemetryRegistryForTests();
  });
  const config = parseAiConfig({
    MERGEN_ROTA_AI_ENABLED: 'true',
    MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1',
    MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY,
    ...env
  });
  assert.deepEqual(config.issues, []);
  const admission = createAiAdmissionController({ limits: config.limits });
  const gateway = createAiGateway({
    getProvider: () => provider,
    getAdmission: () => admission,
    loadConfig: () => config,
    loadRegistry: async () => (typeof registry === 'function' ? registry() : registry),
    resolveCredential: async () => ({ source: 'default', apiKey: DEFAULT_KEY }),
    currentSicil: async () => 900001,
    verifySicil: async () => {},
    random
  });
  return { gateway, admission, provider, config };
}

export function assertIdle(admission) {
  assert.deepEqual({ active: admission.status().active, queued: admission.status().queued }, { active: 0, queued: 0 });
}
