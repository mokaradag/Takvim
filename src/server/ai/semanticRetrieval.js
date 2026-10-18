import 'server-only';
import { AI_ERROR_CODES } from '../../domain/ai/aiErrorCatalog.js';
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
  semanticIndexIdentity,
  semanticModelProvenance,
  semanticToolDefinitions
} from '../../domain/ai/semanticContract.js';
import { readAiConfig, requireAiAvailable } from './aiConfig.js';
import { raceWithAbort } from './aiDeadline.js';
import { AiError, isAiError } from './aiErrors.js';
import { getAiGateway } from './aiRuntime.js';
import { recordSemanticRetrieval } from './aiTelemetry.js';
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
 * Yukarı yalnızca çağıranın kendi iptali ve yapay zekâ dışı hatalar (kimlik,
 * veritabanı, programlama hatası) taşınır.
 *
 * Katalog dizini süreç içinde tutulur (kalıcılık, vektör veritabanı yok).
 * Yeniden kullanımdan önce 4A dizin kimliği (sözleşme sürümü, katalog parmak
 * izi, gömme uzayı, boyut) güncel katalog ve uzayla yeniden hesaplanıp
 * karşılaştırılır; ön işlemenin önekleri de aynı olmalıdır. Kurulum tek
 * uçuştur ve tek bir çağıranın iptaline bağlı değildir (ağ geçidinin süre
 * sınırıyla biter); yalnızca tamamen doğrulanmış dizin görünür olur, başarısız
 * kurulum önbelleğe girmez.
 */

/** İlk aşama derinliği: değerlendirmenin aday sınırıyla (`SEMANTIC_EVALUATION_DEFAULTS.limit`) aynıdır. */
export const SEMANTIC_RETRIEVAL_DEPTH = 10;

export const SEMANTIC_RETRIEVAL_STATUS = Object.freeze({ RERANKED: 'reranked', FIRST_STAGE: 'first_stage', UNAVAILABLE: 'unavailable' });

const STAGE = Object.freeze({ QUERY: 'query', CATALOGUE: 'catalogue', EMBEDDING: 'embedding', INDEX: 'index', RERANK: 'rerank' });

/** Ağ geçidi sonucunun teşhis sınıfı: kararlı ve içeriksiz. */
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

/** Anlamsal katmanın kendi kusuru (ağ geçidi görmediği için burada günlüğe yazılır). */
class SemanticStageFailure extends Error {
  constructor(failure) {
    super(failure.reason);
    this.failure = failure;
  }
}

function gatewayFailure(stage, error) {
  const reason = error.details?.reason;
  return failureOf(stage, CATEGORY_OF_CODE[error.code] ?? 'internal', typeof reason === 'string' && SAFE_REASON.test(reason) ? reason : error.code);
}

function cancelled(error) {
  return isAiError(error) && error.code === AI_ERROR_CODES.AI_CANCELLED ? error : new AiError(AI_ERROR_CODES.AI_CANCELLED);
}

/** Gömme rotasının uzayı: profil, model, sağlayıcı ve ön işleme belirteci (4A). */
function spaceOf(route) {
  const provenance = semanticModelProvenance(route, AI_PROFILES.EMBEDDING);
  return provenance ? createEmbeddingSpace(provenance, route.preprocessing?.id) : null;
}

/** Süren kurulumun anahtarı: katalog, uzay ve öneklerin kendisi (belirteç aynı kalıp önek değişse de eski kurulum paylaşılmaz). */
function indexKey(catalogue, space, route) {
  return semanticFingerprint([catalogue.fingerprint, space.key, route.preprocessing.queryPrefix, route.preprocessing.documentPrefix]);
}

