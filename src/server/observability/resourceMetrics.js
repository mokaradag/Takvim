import 'server-only';
import { freemem, loadavg, platform, totalmem } from 'node:os';

/**
 * Süreç ve sunucu kaynak ölçümleri.
 *
 * İşletim sistemine göre DEĞİŞEN ölçümler uydurulmaz: bir değer bu
 * platformda anlamlı değilse `{ available: false }` döner ve arayüz
 * "ölçülemiyor" gösterir. Yanlış bir sayı, hiç sayı olmamasından kötüdür.
 */

const SAMPLE_KEY = Symbol.for('mergen-rota.resource-sample');

function gauge(value, { unit = null, available = true } = {}) {
  // `Number(null)` sıfır üretir: ölçüm YOKLUĞU sıfır değer gibi bildirilemez.
  if (value == null || value === '') return { available: false, value: null, unit };
  const numeric = Number(value);
  if (!available || !Number.isFinite(numeric)) return { available: false, value: null, unit };
  return { available: true, value: numeric, unit };
}

/**
 * Olay döngüsü gecikmesi.
 *
 * `perf_hooks.monitorEventLoopDelay` her çalışma zamanında bulunmaz; yoksa
 * ölçüm "kullanılamıyor" olarak bildirilir, tahmin üretilmez.
 */
function eventLoopDelay() {
  const monitor = globalThis[SAMPLE_KEY]?.loopMonitor;
  if (!monitor) return gauge(null, { unit: 'ms', available: false });
  try {
    return gauge(monitor.mean / 1e6, { unit: 'ms' });
  } catch {
    return gauge(null, { unit: 'ms', available: false });
  }
}

/** Olay döngüsü izleyicisini bir kez başlatır (süreç düzeyinde). */
export async function startResourceMonitoring() {
  if (globalThis[SAMPLE_KEY]) return;
  globalThis[SAMPLE_KEY] = { loopMonitor: null, lastCpu: null };
  try {
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    if (typeof monitorEventLoopDelay === 'function') {
      const monitor = monitorEventLoopDelay({ resolution: 20 });
      monitor.enable();
      globalThis[SAMPLE_KEY].loopMonitor = monitor;
    }
  } catch {
    // İzleyici yoksa gecikme ölçümü "kullanılamıyor" olarak bildirilir.
  }
}

/**
 * İki ölçüm arası süreç CPU kullanımı (%).
 *
 * Tek bir `process.cpuUsage()` okuması SÜREÇ ÖMRÜ boyunca toplam CPU'yu verir;
 * onu anlık kullanım gibi göstermek yanıltıcıdır. Bu yüzden oran ancak iki
 * ardışık örnek arasında hesaplanır; ilk okumada "kullanılamıyor" döner.
 */
function processCpuPercent(now) {
  const store = globalThis[SAMPLE_KEY];
  if (!store || typeof process.cpuUsage !== 'function') return gauge(null, { unit: '%', available: false });
  const usage = process.cpuUsage();
  const previous = store.lastCpu;
  store.lastCpu = { at: now, user: usage.user, system: usage.system };
  if (!previous) return gauge(null, { unit: '%', available: false });
  const elapsedMs = now - previous.at;
  if (elapsedMs <= 0) return gauge(null, { unit: '%', available: false });
  const usedMs = ((usage.user - previous.user) + (usage.system - previous.system)) / 1000;
  return gauge(Math.max(0, Math.min(100, (usedMs / elapsedMs) * 100)), { unit: '%' });
}

/**
 * Yük ortalaması yalnızca POSIX'te anlamlıdır.
 * Windows'ta `os.loadavg()` sıfır döndürür; sıfır göstermek "boşta" yanılgısı
 * üretir, bu yüzden platform açıkça denetlenir.
 */
function hostLoadAverage() {
  if (platform() === 'win32') return gauge(null, { available: false });
  try {
    const [oneMinute] = loadavg();
    return gauge(oneMinute, { available: Number.isFinite(oneMinute) });
  } catch {
    return gauge(null, { available: false });
  }
}

function hostMemory() {
  try {
    const total = totalmem();
    const free = freemem();
    if (!Number.isFinite(total) || total <= 0) {
      return { total: gauge(null, { unit: 'bytes', available: false }), used: gauge(null, { unit: 'bytes', available: false }), usedRatio: gauge(null, { available: false }) };
    }
    const used = total - free;
    return {
      total: gauge(total, { unit: 'bytes' }),
      used: gauge(used, { unit: 'bytes' }),
      usedRatio: gauge(used / total)
    };
  } catch {
    return { total: gauge(null, { unit: 'bytes', available: false }), used: gauge(null, { unit: 'bytes', available: false }), usedRatio: gauge(null, { available: false }) };
  }
}

/** Süreç/sunucu kaynaklarının anlık görüntüsü. */
export function readResourceMetrics(now = Date.now()) {
  const memory = typeof process.memoryUsage === 'function' ? process.memoryUsage() : {};
  const heapTotal = Number(memory.heapTotal);
  const heapUsed = Number(memory.heapUsed);
  return {
    platform: platform(),
    runtimeVersion: typeof process.version === 'string' ? process.version : null,
    uptimeSeconds: gauge(typeof process.uptime === 'function' ? process.uptime() : null, { unit: 's' }),
    rss: gauge(memory.rss, { unit: 'bytes' }),
    heapUsed: gauge(heapUsed, { unit: 'bytes' }),
    heapTotal: gauge(heapTotal, { unit: 'bytes' }),
    heapUsedRatio: gauge(
      Number.isFinite(heapUsed) && Number.isFinite(heapTotal) && heapTotal > 0 ? heapUsed / heapTotal : null,
      { available: Number.isFinite(heapUsed) && Number.isFinite(heapTotal) && heapTotal > 0 }
    ),
    external: gauge(memory.external, { unit: 'bytes' }),
    cpuPercent: processCpuPercent(now),
    eventLoopDelayMs: eventLoopDelay(),
    hostLoadAverage: hostLoadAverage(),
    hostMemory: hostMemory()
  };
}

/** Testlerin platforma bağımlı olmadan ölçüm normalleştirmesini sınaması için. */
export function normalizeGauge(value, options = {}) {
  return gauge(value, options);
}

export function resetResourceMonitoringForTests() {
  const store = globalThis[SAMPLE_KEY];
  try { store?.loopMonitor?.disable?.(); } catch { /* izleyici zaten kapalı olabilir */ }
  globalThis[SAMPLE_KEY] = undefined;
}
