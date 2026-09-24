/**
 * Ölçüm matematiği — saf JavaScript.
 *
 * Yüzdelikler, kova (bucket) hizalama ve temel karşılaştırması hem sunucu
 * toplayıcısında hem de yönetim konsolunda aynı işlevlerle hesaplanır.
 */

/** Kalıcı toplama penceresi. 30 günlük eğilim bu kova boyutunda tutulur. */
export const METRIC_BUCKET_MS = 5 * 60 * 1000;

export const TIME_RANGES = Object.freeze({
  '1h': { id: '1h', label: 'Son 1 saat', durationMs: 60 * 60 * 1000, bucketMs: METRIC_BUCKET_MS },
  '24h': { id: '24h', label: 'Son 24 saat', durationMs: 24 * 60 * 60 * 1000, bucketMs: 15 * 60 * 1000 },
  '7d': { id: '7d', label: 'Son 7 gün', durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 2 * 60 * 60 * 1000 },
  '30d': { id: '30d', label: 'Son 30 gün', durationMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000 }
});

export const DEFAULT_TIME_RANGE = '24h';

/**
 * Anlık ölçüm (gauge) anahtarları.
 *
 * Sunucu bu adlarla yazar, yönetim konsolu bu adlarla okur; ad tek yerde
 * tanımlanır ki grafik sessizce boş kalmasın.
 */
export const GAUGE_KEYS = Object.freeze({
  PROCESS_RSS: 'process.rss',
  PROCESS_HEAP_USED: 'process.heap_used',
  PROCESS_HEAP_RATIO: 'process.heap_ratio',
  PROCESS_CPU: 'process.cpu_percent',
  EVENT_LOOP_DELAY: 'process.event_loop_delay_ms',
  OUTLOOK_QUEUE_PENDING: 'outlook.queue_pending',
  OUTLOOK_QUEUE_FAILED: 'outlook.queue_failed',
  OUTLOOK_QUEUE_OLDEST_MINUTES: 'outlook.queue_oldest_minutes',
  AI_ACTIVE_REQUESTS: 'ai.active_requests',
  AI_QUEUED_REQUESTS: 'ai.queued_requests'
});

export const GAUGE_LABELS = Object.freeze({
  [GAUGE_KEYS.PROCESS_RSS]: 'Süreç belleği (RSS)',
  [GAUGE_KEYS.PROCESS_HEAP_USED]: 'Kullanılan yığın',
  [GAUGE_KEYS.PROCESS_HEAP_RATIO]: 'Yığın kullanım oranı',
  [GAUGE_KEYS.PROCESS_CPU]: 'Süreç CPU kullanımı',
  [GAUGE_KEYS.EVENT_LOOP_DELAY]: 'Olay döngüsü gecikmesi',
  [GAUGE_KEYS.OUTLOOK_QUEUE_PENDING]: 'Outlook kuyruk derinliği',
  [GAUGE_KEYS.OUTLOOK_QUEUE_FAILED]: 'Outlook hatalı teslimat',
  [GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES]: 'En eski bekleyen (dk)',
  [GAUGE_KEYS.AI_ACTIVE_REQUESTS]: 'Etkin yapay zekâ isteği',
  [GAUGE_KEYS.AI_QUEUED_REQUESTS]: 'Sıradaki yapay zekâ isteği'
});

/**
 * Aralık seçimi.
 *
 * Yalnızca KENDİ özellikleri kabul edilir: `constructor` ya da `toString` gibi
 * kalıtılan adlar sorgu dizesinden gelebilir ve aralık yerine bir işlev
 * döndürüp ucu HTTP 500 ile düşürürdü.
 */
export function timeRange(id) {
  const key = String(id ?? '');
  return Object.hasOwn(TIME_RANGES, key) ? TIME_RANGES[key] : TIME_RANGES[DEFAULT_TIME_RANGE];
}

/** Zaman damgasını kova başlangıcına hizalar. */
export function bucketStart(timestamp, bucketMs = METRIC_BUCKET_MS) {
  const value = Number(timestamp);
  const size = Math.max(1, Math.trunc(Number(bucketMs) || METRIC_BUCKET_MS));
  if (!Number.isFinite(value)) return null;
  return Math.floor(value / size) * size;
}

