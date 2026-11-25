import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { AI_REPORT_PROFILES } from '../../../domain/ai/aiModelRegistry.js';
import { parseReportDraft, ReportDraftError } from '../../../domain/ai/report/reportDraft.js';
import { validateEvidencePackageContract } from '../../../domain/ai/report/reportRequest.js';
import { buildReportSectionPlan, REPORT_WRITING_CONTRACT, ReportPlanError, requireWriterStyle } from '../../../domain/ai/report/reportSectionPlan.js';
import { buildReportWriterMessages, REPORT_WRITER_PROMPT_VERSION, ReportPromptError } from '../../../domain/ai/report/reportWriterPrompt.js';
import { ServerPersistenceError } from '../../errors.js';
import { AiError } from '../aiErrors.js';

/**
 * Bilgin Aşama 4I-B — yönetici raporu anlatı yazarı (sunucu).
 *
 * Akış: yetkili kanıt paketi (4I-A) → sözleşme doğrulaması → belirlenimci bölüm planı → yazar istemi →
 * ağ geçidi üzerinden TEK model çağrısı → değiştirilmemiş yanıtın ayrıştırılması → yetkinin yeniden
 * doğrulanması → doğrulanmış taslak.
 *
 * Yazar SQL çalıştırmaz, araç çağırmaz, veri istemez ve yetki kararı vermez. Kimlik, kapasite, süre sınırı,
 * iptal ve profil çözümü mevcut ağ geçidindedir (`completeChat`); bu modül ek yeniden deneme, daha güçlü
 * modele sessiz geçiş ya da sınır yükseltmesi yapmaz. Rapor başına yazım çağrısı tavanı 1'dir; 4I-C'nin
 * onarım ve denetim payı burada tüketilmez. Taslak, istem, not ve kanıt içeriği günlüğe yazılmaz.
 */

export const REPORT_WRITER_QUALITY = Object.freeze({ AUTOMATIC: 'otomatik', HIGH: 'yuksek_kalite' });
export const REPORT_WRITER_CALLS_PER_DRAFT = 1;
const PROFILE_BY_QUALITY = Object.freeze({
  [REPORT_WRITER_QUALITY.AUTOMATIC]: AI_REPORT_PROFILES.WRITER,
  [REPORT_WRITER_QUALITY.HIGH]: AI_REPORT_PROFILES.WRITER_QUALITY
});
/**
 * Çıktı belirteci isteği: sözcük başına pay (Türkçe düzyazı + JSON + iddia eki), sabit pay ve akıl yürüten modellerin
 * düşünme payı. Düşünme belirteçleri çoğu uçta aynı sınırdan düşer; pay yetmezse yanıt kesilir ve taslak reddedilir.
 * Sonuç her durumda profilin `maxOutputTokens` sınırı ve modelin bağlam penceresiyle ağ geçidinde daraltılır.
 */
const TOKENS_PER_WORD = 6;
const FIXED_OUTPUT_TOKENS = 1500;
// Vekil koşusunda düşük eforlu akıl yürüten model bile rapor başına 20–42 bin düşünme belirteci harcadı; pay buna göre seçildi.
const REASONING_HEADROOM_TOKENS = 40960;
const MAX_REQUESTED_OUTPUT_TOKENS = 65536;

const NORMAL_FINISH_REASONS = new Set(['stop', 'end_turn']);

function writerFailure(code, reason, extra = {}) {
  return new AiError(code, { details: { reason, ...extra } });
}

function cancelled(signal) {
  if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
}

/** İstemci iptal ettiğinde yavaş dönen yeniden doğrulamayı beklemeden iptal hatası fırlatır. */
function raceWithCancel(run, signal) {
  cancelled(signal);
  if (!signal) return Promise.resolve().then(run);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AiError(AI_ERROR_CODES.AI_CANCELLED));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function assertStillAuthorized(revalidate, signal) {
  const stillAuthorized = await raceWithCancel(() => revalidate({ signal }), signal);
  cancelled(signal);
  if (stillAuthorized !== true) {
    throw new ServerPersistenceError('AUTHORIZATION_CHANGED', 'Rapor yazımı sırasında yetki kapsamı değiştiği için taslak döndürülmedi.');
  }
}

