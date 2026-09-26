import {
  ASSISTANT_LIMITS,
  ASSISTANT_PROTOCOL_VERSION,
  ASSISTANT_STREAM_EVENTS,
  ASSISTANT_STREAM_PHASES,
  isAssistantId
} from '../../../domain/ai/assistantContract.js';
import { createEventStreamParser } from '../../../domain/ai/eventStreamParser.js';
import { publicRotaPath } from '../../../lib/publicPath.js';
import { requestJson } from '../../shared/jsonRequest.js';

/**
 * Rota AI uçlarının istemci sarmalayıcısı.
 *
 * Tarayıcı yalnızca MERGEN Rota sunucusuyla konuşur ve yalnızca Rota akış
 * protokolünü çözer; sağlayıcının tel biçimini hiç görmez. Model adı, profil,
 * Sicil ya da anahtar gönderilmez: tur isteği yalnızca konuşma kimliği, tur
 * kimliği, ileti ve kullanıcıya dönük kip taşır.
 *
 * Her sonuç aynı biçimdedir: başarıda `{ ok: true, ... }`, aksi hâlde
 * `{ ok: false, code, message, reason, retryable, partial, cancelled, ... }`.
 * Beklenen biçimi taşımayan yanıt (ör. vekilin 200 dönen HTML sayfası) başarı
 * sayılmaz.
 */

const BASE = '/api/mergen-rota/ai/assistant';
/** Sunucu 15 sn'de bir canlı tutma gönderir; bu süre boyunca hiç bayt gelmezse bağlantı kopmuş sayılır. */
export const ASSISTANT_STREAM_INACTIVITY_MS = 45000;
/** Tek olayın istemci üst sınırı (kayıtlı yanıtın yeniden oynatılması tek olaydır). */
const MAX_STREAM_EVENT_CHARS = 1024 * 1024;
export const ASSISTANT_INVALID_RESPONSE = 'INVALID_RESPONSE';

const KNOWN_EVENTS = new Set(Object.values(ASSISTANT_STREAM_EVENTS));
const KNOWN_PHASES = new Set(Object.values(ASSISTANT_STREAM_PHASES));

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isConversation(value) {
  return isPlainObject(value) && isAssistantId(value.id) && typeof value.title === 'string';
}

function isMessage(value) {
  return isPlainObject(value) && isAssistantId(value.id)
    && (value.role === 'user' || value.role === 'assistant')
    && Number.isFinite(value.sequence);
}

function isStoredMessage(value) {
  return isMessage(value) && typeof value.content === 'string';
}

function isReadiness(value) {
  return isPlainObject(value) && typeof value.available === 'boolean' && Array.isArray(value.modes)
    && value.modes.every((mode) => isPlainObject(mode) && typeof mode.id === 'string' && typeof mode.available === 'boolean')
    && isPlainObject(value.limits) && Number.isFinite(value.limits.maxMessageChars);
}

async function expectPayload(pending, isValid) {
  const response = await pending;
  if (!response.ok || isValid(response)) return response;
  return { ok: false, code: ASSISTANT_INVALID_RESPONSE, message: null };
}

/* ── JSON uçları ─────────────────────────────────────────────── */

export function loadAssistantReadinessRequest(options = {}) {
  return expectPayload(requestJson(BASE, { method: 'GET' }, options), (response) => isReadiness(response.assistant));
}

export function listAssistantConversationsRequest({ cursor = null, ...options } = {}) {
  const path = cursor ? `${BASE}/conversations/before/${encodeURIComponent(cursor)}` : `${BASE}/conversations`;
  return expectPayload(requestJson(path, { method: 'GET' }, options), (response) => Array.isArray(response.conversations)
    && response.conversations.every(isConversation)
    && (response.nextCursor == null || typeof response.nextCursor === 'string'));
}

export function loadAssistantConversationRequest(conversationId, options = {}) {
  return expectPayload(
    requestJson(`${BASE}/conversations/${encodeURIComponent(conversationId)}`, { method: 'GET' }, options),
    (response) => isConversation(response.conversation) && response.conversation.id === conversationId
      && Array.isArray(response.messages) && response.messages.every(isStoredMessage)
  );
}

