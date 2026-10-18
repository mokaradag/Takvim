import 'server-only';
import { AI_ERROR_CODES, aiErrorDefinition } from '../../domain/ai/aiErrorCatalog.js';
import { AI_EMBEDDING_PURPOSES, AI_PROFILE_RESOLUTION_FAILURES, AI_PROFILES, resolveModelProfile } from '../../domain/ai/aiModelRegistry.js';
import {
  applyRerankScores,
  createEmbeddingSpace,
  createSemanticCatalogue,
  createSemanticIndex,
  normalizeSemanticQuery,
  rankSemanticIndex,
  SEMANTIC_FAILURES,
  semanticFingerprint,
  semanticModelProvenance,
  semanticToolDefinitions
} from '../../domain/ai/semanticContract.js';
import { readAiConfig, requireAiAvailable } from './aiConfig.js';
import { raceWithAbort } from './aiDeadline.js';
import { AiError, isAiError } from './aiErrors.js';
import { getAiGateway } from './aiRuntime.js';
import { aiFailureServiceHealth, recordSemanticRetrieval } from './aiTelemetry.js';
import { loadAiModelRegistry } from './modelRegistryLoader.js';
import { getRotaTool, rotaToolNames } from './tools/toolRegistry.js';

/**
 * Rota AI anlamsal aday keşfi (Aşama 4B) — DANIŞMAN katman.
 *
 * Normalleşmiş sorgu → sunucuya ait yetenek kataloğu → `embedding` profiliyle
 * gerçek gömme (ağ geçidi) → sınırlı ilk aşama → `rerank` profiliyle gerçek
 * yeniden sıralama (ağ geçidi) → sınırlı aday listesi. Aday yalnızca katalog
 * kimliği, türü, sırası ve skoru taşır: araç yürütülmez, plan kurulmaz; kimlik,
 * yetki, SQL ya da kanıt üretilmez. Model çıktısı yalnızca Aşama 4A
 * sözleşmesinden geçer; burada ikinci bir doğrulama, benzerlik ya da eşitlik
 * kuralı yoktur.
 *
 * Başarısızlık danışmanlığın kaybıdır: yeniden sıralama kullanılamazsa
 * doğrulanmış ilk aşama sırası (`first_stage`), gömme ya da dizin
 * kullanılamazsa `unavailable` döner ve çağıran Aşama 3 davranışıyla sürer.
 * Danışmanlık kaybına yalnızca ortak hata kataloğunun BEKLENEN model/hizmet
 * sonuçları çevrilir; çağıranın kendi iptali, iç hata (açık SQL işlemi,
 * programlama hatası) ve yapay zekâ dışı hatalar (kimlik, veritabanı) yukarı
 * taşınır.
 *
 * Katalog dizini süreç içinde tutulur (kalıcılık, vektör veritabanı yok).
 * Yeniden kullanım anahtarı katalog parmak izi, gömme uzayı (4A) ve ön
 * işlemenin kendisidir (önekler, belirteç penceresi); boyut sorgu vektörüyle
 * denetlenir ve uç geçerli ama farklı boyutta vektör döndürmeye başlarsa dizin
 * bir kez yeniden kurulur. Kurulum anahtar başına tek uçuştur ve tek bir
 * çağıranın iptaline bağlı değildir (ağ geçidinin süre sınırıyla biter); yalnızca
 * tamamen doğrulanmış ve en son istenen anahtara ait dizin görünür olur,
 * başarısız kurulum önbelleğe girmez.
 */

/** İlk aşama derinliği: değerlendirmenin aday sınırıyla (`SEMANTIC_EVALUATION_DEFAULTS.limit`) aynıdır. */
export const SEMANTIC_RETRIEVAL_DEPTH = 10;

/**
 * Boyut uyuşmazlığının tetiklediği yeniden kurulumlar arasındaki en kısa süre
 * (anahtar başına): farklı boyutlu arka uçları karıştıran bir uç her istekte
 * kataloğu yeniden gömdüremez; gerçek boyut geçişi en geç bu sürede toparlanır.
 */
export const SEMANTIC_DIMENSION_REBUILD_COOLDOWN_MS = 60000;

export const SEMANTIC_RETRIEVAL_STATUS = Object.freeze({ RERANKED: 'reranked', FIRST_STAGE: 'first_stage', UNAVAILABLE: 'unavailable' });

