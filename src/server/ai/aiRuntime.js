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
  globalThis[RUNTIME_KEY] ||= { provider: null, providerOverride: null, admission: null, gateway: null, load: null };
  return globalThis[RUNTIME_KEY];
}

/**
 * Yük penceresi: son örnekten bu yana etkin/sıradaki istek sayısının zamana
 * göre integrali. Kapasite her değiştiğinde (kabul, bırakma, sıraya girme)
 * ilerletilir; telemetri turu penceredeki ZAMAN AĞIRLIKLI ortalamayı yazar.
 */
function loadWindow(at, active = 0, queued = 0) {
  return { startedAt: at, lastAt: at, active, queued, activeArea: 0, queuedArea: 0 };
}

function advanceLoad(window, at) {
  const elapsed = Math.max(0, at - window.lastAt);
  window.activeArea += window.active * elapsed;
  window.queuedArea += window.queued * elapsed;
  window.lastAt = Math.max(window.lastAt, at);
}

function noteAdmissionChange({ active, queued }) {
  const current = runtime();
  const at = Date.now();
  current.load ||= loadWindow(at);
  advanceLoad(current.load, at);
  current.load.active = active;
  current.load.queued = queued;
}

/**
 * Kapasite denetimi süreç ömrü boyunca TEKTİR; sınırlar ilk kullanımda okunur.
 * Sınırı değiştirmek yeniden başlatma gerektirir: denetimi yeniden kurmak,
 * süren isteklerin kiralarını unutup kapasiteyi aşmak olurdu. Her kapasite
 * değişimi yük penceresine işlenir.
 */
function getAiAdmission(config = readAiConfig()) {
  const current = runtime();
  current.admission ||= createAiAdmissionController({ limits: config.limits, onChange: noteAdmissionChange });
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
 * Yük ölçümü telemetri turunun ritminde yazılır.
 *
 * Yalnızca durum değişiminde yazılan örnekler boşta geçen kovalarda veri
 * boşluğu bırakır ve ortalamayı olay anlarına göre çarpıtırdı; yalnızca tur
 * anındaki anlık değer ise iki tur arasında başlayıp biten bir yük patlamasını
 * hiç görmezdi. Her tur bu yüzden son turdan bu yana kapasite değişimleriyle
 * biriken ZAMAN AĞIRLIKLI ortalamayı yazar: boşta sıfır, tur arasındaki kısa
 * yük süresiyle orantılı olarak görünür. Henüz kurulmamış çalışma zamanında
 * sıfır yazılır; yapay zekâ kapalıysa örnek yazılmaz.
 */
export function sampleAiLoad(now = Date.now()) {
  if (!readAiConfig().enabled) return;
  const current = runtime();
  const window = current.load;
  if (!window) {
    const load = aiRuntimeLoad();
    recordAiLoad({ active: load?.active ?? 0, queued: load?.queued ?? 0 }, now);
    current.load = loadWindow(now, load?.active ?? 0, load?.queued ?? 0);
    return;
  }
  advanceLoad(window, now);
  const span = window.lastAt - window.startedAt;
  recordAiLoad(span > 0
    ? { active: window.activeArea / span, queued: window.queuedArea / span }
    : { active: window.active, queued: window.queued }, now);
  current.load = loadWindow(window.lastAt, window.active, window.queued);
}

/** Yalnızca testler: gerçek ağ yerine belirlenimci sağlayıcı bağlar. */
export function setAiProviderForTests(provider) {
  runtime().providerOverride = provider || null;
}

export function resetAiRuntimeForTests() {
  globalThis[RUNTIME_KEY] = undefined;
}
