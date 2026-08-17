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
 *   3. **Açılışın kaynağa bağımlılığı** – Ağaç bir kez kurulduktan sonra
 *      pencerenin dolması, kullanıcının yeniden tam bir CN43N turunu beklemesi
 *      anlamına geliyordu. Artık ilk kurulumdan sonraki tazelemeler arka planda
 *      yürür; istek depodaki ağaçla hemen yanıtlanır.
 *
 * Süre `MERGEN_ROTA_WBS_SYNC_TTL_MS` ile ayarlanır. `0` verildiğinde eşitleme
 * her istekte eşzamanlı çalışır (geliştirme ve test için).
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

function skipped(reason) {
  return { synchronized: false, projectCount: 0, nodeCount: 0, mergedProjectCount: 0, reason };
}

/**
 * Bu süreçte en az bir kez başarıyla eşitlendi mi?
 *
 * Kurumsal ağaç bir kez kurulduktan sonra MR_WBS içinde durur; sonraki
 * tazelemeler yalnızca kaynaktaki değişiklikleri yakalamak içindir.
 */
export function hasCorporateWbsSyncedOnce() {
  return lastSuccessAt != null;
}

/**
 * Eşitlemeyi tazelik penceresine ve tek uçuş kilidine uyarak çalıştırır.
 *
 * Üç davranış vardır:
 *  1. **Taze** – pencere açıkken hiç çalışmaz.
 *  2. **İlk kurulum** – bu süreçte hiç başarılı eşitleme yoksa istek eşitlemeyi
 *     BEKLER: depoda henüz ağaç olmayabilir, boş bir yapı göstermek yanlıştır.
 *  3. **Arka planda tazeleme** – ağaç bir kez kurulduktan sonra pencere
 *     dolduğunda istek BEKLEMEZ. Depodaki (en fazla TTL kadar eski) ağaçla
 *     hemen yanıt verilir, tazeleme arka planda sürer. Açılışın CN43N
 *     kaynağının hızına bağlı kalmasını önleyen asıl kazanç budur.
 *
 * `MERGEN_ROTA_WBS_SYNC_TTL_MS=0` verildiğinde tazelik penceresi tümüyle
 * kapalıdır; bu kipte davranış eskisi gibi her istekte eşzamanlı çalışmaktır.
 */
export async function runCorporateWbsSync(run, { now = Date.now, logger = console } = {}) {
  const startedAt = now();
  if (isCorporateWbsSyncFresh(startedAt)) return skipped('FRESH');

  const canRevalidateInBackground = getCorporateWbsSyncTtlMs() > 0 && lastSuccessAt != null;
  if (inFlight) return canRevalidateInBackground ? skipped('REVALIDATING') : inFlight;

  const job = (async () => {
    try {
      const result = await run();
      // Kaynak erişilemediğinde pencere ilerletilmez: bir sonraki istek yeniden dener.
      if (result?.synchronized) lastSuccessAt = now();
      return result;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = job;

  if (!canRevalidateInBackground) return job;

  // Arka plan işinin reddi sahiplenilmemiş kalmamalıdır.
  job.catch((cause) => logger?.warn?.('Kurumsal katalog arka plan tazelemesi tamamlanamadı.', cause));
  return skipped('REVALIDATING');
}

/** Testler ve veri modu değişimi için zamanlayıcıyı sıfırlar. */
export function resetCorporateWbsSyncScheduleForTests() {
  lastSuccessAt = null;
  inFlight = null;
}
