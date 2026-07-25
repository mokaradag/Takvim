/**
 * Kurumsal WBS eşitlemesinin çalışma sıklığını yöneten süreç düzeyi zamanlayıcı.
 *
 * İki sorunu birden çözer:
 *   1. **Gereksiz tekrar** – CN43N kaynağı gün içinde nadiren değişir. Her anlık
 *      görüntü isteğinde kaynağı baştan okumak, açılış süresini otuz saniyenin
 *      üzerine çıkarıyordu. Başarılı bir eşitlemeden sonra belirlenen süre
 *      boyunca eşitleme atlanır ve istek doğrudan depodan yanıtlanır.
 *   2. **Eşzamanlı yığılma** – Birden çok sekme aynı anda açıldığında eşitleme
 *      paralel olarak birden fazla kez başlıyordu. Tek uçuş (single flight)
 *      kilidi sayesinde aynı anda yalnızca bir eşitleme yürür; diğer istekler
 *      aynı sonucu paylaşır.
 *
 * Süre `MERGEN_ROTA_WBS_SYNC_TTL_MS` ile ayarlanır. `0` verildiğinde eşitleme
 * her istekte çalışır (geliştirme ve test için).
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

let lastSuccessAt = null;
let inFlight = null;

/** Yapılandırılmış tazelik süresi (ms). Geçersiz değerler varsayılana düşer. */
export function getCorporateWbsSyncTtlMs() {
  const raw = process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_TTL_MS;
  const normalized = String(raw).trim();
  if (!/^\d+$/.test(normalized)) return DEFAULT_TTL_MS;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : DEFAULT_TTL_MS;
}

/** Önceki başarılı eşitleme hâlâ taze mi? */
export function isCorporateWbsSyncFresh(now = Date.now()) {
  const ttl = getCorporateWbsSyncTtlMs();
  if (ttl <= 0 || lastSuccessAt == null) return false;
  return now - lastSuccessAt < ttl;
}

/**
 * Eşitlemeyi tazelik penceresine ve tek uçuş kilidine uyarak çalıştırır.
 *
 * @param {() => Promise<object>} run  Gerçek eşitleme işi
 * @param {{ now?: () => number }} options
 */
export async function runCorporateWbsSync(run, { now = Date.now } = {}) {
  const startedAt = now();
  if (isCorporateWbsSyncFresh(startedAt)) {
    return { synchronized: false, projectCount: 0, nodeCount: 0, mergedProjectCount: 0, reason: 'FRESH' };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await run();
      // Kaynak erişilemediğinde pencere ilerletilmez: bir sonraki istek yeniden dener.
      if (result?.synchronized) lastSuccessAt = now();
      return result;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Testler ve veri modu değişimi için zamanlayıcıyı sıfırlar. */
export function resetCorporateWbsSyncScheduleForTests() {
  lastSuccessAt = null;
  inFlight = null;
}
