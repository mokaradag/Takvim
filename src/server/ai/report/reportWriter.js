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
/** Nitelendirme ve üretim yazarı aynı örnekleme ayarını kullanır. */
export const REPORT_WRITER_SAMPLING = Object.freeze({ temperature: 0.2, topP: 0.9 });
/** Model yanıtı döndükten sonraki son yetki denetimi için bağımsız üst süre sınırı (ms). */
export const REPORT_WRITER_REVALIDATION_TIMEOUT_MS = 15_000;
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

/**
 * İstemci iptali ya da bağımsız süre aşımı durumunda yavaş dönen yeniden doğrulamayı beklemeden keser;
 * süreölçer ve dinleyicileri her yolda temizler.
 */
function raceWithCancel(run, signal, timeoutMs = null) {
  cancelled(signal);
  const boundedTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  if (!signal && boundedTimeout == null) return Promise.resolve().then(() => run(null));
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
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
        finish(reject, writerFailure(AI_ERROR_CODES.AI_TIMEOUT, 'REPORT_WRITER_REVALIDATION_TIMEOUT'));
      }, boundedTimeout);
    }
    Promise.resolve()
      .then(() => run(controller.signal))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function assertStillAuthorized(revalidate, signal, timeoutMs = null) {
  const stillAuthorized = await raceWithCancel((revalidationSignal) => revalidate({ signal: revalidationSignal ?? signal }), signal, timeoutMs);
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
 * @returns {{ plan: object, messages: object[], profile: string, maxOutputTokens: number, sampling: object, promptVersion: string }} İstek.
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
    return Object.freeze({
      plan,
      messages,
      profile,
      maxOutputTokens,
      sampling: REPORT_WRITER_SAMPLING,
      promptVersion: REPORT_WRITER_PROMPT_VERSION
    });
  } catch (error) {
    if (error instanceof ReportPlanError || error instanceof ReportPromptError) {
      throw writerFailure(AI_ERROR_CODES.AI_REQUEST_INVALID, `REPORT_WRITER_${error.code}`);
    }
    throw error;
  }
}

/**
 * Model kimliğini değerlendirir. Sohbet modellerinde kayıt takma ad (`reportedModels`) tanımlamadığından
 * bildirilen kimlik yapılandırılan model adıyla bire bir eşleşmelidir; farklıysa taslak reddedilir.
 * Kimlik bildirilmemişse taslak kullanılabilir ama doğrulanmamış olarak işaretlenir (nitelendirmede geçersiz).
 */
export function assessReportWriterModelIdentity({ model = null, configuredModel = null }) {
  if (typeof model !== 'string' || !model) return { reported: null, configured: configuredModel, verified: false };
  if (!configuredModel || model !== configuredModel) {
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
 * @param {number} [input.revalidationTimeoutMs] - Üretim sonrası son yetki doğrulaması için üst süre sınırı (ms).
 * @returns {Promise<{ draft: object, plan: object, meta: object }>} Doğrulanmış taslak ve içeriksiz üstveri.
 */
export async function writeExecutiveReportDraft({
  evidencePackage,
  style,
  gateway,
  revalidate,
  quality = REPORT_WRITER_QUALITY.AUTOMATIC,
  kapaliBolumler = [],
  signal = null,
  revalidationTimeoutMs = REPORT_WRITER_REVALIDATION_TIMEOUT_MS,
  now = Date.now
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
      sampling: request.sampling,
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
  // Uzun süren yazım sırasında yetki ya da rıza değişmiş olabilir: içerik ancak bağımsız süre sınırlı güncel denetimden sonra döner.
  await assertStillAuthorized(revalidate, signal, revalidationTimeoutMs);
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
