import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { AI_PROFILES, AI_REPORT_PROFILES, resolveModelProfile } from '../../../domain/ai/aiModelRegistry.js';
import { validateEvidencePackageContract } from '../../../domain/ai/report/reportRequest.js';
import { requireWriterStyle } from '../../../domain/ai/report/reportSectionPlan.js';
import {
  buildEvidenceFactLedger,
  REPORT_CLAIM_CLASSES,
  REPORT_FINDING_SEVERITIES,
  REPORT_OBJECTIVE_FINDING_CODES,
  selectRelevantEvidenceForParagraph,
  verifyReportObjectiveFacts
} from '../../../domain/ai/report/reportClaims.js';
import {
  applyDeterministicParagraphFallback,
  buildParagraphRepairMessages,
  buildReportReviewMessages,
  computeReviewTargetHash,
  getDraftBlock,
  listDraftTargets,
  paragraphLocationKey,
  parseParagraphRepairResponse,
  parseReportReviewResponse,
  replaceDraftParagraph,
  REPORT_REPAIR_CONTRACT,
  REPORT_REVIEW_CONTRACT,
  REPORT_REVIEW_MODES,
  ReportRepairParseError,
  ReportReviewError
} from '../../../domain/ai/report/reportReview.js';
import { ServerPersistenceError } from '../../errors.js';
import { AiError, isAiError } from '../aiErrors.js';
import {
  assessReportWriterModelIdentity,
  REPORT_WRITER_QUALITY,
  REPORT_WRITER_REVALIDATION_TIMEOUT_MS,
  writeExecutiveReportDraft
} from './reportWriter.js';

/**
 * Bilgin Aşama 4I-C — orantılı doğrulama, bağımsız anlamsal destek denetimi, yerel paragraf
 * onarımı ve katı çağrı bütçesi yürütücüsü (sunucu).
 *
 * Akış:
 *   4I-A kanıt paketi → 4I-B anlatı taslağı (1 çağrı) → belirlenimci nesnel olgu denetimi (0 çağrı)
 *   → zorunlu bağımsız anlamsal destek denetimi (en çok 1 ilk çağrı) → sorunların konumlandırılması
 *   → gerektiğinde yerel paragraf onarımı (paragraf başına ≤ 2, anlamsal gerektirenlerde ≤ 1,
 *     rapor başına ≤ 8) → her onarımın belirlenimci yeniden doğrulanması (0 çağrı)
 *   → gerektiğinde toplu onarım sonrası anlamsal denetim (en çok 1 çağrı)
 *   → bütçe tükendiğinde belirlenimci çıkar/işaretle → güncel yetki ve rıza doğrulaması
 *   → yayımlanabilir rapor veya inceleme gerektiren güvenli taslak.
 *
 * Toplam çağrı tavanı rapor başına kesin olarak 11'dir (1 yazım + 8 onarım + denetim/yeniden
 * sıralama için ortak 2). Bütçe istem yönergesi değil sunucu değişmezidir: eşzamanlı çağrı,
 * başarısız veya bozuk yanıt, yeniden deneme ya da bütçe sıfırlaması ile aşılamaz.
 */

export const REPORT_CALL_BUDGET = Object.freeze({
  maxTotalCalls: 11,
  maxWriterCalls: 1,
  maxRepairCalls: 8,
  maxReviewAndRerankCalls: 2,
  maxInitialReviewCalls: 1,
  maxPostRepairReviewCalls: 1,
  maxRepairAttemptsPerParagraph: 2,
  maxSemanticRepairAttemptsPerParagraph: 1
});

export const REPORT_PUBLICATION_STATUS = Object.freeze({
  PUBLISHABLE: 'yayimlanabilir',
  REVIEW_REQUIRED: 'inceleme_gerektirir'
});

export const REPORT_SEMANTIC_REVIEW_STATUS = Object.freeze({
  VERIFIED_INDEPENDENT: 'bagimsiz_model_dogrulandi',
  VERIFIED_EQUIVALENT: 'esdeger_denetim_dogrulandi',
  UNAVAILABLE: 'denetci_kullanilamiyor',
  NOT_INDEPENDENT: 'bagimsiz_model_degil',
  INVALID_OUTPUT: 'gecersiz_denetci_ciktisi',
  POST_REPAIR_INCOMPLETE: 'onarim_sonrasi_denetim_eksik'
});

/** Denetçi ve yerel onarım için kararlı örnekleme ayarları. */
export const REPORT_REVIEW_SAMPLING = Object.freeze({ temperature: 0.1, topP: 0.9 });
export const REPORT_REPAIR_SAMPLING = Object.freeze({ temperature: 0.2, topP: 0.9 });
export const REPORT_REPAIR_REVALIDATION_TIMEOUT_MS = REPORT_WRITER_REVALIDATION_TIMEOUT_MS;

const REVIEW_MAX_OUTPUT_TOKENS = 8_192;
const REPAIR_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_MAX_REPAIR_EVIDENCE_ITEMS = 18;

const NORMAL_FINISH_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'eos', 'eos_token']);
const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

const PROFILE_BY_QUALITY = Object.freeze({
  [REPORT_WRITER_QUALITY.AUTOMATIC]: AI_REPORT_PROFILES.WRITER,
  [REPORT_WRITER_QUALITY.HIGH]: AI_REPORT_PROFILES.WRITER_QUALITY
});

function repairFailure(code, reason, extra = {}) {
  return new AiError(code, { details: { reason, ...extra } });
}

function cancelled(signal) {
  if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
}

function normalizeFinishReason(finishReason) {
  if (typeof finishReason !== 'string') return null;
  const normalized = finishReason.trim().toLowerCase();
  if (!normalized) return null;
  return TRUNCATED_FINISH_REASONS.has(normalized) ? 'length' : normalized;
}

function isAbnormalFinishReason(finishReason) {
  const normalized = normalizeFinishReason(finishReason);
  return Boolean(normalized && !NORMAL_FINISH_REASONS.has(normalized));
}