/**
 * Yazar isteğini model çağrısından bağımsız olarak hazırlar: aynı fonksiyon üretim yazarında ve
 * nitelendirme/vekil betiklerinde kullanılır, böylece bütün adaylar bayt bayt aynı istemi alır.
 *
 * @param {{ evidencePackage: object, style: object, quality?: string, kapaliBolumler?: string[] }} input - Girdiler.
 * @returns {{ plan: object, messages: object[], profile: string, maxOutputTokens: number, promptVersion: string }} İstek.
 */
export function prepareReportWriterRequest({ evidencePackage, style, quality = REPORT_WRITER_QUALITY.AUTOMATIC, kapaliBolumler = [] }) {
  const profile = typeof quality === 'string' && Object.hasOwn(PROFILE_BY_QUALITY, quality) ? PROFILE_BY_QUALITY[quality] : null;
  if (!profile) throw writerFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_WRITER_QUALITY_INVALID');
  const contract = validateEvidencePackageContract(evidencePackage);
  if (!contract.ok) {
    // Sorunların yalnızca sayısı taşınır; sorun etiketleri kanıt kimliği içerebilir ama metin içermez.
    throw writerFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_EVIDENCE_INVALID', { problemCount: contract.problems.length });
  }
  try {
    const writerStyle = requireWriterStyle(style);
    const plan = buildReportSectionPlan(evidencePackage, writerStyle, { kapaliBolumler });
    const messages = buildReportWriterMessages({ evidencePackage, plan, style: writerStyle });
    const maxOutputTokens = Math.min(MAX_REQUESTED_OUTPUT_TOKENS, plan.sozcuk_araligi[1] * TOKENS_PER_WORD + FIXED_OUTPUT_TOKENS + REASONING_HEADROOM_TOKENS);
    return Object.freeze({ plan, messages, profile, maxOutputTokens, promptVersion: REPORT_WRITER_PROMPT_VERSION });
  } catch (error) {
    if (error instanceof ReportPlanError || error instanceof ReportPromptError) {
      throw writerFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, `REPORT_WRITER_${error.code}`);
    }
    throw error;
  }
}

/**
 * Model kimliğini değerlendirir. Bildirilen kimlik yapılandırılan modelden ve kayıtta onun için açıkça
 * bildirilmiş adlardan farklıysa yanıt başka modelindir: taslak reddedilir. Kimlik bildirilmemişse taslak
 * kullanılabilir ama doğrulanmamış olarak işaretlenir (nitelendirmede bu koşu GEÇERSİZ sayılır).
 */
export function assessReportWriterModelIdentity({ model = null, configuredModel = null, reportedModels = [] }) {
  if (typeof model !== 'string' || !model) return { reported: null, configured: configuredModel, verified: false };
  const accepted = new Set([configuredModel, ...(Array.isArray(reportedModels) ? reportedModels : [])].filter(Boolean));
  if (!accepted.has(model)) {
    throw writerFailure(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, 'REPORT_WRITER_MODEL_MISMATCH');
  }
  return { reported: model, configured: configuredModel, verified: true };
}

/**
 * Değiştirilmemiş model yanıtını taslağa çevirir. Kesilen (`length`) ya da normal bitmemiş (`content_filter`,
 * `tool_calls` vb.) yanıt kısmi/geçersiz çıktıdır ve ayrıştırılmadan reddedilir; JSON kazıma, eksik parçayı
 * tamamlama ya da metni düzeltme yapılmaz.
 */
const KNOWN_ABNORMAL_FINISH_REASONS = new Set(['content_filter', 'tool_calls', 'function_call']);

export function finalizeReportWriterResponse({ text, finishReason = null, plan, evidencePackage }) {
  if (finishReason === 'length') throw writerFailure(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, 'REPORT_DRAFT_TRUNCATED');
  if (typeof finishReason === 'string' && finishReason.trim() && !NORMAL_FINISH_REASONS.has(finishReason)) {
    const safeReason = KNOWN_ABNORMAL_FINISH_REASONS.has(finishReason) ? finishReason : 'other';
    throw writerFailure(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, 'REPORT_DRAFT_INCOMPLETE_FINISH', { finishReason: safeReason });
  }
  try {
    return parseReportDraft(text, { plan, evidencePackage });
  } catch (error) {
    if (error instanceof ReportDraftError) {
      throw writerFailure(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, 'REPORT_DRAFT_INVALID', {
        draftCode: error.code,
        path: error.path,
        ...(error.reason ? { draftReason: error.reason } : {})
      });
    }
    throw error;
  }
}

