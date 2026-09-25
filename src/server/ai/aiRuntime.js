import 'server-only';
import { createAiAdmissionController } from './admissionController.js';
import { readAiConfig } from './aiConfig.js';
import { createAiGateway } from './aiGateway.js';
import { recordAiLoad } from './aiTelemetry.js';
import { createOpenAiCompatibleProvider } from './providers/openAiCompatibleProvider.js';

/**
 * Süreç düzeyi yapay zekâ çalışma zamanı.
 *
 * Kapasite denetimi, sağlayıcı bağdaştırıcısı ve ağ geçidi süreç başına TEK
 * örnektir ve `globalThis` üzerinde tutulur (Next.js modül yeniden yüklemesi
 * ikinci bir kapasite havuzu açmaz). Sınırlar süreç başınadır; birden çok
 * uygulama örneğinde toplam kapasite örnek sayısıyla çarpılır.
 */

const RUNTIME_KEY = Symbol.for('mergen-rota.ai-runtime');

function runtime() {
  globalThis[RUNTIME_KEY] ||= { provider: null, providerOverride: null, admission: null, gateway: null };
  return globalThis[RUNTIME_KEY];
}

/**
 * Kapasite denetimi süreç ömrü boyunca TEKTİR; sınırlar ilk kullanımda okunur.
 * Sınırı değiştirmek yeniden başlatma gerektirir: denetimi yeniden kurmak,
 * süren isteklerin kiralarını unutup kapasiteyi aşmak olurdu.
 */
function getAiAdmission(config = readAiConfig()) {
  const current = runtime();
  current.admission ||= createAiAdmissionController({ limits: config.limits });
  return current.admission;
}

export function getAiProvider() {
  const current = runtime();
  if (current.providerOverride) return current.providerOverride;
  current.provider ||= createOpenAiCompatibleProvider();
  return current.provider;
}

export function getAiGateway() {
  const current = runtime();
  current.gateway ||= createAiGateway({ getProvider: getAiProvider, getAdmission: getAiAdmission });
  return current.gateway;
}

/** Kapasite durumu; çalışma zamanı henüz kurulmadıysa `null`. */
export function aiRuntimeLoad() {
  return runtime().admission?.status() ?? null;
}

/**
 * Yük ölçümü telemetri turunun ritminde örneklenir.
 *
 * Yalnızca durum değişiminde yazılan örnekler boşta geçen kovalarda veri
 * boşluğu bırakır ve ortalamayı olay anlarına göre çarpıtırdı. Her tur, hiçbir
 * istek yokken de (henüz kurulmamış çalışma zamanı dâhil) sıfır değerle
 * örneklenir; yapay zekâ kapalıysa örnek yazılmaz.
 */
export function sampleAiLoad(now = Date.now()) {
  if (!readAiConfig().enabled) return;
  const load = aiRuntimeLoad();
  recordAiLoad({ active: load?.active ?? 0, queued: load?.queued ?? 0 }, now);
}

/** Yalnızca testler: gerçek ağ yerine belirlenimci sağlayıcı bağlar. */
export function setAiProviderForTests(provider) {
  runtime().providerOverride = provider || null;
}

export function resetAiRuntimeForTests() {
  globalThis[RUNTIME_KEY] = undefined;
}