function raceWithCancel(run, signal, timeoutMs = null) {
  cancelled(signal);
  const boundedTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  if (!signal && boundedTimeout == null) return Promise.resolve().then(() => run(null));
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      controller.abort();
      finish(reject, new AiError(AI_ERROR_CODES.AI_CANCELLED));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (boundedTimeout != null) {
      timer = setTimeout(() => {
        controller.abort();
        finish(reject, repairFailure(AI_ERROR_CODES.AI_TIMEOUT, 'REPORT_REPAIR_REVALIDATION_TIMEOUT'));
      }, boundedTimeout);
    }
    Promise.resolve()
      .then(() => run(controller.signal))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function assertStillAuthorized(revalidate, signal, timeoutMs, stage) {
  const stillAuthorized = await raceWithCancel(
    (revalidationSignal) => revalidate({ signal: revalidationSignal ?? signal, stage }),
    signal,
    timeoutMs
  );
  cancelled(signal);
  if (stillAuthorized !== true) {
    throw new ServerPersistenceError(
      'AUTHORIZATION_CHANGED',
      'Rapor doğrulama veya onarım sırasında yetki/rıza kapsamı değiştiği için içerik döndürülmedi.'
    );
  }
}

/**
 * Rapor başına katı ve eşzamanlılığa dayanıklı sunucu çağrı bütçesi izleyicisi.
 *
 * Bütün ayırmalar eşzamanlı olarak (`await` öncesinde) yapılır ve hiçbir koşulda geri alınmaz
 * ya da sıfırlanmaz. Başarısız, zaman aşımına uğrayan veya bozuk yanıt dönen çağrılar da bütçeden düşer.
 */
export function createReportCallBudget({ initialWriterCalls = 0 } = {}) {
  const writerInit = Number.isSafeInteger(initialWriterCalls) && initialWriterCalls >= 0 && initialWriterCalls <= REPORT_CALL_BUDGET.maxWriterCalls
    ? initialWriterCalls
    : 0;
  const state = {
    total: writerInit,
    writer: writerInit,
    repair: 0,
    initialReview: 0,
    postRepairReview: 0,
    rerank: 0,
    perParagraph: new Map()
  };

  const reviewAndRerankUsed = () => state.initialReview + state.postRepairReview + state.rerank;
  const remainingTotal = () => Math.max(0, REPORT_CALL_BUDGET.maxTotalCalls - state.total);
  const remainingRepair = () => Math.min(remainingTotal(), Math.max(0, REPORT_CALL_BUDGET.maxRepairCalls - state.repair));
  const remainingReviewAndRerank = () => Math.min(
    remainingTotal(),
    Math.max(0, REPORT_CALL_BUDGET.maxReviewAndRerankCalls - reviewAndRerankUsed())
  );

  const paragraphCap = (requiresSemanticReview) => (
    requiresSemanticReview
      ? REPORT_CALL_BUDGET.maxSemanticRepairAttemptsPerParagraph
      : REPORT_CALL_BUDGET.maxRepairAttemptsPerParagraph
  );

  function canReserveWriter() {
    return state.writer < REPORT_CALL_BUDGET.maxWriterCalls && remainingTotal() >= 1;
  }

  function reserveWriter() {
    if (!canReserveWriter()) throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_BUDGET_WRITER_EXHAUSTED');
    state.writer += 1;
    state.total += 1;
  }

  function canReserveInitialReview() {
    return state.initialReview < REPORT_CALL_BUDGET.maxInitialReviewCalls && remainingReviewAndRerank() >= 1;
  }

  function reserveInitialReview() {
    if (!canReserveInitialReview()) throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_BUDGET_REVIEW_EXHAUSTED');
    state.initialReview += 1;
    state.total += 1;
  }

  function canReservePostRepairReview() {
    return state.postRepairReview < REPORT_CALL_BUDGET.maxPostRepairReviewCalls && remainingReviewAndRerank() >= 1;
  }

  function reservePostRepairReview() {
    if (!canReservePostRepairReview()) throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_BUDGET_POST_REVIEW_EXHAUSTED');
    state.postRepairReview += 1;
    state.total += 1;
  }

  /**
   * İsteğe bağlı yeniden sıralama, zorunlu anlamsal denetim payı ayrıldıktan sonra kalan bütçeden
   * yalnızca yeterli pay varsa çağrı alabilir.
   */
  function canReserveRerank({ reserveInitialReviewCalls = 0, reservePostRepairReviewCalls = 0 } = {}) {
    const reserved = Math.max(0, reserveInitialReviewCalls) + Math.max(0, reservePostRepairReviewCalls);
    return remainingReviewAndRerank() - reserved >= 1;
  }

  function reserveRerank(options = {}) {
    if (!canReserveRerank(options)) return false;
    state.rerank += 1;
    state.total += 1;
    return true;
  }

  function canReserveRepair(paragraphKey, { requiresSemanticReview = false } = {}) {
    const used = state.perParagraph.get(paragraphKey) ?? 0;
    return remainingRepair() >= 1 && used < paragraphCap(requiresSemanticReview);
  }

  function reserveRepair(paragraphKey, { requiresSemanticReview = false } = {}) {
    if (!canReserveRepair(paragraphKey, { requiresSemanticReview })) return false;
    state.perParagraph.set(paragraphKey, (state.perParagraph.get(paragraphKey) ?? 0) + 1);
    state.repair += 1;
    state.total += 1;
    return true;
  }

  function paragraphAttempts(paragraphKey) {
    return state.perParagraph.get(paragraphKey) ?? 0;
  }

  function snapshot() {
    return Object.freeze({
      toplam: state.total,
      yazim: state.writer,
      onarim: state.repair,
      denetim: state.initialReview + state.postRepairReview,
      ilk_denetim: state.initialReview,
      onarim_sonrasi_denetim: state.postRepairReview,
      yeniden_siralama: state.rerank,
      denetim_ve_siralama_toplam: reviewAndRerankUsed(),
      kalan_toplam: remainingTotal(),
      kalan_onarim: remainingRepair(),
      kalan_denetim_ve_siralama: remainingReviewAndRerank(),
      sinirlar: REPORT_CALL_BUDGET
    });
  }

  return Object.freeze({
    canReserveWriter,
    reserveWriter,
    canReserveInitialReview,
    reserveInitialReview,
    canReservePostRepairReview,
    reservePostRepairReview,
    canReserveRerank,
    reserveRerank,
    canReserveRepair,
    reserveRepair,
    paragraphAttempts,
    snapshot
  });
}

/**
 * Bağımsız denetçinin fiilî yazardan gerçekten farklı bir model olduğunu doğrular.
 * Yalnızca profil adının farklı olması yetmez; hem yapılandırılan hem sağlayıcının bildirdiği
 * model kimlikleri karşılaştırılır.
 */
export function assessIndependentReviewerIdentity({ writerIdentity, reviewerIdentity }) {
  const reviewerConfigured = typeof reviewerIdentity?.configured === 'string' && reviewerIdentity.configured.trim()
    ? reviewerIdentity.configured.trim() : null;
  const reviewerReported = typeof reviewerIdentity?.reported === 'string' && reviewerIdentity.reported.trim()
    ? reviewerIdentity.reported.trim() : null;

  if (reviewerReported && reviewerConfigured && reviewerReported !== reviewerConfigured) {
    return Object.freeze({ ok: false, reason: 'REPORT_REVIEW_MODEL_MISMATCH', configured: reviewerConfigured, reported: reviewerReported });
  }
  const writerIds = new Set(
    [writerIdentity?.configured, writerIdentity?.reported]
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim())
  );
  const reviewerIds = new Set([reviewerConfigured, reviewerReported].filter(Boolean));
  if (!writerIds.size || !reviewerIds.size) {
    return Object.freeze({ ok: false, reason: 'MODEL_IDENTITY_UNVERIFIED', configured: reviewerConfigured, reported: reviewerReported });
  }
  for (const id of reviewerIds) {
    if (writerIds.has(id)) {
      return Object.freeze({ ok: false, reason: 'REVIEWER_SAME_AS_WRITER', configured: reviewerConfigured, reported: reviewerReported });
    }
  }
  return Object.freeze({
    ok: true,
    reason: null,
    configured: reviewerConfigured,
    reported: reviewerReported,
    verified: Boolean(reviewerReported && reviewerConfigured && reviewerReported === reviewerConfigured)
  });
}

function addTokenUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return;
  if (Number.isFinite(usage.promptTokens)) acc.girdiBelirteci += usage.promptTokens;
  if (Number.isFinite(usage.completionTokens)) acc.ciktiBelirteci += usage.completionTokens;
  if (Number.isFinite(usage.reasoningTokens)) acc.dusunmeBelirteci += usage.reasoningTokens;
}

/** İsteğe bağlı yeniden sıralama çıktısını güvenilmez girdi olarak doğrular ve yalnızca yetkili kanıtları sıralar. */
function applySafeRerankOrder(relevantEvidence, scores) {
  const items = relevantEvidence.kanitlar || [];
  if (!Array.isArray(scores) || !items.length) return relevantEvidence;
  const scoreByIndex = new Map();
  for (const entry of scores) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= items.length) return relevantEvidence;
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) return relevantEvidence;
    if (scoreByIndex.has(entry.index)) return relevantEvidence;
    scoreByIndex.set(entry.index, entry.score);
  }
  if (scoreByIndex.size === 0) return relevantEvidence;
  const reordered = items
    .map((item, idx) => ({ item, idx, score: scoreByIndex.get(idx) ?? -Infinity }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((entry) => entry.item);
  return Object.freeze({
    ...relevantEvidence,
    kanitlar: Object.freeze(reordered)
  });
}

/**
 * Doğrulanmış bir 4I-B taslağı üzerinde tam 4I-C doğrulama, bağımsız anlamsal denetim,
 * yerel paragraf onarımı ve yayımlama kapısı akışını yürütür.
 *
 * @param {object} input - Girdiler.
 * @param {object} input.draft - 4I-B taslağı (`4i-yazim-1`).
 * @param {object|null} [input.plan] - Bölüm planı.
 * @param {object} input.evidencePackage - Yetkili `4i-kanit-1` kanıt paketi.
 * @param {object} input.style - Ayrıştırılmış kurumsal stil belgesi.
 * @param {{ completeChat: Function, rerankTexts?: Function }} input.gateway - Yapay zekâ ağ geçidi.
 * @param {(options: { signal: AbortSignal|null, stage: string }) => Promise<boolean>} input.revalidate - Güncel yetki ve rıza denetimi.
 * @param {object|null} [input.writerMeta] - 4I-B yazar çağrısının kimlik üstverisi.
 * @param {string} [input.quality] - Onarım çağrısında kullanılacak yazar kalitesi (`otomatik` | `yuksek_kalite`).
 * @param {object|null} [input.registry] - İsteğe bağlı ön denetim için doğrulanmış model kaydı.
 * @param {Function|null} [input.equivalentReview] - Bağımsız model denetçisi yokken mimariye uygun eşdeğer inceleme kancası.
 * @param {object[]} [input.mandatoryFacts] - Sürümlü zorunlu olgular.
 * @param {string[]} [input.unauthorizedEntities] - Yetkisiz/kapalı varlık listesi.
 * @param {string[]} [input.knownExternalEntities] - Bilinen dış varlık listesi.
 * @param {{ sekiller?: number[], tablolar?: number[] }|null} [input.documentPlan] - Planlı şekil/tablo listesi.
 * @param {boolean} [input.enableRerank] - Kalan bütçe izin veriyorsa isteğe bağlı yeniden sıralama kullan.
 * @param {object|null} [input.budget] - Paylaşılan `createReportCallBudget` örneği.
 * @param {AbortSignal|null} [input.signal] - İstemci iptali.
 * @param {number} [input.revalidationTimeoutMs] - Yetki doğrulama zaman aşımı (ms).
 * @param {Function} [input.now] - Saat kaynağı.
 * @returns {Promise<object>} Yayımlama kararı, güvenli taslak, bulgular, onarım izi ve bütçe özeti.
 */
export async function verifyAndRepairExecutiveReport({
  draft,
  plan = null,
  evidencePackage,
  style,
  gateway,
  revalidate,
  writerMeta = null,
  quality = REPORT_WRITER_QUALITY.AUTOMATIC,
  registry = null,
  equivalentReview = null,
  mandatoryFacts = [],
  unauthorizedEntities = [],
  knownExternalEntities = [],
  documentPlan = null,
  enableRerank = false,
  maxRepairEvidenceItems = DEFAULT_MAX_REPAIR_EVIDENCE_ITEMS,
  budget = null,
  signal = null,
  revalidationTimeoutMs = REPORT_REPAIR_REVALIDATION_TIMEOUT_MS,
  now = () => performance.now()
}) {
  cancelled(signal);
  if (typeof gateway?.completeChat !== 'function') {
    throw repairFailure(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, 'REPORT_REPAIR_GATEWAY_MISSING');
  }
  if (typeof revalidate !== 'function') {
    throw repairFailure(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, 'REPORT_REPAIR_REVALIDATION_MISSING');
  }
  const repairProfile = typeof quality === 'string' && Object.hasOwn(PROFILE_BY_QUALITY, quality)
    ? PROFILE_BY_QUALITY[quality]
    : null;
  if (!repairProfile) {
    throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_REPAIR_QUALITY_INVALID');
  }
  const boundedTimeoutMs = typeof revalidationTimeoutMs === 'number' && Number.isFinite(revalidationTimeoutMs) && revalidationTimeoutMs > 0
    ? revalidationTimeoutMs
    : REPORT_REPAIR_REVALIDATION_TIMEOUT_MS;

  const startedAt = now();
  const callBudget = budget ?? createReportCallBudget({ initialWriterCalls: 1 });
  const tokenUsage = { girdiBelirteci: 0, ciktiBelirteci: 0, dusunmeBelirteci: 0 };

  // Dış mutasyonlara ve çapraz rapor sızıntısına karşı derin kopyalama.
  let evidenceSnapshot;
  let workingDraft;
  try {
    evidenceSnapshot = structuredClone(evidencePackage);
    workingDraft = structuredClone(draft);
  } catch {
    throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_REPAIR_INPUT_INVALID');
  }

  const contract = validateEvidencePackageContract(evidenceSnapshot);
  if (!contract.ok) {
    throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_EVIDENCE_INVALID', { problemCount: contract.problems.length });
  }
  if (!workingDraft || !Array.isArray(workingDraft.bolumler) || workingDraft.bolumler.length === 0) {
    throw repairFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_DRAFT_MISSING');
  }
  const writerStyle = requireWriterStyle(style);

  // Yaşam döngüsü sınırı 1: Başlangıç yetki ve rıza doğrulaması
  await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, 'baslangic');

  const ledger = buildEvidenceFactLedger(evidenceSnapshot, { documentPlan });
  const writerIdentity = {
    configured: writerMeta?.yapilandirilanModel ?? null,
    reported: writerMeta?.bildirilenModel ?? null
  };

  // Yardımcı: nesnel doğrulama
  const runObjectiveCheck = (targetDraft) => verifyReportObjectiveFacts({
    draft: targetDraft,
    evidencePackage: evidenceSnapshot,
    plan,
    mandatoryFacts,
    unauthorizedEntities,
    knownExternalEntities,
    documentPlan,
    ledger
  });

  // 1. Belirlenimci nesnel olgu denetimi (0 model çağrısı)
  let objectiveResult = runObjectiveCheck(workingDraft);

  // 2. Zorunlu bağımsız anlamsal destek denetimi (ilk taslak — en çok 1 model çağrısı)
  const semanticState = {
    status: REPORT_SEMANTIC_REVIEW_STATUS.UNAVAILABLE,
    completed: false,
    independentModel: false,
    configuredModel: null,
    reportedModel: null,
    usingEquivalent: false,
    findings: [],
    assessments: []
  };

  const invokeModelReview = async ({ targetDraft, targets, mode, selectedEvidenceIds = null, isPostRepair = false }) => {
    cancelled(signal);
    // Kayıt verilmişse sağlayıcı çağrısından ÖNCE bağımsızlık ve profil ön denetimi yap (gereksiz çağrıyı önle).
    if (registry) {
      const resolved = resolveModelProfile(registry, AI_REPORT_PROFILES.REVIEW);
      if (!resolved.ok) {
        return { ok: false, status: REPORT_SEMANTIC_REVIEW_STATUS.UNAVAILABLE, reason: resolved.reason };
      }
      const precheck = assessIndependentReviewerIdentity({
        writerIdentity,
        reviewerIdentity: { configured: resolved.route.model, reported: null }
      });
      if (!precheck.ok && precheck.reason === 'REVIEWER_SAME_AS_WRITER') {
        return { ok: false, status: REPORT_SEMANTIC_REVIEW_STATUS.NOT_INDEPENDENT, reason: precheck.reason, configured: resolved.route.model };
      }
    }

    if (isPostRepair) {
      if (!callBudget.canReservePostRepairReview()) {
        return { ok: false, status: REPORT_SEMANTIC_REVIEW_STATUS.POST_REPAIR_INCOMPLETE, reason: 'BUDGET_EXHAUSTED' };
      }
      callBudget.reservePostRepairReview();
    } else {
      if (!callBudget.canReserveInitialReview()) {
        return { ok: false, status: REPORT_SEMANTIC_REVIEW_STATUS.UNAVAILABLE, reason: 'BUDGET_EXHAUSTED' };
      }
      callBudget.reserveInitialReview();
    }

    const built = buildReportReviewMessages({
      draft: targetDraft,
      evidencePackage: evidenceSnapshot,
      style: writerStyle,
      targets,
      mode,
      selectedEvidenceIds
    });

    let result;
    try {
      result = await gateway.completeChat({
        profile: AI_REPORT_PROFILES.REVIEW,
        messages: built.messages,
        maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
        sampling: REPORT_REVIEW_SAMPLING,
        signal,
        requireText: true,
        callerInput: false,
        allowRetry: false,
        beforeDispatch: (dispatchSignal) => assertStillAuthorized(revalidate, dispatchSignal ?? signal, boundedTimeoutMs, isPostRepair ? 'onarim_sonrasi_denetim_gonderim' : 'ilk_denetim_gonderim')
      });
    } catch (error) {
      if (signal?.aborted || (isAiError(error) && error.code === AI_ERROR_CODES.AI_CANCELLED)) throw error;
      if (error instanceof ServerPersistenceError && error.code === 'AUTHORIZATION_CHANGED') throw error;
      if (isAiError(error) && error.details?.reason === 'REPORT_REPAIR_REVALIDATION_TIMEOUT') throw error;
      return { ok: false, status: REPORT_SEMANTIC_REVIEW_STATUS.UNAVAILABLE, reason: error?.code ?? 'REVIEWER_CALL_FAILED' };
    }

    addTokenUsage(tokenUsage, result?.usage);
    cancelled(signal);
    await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, isPostRepair ? 'onarim_sonrasi_denetim_sonrasi' : 'ilk_denetim_sonrasi');

    const identity = assessIndependentReviewerIdentity({
      writerIdentity,
      reviewerIdentity: { configured: result?.configuredModel ?? null, reported: result?.model ?? null }
    });
    if (!identity.ok) {
      return {
        ok: false,
        status: identity.reason === 'REVIEWER_SAME_AS_WRITER'
          ? REPORT_SEMANTIC_REVIEW_STATUS.NOT_INDEPENDENT
          : REPORT_SEMANTIC_REVIEW_STATUS.INVALID_OUTPUT,
        reason: identity.reason,
        configured: identity.configured,
        reported: identity.reported
      };
    }

    if (isAbnormalFinishReason(result?.finishReason)) {
      return {
        ok: false,
        status: REPORT_SEMANTIC_REVIEW_STATUS.INVALID_OUTPUT,
        reason: 'REVIEW_TRUNCATED',
        configured: identity.configured,
        reported: identity.reported
      };
    }

    try {
      const parsed = parseReportReviewResponse(result.text, {
        draft: targetDraft,
        evidencePackage: evidenceSnapshot,
        expectedTargetHash: built.targetHash,
        targets: built.targets
      });
      return {
        ok: true,
        status: REPORT_SEMANTIC_REVIEW_STATUS.VERIFIED_INDEPENDENT,
        configured: identity.configured,
        reported: identity.reported,
        parsed
      };
    } catch (error) {
      if (error instanceof ReportReviewError) {
        return {
          ok: false,
          status: REPORT_SEMANTIC_REVIEW_STATUS.INVALID_OUTPUT,
          reason: error.code,
          configured: identity.configured,
          reported: identity.reported
        };
      }
      throw error;
    }
  };

  const invokeEquivalentReview = async ({ targetDraft, targets, mode }) => {
    cancelled(signal);
    await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, 'esdeger_denetim');
    const targetHash = computeReviewTargetHash({ draft: targetDraft, targets });
    const raw = await equivalentReview({
      draft: structuredClone(targetDraft),
      targets,
      mode,
      targetHash,
      evidencePackage: structuredClone(evidenceSnapshot),
      signal
    });
    cancelled(signal);
    await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, 'esdeger_denetim_sonrasi');
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    try {
      const parsed = parseReportReviewResponse(text, {
        draft: targetDraft,
        evidencePackage: evidenceSnapshot,
        expectedTargetHash: targetHash,
        targets
      });
      return { ok: true, status: REPORT_SEMANTIC_REVIEW_STATUS.VERIFIED_EQUIVALENT, parsed };
    } catch (error) {
      if (error instanceof ReportReviewError) {
        return { ok: false, status: REPORT_SEMANTIC_REVIEW_STATUS.INVALID_OUTPUT, reason: error.code };
      }
      throw error;
    }
  };

  const allInitialTargets = listDraftTargets(workingDraft);
  if (typeof equivalentReview === 'function') {
    const eqRes = await invokeEquivalentReview({
      targetDraft: workingDraft,
      targets: allInitialTargets,
      mode: REPORT_REVIEW_MODES.INITIAL
    });
    semanticState.usingEquivalent = true;
    semanticState.status = eqRes.status;
    if (eqRes.ok) {
      semanticState.completed = true;
      semanticState.findings = [...eqRes.parsed.bulgular];
      semanticState.assessments = [...eqRes.parsed.degerlendirmeler];
    }
  } else {
    const modelRes = await invokeModelReview({
      targetDraft: workingDraft,
      targets: allInitialTargets,
      mode: REPORT_REVIEW_MODES.INITIAL,
      isPostRepair: false
    });
    semanticState.status = modelRes.status;
    semanticState.configuredModel = modelRes.configured ?? null;
    semanticState.reportedModel = modelRes.reported ?? null;
    if (modelRes.ok) {
      semanticState.completed = true;
      semanticState.independentModel = true;
      semanticState.findings = [...modelRes.parsed.bulgular];
      semanticState.assessments = [...modelRes.parsed.degerlendirmeler];
    }
  }

  // 3. Sorunları paragraf bazında konumlandır ve grupla
  const actionableFindingsOf = (objRes, semFindings) => {
    const list = [];
    for (const f of objRes.bulgular) {
      if (f.siddet === REPORT_FINDING_SEVERITIES.WARNING) continue;
      if (f.paragraf !== null) {
        list.push(f);
      } else if (f.kod === REPORT_OBJECTIVE_FINDING_CODES.MISSING_MANDATORY_FACT) {
        // Bölüm/rapor düzeyi eksik zorunlu olguyu ilgili bölümün son paragrafına bağla.
        const sec = workingDraft.bolumler.find((s) => s.kimlik === f.bolum) ?? workingDraft.bolumler[0];
        if (sec && sec.paragraflar.length > 0) {
          list.push(Object.freeze({ ...f, bolum: sec.kimlik, paragraf: sec.paragraflar.length }));
        }
      }
    }
    for (const sf of semFindings) {
      list.push(sf);
    }
    return list;
  };

  const groupFindingsByParagraph = (findingsList) => {
    const groups = new Map();
    for (const f of findingsList) {
      const key = paragraphLocationKey(f.bolum, f.paragraf);
      if (!groups.has(key)) {
        groups.set(key, { key, bolum: f.bolum, paragraf: f.paragraf, findings: [] });
      }
      groups.get(key).findings.push(f);
    }
    // Önce kesin kapı ve kritik sorunlu paragraflar sıralanır, ardından belge sırası korunur.
    const order = new Map(allInitialTargets.map((t, idx) => [paragraphLocationKey(t.bolum, t.paragraf), idx]));
    return [...groups.values()].sort((a, b) => {
      const aHard = a.findings.some((f) => f.kesin_kapi) ? 0 : 1;
      const bHard = b.findings.some((f) => f.kesin_kapi) ? 0 : 1;
      if (aHard !== bHard) return aHard - bHard;
      const aCrit = a.findings.some((f) => f.siddet === REPORT_FINDING_SEVERITIES.CRITICAL) ? 0 : 1;
      const bCrit = b.findings.some((f) => f.siddet === REPORT_FINDING_SEVERITIES.CRITICAL) ? 0 : 1;
      if (aCrit !== bCrit) return aCrit - bCrit;
      return (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999);
    });
  };

  const initialActionable = actionableFindingsOf(objectiveResult, semanticState.findings);
  const paragraphGroups = groupFindingsByParagraph(initialActionable);
  const repairTrail = [];
  const repairedTargetsMap = new Map();
  const repairedEvidenceIds = new Set();
  const semanticFindingsByParagraph = new Map();
  for (const sf of semanticState.findings) {
    const key = paragraphLocationKey(sf.bolum, sf.paragraf);
    if (!semanticFindingsByParagraph.has(key)) semanticFindingsByParagraph.set(key, []);
    semanticFindingsByParagraph.get(key).push(sf);
  }

  // İsteğe bağlı yeniden sıralama için zorunlu onarım sonrası toplu anlamsal denetim payını ÖNCE ayır.
  const willNeedPostRepairModelReview = semanticState.completed && !semanticState.usingEquivalent
    && paragraphGroups.length > 0;
  let rerankUsed = false;
  let rerankSkippedReason = null;

  // 4. Yerel paragraf onarım döngüsü (etkilenmeyen paragraflara hiç dokunulmaz)
  for (const group of paragraphGroups) {
    cancelled(signal);
    const requiresSemanticReview = semanticState.completed
      && group.findings.some((f) => f.kaynak === 'anlamsal_denetci' || f.kod === REPORT_OBJECTIVE_FINDING_CODES.AMBIGUOUS_OBJECTIVE_STATEMENT);

    const baselineMandatoryCovered = new Set(objectiveResult.zorunlu_olgu_kapsami.filter((m) => m.yer_aliyor).map((m) => m.id));
    const baselineDisclosuresCovered = new Set(objectiveResult.zorunlu_aciklama_kapsami.filter((d) => d.yer_aliyor).map((d) => `${d.bolum}:${d.kimlik}`));
    let resolvedInLoop = false;
    let lastRejectReason = null;
    const attemptsBefore = callBudget.paragraphAttempts(group.key);

    while (callBudget.canReserveRepair(group.key, { requiresSemanticReview })) {
      cancelled(signal);
      const currentBlock = getDraftBlock(workingDraft, group.bolum, group.paragraf);
      if (!currentBlock) break;

      let relevantEvidence = selectRelevantEvidenceForParagraph({
        paragraph: currentBlock,
        sectionId: group.bolum,
        findings: group.findings,
        evidencePackage: evidenceSnapshot,
        plan,
        maxItems: maxRepairEvidenceItems
      });

      // İsteğe bağlı yeniden sıralama: yalnızca büyük kanıtta, tek kez ve anlamsal denetim payı korunduktan sonra!
      if (enableRerank && !rerankUsed && typeof gateway.rerankTexts === 'function'
        && (evidenceSnapshot.kanitlar?.length ?? 0) > maxRepairEvidenceItems) {
        const reserved = callBudget.reserveRerank({
          reservePostRepairReviewCalls: willNeedPostRepairModelReview ? 1 : 0
        });
        if (!reserved) {
          rerankSkippedReason = 'DENETIM_BUTCESI_KORUNDU';
        } else {
          rerankUsed = true;
          try {
            const docs = relevantEvidence.kanitlar.map((item) => JSON.stringify(item).slice(0, 1200));
            const rerankRes = await gateway.rerankTexts({
              profile: AI_PROFILES.RERANK,
              query: currentBlock.metin.slice(0, 800),
              documents: docs,
              signal,
              allowRetry: false,
              beforeDispatch: (dispatchSignal) => assertStillAuthorized(revalidate, dispatchSignal ?? signal, boundedTimeoutMs, 'yeniden_siralama_gonderim')
            });
            cancelled(signal);
            await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, 'yeniden_siralama_sonrasi');
            relevantEvidence = applySafeRerankOrder(relevantEvidence, rerankRes?.scores);
          } catch (error) {
            if (signal?.aborted || (isAiError(error) && error.code === AI_ERROR_CODES.AI_CANCELLED)) throw error;
            if (error instanceof ServerPersistenceError && error.code === 'AUTHORIZATION_CHANGED') throw error;
            if (isAiError(error) && error.details?.reason === 'REPORT_REPAIR_REVALIDATION_TIMEOUT') throw error;
            // Yeniden sıralama hatası yerel onarımı durdurmaz; belirlenimci seçimle devam edilir (çağrı bütçeden düşmüştür).
          }
        }
      }

      // Onarım çağrısını eşzamanlı ve geri alınamaz biçimde ayır.
      const reservedRepair = callBudget.reserveRepair(group.key, { requiresSemanticReview });
      if (!reservedRepair) break;

      const mandatoryHints = mandatoryFacts
        .filter((f) => !f.bolum || f.bolum === group.bolum)
        .map((f) => f.olgu || f.id)
        .filter(Boolean)
        .slice(0, 4);

      const repairReq = buildParagraphRepairMessages({
        draft: workingDraft,
        sectionId: group.bolum,
        paragraphIndex: group.paragraf,
        findings: group.findings,
        relevantEvidence,
        evidencePackage: evidenceSnapshot,
        plan,
        style: writerStyle,
        mandatoryHints
      });

      let repairResult;
      try {
        repairResult = await gateway.completeChat({
          profile: repairProfile,
          messages: repairReq.messages,
          maxOutputTokens: REPAIR_MAX_OUTPUT_TOKENS,
          sampling: REPORT_REPAIR_SAMPLING,
          signal,
          requireText: true,
          callerInput: false,
          allowRetry: false,
          beforeDispatch: (dispatchSignal) => assertStillAuthorized(revalidate, dispatchSignal ?? signal, boundedTimeoutMs, 'onarim_gonderim')
        });
      } catch (error) {
        if (signal?.aborted || (isAiError(error) && error.code === AI_ERROR_CODES.AI_CANCELLED)) throw error;
        if (error instanceof ServerPersistenceError && error.code === 'AUTHORIZATION_CHANGED') throw error;
        if (isAiError(error) && error.details?.reason === 'REPORT_REPAIR_REVALIDATION_TIMEOUT') throw error;
        lastRejectReason = error?.code ?? 'REPAIR_CALL_FAILED';
        continue;
      }

      addTokenUsage(tokenUsage, repairResult?.usage);
      cancelled(signal);
      await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, 'onarim_sonrasi');

      try {
        assessReportWriterModelIdentity(repairResult);
      } catch {
        lastRejectReason = 'REPAIR_MODEL_MISMATCH';
        continue;
      }
      if (isAbnormalFinishReason(repairResult?.finishReason)) {
        lastRejectReason = 'REPAIR_TRUNCATED';
        continue;
      }

      let parsedRepair;
      try {
        parsedRepair = parseParagraphRepairResponse(repairResult.text, {
          expectedSectionId: group.bolum,
          expectedParagraphIndex: group.paragraf,
          evidencePackage: evidenceSnapshot
        });
      } catch (error) {
        if (error instanceof ReportRepairParseError) {
          lastRejectReason = error.code;
          continue;
        }
        throw error;
      }

      if (parsedRepair.bicim_uyarilari.length > 0) {
        lastRejectReason = `FORMAT_REGRESSION:${parsedRepair.bicim_uyarilari[0]}`;
        continue;
      }

      // Aday taslakta YALNIZCA bu paragraf değiştirilir; bütün diğer paragraflar bayt bayt korunur.
      const candidateDraft = replaceDraftParagraph(workingDraft, {
        bolum: group.bolum,
        paragraf: group.paragraf,
        metin: parsedRepair.metin,
        kanitlar: parsedRepair.kanitlar,
        iddialar: parsedRepair.iddialar
      });

      // Her onarım denemesi sonrası belirlenimci yeniden doğrulama (0 model çağrısı).
      const candidateObjective = runObjectiveCheck(candidateDraft);
      const paragraphObjCriticals = candidateObjective.bulgular.filter(
        (f) => f.bolum === group.bolum && f.paragraf === group.paragraf && f.siddet === REPORT_FINDING_SEVERITIES.CRITICAL
      );
      const lostMandatory = candidateObjective.zorunlu_olgu_kapsami.some(
        (m) => baselineMandatoryCovered.has(m.id) && !m.yer_aliyor
      );
      const lostDisclosure = candidateObjective.zorunlu_aciklama_kapsami.some(
        (d) => baselineDisclosuresCovered.has(`${d.bolum}:${d.kimlik}`) && !d.yer_aliyor
      );
      const sectionMissingMandatory = group.findings.some((f) => f.kod === REPORT_OBJECTIVE_FINDING_CODES.MISSING_MANDATORY_FACT)
        && candidateObjective.bulgular.some((f) => f.kod === REPORT_OBJECTIVE_FINDING_CODES.MISSING_MANDATORY_FACT && f.bolum === group.bolum);

      if (paragraphObjCriticals.length > 0) {
        lastRejectReason = `OBJECTIVE_REGRESSION:${paragraphObjCriticals[0].kod}`;
        continue;
      }
      if (lostMandatory || lostDisclosure || sectionMissingMandatory) {
        lastRejectReason = 'MANDATORY_FACT_REGRESSION';
        continue;
      }

      // Onarım kabul edildi!
      workingDraft = candidateDraft;
      objectiveResult = candidateObjective;
      resolvedInLoop = true;
      repairedTargetsMap.set(group.key, Object.freeze({ bolum: group.bolum, paragraf: group.paragraf }));
      for (const id of relevantEvidence.kanit_kimlikleri) repairedEvidenceIds.add(id);
      for (const id of parsedRepair.kanitlar) repairedEvidenceIds.add(id);
      break;
    }

    repairTrail.push(Object.freeze({
      bolum: group.bolum,
      paragraf: group.paragraf,
      deneme_sayisi: callBudget.paragraphAttempts(group.key) - attemptsBefore,
      anlamsal_denetim_gerektirir: requiresSemanticReview,
      durum: resolvedInLoop ? 'yerel_onarildi' : 'butce_veya_deneme_tukenerek_kaldi',
      ...(lastRejectReason && !resolvedInLoop ? { son_ret_nedeni: lastRejectReason } : {})
    }));
  }

  // 5. Onarılan paragraflar için toplu onarım sonrası anlamsal yeniden denetim (en çok 1 çağrı)
  const repairedTargets = [...repairedTargetsMap.values()];
  if (repairedTargets.length > 0 && semanticState.completed) {
    if (semanticState.usingEquivalent) {
      const postEq = await invokeEquivalentReview({
        targetDraft: workingDraft,
        targets: repairedTargets,
        mode: REPORT_REVIEW_MODES.POST_REPAIR_BATCH
      });
      if (postEq.ok) {
        for (const t of repairedTargets) semanticFindingsByParagraph.delete(paragraphLocationKey(t.bolum, t.paragraf));
        for (const sf of postEq.parsed.bulgular) {
          const key = paragraphLocationKey(sf.bolum, sf.paragraf);
          if (!semanticFindingsByParagraph.has(key)) semanticFindingsByParagraph.set(key, []);
          semanticFindingsByParagraph.get(key).push(sf);
        }
      } else {
        semanticState.completed = false;
        semanticState.status = REPORT_SEMANTIC_REVIEW_STATUS.POST_REPAIR_INCOMPLETE;
      }
    } else {
      const postModel = await invokeModelReview({
        targetDraft: workingDraft,
        targets: repairedTargets,
        mode: REPORT_REVIEW_MODES.POST_REPAIR_BATCH,
        selectedEvidenceIds: repairedEvidenceIds.size > 0 ? [...repairedEvidenceIds] : null,
        isPostRepair: true
      });
      if (postModel.ok) {
        for (const t of repairedTargets) semanticFindingsByParagraph.delete(paragraphLocationKey(t.bolum, t.paragraf));
        for (const sf of postModel.parsed.bulgular) {
          const key = paragraphLocationKey(sf.bolum, sf.paragraf);
          if (!semanticFindingsByParagraph.has(key)) semanticFindingsByParagraph.set(key, []);
          semanticFindingsByParagraph.get(key).push(sf);
        }
      } else {
        semanticState.completed = false;
        semanticState.status = REPORT_SEMANTIC_REVIEW_STATUS.POST_REPAIR_INCOMPLETE;
      }
    }
  }

  // 6. Bütçe tükendiyse veya çözülemeyen bulgu kaldıysa belirlenimci son çare (çıkar / inceleme işareti)
  objectiveResult = runObjectiveCheck(workingDraft);
  const remainingSemanticFindings = [...semanticFindingsByParagraph.values()].flat();
  const unresolvedBeforeFallback = actionableFindingsOf(objectiveResult, remainingSemanticFindings);

  // Bağımsız anlamsal denetim tamamlanamadıysa, belirlenimci denetimin tek başına doğrulayamadığı
  // yorum/maddi ifadeler (ör. `desteklenen_yorum` beyanları) önizlemede inceleme işaretiyle maskelenir.
  if (!semanticState.completed) {
    for (const claim of workingDraft.iddialar || []) {
      if (claim.sinif === REPORT_CLAIM_CLASSES.SUPPORTED_INTERPRETATION) {
        unresolvedBeforeFallback.push(Object.freeze({
          id: 'AD_BEKLIYOR',
          kod: 'anlamsal_denetim_bekliyor',
          siddet: REPORT_FINDING_SEVERITIES.MEDIUM,
          kesin_kapi: false,
          kaynak: 'sunucu',
          bolum: claim.bolum,
          paragraf: claim.paragraf,
          cumle: null,
          alinti: claim.alinti,
          mesaj: 'Bağımsız anlamsal denetim tamamlanmadığından bu yorum ifadesi inceleme bekliyor.'
        }));
      }
    }
  }

  const fallbackGroups = groupFindingsByParagraph(unresolvedBeforeFallback);

  const markers = [];
  let fallbackCriticalReviewRequired = false;
  let deliverableDraft = workingDraft;

  for (const group of fallbackGroups) {
    const block = getDraftBlock(deliverableDraft, group.bolum, group.paragraf);
    if (!block) continue;
    const fb = applyDeterministicParagraphFallback({
      paragraph: block,
      bolum: group.bolum,
      paragraf: group.paragraf,
      findings: group.findings
    });
    if (fb.degisti) {
      deliverableDraft = replaceDraftParagraph(deliverableDraft, {
        bolum: group.bolum,
        paragraf: group.paragraf,
        metin: fb.metin,
        kanitlar: fb.kanitlar
      });
    }
    if (fb.kritik_inceleme_gerekli) fallbackCriticalReviewRequired = true;
    markers.push(...fb.isaretler);
    // Çözülen anlamsal bulguları yalnızca temiz cümle çıkarımı sonrası düş; kritik inceleme gerektirenleri koru.
    if (!fb.kritik_inceleme_gerekli && fb.cikarilan_cumle_sayisi > 0) {
      semanticFindingsByParagraph.delete(group.key);
    }
  }

  // Bağımsız anlamsal denetim tamamlanamadıysa maddi iddia desteği doğrulanmamış kabul edilir (kapalı güvenli).
  if (!semanticState.completed) {
    fallbackCriticalReviewRequired = true;
  }

  // Son çare sonrası yeniden belirlenimci doğrulama (çıkarma zorunlu olgu kaybettirdiyse kesinlikle yakalanır).
  const finalObjective = runObjectiveCheck(deliverableDraft);
  const finalRemainingSemantic = [...semanticFindingsByParagraph.values()].flat();

  const blockingReasons = [];
  if (finalObjective.kesin_kapilar.length > 0) blockingReasons.push('kesin_kapi_ihlali');
  if (finalObjective.kritik_bulgu_sayisi > 0) blockingReasons.push('cozulmemis_nesnel_hata');
  if (finalObjective.zorunlu_olgu_kapsami.some((m) => !m.yer_aliyor) || finalObjective.zorunlu_aciklama_kapsami.some((d) => !d.yer_aliyor)) {
    blockingReasons.push('eksik_zorunlu_olgu');
  }
  if (!semanticState.completed) blockingReasons.push(`anlamsal_denetim_eksik:${semanticState.status}`);
  if (finalRemainingSemantic.length > 0) blockingReasons.push('cozulmemis_anlamsal_bulgu');
  if (fallbackCriticalReviewRequired) blockingReasons.push('insan_incelemesi_gerekli');

  const uniqueBlockingReasons = [...new Set(blockingReasons)];
  const publishable = uniqueBlockingReasons.length === 0;

  // Yaşam döngüsü sınırı son: teslimden hemen önce güncel yetki ve rıza yeniden doğrulaması
  cancelled(signal);
  await assertStillAuthorized(revalidate, signal, boundedTimeoutMs, 'teslim_oncesi');

  // Etkilenmeyen paragraf bütünlüğü ölçümü
  let untouchedCount = 0;
  for (const t of allInitialTargets) {
    const before = getDraftBlock(draft, t.bolum, t.paragraf);
    const after = getDraftBlock(deliverableDraft, t.bolum, t.paragraf);
    if (before && after && before.metin === after.metin) untouchedCount += 1;
  }

  return Object.freeze({
    sozlesme: REPORT_REPAIR_CONTRACT,
    durum: publishable ? REPORT_PUBLICATION_STATUS.PUBLISHABLE : REPORT_PUBLICATION_STATUS.REVIEW_REQUIRED,
    yayimlanabilir: publishable,
    sonlandirilabilir: publishable,
    taslak: deliverableDraft,
    korunan_taslak_durumu: Object.freeze({
      taslak_korundu: true,
      dogrulanmis_paragraf_sayisi: Math.max(0, allInitialTargets.length - fallbackGroups.length),
      isaretlenen_ifade_sayisi: markers.length,
      sonlandirma_engelli: !publishable
    }),
    engelleme_nedenleri: Object.freeze(uniqueBlockingReasons),
    bulgular: Object.freeze({
      belirlenimci: finalObjective.bulgular,
      anlamsal: Object.freeze(finalRemainingSemantic),
      kesin_kapilar: finalObjective.kesin_kapilar,
      zorunlu_olgu_kapsami: finalObjective.zorunlu_olgu_kapsami,
      zorunlu_aciklama_kapsami: finalObjective.zorunlu_aciklama_kapsami
    }),
    onarimlar: Object.freeze(repairTrail),
    isaretler: Object.freeze(markers),
    anlamsal_denetim: Object.freeze({
      sozlesme: REPORT_REVIEW_CONTRACT,
      durum: semanticState.status,
      tamamlandi: semanticState.completed,
      model_bagimsiz: semanticState.independentModel,
      esdeger_denetim: semanticState.usingEquivalent,
      yapilandirilan_model: semanticState.configuredModel,
      bildirilen_model: semanticState.reportedModel,
      degerlendirme_sayisi: semanticState.assessments.length
    }),
    butce: callBudget.snapshot(),
    meta: Object.freeze({
      sureMs: Math.max(0, now() - startedAt),
      toplamParagraf: allInitialTargets.length,
      degismeyenParagraf: untouchedCount,
      onarilanParagraf: repairedTargets.length,
      yenidenSiralamaKullanildi: rerankUsed,
      yenidenSiralamaAtlamaNedeni: rerankSkippedReason,
      kullanim: Object.freeze({ ...tokenUsage })
    })
  });
}