const samePrefixes = (left, right) => left.queryPrefix === right.queryPrefix && left.documentPrefix === right.documentPrefix;

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
  // Tek görünür dizin ve en çok bir süren kurulum; kullanıcı verisi (sorgu, sorgu vektörü) burada tutulmaz.
  const state = { ready: null, building: null };

  async function buildIndex(catalogue, space, key) {
    const call = await getGateway().embedTexts({
      profile: AI_PROFILES.EMBEDDING,
      texts: catalogue.items.map((item) => item.text),
      purpose: AI_EMBEDDING_PURPOSES.DOCUMENT,
      signal: null
    });
    // Kurulum sırasında rota değiştiyse (kayıt yeniden yüklendi) vektörler istenen uzaya ait değildir.
    const built = spaceOf(call.route);
    if (!built || built.key !== space.key || indexKey(catalogue, built, call.route) !== key) {
      throw new SemanticStageFailure(failureOf(STAGE.INDEX, 'stale', SEMANTIC_FAILURES.SPACE_MISMATCH));
    }
    const created = createSemanticIndex(catalogue, space, call.embeddings);
    if (!created.ok) throw new SemanticStageFailure(failureOf(STAGE.INDEX, 'invalid_output', created.reason));
    return created.index;
  }

  /**
   * Geçerli dizin ya da tek uçuşlu kurulum. Kurulum çağıranın sinyaline bağlı
   * değildir: iptal eden çağıran yalnızca kendi beklemesinden çıkar, öteki
   * bekleyenler ve sonraki istekler kurulumu kullanır. Kurulum ağ geçidinin
   * süre sınırıyla her zaman sonuçlanır.
   */
  async function indexFor(catalogue, space, route, signal) {
    signal?.throwIfAborted();
    // Yeniden kullanım 4A dizin kimliğiyle (sözleşme sürümü, katalog, uzay, boyut) ve öneklerin kendisiyle karşılaştırılır.
    const { ready } = state;
    if (ready && samePrefixes(ready.preprocessing, route.preprocessing)
      && ready.index.identity === semanticIndexIdentity(catalogue.fingerprint, space.key, ready.index.dimensions)) {
      return { index: ready.index, use: 'hit' };
    }
    const key = indexKey(catalogue, space, route);
    let build = state.building?.key === key ? state.building : null;
    const use = build ? 'shared' : 'built';
    if (!build) {
      build = { key, promise: buildIndex(catalogue, space, key) };
      state.building = build;
      // Yalnızca en son istenen kurulum görünür olur; reddedilen kurulum önbellekte kalmaz.
      build.promise.then((index) => {
        if (state.building !== build) return;
        state.building = null;
        state.ready = { index, preprocessing: route.preprocessing };
      }, () => {
        if (state.building === build) state.building = null;
      });
    }
    const index = await (signal ? raceWithAbort(() => build.promise, signal) : build.promise);
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

  async function discover(query, signal, trace) {
    const normalized = normalizeSemanticQuery(query);
    if (!normalized.ok) return { failure: failureOf(STAGE.QUERY, 'query', normalized.reason) };
    const built = createSemanticCatalogue(semanticToolDefinitions(loadTools()));
    if (!built.ok) return { failure: failureOf(STAGE.CATALOGUE, 'catalogue', 'CATALOGUE_INVALID'), log: true };
    const { catalogue } = built;
    let routes;
    try {
      routes = await routeFailures(signal);
    } catch (error) {
      if (signal?.aborted) throw cancelled(error);
      if (!isAiError(error)) throw error;
      // Ağ geçidi çağrılmadığı için yapılandırma kusuru burada günlüğe yazılır.
      return { failure: gatewayFailure(STAGE.EMBEDDING, error), log: true };
    }
    if (routes.embedding) {
      return { failure: failureOf(STAGE.EMBEDDING, PROFILE_OFF.has(routes.embedding) ? 'disabled' : 'configuration', routes.embedding), log: true };
    }

    let ranked;
    try {
      const embedded = await getGateway().embedTexts({
        profile: AI_PROFILES.EMBEDDING, texts: [normalized.value], purpose: AI_EMBEDDING_PURPOSES.QUERY, signal
      });
      const space = spaceOf(embedded.route);
      if (!space) return { failure: failureOf(STAGE.EMBEDDING, 'configuration', 'SPACE_INVALID'), log: true };
      trace.stage = STAGE.INDEX;
      const { index, use } = await indexFor(catalogue, space, embedded.route, signal);
      trace.index = use;
      // Sorgu vektörü sıralamada doğrulanır (biçim, sayı, boyut, sonluluk, uzay): bozuksa gömme evresinin çıktısıdır.
      const result = rankSemanticIndex(index, {
        space, embeddings: embedded.embeddings, limit: Math.min(SEMANTIC_RETRIEVAL_DEPTH, index.catalogue.items.length)
      });
      if (!result.ok) return { failure: failureOf(STAGE.EMBEDDING, 'invalid_output', result.reason), log: true };
      ranked = { candidates: result.candidates, textOf: new Map(index.catalogue.items.map((item) => [item.id, item.text])) };
    } catch (error) {
      if (signal?.aborted) throw cancelled(error);
      if (error instanceof SemanticStageFailure) return { failure: error.failure, log: true };
      if (!isAiError(error)) throw error;
      return { failure: gatewayFailure(trace.stage, error) };
    }

    const firstStage = (failure, log = false) => ({ status: SEMANTIC_RETRIEVAL_STATUS.FIRST_STAGE, candidates: ranked.candidates, failure, log });
    if (routes.rerank) {
      return firstStage(failureOf(STAGE.RERANK, PROFILE_OFF.has(routes.rerank) ? 'disabled' : 'configuration', routes.rerank), true);
    }
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
      if (!isAiError(error)) throw error;
      return firstStage(gatewayFailure(STAGE.RERANK, error));
    }
    const reranked = applyRerankScores(ranked.candidates, scored.scores);
    if (!reranked.ok) return firstStage(failureOf(STAGE.RERANK, 'invalid_output', reranked.reason), true);
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
      status, failure: outcome.failure, index: trace.index, candidates: candidates.length, durationMs: now() - startedAt, log: Boolean(outcome.log)
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
        building: state.building !== null
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