/**
 * Sıralanmış örneklerden yüzdelik.
 *
 * Boş örnek kümesi `null` döner: sıfır, "çok hızlı" anlamına gelirdi.
 * En yakın sıra (nearest-rank) yöntemi kullanılır; küçük örneklemde
 * enterpolasyon gerçekte gözlenmemiş bir süre uydurur.
 */
export function percentile(sortedSamples, fraction) {
  if (!Array.isArray(sortedSamples) || !sortedSamples.length) return null;
  const ratio = Math.min(1, Math.max(0, Number(fraction) || 0));
  const rank = Math.max(1, Math.ceil(ratio * sortedSamples.length));
  return sortedSamples[Math.min(sortedSamples.length, rank) - 1];
}

/** Sıralanmamış örneklerden P50/P95/P99 + toplam istatistikler. */
export function summarizeDurations(samples = []) {
  const values = samples
    // `Number(null)` ve `Number('')` sıfırdır: ÖLÇÜLEMEYEN örnek, sıfır süreli
    // bir örnek gibi sayıya, ortalamaya ve yüzdeliklere karışmamalıdır.
    .filter((value) => value != null && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!values.length) {
    return { count: 0, avgMs: null, minMs: null, maxMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    avgMs: total / values.length,
    minMs: values[0],
    maxMs: values[values.length - 1],
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99)
  };
}

/**
 * Kova özetlerini tek bir özete indirger.
 *
 * Yüzdelikler kovalar arasında toplanamaz; bu yüzden AĞIRLIKLI ortalama
 * kullanılır. Sonuç yaklaşık değerdir ve öyle sunulur: kesin yüzdelik yalnızca
 * ham örneklerin durduğu güncel kovada hesaplanır.
 */
export function mergeBucketSummaries(buckets = []) {
  const rows = buckets.filter((bucket) => Number(bucket?.count) > 0);
  if (!rows.length) {
    return {
      count: 0, errorCount: 0, errorRate: null, avgMs: null, maxMs: null,
      p50Ms: null, p95Ms: null, p99Ms: null, percentilesApproximate: false
    };
  }
  const count = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const errorCount = rows.reduce((sum, row) => sum + Number(row.errorCount || 0), 0);
  // `Number(null)` sıfırdır: ölçülemeyen bir kova değeri, gerçek bir sıfır
  // ölçüm gibi ağırlıklı ortalamaya girmemelidir; aksi halde birleşik gecikme
  // olduğundan düşük, ölçülemeyen en yüksek süre ise `0` görünür.
  const measurable = (row, key) => row[key] != null && row[key] !== '' && Number.isFinite(Number(row[key]));
  const weighted = (key) => {
    const usable = rows.filter((row) => measurable(row, key));
    if (!usable.length) return null;
    const weight = usable.reduce((sum, row) => sum + Number(row.count || 0), 0);
    if (weight <= 0) return null;
    return usable.reduce((sum, row) => sum + Number(row[key]) * Number(row.count || 0), 0) / weight;
  };
  const maxima = rows.filter((row) => measurable(row, 'maxMs')).map((row) => Number(row.maxMs));
  return {
    count,
    errorCount,
    errorRate: count > 0 ? errorCount / count : null,
    avgMs: weighted('avgMs'),
    maxMs: maxima.length ? Math.max(...maxima) : null,
    p50Ms: weighted('p50Ms'),
    p95Ms: weighted('p95Ms'),
    p99Ms: weighted('p99Ms'),
    // Birden çok kovanın ağırlıklı ortalaması, birleşik örneklerin gerçek
    // yüzdeliği DEĞİLDİR. Değer YAKLAŞIKTIR ve arayüzde öyle sunulmalıdır;
    // kesin yüzdelik yalnızca tek bir kovadan okunduğunda geçerlidir.
    percentilesApproximate: rows.length > 1
      || rows.some((row) => row.percentilesApproximate === true)
  };
}

/**
 * Güncel değeri geçmiş temele göre karşılaştırır.
 *
 * Yeterli örnek yoksa karşılaştırma YAPILMAZ: birkaç isteklik bir kovadan
 * "%34 kötüleşme" çıkarmak yanlış alarm üretir.
 */