const STAGE = Object.freeze({ QUERY: 'query', CATALOGUE: 'catalogue', EMBEDDING: 'embedding', INDEX: 'index', RERANK: 'rerank' });

/**
 * Ağ geçidinin BEKLENEN sonuçlarının teşhis sınıfı: kararlı ve içeriksiz.
 * Tabloda olmayan kod (ör. `AI_INTERNAL_ERROR`) model ya da hizmet sonucu
 * değildir; danışmanlık kaybına çevrilmez, yukarı taşınır.
 */
const CATEGORY_OF_CODE = Object.freeze({
  [AI_ERROR_CODES.AI_DISABLED]: 'disabled',
  [AI_ERROR_CODES.AI_CONFIGURATION_ERROR]: 'configuration',
  [AI_ERROR_CODES.AI_KEY_MISSING]: 'credential',
  [AI_ERROR_CODES.AI_KEY_INVALID]: 'credential',
  [AI_ERROR_CODES.AI_UNAUTHORIZED]: 'credential',
  [AI_ERROR_CODES.AI_BUSY]: 'capacity',
  [AI_ERROR_CODES.AI_QUEUE_TIMEOUT]: 'capacity',
  [AI_ERROR_CODES.AI_RATE_LIMITED]: 'capacity',
  [AI_ERROR_CODES.AI_TIMEOUT]: 'timeout',
  [AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE]: 'provider',
  [AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID]: 'invalid_output',
  [AI_ERROR_CODES.AI_REQUEST_INVALID]: 'rejected'
});
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
// Bilinçli olarak kapatılmış ya da hiç tanımlanmamış profil hata değildir: anlamsal danışmanlık kullanılmıyor demektir.
const PROFILE_OFF = new Set([AI_PROFILE_RESOLUTION_FAILURES.PROFILE_DISABLED, AI_PROFILE_RESOLUTION_FAILURES.PROFILE_NOT_CONFIGURED]);

const failureOf = (stage, category, reason) => Object.freeze({ stage, category, reason });

/**
 * Anlamsal katmanın kendi bulgusu. Hizmet sağlığı sınıfı ortak hata
 * kataloğunun karşılık gelen kodundan gelir (`code` yoksa sağlık hatası değildir).
 */
function localOutcome(stage, category, reason, { code = null, log = true } = {}) {
  return { failure: failureOf(stage, category, reason), serviceFailure: code ? aiErrorDefinition(code).serviceFailure : false, log };
}

/** Anlamsal katmanın kendi kusuru (ağ geçidi görmediği için burada günlüğe yazılır). */
class SemanticStageFailure extends Error {
  constructor(outcome) {
    super(outcome.failure.reason);
    this.outcome = outcome;
  }
}

/** Ağ geçidi hatasının sonucu; beklenen bir model/hizmet sonucu değilse `null` (çağıran yukarı taşır). */
function gatewayOutcome(stage, error) {
  if (!isAiError(error) || !Object.hasOwn(CATEGORY_OF_CODE, error.code)) return null;
  const reason = error.details?.reason;
  return {
    failure: failureOf(stage, CATEGORY_OF_CODE[error.code], typeof reason === 'string' && SAFE_REASON.test(reason) ? reason : error.code),
    // Sağlık sınıfı ağ geçidinin `ai.request` kaydıyla aynı kuraldır (anahtar kaynağı ve kapasite kapsamı dâhil).
    serviceFailure: aiFailureServiceHealth(error) === true
  };
}

function cancelled(error) {
  return isAiError(error) && error.code === AI_ERROR_CODES.AI_CANCELLED ? error : new AiError(AI_ERROR_CODES.AI_CANCELLED);
}

/** Gömme rotasının uzayı: profil, model, sağlayıcı ve ön işleme belirteci (4A). */
function spaceOf(route) {
  const provenance = semanticModelProvenance(route, AI_PROFILES.EMBEDDING);
  return provenance ? createEmbeddingSpace(provenance, route.preprocessing?.id) : null;
}

