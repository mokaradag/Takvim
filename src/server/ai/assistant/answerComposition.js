import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { AI_CAPABILITIES } from '../../../domain/ai/aiModelRegistry.js';
import { parseCompositionResponse, renderComposition, validateComposition } from '../../../domain/ai/groundedComposition.js';
import { AiError, isAiError } from '../aiErrors.js';
import { compositionMessages } from './groundedPrompt.js';

/**
 * Doğrulanmış kanıttan doğal yanıtın TEK model turu.
 *
 * Tur, kanıta dayalı oturumun içinde (aynı kapasite kirası ve kimlik bilgisiyle), araçsız ve dar bir
 * çıktı sınırıyla yürür; kendi süre penceresi oturumun kalan süresinden ayrılır ki yavaş bir düzen
 * turu doğrulanmış yanıtın teslimini düşürmesin. Düzen bir sunum katmanıdır: düzeltme turu, Derin
 * düşünmeye devir ya da ikinci deneme yoktur. Model metni geçersiz, kesik, boş ya da geç kalırsa sonuç
 * `ok: false` olur ve çağıran doğrulanmış belirlenimci anlatımı gösterir. Yalnızca turun kendisinin
 * iptali/süre sınırı ve yapay zekâ dışı hatalar yukarı taşınır.
 */
export const COMPOSITION_RUNTIME = Object.freeze({
  /**
   * Düşünmesiz modelde kapalı düzenin çıktı sınırı; profil sınırını yalnızca daraltır.
   */
  maxOutputTokens: 1200,
  /** Düzen turunun en uzun süresi; oturumun kalan süresinden ayrıca `reserveMs` teslim payı kalır. */
  timeoutMs: 60000,
  reserveMs: 5000,
  /** Bu süreden az kaldıysa düzen istenmez. */
  minMs: 8000
});

export const COMPOSITION_REASONS = Object.freeze(['BUDGET', 'TIMEOUT', 'PROVIDER', 'LENGTH', 'EMPTY', 'INVALID', 'INTERNAL']);

function outputBudget(session) {
  const limit = Number.isSafeInteger(session.maxOutputTokens) && session.maxOutputTokens > 0 ? session.maxOutputTokens : COMPOSITION_RUNTIME.maxOutputTokens;
  // Düşünme yetenekli model çıktısının bir kısmını akıl yürütmeye harcayabilir: profil sınırı korunur.
  if (session.capabilities?.includes(AI_CAPABILITIES.REASONING)) return limit;
  return Math.min(COMPOSITION_RUNTIME.maxOutputTokens, limit);
}

/** Düzen turu açılmadan önce ayrılabilecek süre; yetki okuması gerektirmez. */
export function compositionWindowMs(session) {
  const remaining = Number(session.remainingMs?.() ?? 0);
  const windowMs = Math.min(COMPOSITION_RUNTIME.timeoutMs, remaining - COMPOSITION_RUNTIME.reserveMs);
  return Number.isFinite(windowMs) && windowMs >= COMPOSITION_RUNTIME.minMs ? windowMs : null;
}

/**
 * @returns {Promise<{ ok: true, text: string, citedIds: string[], chart: string|null, charts: number, blocks: number }
 *   | { ok: false, reason: string, issue?: string }>}
 */
export async function composeGroundedAnswer({ session, composition, onStart = null, onProgress = null, onRound = null }) {
  const windowMs = compositionWindowMs(session);
  if (windowMs == null) return { ok: false, reason: 'BUDGET' };
  const budget = outputBudget(session);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AiError(AI_ERROR_CODES.AI_CANCELLED, { details: { reason: 'COMPOSITION_BUDGET' } })), windowMs);
  timer.unref?.();
  const startedAt = Date.now();
  let result;
  try {
    const messages = compositionMessages(composition.view);
    onStart?.();
    result = await session.round({ messages, resend: false, tools: [], toolChoice: 'none', maxOutputTokens: budget, signal: controller.signal, onEvent: () => { onProgress?.(); } });
  } catch (error) {
    onRound?.({ startedAt, budget, error });
    // Turun kendisi bittiyse (kullanıcı iptali, oturum süre sınırı) düzen beklenmez; hata turu sonlandırır.
    if (session.signal?.aborted || !isAiError(error)) throw error;
    if (controller.signal.aborted) return { ok: false, reason: 'TIMEOUT' };
    if (error.code === AI_ERROR_CODES.AI_CANCELLED) throw error;
    if (error.code === AI_ERROR_CODES.AI_TIMEOUT) return { ok: false, reason: 'TIMEOUT' };
    return { ok: false, reason: error.details?.reason === 'EMPTY_COMPLETION' ? 'EMPTY' : 'PROVIDER' };
  } finally {
    clearTimeout(timer);
  }
  onRound?.({ startedAt, budget, result });
  if (result.finishReason === 'length') return { ok: false, reason: 'LENGTH' };
  if (!String(result.text || '').trim()) return { ok: false, reason: 'EMPTY' };
  try {
    const parsed = parseCompositionResponse(result.text);
    if (!parsed) return { ok: false, reason: 'INVALID', issue: 'SHAPE_INVALID' };
    const validated = validateComposition(composition, parsed);
    if (!validated.ok) return { ok: false, reason: 'INVALID', issue: validated.issues[0] };
    const rendered = renderComposition(composition, validated);
    return rendered.text.trim() ? { ok: true, ...rendered } : { ok: false, reason: 'INVALID', issue: 'EMPTY_RENDER' };
  } catch {
    // Doğrulayıcının beklenmeyen hatası doğrulanmış yanıtı düşürmez; belirlenimci anlatım gösterilir.
    return { ok: false, reason: 'INTERNAL' };
  }
}