/**
 * Yetkili kanıt paketinden doğrulanmış yönetici raporu taslağı üretir.
 *
 * @param {object} input - Girdiler.
 * @param {object} input.evidencePackage - 4I-A `4i-kanit-1` paketi (yetki bağlamı içermez).
 * @param {object} input.style - Kanonik stil belgesinin ayrıştırılmış hâli.
 * @param {{ completeChat: Function }} input.gateway - Mevcut yapay zekâ ağ geçidi.
 * @param {(options: { signal: AbortSignal|null }) => Promise<boolean>} input.revalidate - Gönderim öncesinde ve
 *   içerik dönmeden önce güncel yetki ve rızayı doğrulayan sunucu denetimi; `true` dönmezse işlem durdurulur.
 * @param {string} [input.quality] - `otomatik` ya da `yuksek_kalite`.
 * @param {string[]} [input.kapaliBolumler] - Kullanıcının kapattığı isteğe bağlı bölümler.
 * @param {AbortSignal|null} [input.signal] - İstemci iptali.
 * @returns {Promise<{ draft: object, plan: object, meta: object }>} Doğrulanmış taslak ve içeriksiz üstveri.
 */
export async function writeExecutiveReportDraft({
  evidencePackage, style, gateway, revalidate, quality = REPORT_WRITER_QUALITY.AUTOMATIC, kapaliBolumler = [], signal = null, now = Date.now
}) {
  cancelled(signal);
  if (typeof gateway?.completeChat !== 'function') throw writerFailure(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, 'REPORT_WRITER_GATEWAY_MISSING');
  if (typeof revalidate !== 'function') throw writerFailure(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, 'REPORT_WRITER_REVALIDATION_MISSING');
  // İstem ve taslak doğrulaması aynı kanıt anlık görüntüsüne bağlanır; çağrı sırasında dış nesne değişse bile tutarlılık bozulmaz.
  let evidenceSnapshot;
  try {
    evidenceSnapshot = structuredClone(evidencePackage);
  } catch {
    throw writerFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, 'REPORT_EVIDENCE_INVALID', { problemCount: 1 });
  }
  const request = prepareReportWriterRequest({ evidencePackage: evidenceSnapshot, style, quality, kapaliBolumler });
  const startedAt = now();
  let result;
  try {
    result = await gateway.completeChat({
      profile: request.profile,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      signal,
      requireText: true,
      // İletiler sunucunun ürettiği sabit istektir: sağlayıcının 4xx yanıtı kullanıcı değil yapılandırma hatasıdır.
      callerInput: false,
      // Kuyruk beklemesi sırasında yetki ya da rıza kaldırıldıysa kanıt sağlayıcıya hiç gönderilmez.
      beforeDispatch: (dispatchSignal) => assertStillAuthorized(revalidate, dispatchSignal ?? signal)
    });
  } catch (error) {
    if (error instanceof AiError
      && error.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID
      && error.details?.reason === 'EMPTY_COMPLETION'
      && error.details?.finishReason === 'length') {
      throw writerFailure(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, 'REPORT_DRAFT_TRUNCATED');
    }
    throw error;
  }
  cancelled(signal);
  const identity = assessReportWriterModelIdentity(result);
  const draft = finalizeReportWriterResponse({ text: result.text, finishReason: result.finishReason, plan: request.plan, evidencePackage: evidenceSnapshot });
  // Uzun süren yazım sırasında yetki ya da rıza değişmiş olabilir: içerik ancak güncel denetimden sonra döner.
  await assertStillAuthorized(revalidate, signal);
  return Object.freeze({
    draft,
    plan: request.plan,
    meta: Object.freeze({
      sozlesme: REPORT_WRITING_CONTRACT,
      istemSurumu: request.promptVersion,
      profil: request.profile,
      yapilandirilanModel: identity.configured,
      bildirilenModel: identity.reported,
      modelKimligiDogrulandi: identity.verified,
      cagriSayisi: REPORT_WRITER_CALLS_PER_DRAFT,
      sureMs: Math.max(0, now() - startedAt),
      bitisNedeni: result.finishReason ?? null,
      kullanim: result.usage ?? null,
      uyariSayisi: draft.uyarilar.length
    })
  });
}