/**
 * Uçtan uca 4I-B + 4I-C yönetici raporu yürütücüsü.
 *
 * Tek çağrılık 4I-B yazar sözleşmesini (`writeExecutiveReportDraft`) koruyarak ortak 11 çağrılık
 * bütçe içinde önce ilk anlatı taslağını üretir, ardından 4I-C orantılı doğrulama, bağımsız
 * anlamsal denetim ve yerel onarım hattını çalıştırır.
 */
export async function generateVerifiedExecutiveReport({
  evidencePackage,
  style,
  gateway,
  revalidate,
  quality = REPORT_WRITER_QUALITY.AUTOMATIC,
  kapaliBolumler = [],
  registry = null,
  equivalentReview = null,
  mandatoryFacts = [],
  unauthorizedEntities = [],
  knownExternalEntities = [],
  documentPlan = null,
  enableRerank = false,
  signal = null,
  revalidationTimeoutMs = REPORT_REPAIR_REVALIDATION_TIMEOUT_MS,
  now = () => performance.now()
}) {
  cancelled(signal);
  const budget = createReportCallBudget({ initialWriterCalls: 0 });
  // 4I-B yazar çağrısı ortak 11 çağrılık bütçeden 1 çağrı ayırır.
  budget.reserveWriter();
  const writerResult = await writeExecutiveReportDraft({
    evidencePackage,
    style,
    gateway,
    revalidate,
    quality,
    kapaliBolumler,
    signal,
    revalidationTimeoutMs,
    now
  });
  const verified = await verifyAndRepairExecutiveReport({
    draft: writerResult.draft,
    plan: writerResult.plan,
    evidencePackage,
    style,
    gateway,
    revalidate,
    writerMeta: writerResult.meta,
    quality,
    registry,
    equivalentReview,
    mandatoryFacts,
    unauthorizedEntities,
    knownExternalEntities,
    documentPlan,
    enableRerank,
    budget,
    signal,
    revalidationTimeoutMs,
    now
  });
  return Object.freeze({
    ...verified,
    plan: writerResult.plan,
    yazar_meta: writerResult.meta
  });
}