export const BASELINE_MIN_SAMPLES = 20;

export function compareToBaseline(current, baseline, {
  minSamples = BASELINE_MIN_SAMPLES,
  baselineSamples = null,
  currentSamples = null
} = {}) {
  // Ölçülemeyen güncel değer karşılaştırılmaz: `Number(null)` sıfır olur ve
  // pozitif bir tabana karşı "-%100" gibi uydurma bir kötüleşme üretirdi.
  if (current == null || current === '' || baseline == null || baseline === '') return null;
  const currentValue = Number(current);
  const baselineValue = Number(baseline);
  if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue) || baselineValue < 0) return null;
  // Örnek eşiği İKİ pencere için de geçerlidir: birkaç isteklik bir güncel
  // pencereden "%34 kötüleşme" çıkarmak da yanlış alarm üretir.
  if (baselineSamples != null && Number(baselineSamples) < minSamples) return null;
  if (currentSamples != null && Number(currentSamples) < minSamples) return null;
  if (baselineValue === 0) {
    // Sıfır tabanda oran tanımsızdır; ama "hata yoktu, şimdi var" bilgisi
    // yöneticinin görmesi gereken bir değişimdir ve gizlenmemelidir.
    return {
      current: currentValue,
      baseline: 0,
      changeRatio: null,
      direction: currentValue > 0 ? 'up' : 'flat'
    };
  }
  const changeRatio = (currentValue - baselineValue) / baselineValue;
  return {
    current: currentValue,
    baseline: baselineValue,
    changeRatio,
    direction: changeRatio > 0.05 ? 'up' : changeRatio < -0.05 ? 'down' : 'flat'
  };
}

/** Süreyi okunur metne çevirir (ms / sn / dk). */
export function formatDuration(valueMs) {
  // `Number(null)` sıfırdır: ölçülemeyen değer sıfır süre gibi gösterilmemelidir.
  if (valueMs == null || valueMs === '') return '—';
  const value = Number(valueMs);
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  // Önce TOPLAM saniye yuvarlanır; aksi halde 59.999 ms "60.00 sn",
  // 119.999 ms ise "1 dk 60 sn" gibi var olmayan değerler üretirdi.
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} sn`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} dk ${String(seconds).padStart(2, '0')} sn`;
}

/**
 * DAKİKA cinsinden süreyi yazar.
 *
 * Kuyruk yaşı gibi ölçüler dakikadır ve kesirli olabilir; sayım biçimiyle
 * yuvarlanırsa yarım dakikalık bir bekleme "1" görünür ve birimini yitirirdi.
 */
export function formatMinutes(value) {
  if (value == null || value === '') return '—';
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return '—';
  if (minutes === 0) return '0 dk';
  const magnitude = Math.abs(minutes);
  if (magnitude >= 10) return `${Math.round(minutes)} dk`;
  return `${minutes.toFixed(magnitude < 1 ? 2 : 1)} dk`;
}

/** Çalışma süresini gün/saat/dakika olarak yazar. */
export function formatUptime(seconds) {
  if (seconds == null || seconds === '') return '—';
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '—';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} gün ${hours} sa`;
  if (hours > 0) return `${hours} sa ${minutes} dk`;
  return `${minutes} dk`;
}

export function formatBytes(value) {
  if (value == null || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[index]}`;
}

export function formatPercent(ratio, { digits = 1 } = {}) {
  if (ratio == null || ratio === '') return '—';
  const value = Number(ratio);
  if (!Number.isFinite(value)) return '—';
  return `%${(value * 100).toFixed(digits)}`;
}

/** Geçen süreyi "3 dk önce" biçiminde yazar. */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const value = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp ?? '').getTime();
  if (!Number.isFinite(value)) return 'bilinmiyor';
  const deltaSeconds = Math.round((Number(now) - value) / 1000);
  if (deltaSeconds < 0) return 'az sonra';
  if (deltaSeconds < 10) return 'az önce';
  if (deltaSeconds < 60) return `${deltaSeconds} sn önce`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)} dk önce`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)} sa önce`;
  return `${Math.floor(deltaSeconds / 86400)} gün önce`;
}
