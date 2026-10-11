import 'server-only';
import { AI_ERROR_CODES, aiErrorDefinition, isAiErrorCode } from '../../../domain/ai/aiErrorCatalog.js';
import {
  ASSISTANT_PROTOCOL_HEADER,
  ASSISTANT_PROTOCOL_VERSION,
  ASSISTANT_STREAM_EVENTS,
  ASSISTANT_TOOL_TOPICS,
  ASSISTANT_TIMING,
  assistantGenerationStallMs
} from '../../../domain/ai/assistantContract.js';
import { ServerPersistenceError } from '../../errors.js';
import { AiError } from '../aiErrors.js';
import { readAiConfig } from '../aiConfig.js';
import { recordAssistantTurn } from '../aiTelemetry.js';
import { discloseAssistantMessage, generateAssistantAnswer } from './assistantService.js';

/**
 * Rota AI akış yanıtı (tarayıcıya giden sürümlü protokol).
 *
 * Biçim Server-Sent Events'tir ve `fetch` ile okunur (POST gövdesi gerektiği
 * için `EventSource` kullanılmaz). Olaylar: `accepted` (istek kabul edildi,
 * kullanıcı iletisi kaydedildi), `status` (gerçek evre geçişi; Rota verisi
 * okunurken yalnızca veri alanı konusu), `delta` (görünür yanıt metni), `revise`
 * (o ana kadar gösterilen taslak geçersiz; kanıta dayalı yol), `done` (yanıt
 * tamamlandı VE kaydedildi) ya da `error`. Her akış tam olarak bir sonlandırıcı
 * olayla biter. Sağlayıcının tel biçimi, model adı, anahtar, adres, araç adı,
 * araç bağımsız değişkeni, SQL ve akıl yürütme metni hiçbir olayda bulunmaz.
 *
 * Geri basınç: kuyruk doluysa (yavaş istemci) sonraki metin parçası kuyrukta
 * yer açılana kadar bekletilir; bu bekleme ağ geçidinin süre sınırına bağlıdır.
 * Böylece sunucu belleğinde okunmamış sınırsız çıktı birikmez.
 *
 * Canlı tutma ile ilerleme AYRIDIR. Bağlantı ve ters vekil sessiz kalmasın diye
 * aralıklarla SSE YORUM satırı (`: keepalive`) gönderilir; yorum veri taşımaz ve
 * istemci onu ilerleme saymaz. Gerçek ilerleme (evre, metin, sağlayıcı ya da araç
 * olayı) seyrekleştirilmiş `progress` olayıyla bildirilir. Belirli süre hiç
 * ilerlemeyen üretim sunucuda kesilir; kesilen üretim sinyale uymasa da kısa bir
 * süre sonra tur sonlandırılır, üretim hakkı ve kaynaklar bırakılır. Son yanıtın
 * teslimi de sınırlıdır: okumayan istemci turu tutamaz.
 */

export const ASSISTANT_KEEPALIVE_MS = 15000;
/** `progress` olayları arasındaki en kısa süre (ilerleme varken). */
export const ASSISTANT_PROGRESS_EVENT_MS = ASSISTANT_TIMING.progressEventMs;
/** Hiç ilerlemeyen üretimin kesildiği süre (sağlayıcının ilerleme sınırlarından uzun). */
export const ASSISTANT_GENERATION_STALL_MS = 90000;
/** Kesilen üretimin kendiliğinden bitmesi için beklenen süre (yanıt yazımı bütçesinden uzun). */
export const ASSISTANT_STALL_GRACE_MS = ASSISTANT_TIMING.stallGraceMs;
/** Okumayan istemcinin kuyrukta yer açması için beklenen en uzun süre. */
export const ASSISTANT_DELIVERY_TIMEOUT_MS = 20000;
/** Kuyruktaki en fazla olay (tek olay en fazla bir sağlayıcı parçası kadardır). */
export const QUEUE_HIGH_WATER_MARK = 32;
const RETRYABLE_SERVER_CODES = new Set(['DATABASE_UNAVAILABLE']);

