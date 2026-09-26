import 'server-only';
import { AI_ERROR_CODES, aiErrorDefinition, isAiErrorCode } from '../../../domain/ai/aiErrorCatalog.js';
import {
  ASSISTANT_PROTOCOL_HEADER,
  ASSISTANT_PROTOCOL_VERSION,
  ASSISTANT_STREAM_EVENTS
} from '../../../domain/ai/assistantContract.js';
import { COMPONENTS, EVENT_SEVERITIES } from '../../../domain/observability/eventModel.js';
import { ServerPersistenceError } from '../../errors.js';
import { logEvent } from '../../observability/structuredLogger.js';
import { generateAssistantAnswer } from './assistantService.js';

/**
 * Rota AI akış yanıtı (tarayıcıya giden sürümlü protokol).
 *
 * Biçim Server-Sent Events'tir ve `fetch` ile okunur (POST gövdesi gerektiği
 * için `EventSource` kullanılmaz). Olaylar: `accepted` (istek kabul edildi,
 * kullanıcı iletisi kaydedildi), `status` (gerçek evre geçişi), `delta` (görünür
 * yanıt metni), `done` (yanıt tamamlandı VE kaydedildi) ya da `error`. Her akış
 * tam olarak bir sonlandırıcı olayla biter. Sağlayıcının tel biçimi, model adı,
 * anahtar, adres ve akıl yürütme metni hiçbir olayda bulunmaz.
 *
 * Geri basınç: kuyruk doluysa (yavaş istemci) sonraki metin parçası kuyrukta
 * yer açılana kadar bekletilir; bu bekleme ağ geçidinin süre sınırına bağlıdır.
 * Böylece sunucu belleğinde okunmamış sınırsız çıktı birikmez.
 *
 * Canlı tutma: yavaş bir model ilk metni üretirken (ya da yalnızca akıl
 * yürütürken) bağlantı ve ters vekil sessiz kalmasın diye aralıklarla SSE
 * YORUM satırı (`: keepalive`) gönderilir. Yorum veri taşımaz, istemci onu
 * gösterilecek metin ya da ilerleme saymaz; zamanlayıcı akış bitince durur.
 */

export const ASSISTANT_KEEPALIVE_MS = 15000;
/** Kuyruktaki en fazla olay (tek olay en fazla bir sağlayıcı parçası kadardır). */
const QUEUE_HIGH_WATER_MARK = 32;
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
    length: message.content.length
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
  } else {
    logEvent({
      severity: EVENT_SEVERITIES.ERROR,
      component: COMPONENTS.AI,
      operation: 'ai.assistant.turn',
      code: AI_ERROR_CODES.AI_INTERNAL_ERROR,
      message: 'Rota AI akışında beklenmeyen hata.',
      error
    });
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
    context: turn.context
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
  generate = generateAssistantAnswer
} = {}) {
  const cancelled = new AbortController();
  const generationSignal = AbortSignal.any([cancelled.signal, turn.claim.signal, ...(signal ? [signal] : [])]);
  let controller = null;
  let closed = false;
  let waiting = null;
  let textSent = false;

  const wake = () => {
    const pending = waiting;
    waiting = null;
    pending?.();
  };

  const enqueue = (bytes) => {
    if (closed) return false;
    try {
      controller.enqueue(bytes);
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const send = (event, data) => enqueue(frame(event, data));

  /** Kuyrukta yer açılana (ya da akış kapanana) kadar bekler; üretim sinyali bu beklemeyi de keser. */
  async function sendWhenReady(event, data) {
    while (!closed && controller.desiredSize <= 0 && !generationSignal.aborted) {
      await new Promise((resolve) => {
        waiting = resolve;
      });
    }
    return send(event, data);
  }

  async function run() {
    const keepalive = setInterval(() => {
      if (!closed && controller.desiredSize > 0) enqueue(KEEPALIVE);
    }, keepaliveMs);
    keepalive.unref?.();
    const onAbort = () => wake();
    generationSignal.addEventListener('abort', onAbort, { once: true });
    try {
      send(ASSISTANT_STREAM_EVENTS.ACCEPTED, acceptedPayload(turn));
      if (turn.replay) {
        textSent = send(ASSISTANT_STREAM_EVENTS.DELTA, { text: turn.replay.content });
        send(ASSISTANT_STREAM_EVENTS.DONE, {
          conversation: turn.conversation,
          assistantMessage: messageView(turn.replay, { includeContent: false }),
          replayed: true
        });
        return;
      }
      const result = await generate(turn, {
        signal: generationSignal,
        onStatus: (status) => send(ASSISTANT_STREAM_EVENTS.STATUS, { phase: status.phase }),
        onText: async (text) => {
          textSent = true;
          await sendWhenReady(ASSISTANT_STREAM_EVENTS.DELTA, { text });
        }
      });
      send(ASSISTANT_STREAM_EVENTS.DONE, {
        conversation: result.conversation,
        assistantMessage: messageView(result.answer, { includeContent: false }),
        replayed: false
      });
    } catch (error) {
      send(ASSISTANT_STREAM_EVENTS.ERROR, assistantStreamErrorPayload(error, { partial: textSent }));
    } finally {
      clearInterval(keepalive);
      generationSignal.removeEventListener('abort', onAbort);
      turn.claim.release();
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // İptal edilmiş akış zaten kapalıdır.
        }
      }
      // Süre sınırıyla terk edilmiş bir geri basınç beklemesi askıda kalmaz.
      wake();
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