/** Dizinin anahtarı: katalog, uzay ve ön işlemenin kendisi (belirteç aynı kalıp önek ya da pencere değişse de eski dizin kullanılmaz). */
function indexKey(catalogue, space, route) {
  const { queryPrefix, documentPrefix, truncateTokens = null } = route.preprocessing;
  return semanticFingerprint([catalogue.fingerprint, space.key, queryPrefix, documentPrefix, truncateTokens]);
}

async function defaultLoadRegistry(signal) {
  const config = requireAiAvailable(readAiConfig());
  const load = () => loadAiModelRegistry({ path: config.registryPath });
  return signal ? raceWithAbort(load, signal) : load();
}

const defaultTools = () => rotaToolNames().map((name) => getRotaTool(name));

export function createSemanticRetrieval({
  getGateway = getAiGateway,
  loadRegistry = defaultLoadRegistry,
  loadTools = defaultTools,
  now = Date.now
} = {}) {
  // Tek görünür dizin ve anahtar başına en çok bir süren kurulum; kullanıcı verisi (sorgu, sorgu vektörü) burada tutulmaz.
  const state = { ready: null, builds: new Map(), latest: null, dimensionRebuilds: new Map() };

  async function buildIndex(catalogue, space, key) {
    // Katalog belgesi sunucuya aittir: ağ geçidi bunu kurumsal anahtar ve sunucu kapasitesiyle yürütür.
    const call = await getGateway().embedServerCatalogue({
      signal: null
    });
    // Kurulum sırasında rota değiştiyse (kayıt yeniden yüklendi) vektörler istenen uzaya ait değildir.
    const built = spaceOf(call.route);
    if (!built || built.key !== space.key || indexKey(catalogue, built, call.route) !== key) {
      throw new SemanticStageFailure(localOutcome(STAGE.INDEX, 'stale', SEMANTIC_FAILURES.SPACE_MISMATCH));
    }
    const created = createSemanticIndex(catalogue, space, call.embeddings);
    if (!created.ok) {
      throw new SemanticStageFailure(localOutcome(STAGE.INDEX, 'invalid_output', created.reason, { code: AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID }));
    }
    return created.index;
  }

  /**
   * Geçerli dizin ya da anahtar başına tek uçuşlu kurulum. Kurulum çağıranın
   * sinyaline bağlı değildir: iptal eden çağıran yalnızca kendi beklemesinden
   * çıkar, öteki bekleyenler ve sonraki istekler kurulumu kullanır. Kurulum ağ
   * geçidinin süre sınırıyla her zaman sonuçlanır. Arada başka anahtar istense
   * de süren kurulum izlenir (A → B → A ikinci kurulum açmaz); yalnızca en son
   * istenen anahtarın kurulumu görünür olur. `rebuild`, hazır dizini kullanmadan
   * kurulumu başlatır ya da paylaşır; hazır dizin yalnızca yeni kurulum
   * başarıyla bitince değişir, kurulum düşerse hazır dizin korunur.
   */
  async function indexFor(catalogue, space, route, signal, { rebuild = false } = {}) {
    signal?.throwIfAborted();
    const key = indexKey(catalogue, space, route);
    state.latest = key;
    if (!rebuild && state.ready?.key === key) return { index: state.ready.index, use: 'hit' };
    let build = state.builds.get(key);
    const use = build ? 'shared' : 'built';
    if (!build) {
      build = buildIndex(catalogue, space, key);
      state.builds.set(key, build);
      // Reddedilen kurulum önbellekte kalmaz; sonraki istek yeniden kurar.
      build.then((index) => {
        if (state.builds.get(key) === build) state.builds.delete(key);
        if (state.latest === key) state.ready = { key, index };
      }, () => {
        if (state.builds.get(key) === build) state.builds.delete(key);
      });
    }
    const index = await (signal ? raceWithAbort(() => build, signal) : build);
    return { index, use };
  }

  /**
   * Profillerin kullanılabilirliği ağ geçidi çağrılmadan denetlenir (asistanın
   * kip denetimiyle aynı yol): bilinçli olarak kapatılmış profil her istekte
   * yapılandırma hatası olarak kaydedilmez. Yetkili çözüm yine ağ geçidindedir.
   */
  async function routeFailures(signal) {
    const registry = await loadRegistry(signal);
    const reasonOf = (profile) => {
      const resolved = resolveModelProfile(registry, profile);
      return resolved.ok ? null : resolved.reason;
    };
    return { embedding: reasonOf(AI_PROFILES.EMBEDDING), rerank: reasonOf(AI_PROFILES.RERANK) };
  }

  /** Kapalı ya da tanımsız profil sağlık hatası değildir; bozuk eşleme yapılandırma hatasıdır. */
  const profileOutcome = (stage, reason) => (PROFILE_OFF.has(reason)
    ? localOutcome(stage, 'disabled', reason, { code: AI_ERROR_CODES.AI_DISABLED })
    : localOutcome(stage, 'configuration', reason, { code: AI_ERROR_CODES.AI_CONFIGURATION_ERROR }));

  /** Boyut uyuşmazlığı yeniden kurulumu bu anahtar için bekleme süresi dışında mı? Evetse zamanı kaydeder. */
  function claimDimensionRebuild(key) {
    const at = now();
    for (const [entry, startedAt] of state.dimensionRebuilds) {
      if (at - startedAt >= SEMANTIC_DIMENSION_REBUILD_COOLDOWN_MS) state.dimensionRebuilds.delete(entry);
    }
    if (state.dimensionRebuilds.has(key)) return false;
    // Dolu tabloda yeni kurulum başlatılmaz; yaşayan anahtarların bekleme süresi silinmez.
    if (state.dimensionRebuilds.size >= 256) return false;
    state.dimensionRebuilds.set(key, at);
    return true;
  }

  async function discover(query, signal, trace) {
    const normalized = normalizeSemanticQuery(query);
    if (!normalized.ok) return localOutcome(STAGE.QUERY, 'query', normalized.reason, { code: AI_ERROR_CODES.AI_REQUEST_INVALID, log: false });
    const built = createSemanticCatalogue(semanticToolDefinitions(loadTools()));
    if (!built.ok) return localOutcome(STAGE.CATALOGUE, 'catalogue', 'CATALOGUE_INVALID', { code: AI_ERROR_CODES.AI_CONFIGURATION_ERROR });
    const { catalogue } = built;
    let routes;
    try {
      routes = await routeFailures(signal);
    } catch (error) {
      if (signal?.aborted) throw cancelled(error);
      const outcome = gatewayOutcome(STAGE.EMBEDDING, error);
      if (!outcome) throw error;
      // Ağ geçidi çağrılmadığı için yapılandırma kusuru burada günlüğe yazılır.
      return { ...outcome, log: true };
    }
    if (routes.embedding) return profileOutcome(STAGE.EMBEDDING, routes.embedding);

    let ranked;
    try {
      const embedded = await getGateway().embedTexts({
        profile: AI_PROFILES.EMBEDDING, texts: [normalized.value], purpose: AI_EMBEDDING_PURPOSES.QUERY, signal
      });
      const space = spaceOf(embedded.route);
      if (!space) return localOutcome(STAGE.EMBEDDING, 'configuration', 'SPACE_INVALID', { code: AI_ERROR_CODES.AI_CONFIGURATION_ERROR });
      trace.stage = STAGE.INDEX;
      // Sorgu vektörü sıralamada doğrulanır (biçim, sayı, boyut, sonluluk, uzay): bozuksa gömme evresinin çıktısıdır.
      const rank = (index) => rankSemanticIndex(index, {
        space, embeddings: embedded.embeddings, limit: Math.min(SEMANTIC_RETRIEVAL_DEPTH, index.catalogue.items.length)
      });
      let { index, use } = await indexFor(catalogue, space, embedded.route, signal);
      let result = rank(index);
      // Uç bu uzayda başka boyutta vektör döndürmeye başladıysa hazır dizin güncel olmayabilir: süren kurulum
      // varsa beklenir, yoksa bekleme süresi dışındaysa bir kez yeniden kurulur. Kurulum düşerse hazır dizin
      // korunur; yeni dizin de uyuşmuyorsa bozuk olan sorgudur.
      if (!result.ok && result.reason === SEMANTIC_FAILURES.DIMENSION_MISMATCH && use === 'hit') {
        const key = indexKey(catalogue, space, embedded.route);
        if (state.builds.has(key) || claimDimensionRebuild(key)) {
          ({ index, use } = await indexFor(catalogue, space, embedded.route, signal, { rebuild: true }));
          result = rank(index);
        }
      }
      trace.index = use;
      if (!result.ok) return localOutcome(STAGE.EMBEDDING, 'invalid_output', result.reason, { code: AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID });
      ranked = { candidates: result.candidates, textOf: new Map(index.catalogue.items.map((item) => [item.id, item.text])) };
    } catch (error) {
      if (signal?.aborted) throw cancelled(error);
      if (error instanceof SemanticStageFailure) return error.outcome;
      const outcome = gatewayOutcome(trace.stage, error);
      if (!outcome) throw error;
      return outcome;
    }

    const firstStage = (outcome) => ({ ...outcome, status: SEMANTIC_RETRIEVAL_STATUS.FIRST_STAGE, candidates: ranked.candidates });
    if (routes.rerank) return firstStage(profileOutcome(STAGE.RERANK, routes.rerank));
    let scored;
    try {
      scored = await getGateway().rerankTexts({
        profile: AI_PROFILES.RERANK,
        query: normalized.value,
        documents: ranked.candidates.map((candidate) => ranked.textOf.get(candidate.id)),
        signal
      });
    } catch (error) {
      // Çağıranın iptali burada ilk aşamaya çevrilmez: `retrieve` sonucu döndürmeden önce iptali denetler.
      const outcome = gatewayOutcome(STAGE.RERANK, error);
      if (!outcome) throw error;
      return firstStage(outcome);
    }
    const reranked = applyRerankScores(ranked.candidates, scored.scores);
    if (!reranked.ok) {
      return firstStage(localOutcome(STAGE.RERANK, 'invalid_output', reranked.reason, { code: AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID }));
    }
    return { status: SEMANTIC_RETRIEVAL_STATUS.RERANKED, candidates: reranked.candidates, failure: null };
  }

  /**
   * Sorgu için sınırlı anlamsal aday listesi:
   * `{ status: 'reranked' | 'first_stage' | 'unavailable', candidates, failure }`.
   * `failure` evre, sınıf ve güvenli kod taşır (`first_stage` için yeniden
   * sıralamanın neden kullanılamadığını anlatır). Sonuç yalnızca sunucu içinde
   * kullanılır; istemciye gönderilmez. Çağıran iptal ederse `AI_CANCELLED`
   * fırlar ve geç gelen model sonucu uygulanmaz.
   */
  async function retrieve({ query, signal = null } = {}) {
    const startedAt = now();
    const trace = { stage: STAGE.EMBEDDING, index: null };
    let outcome;
    try {
      if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
      outcome = await discover(query, signal, trace);
      if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
    } catch (error) {
      if (signal?.aborted) recordSemanticRetrieval({ status: 'cancelled', index: trace.index, durationMs: now() - startedAt });
      throw error;
    }
    const status = outcome.status ?? SEMANTIC_RETRIEVAL_STATUS.UNAVAILABLE;
    const candidates = outcome.candidates ?? Object.freeze([]);
    recordSemanticRetrieval({
      status,
      failure: outcome.failure,
      serviceFailure: Boolean(outcome.serviceFailure),
      index: trace.index,
      candidates: candidates.length,
      durationMs: now() - startedAt,
      log: Boolean(outcome.log)
    });
    return Object.freeze({ status, candidates, failure: outcome.failure });
  }

  return {
    retrieve,
    /** Dizinin içeriksiz durumu (kimlik, boyut, öğe sayısı, süren kurulum). */
    indexStatus() {
      const index = state.ready?.index;
      return {
        ready: index ? { identity: index.identity, dimensions: index.dimensions, items: index.catalogue.items.length } : null,
        building: state.builds.size > 0
      };
    }
  };
}

const STATE_KEY = Symbol.for('mergen-rota.ai-semantic-retrieval');

/** Süreç başına tek anlamsal keşif (dizin tek kez tutulur; Next.js modül yeniden yüklemesi ikinci dizin açmaz). */
export function getSemanticRetrieval() {
  globalThis[STATE_KEY] ||= createSemanticRetrieval();
  return globalThis[STATE_KEY];
}

export function retrieveSemanticCandidates(options) {
  return getSemanticRetrieval().retrieve(options);
}

export function resetSemanticRetrievalForTests() {
  globalThis[STATE_KEY] = undefined;
}
