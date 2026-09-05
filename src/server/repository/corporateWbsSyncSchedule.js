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
 *      yürür; istek depodaki ağaçla hemen yanıtlanır. "Ağaç kurulmuş mu"
 *      sorusu SÜREÇ BELLEĞİNDEN değil depodan yanıtlanır: yeniden başlatma ve
 *      yeni işçi süreçleri de bekletmeden yanıt verir.
 *
 *   4. **Kesintide yığılma** – Kaynak erişilemez olduğunda başarısız tazeleme
 *      tazelik penceresini ilerletmez; bu doğrudur ama her isteğin yeni bir tur
 *      başlatması demekti. Başarısızlıklar ayrı bir damgayla üstel beklemeye
 *      alınır: başarı taklit edilmez, deneme sıklığı sınırlanır.
 *
 * Süre `MERGEN_ROTA_WBS_SYNC_TTL_MS` ile ayarlanır. `0` verildiğinde ilk yük
 * yolu her istekte eşzamanlı çalışır; manuel Refresh yine beklemeden döner.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Başarısız tazelemeden sonraki ilk bekleme; her başarısızlıkta ikiye katlanır. */
const FAILURE_BACKOFF_BASE_MS = 15 * 1000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60 * 1000;

let lastSuccessAt = null;
let lastFailureAt = null;
let failureCount = 0;
// Depoda kullanılabilir bir kurumsal ağaç var mı? Süreç belleğinden BAĞIMSIZ
// bir gerçektir ve yalnızca "istek beklemeli mi" kararını besler.
let durableWarmth = false;
let durableWarmthProbed = false;
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

/** Art arda başarısızlıklarda üstel, tavanlı bekleme süresi. */
export function getCorporateWbsSyncBackoffMs() {
  if (failureCount <= 0) return 0;
  return Math.min(FAILURE_BACKOFF_BASE_MS * (2 ** (failureCount - 1)), FAILURE_BACKOFF_MAX_MS);
}

/**
 * Son deneme başarısız oldu ve bekleme süresi dolmadı mı?
 *
 * Başarısız tazeleme `lastSuccessAt`'i ilerletmez; bu doğrudur ama tek başına
 * kaynak kesintisinde HER isteğin yeni bir CN43N turu (ve kurumsal proje
 * eşitlemesi) başlatması demekti. Deneme sıklığı ayrı bir başarısızlık
 * damgasıyla sınırlanır — başarı taklit edilmeden.
 */
export function isCorporateWbsSyncBackedOff(now = Date.now()) {
  if (lastFailureAt == null) return false;
  return now - lastFailureAt < getCorporateWbsSyncBackoffMs();
}

/**
 * Depoda kullanılabilir bir kurumsal ağaç olup olmadığını okur.
 *
 * Süreç belleği bu soruyu yanıtlayamaz: her yeniden başlatma ve her yeni işçi
 * süreci `lastSuccessAt = null` ile açılır ve MR_WBS dolu olsa bile ilk isteği
 * tam bir CN43N turuna KİLİTLERDİ. Yanıt süreç başına bir kez okunur.
 *
 * Sonuç yalnızca "istek beklemeli mi" kararını etkiler; tazelik penceresini
 * ilerletmez. Depodaki ağacın kaynağa göre ne kadar eski olduğunu bu süreç
 * bilemez, bu yüzden tazeleme yine çalışır — sadece arka planda.
 */
async function probeDurableWarmth(readDurableSyncState, logger) {
  if (durableWarmth || durableWarmthProbed || typeof readDurableSyncState !== 'function') return;
  durableWarmthProbed = true;
  try {
    const state = await readDurableSyncState();
    durableWarmth = Number(state?.projectCount ?? 0) > 0;
  } catch (cause) {
    durableWarmthProbed = false;
    logger?.warn?.('Kurumsal katalog depo durumu okunamadı; ilk eşitleme bekletilerek çalışacak.', cause);
  }
}

/** Süren tazeleme işi (varsa) tamamlanana kadar bekler. */
export function whenCorporateWbsSyncSettled() {
  return inFlight ? inFlight.catch(() => null) : Promise.resolve(null);
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
 * kapalıdır. İlk yük yolu eşzamanlıdır; `waitForColdStart: false` kullanan
 * manuel Refresh yolu işi yine arka plana bırakır.
 */
export async function runCorporateWbsSync(run, {
  now = Date.now,
  logger = console,
  readDurableSyncState = null,
  waitForColdStart = true
} = {}) {
  const startedAt = now();
  if (isCorporateWbsSyncFresh(startedAt)) return skipped('FRESH');

  const startJob = ({ probeBeforeRun = false } = {}) => {
    const job = (async () => {
      if (probeBeforeRun) await probeDurableWarmth(readDurableSyncState, logger);
      try {
        const result = await run();
        // Kaynak erişilemediğinde pencere ilerletilmez: bir sonraki istek yeniden
        // dener, ancak deneme sıklığı üstel beklemeyle sınırlanır.
        if (result?.synchronized) {
          lastSuccessAt = now();
          lastFailureAt = null;
          failureCount = 0;
          durableWarmth = true;
        } else {
          lastFailureAt = now();
          failureCount += 1;
        }
        return result;
      } catch (cause) {
        lastFailureAt = now();
        failureCount += 1;
        throw cause;
      } finally {
        inFlight = null;
      }
    })();
    inFlight = job;
    return job;
  };

  // Manuel yenileme eldeki yetkili snapshot'ı öne alır. Süreç soğuk olsa bile
  // depo sıcaklığı sorgusu bu isteğin dönüş yolunda BEKLENMEZ; sorgu ve katalog
  // turu tek arka plan işinin içinde çalışır.
  if (!waitForColdStart) {
    if (isCorporateWbsSyncBackedOff(startedAt)) return skipped('BACKOFF');
    if (inFlight) return skipped('REVALIDATING');
    const job = startJob({ probeBeforeRun: true });
    job.catch((cause) => logger?.warn?.('Kurumsal katalog arka plan tazelemesi tamamlanamadı.', cause));
    return skipped('REVALIDATING');
  }

  await probeDurableWarmth(readDurableSyncState, logger);
  const requiresBlockingColdStart = !durableWarmth;
  // Sıcak depoda kesinti beklemesi korunur. Boş depodaki ilk yük ise önceki
  // başarısız manuel turun beklemesine takılmaz; yeni bir eşitlemeyi bekler.
  if (isCorporateWbsSyncBackedOff(startedAt) && !requiresBlockingColdStart) {
    return skipped('BACKOFF');
  }

  const canRevalidateInBackground = getCorporateWbsSyncTtlMs() > 0
    && (lastSuccessAt != null || durableWarmth);
  if (inFlight) return canRevalidateInBackground ? skipped('REVALIDATING') : inFlight;

  const job = startJob();

  if (!canRevalidateInBackground) return job;

  // Arka plan işinin reddi sahiplenilmemiş kalmamalıdır.
  job.catch((cause) => logger?.warn?.('Kurumsal katalog arka plan tazelemesi tamamlanamadı.', cause));
  return skipped('REVALIDATING');
}

/** Testler ve veri kipi değişimi için zamanlayıcıyı sıfırlar. */
export function resetCorporateWbsSyncScheduleForTests() {
  lastSuccessAt = null;
  lastFailureAt = null;
  failureCount = 0;
  durableWarmth = false;
  durableWarmthProbed = false;
  inFlight = null;
}