const encoder = new TextEncoder();
const KEEPALIVE = encoder.encode(': keepalive\n\n');

function frame(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function messageView(message, { includeContent = true } = {}) {
  if (!message) return null;
  const view = {
    id: message.id,
    sequence: message.sequence,
    role: message.role,
    turnId: message.turnId,
    replyToId: message.replyToId,
    mode: message.mode,
    finishReason: message.finishReason,
    createdAt: message.createdAt,
    length: message.content.length,
    // Kanıta dayalı yanıtın kanıt özetleri (yalnızca güvenli künye; bkz. evidenceContract).
    ...(Array.isArray(message.evidence) ? { evidence: message.evidence } : {})
  };
  return includeContent ? { ...view, content: message.content } : view;
}

/**
 * Sonlandırıcı hata olayının gövdesi: kararlı kod, güvenli ileti ve yalnızca
 * sunumun ihtiyaç duyduğu ayrıntılar. Beklenmeyen hata ayrıntısı taşınmaz.
 */
export function assistantStreamErrorPayload(error, { partial = false } = {}) {
  let code;
  let message;
  let details = {};
  let retryable;
  if (error instanceof ServerPersistenceError) {
    code = error.code;
    message = error.message;
    details = error.details || {};
    retryable = isAiErrorCode(code) ? aiErrorDefinition(code).retryable : RETRYABLE_SERVER_CODES.has(code);
    // Boş yanıt modelin rastlantısal sonucudur; tur kaydedilmediği için soru yeniden sorulabilir.
    if (code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID && details.reason === 'EMPTY_COMPLETION' && !partial) retryable = true;
  } else {
    // Beklenmeyen hata burada yalnızca güvenli kullanıcı sonucuna çevrilir.
    // İşletim günlüğünü recordAssistantTurn tek kez yazar.
    const definition = aiErrorDefinition(AI_ERROR_CODES.AI_INTERNAL_ERROR);
    code = definition.code;
    message = definition.message;
    retryable = false;
  }
  return {
    code,
    message,
    reason: typeof details.reason === 'string' ? details.reason : null,
    retryable: Boolean(retryable),
    retryAfterMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : null,
    credentialSource: typeof details.credentialSource === 'string' ? details.credentialSource : null,
    partial: Boolean(partial)
  };
}

function acceptedPayload(turn) {
  return {
    v: ASSISTANT_PROTOCOL_VERSION,
    conversation: turn.conversation,
    userMessage: messageView(turn.userMessage),
    mode: turn.mode,
    replay: Boolean(turn.replay),
    context: turn.context,
    // Tur yetkili Rota verisi araçlarıyla yanıtlanıyor (kanıta dayalı yol).
    ...(turn.grounded ? { rotaData: true } : {})
  };
}

/**
 * Hazırlanmış tur için akış yanıtı. `signal` isteğin kendi sinyalidir;
 * tarayıcı bağlantıyı keserse (Durdur) ya da okuyucu akışı iptal ederse
 * üretim sağlayıcıya kadar iptal edilir, kapasite bırakılır ve tamamlanmamış
 * yanıt yazılmaz.
 */
export function assistantStreamResponse(turn, {
  signal = null,
  keepaliveMs = ASSISTANT_KEEPALIVE_MS,
  progressEventMs = ASSISTANT_PROGRESS_EVENT_MS,
  stallMs = assistantGenerationStallMs(readAiConfig()),
  graceMs = ASSISTANT_STALL_GRACE_MS,
  deliveryTimeoutMs = ASSISTANT_DELIVERY_TIMEOUT_MS,
  generate = generateAssistantAnswer
} = {}) {
  const cancelled = new AbortController();
  const generationSignal = AbortSignal.any([cancelled.signal, ...(turn.claim ? [turn.claim.signal] : []), ...(signal ? [signal] : [])]);
  let controller = null;
  let closed = false;
  let waiting = null;
  let textSent = false;
  let terminal = false;
  let finished = false;
  let stalled = null;
  let lastProgressAt = performance.now();
  let lastProgressSentAt = performance.now();
  let lastByteAt = performance.now();
  let graceTimer = null;
  let delivering = false;

  const wake = () => {
    const pending = waiting;
    waiting = null;
    pending?.();
  };

  const enqueue = (bytes) => {
    if (closed) return false;
    try {
      controller.enqueue(bytes);
      lastByteAt = performance.now();
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const send = (event, data) => enqueue(frame(event, data));
  const finalEvent = (event, data) => {
    if (terminal) return false;
    terminal = true;
    return send(event, data);
  };

  /**
   * Gerçek ilerleme: gözcüyü yeniler ve en fazla `progressEventMs` aralıkla
   * istemciye bildirilir. Evre ya da metin olayı zaten görünür ilerlemedir.
   */
  const progress = ({ visible = false } = {}) => {
    const now = performance.now();
    lastProgressAt = now;
    if (visible) lastProgressSentAt = now;
    else if (!terminal && !delivering && now - lastProgressSentAt >= progressEventMs) {
      lastProgressSentAt = now;
      send(ASSISTANT_STREAM_EVENTS.PROGRESS, {});
    }
  };

  /** Akışı kapatır ve üretim hakkını bırakır; her yolda yalnızca bir kez etkilidir. */
  let released = false;
  const close = () => {
    if (!released) {
      released = true;
      turn.claim?.release();
    }
    if (!closed) {
      closed = true;
      try {
        controller.close();
      } catch {
        // İptal edilmiş akış zaten kapalıdır.
      }
    }
    wake();
  };

  /**
   * İlerlemeyen üretim kesilir. Üretim sinyale uyup kısa sürede biter; uymasa da
   * süre sonunda tur hata olayıyla sonlandırılır ve üretim hakkı bırakılır.
   */
  const stall = (reason) => {
    if (stalled || finished) return;
    stalled = new AiError(AI_ERROR_CODES.AI_TIMEOUT, { details: { reason } });
    cancelled.abort(stalled);
    wake();
    graceTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      finalEvent(ASSISTANT_STREAM_EVENTS.ERROR, assistantStreamErrorPayload(stalled, { partial: textSent }));
      close();
    }, graceMs);
    graceTimer.unref?.();
  };

  /** Kuyrukta yer açılana (ya da akış kapanana) kadar bekler; bekleme sınırlıdır ve üretim sinyali onu da keser. */
  async function waitForCapacity() {
    const startedAt = performance.now();
    while (!closed && controller.desiredSize <= 0 && !generationSignal.aborted) {
      const remaining = deliveryTimeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        // Okumayan istemci turu tutamaz: üretim kesilir, hak bırakılır.
        stall('DELIVERY_STALLED');
        break;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return !closed && !generationSignal.aborted;
  }

  async function sendWhenReady(event, data) {
    return await waitForCapacity() && send(event, data);
  }

  const deliveryFailure = () => stalled || (generationSignal.aborted ? generationSignal.reason : null) || new AiError(AI_ERROR_CODES.AI_CANCELLED);

  // Bekleme erişim denetiminden ÖNCE biter; denetimden sonra hiçbir await yoktur.
  async function deliver(prepare, replayed = false) {
    if (!await waitForCapacity()) throw deliveryFailure();
    delivering = true;
    try {
      const result = await prepare();
      if (generationSignal.aborted || closed || finished || terminal) throw deliveryFailure();
      textSent = send(ASSISTANT_STREAM_EVENTS.DELTA, { text: result.answer.content });
      if (!textSent) throw deliveryFailure();
      finalEvent(ASSISTANT_STREAM_EVENTS.DONE, {
        conversation: result.conversation,
        assistantMessage: messageView(result.answer, { includeContent: result.reconciled === true || result.contentAuthoritative === true }),
        ...(result.reconciled ? { reconciled: true } : {}), replayed
      });
      return result;
    } finally {
      delivering = false;
    }
  }

  async function run() {
    const startedAt = performance.now();
    const tickMs = Math.max(1, Math.min(keepaliveMs, Math.floor(stallMs / 3), 5000));
    const ticker = setInterval(() => {
      const now = performance.now();
      if (!closed && !delivering && now - lastByteAt >= keepaliveMs && controller.desiredSize > 0) enqueue(KEEPALIVE);
      if (now - lastProgressAt >= stallMs) stall('GENERATION_STALLED');
    }, tickMs);
    ticker.unref?.();
    const onAbort = () => wake();
    generationSignal.addEventListener('abort', onAbort, { once: true });
    try {
      send(ASSISTANT_STREAM_EVENTS.ACCEPTED, acceptedPayload(turn));
      if (turn.replay) {
        await deliver(async () => ({ conversation: turn.conversation,
          answer: turn.sicil ? await discloseAssistantMessage(turn, turn.replay, generationSignal) : turn.replay }), true);
        // Kayıtlı yanıtın yeniden oynatılması yeni bir tur değildir: tur sayaçlarına girmez.
        return;
      }
      const result = await generate(turn, {
        signal: generationSignal,
        onStatus: (status) => {
          progress({ visible: true });
          send(ASSISTANT_STREAM_EVENTS.STATUS, {
            phase: status.phase,
            ...(ASSISTANT_TOOL_TOPICS.includes(status.topic) ? { topic: status.topic } : {})
          });
        },
        onProgress: () => progress(),
        onDelivery: deliver,
        onText: async (text) => {
          progress({ visible: true });
          // Yanıt yalnızca metin gerçekten kuyruğa girdiyse "kısmi" sayılır.
          if (await sendWhenReady(ASSISTANT_STREAM_EVENTS.DELTA, { text })) {
            textSent = true;
            return;
          }
          // Teslim edilemeyen metin üretimin sonudur: kesilen ya da kapanan akışta tur yanıtı göstermiş sayılmaz.
          throw stalled || (generationSignal.aborted ? generationSignal.reason : null) || new AiError(AI_ERROR_CODES.AI_CANCELLED);
        },
        // Gösterilen taslak geçersizleşti (araç çağrısına dönüştü ya da doğrulanamadı).
        onRevise: () => {
          if (send(ASSISTANT_STREAM_EVENTS.REVISE, {})) textSent = false;
        }
      });
      if (finished) return;
      if (!terminal && result.reconciled && turn.sicil) {
        await deliver(async () => ({ ...result, answer: await discloseAssistantMessage(turn, result.answer, generationSignal) }));
      }
      if (!terminal) finalEvent(ASSISTANT_STREAM_EVENTS.DONE, {
        conversation: result.conversation,
        assistantMessage: messageView(result.answer, { includeContent: result.reconciled === true || result.contentAuthoritative === true }),
        ...(result.reconciled ? { reconciled: true } : {}),
        replayed: false
      });
      recordAssistantTurn({ durationMs: performance.now() - startedAt });
    } catch (error) {
      const failure = stalled || error;
      const payload = assistantStreamErrorPayload(failure, { partial: textSent });
      recordAssistantTurn({
        code: payload.code,
        error: failure,
        source: payload.credentialSource,
        details: failure?.details ?? null,
        serviceFailure: payload.code === 'DATABASE_UNAVAILABLE',
        durationMs: performance.now() - startedAt
      });
      finalEvent(ASSISTANT_STREAM_EVENTS.ERROR, payload);
    } finally {
      finished = true;
      clearInterval(ticker);
      clearTimeout(graceTimer);
      generationSignal.removeEventListener('abort', onAbort);
      close();
    }
  }

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      run().catch(() => {});
    },
    pull() {
      wake();
    },
    cancel(reason) {
      closed = true;
      cancelled.abort(reason);
      wake();
    }
  }, { highWaterMark: QUEUE_HIGH_WATER_MARK });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      [ASSISTANT_PROTOCOL_HEADER]: String(ASSISTANT_PROTOCOL_VERSION)
    }
  });
}