export function deleteAssistantConversationRequest(conversationId, options = {}) {
  return expectPayload(
    requestJson(`${BASE}/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }, options),
    (response) => response.deleted === true
  );
}

/* ── Akış protokolü ──────────────────────────────────────────── */

class AssistantProtocolError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'AssistantProtocolError';
    this.reason = reason;
  }
}

function interpret({ event, data }) {
  // İleriye uyumluluk: tanınmayan olay yok sayılır.
  if (!KNOWN_EVENTS.has(event)) return null;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new AssistantProtocolError('MALFORMED_EVENT');
  }
  if (!isPlainObject(payload)) throw new AssistantProtocolError('MALFORMED_EVENT');
  switch (event) {
    case ASSISTANT_STREAM_EVENTS.ACCEPTED:
      if (payload.v !== ASSISTANT_PROTOCOL_VERSION) throw new AssistantProtocolError('PROTOCOL_VERSION');
      if (!isConversation(payload.conversation) || (!isStoredMessage(payload.userMessage) || payload.userMessage.role !== 'user')) throw new AssistantProtocolError('MALFORMED_EVENT');
      break;
    case ASSISTANT_STREAM_EVENTS.STATUS:
      if (typeof payload.phase !== 'string') throw new AssistantProtocolError('MALFORMED_EVENT');
      if (!KNOWN_PHASES.has(payload.phase)) return null;
      break;
    case ASSISTANT_STREAM_EVENTS.DELTA:
      if (typeof payload.text !== 'string') throw new AssistantProtocolError('MALFORMED_EVENT');
      break;
    case ASSISTANT_STREAM_EVENTS.DONE:
      if (!isConversation(payload.conversation) || (!isMessage(payload.assistantMessage) || payload.assistantMessage.role !== 'assistant')) throw new AssistantProtocolError('MALFORMED_EVENT');
      break;
    default:
      if (typeof payload.code !== 'string' || typeof payload.message !== 'string') throw new AssistantProtocolError('MALFORMED_EVENT');
  }
  return { type: event, data: payload };
}

/**
 * Rota akış protokolünün çözücüsü (saf; ağdan bağımsız sınanır).
 *
 * `push(text)` doğrulanmış olayları döndürür. Protokol kuralları: ilk olay
 * `accepted` (ya da doğrudan `error`) olmalıdır; `done`/`error`
 * sonlandırıcıdır ve sonrasındaki her şey yok sayılır; yanıt metni üst sınırı
 * aşamaz. Bozuk olay `AssistantProtocolError` fırlatır.
 */
export function createAssistantStreamDecoder({ maxEventChars = MAX_STREAM_EVENT_CHARS, maxAnswerChars = ASSISTANT_LIMITS.maxAnswerChars } = {}) {
  const parser = createEventStreamParser({ maxEventChars, tooLarge: () => new AssistantProtocolError('EVENT_TOO_LARGE') });
  const state = { accepted: false, terminal: null, answerChars: 0 };

  function accept(raw) {
    const event = interpret(raw);
    if (!event || state.terminal) return null;
    const terminal = event.type === ASSISTANT_STREAM_EVENTS.DONE || event.type === ASSISTANT_STREAM_EVENTS.ERROR;
    if (!state.accepted && event.type !== ASSISTANT_STREAM_EVENTS.ACCEPTED && event.type !== ASSISTANT_STREAM_EVENTS.ERROR) {
      throw new AssistantProtocolError('UNEXPECTED_EVENT');
    }
    if (event.type === ASSISTANT_STREAM_EVENTS.ACCEPTED) {
      if (state.accepted) throw new AssistantProtocolError('UNEXPECTED_EVENT');
      state.accepted = true;
    }
    if (event.type === ASSISTANT_STREAM_EVENTS.DELTA) {
      state.answerChars += event.data.text.length;
      if (state.answerChars > maxAnswerChars) throw new AssistantProtocolError('ANSWER_TOO_LARGE');
    }
    if (terminal) state.terminal = event;
    return event;
  }

  return {
    get terminal() {
      return state.terminal;
    },
    get accepted() {
      return state.accepted;
    },
    push(text) {
      return parser.push(text).map(accept).filter(Boolean);
    },
    /** Akış sonu; sonlandırıcı olay gelmediyse `null` döner (yanıt yarıda kesildi). */
    end() {
      parser.end();
      return state.terminal;
    }
  };
}

function errorFields(body) {
  const error = isPlainObject(body?.error) ? body.error : {};
  const details = isPlainObject(error.details) ? error.details : {};
  return {
    code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
    message: typeof error.message === 'string' ? error.message : null,
    reason: typeof details.reason === 'string' ? details.reason : null,
    retryable: details.retryable === true,
    retryAfterMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : null,
    credentialSource: typeof details.credentialSource === 'string' ? details.credentialSource : null
  };
}

/**
 * Bir turu akış olarak gönderir.
 *
 * `onEvent({ type, data })` her doğrulanmış olay için çağrılır. `signal`
 * (Durdur) kesilince tarayıcı isteği kesilir; sunucu `request.signal` ile
 * sağlayıcıya kadar iptal eder. Sonuç: `{ ok: true, done }` ya da kararlı hata
 * biçimi (`cancelled`: kullanıcı durdurdu; `partial`: metin gelmeye başlamıştı).
 * Sunucudan belirli süre boyunca hiç bayt (canlı tutma dâhil) gelmezse bağlantı
 * kopmuş sayılır (`STREAM_STALLED`).
 */
export async function streamAssistantTurnRequest({
  conversationId = null,
  turnId,
  message = null,
  mode,
  signal = null,
  onEvent = null,
  inactivityMs = ASSISTANT_STREAM_INACTIVITY_MS
}) {
  const controller = new AbortController();
  let abortCause = signal?.aborted ? 'caller' : null;
  let partial = false;
  let watchdog = null;
  const abort = (cause) => {
    if (!abortCause) abortCause = cause;
    controller.abort();
  };
  const onCallerAbort = () => abort('caller');
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => abort('stalled'), inactivityMs);
  };
  const cleanup = () => {
    clearTimeout(watchdog);
    signal?.removeEventListener?.('abort', onCallerAbort);
  };
  const failure = (code, extra = {}) => ({
    ok: false, code, message: null, reason: null, retryable: false, partial, cancelled: false, ...extra
  });
  const connectionFailure = () => {
    if (abortCause === 'caller') return failure('REQUEST_CANCELLED', { cancelled: true });
    if (abortCause === 'stalled') return failure('STREAM_STALLED', { retryable: true });
    return failure('NETWORK', { retryable: true });
  };

  arm();
  let response;
  try {
    response = await fetch(publicRotaPath(`${BASE}/turns`), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ conversationId, turnId, message, mode }),
      signal: controller.signal
    });
  } catch {
    cleanup();
    return connectionFailure();
  }

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') {
        cleanup();
        return connectionFailure();
      }
    }
    cleanup();
    const fields = errorFields(body);
    if (typeof body?.error?.details?.retryable !== 'boolean') {
      fields.retryable = response.status >= 500 || response.status === 429;
    }
    return { ...failure('REQUEST_FAILED'), ...fields, status: response.status, phase: 'request' };
  }

  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('text/event-stream') || !response.body) {
    response.body?.cancel().catch(() => {});
    cleanup();
    return failure(ASSISTANT_INVALID_RESPONSE, { retryable: true });
  }

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const decoder = createAssistantStreamDecoder();
  try {
    while (!decoder.terminal) {
      let step;
      try {
        step = await reader.read();
      } catch {
        return connectionFailure();
      }
      if (step.done) break;
      arm();
      for (const event of decoder.push(textDecoder.decode(step.value, { stream: true }))) {
        if (event.type === ASSISTANT_STREAM_EVENTS.DELTA && event.data.text) partial = true;
        onEvent?.(event);
      }
    }
    if (!decoder.terminal) {
      for (const event of decoder.push(textDecoder.decode())) onEvent?.(event);
      decoder.end();
    }
  } catch (error) {
    if (!(error instanceof AssistantProtocolError)) throw error;
    abort('protocol');
    return failure('PROTOCOL_ERROR', { reason: error.reason, retryable: true });
  } finally {
    cleanup();
    reader.cancel().catch(() => {});
  }

  const terminal = decoder.terminal;
  if (terminal?.type === ASSISTANT_STREAM_EVENTS.DONE) return { ok: true, done: terminal.data, partial };
  if (terminal?.type === ASSISTANT_STREAM_EVENTS.ERROR) {
    const data = terminal.data;
    return {
      ...failure(data.code),
      message: data.message,
      reason: data.reason ?? null,
      retryable: data.retryable === true,
      retryAfterMs: Number.isFinite(data.retryAfterMs) ? data.retryAfterMs : null,
      credentialSource: data.credentialSource ?? null,
      partial: data.partial === true || partial,
      cancelled: data.code === 'AI_CANCELLED',
      phase: 'stream'
    };
  }
  if (abortCause) return connectionFailure();
  return failure('STREAM_INTERRUPTED', { retryable: true });
}
