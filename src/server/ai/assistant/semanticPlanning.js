import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { AiError, isAiError } from '../aiErrors.js';
import { retrieveSemanticCandidates, SEMANTIC_RETRIEVAL_DEPTH, SEMANTIC_RETRIEVAL_STATUS } from '../semanticRetrieval.js';

/**
 * Aşama 4C · anlamsal planlama danışmanlığı — asistan turunun orkestrasyon sınırı.
 *
 * Kullanıcının sorusu planlama turundan ÖNCE Aşama 4B keşfinden (ağ geçidi →
 * gömme → ilk aşama → yeniden sıralama) geçer; sonuç planlayıcıya yalnızca
 * sıra ve aday üyeliği olarak verilir. Aday yetki, kimlik, SQL, kanıt ya da
 * yürütme izni değildir: araç kümesi her zaman sunucunun kayıt defteridir ve
 * her çağrı Aşama 3 doğrulamalarından geçer. Kayıt defteri dışındaki, yinelenen
 * ya da sınırı aşan aday kümesi bütünüyle reddedilir (keyfî aday girmez).
 *
 * Danışmanlık kaybı (profil kapalı, model yok, süre doldu, bozuk çıktı, bayat
 * katalog) planlamayı Aşama 3 davranışına döndürür: kayıt defterinin tamamı,
 * kendi sırasıyla. Çağıranın iptali iptal kalır; beklenmeyen iç hata yukarı
 * taşınır (4B sözleşmesi). Danışmanlığın süresi ayrıca sınırlıdır: bütçe dolarsa
 * keşif kesilir ve planlama danışmansız sürer.
 */

/** Anlamsal danışmanlığın tur içindeki üst süresi (üretim gözcüsünün kurulum payının altında). */
export const SEMANTIC_PLANNING_BUDGET_MS = 8000;

export const SEMANTIC_PLANNING_STATES = Object.freeze({
  RERANKED: SEMANTIC_RETRIEVAL_STATUS.RERANKED,
  FIRST_STAGE: SEMANTIC_RETRIEVAL_STATUS.FIRST_STAGE,
  UNAVAILABLE: SEMANTIC_RETRIEVAL_STATUS.UNAVAILABLE
});

const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

const advice = (state, candidates, reason) => Object.freeze({ state, candidates: Object.freeze([...candidates]), reason });
const unavailable = (reason) => advice(SEMANTIC_PLANNING_STATES.UNAVAILABLE, [], reason);

/**
 * 4B sonucunu tümleşme sınırında yeniden doğrular: durum bilinen bir durumdur,
 * adaylar `tool` türünde, tekil, sınırlı ve GÜNCEL kayıt defterindedir; sıra
 * 1'den başlayıp kesintisiz artar. Bir aday bile geçersizse küme reddedilir.
 */
function validated(result, registered) {
  const status = result?.status;
  if (status === SEMANTIC_PLANNING_STATES.UNAVAILABLE) {
    const reason = result?.failure?.reason;
    return unavailable(typeof reason === 'string' && SAFE_REASON.test(reason) ? reason : 'UNAVAILABLE');
  }
  if (status !== SEMANTIC_PLANNING_STATES.RERANKED && status !== SEMANTIC_PLANNING_STATES.FIRST_STAGE) return unavailable('STATUS_INVALID');
  const candidates = result.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > SEMANTIC_RETRIEVAL_DEPTH) return unavailable('CANDIDATES_INVALID');
  const ids = [];
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    if (!candidate || candidate.kind !== 'tool' || candidate.rank !== position + 1 || typeof candidate.id !== 'string'
      || !registered.has(candidate.id) || ids.includes(candidate.id)) return unavailable('CANDIDATES_INVALID');
    ids.push(candidate.id);
  }
  return advice(status, ids, null);
}

/**
 * Sorunun anlamsal planlama danışmanlığı: `{ state, candidates, reason }`.
 * `candidates` yalnızca kayıt defterindeki araç adlarıdır, anlamsal sırayla;
 * skor taşınmaz. `retrieve` yalnızca sınamalarda değiştirilir.
 */
export async function semanticPlanningAdvice({ query, catalog, signal = null, retrieve = retrieveSemanticCandidates, budgetMs = SEMANTIC_PLANNING_BUDGET_MS }) {
  const registered = new Set(catalog.map((tool) => tool.name));
  if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
  const deadline = createAiDeadline({ timeoutMs: budgetMs, parentSignal: signal });
  try {
    const result = await raceWithAbort(() => retrieve({ query, signal: deadline.signal }), deadline.signal);
    if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
    return validated(result, registered);
  } catch (error) {
    const failure = deadline.failure();
    // Bütçenin dolması danışmanlığın kaybıdır; çağıranın iptali iptaldir.
    if (failure?.code === AI_ERROR_CODES.AI_TIMEOUT && !signal?.aborted) return unavailable('TIMEOUT');
    if (signal?.aborted) throw isAiError(error) && error.code === AI_ERROR_CODES.AI_CANCELLED ? error : new AiError(AI_ERROR_CODES.AI_CANCELLED);
    throw error;
  } finally {
    deadline.dispose();
  }
}
