import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { createEventStreamParser } from '../../../domain/ai/eventStreamParser.js';
import { AiError } from '../aiErrors.js';

/**
 * OpenAI uyumlu akışlı sohbet yanıtının (Server-Sent Events) SINIRLI çözümü.
 *
 * Ağ parçaları olay sınırlarına denk gelmez: bir satır birden çok parçaya
 * bölünebilir, bir parça birden çok olay taşıyabilir, çok baytlı bir UTF-8
 * karakteri iki parçaya ayrılabilir. Baytlar akış kipindeki tek bir UTF-8
 * çözücüden geçer; satırlar yalnızca YENİ gelen metinde aranır.
 *
 * Bellek sınırlıdır: tamamlanmamış satır ve olay, ham akışın toplamı ve
 * biriken yanıt metni için ayrı üst sınırlar vardır; aşılırsa akış
 * sınıflandırılmış bir hatayla kesilir. Ham parçalar ve olay gövdeleri hiçbir
 * yere yazılmaz: istem ya da yanıt içeriği taşıyabilirler.
 *
 * Sağlayıcının akıl yürütme alanları (`reasoning_content`, `reasoning`) ve
 * yanıtın başındaki `<think>…</think>` bloğu kullanıcıya dönen metne GİRMEZ;
 * yalnızca "düşünüyor" evresi bildirilir.
 */

export const AI_STREAM_LIMITS = Object.freeze({
  /** Tamamlanmamış tek satırın ya da tek olayın en büyük uzunluğu (karakter). */
  maxEventChars: 256 * 1024,
  /** Ham akışın toplam bayt sınırı. */
  maxStreamBytes: 8 * 1024 * 1024,
  /** Kullanıcıya dönen birikmiş yanıt metninin sınırı (karakter). */
  maxTextChars: 64000
});

const MAX_REPORTED_MODEL_LENGTH = 512;
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function invalid(reason) {
  return new AiError(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, { details: { reason } });
}

/** Yanıt başladıktan sonra kesilen akış: sağlayıcı ya da ağ yanıtı tamamlamadı. */
export function streamInterrupted(reason = 'STREAM_INTERRUPTED') {
  return new AiError(AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, {
    message: 'Yapay zekâ yanıtı tamamlanmadan bağlantı kesildi.',
    details: { reason }
  });
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function reportedModel(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.length > MAX_REPORTED_MODEL_LENGTH) throw invalid('MODEL_ID_TOO_LONG');
  return value;
}

/** Sağlayıcı akışının SSE çözücüsü; satır/olay kuralları ortak saf modüldedir. */
export function createSseEventParser({ maxEventChars = AI_STREAM_LIMITS.maxEventChars } = {}) {
  return createEventStreamParser({ maxEventChars, tooLarge: () => invalid('STREAM_EVENT_TOO_LARGE') });
}

/**
 * Yanıtın BAŞINDAKİ `<think>…</think>` bloğunu ayıklar (akıl yürütmeyi metin
 * içinde gönderen modeller). Etiketler parçalar arasında bölünebilir; bellek
 * sınırlıdır (blok içinde yalnızca kapanış etiketini yakalayacak kadar metin
 * tutulur). Görünür yanıtın baştaki boşlukları atılır.
 */
export function createLeadingThinkFilter() {
  let phase = 'start';
  let buffer = '';

  function visible(text) {
    if (phase === 'leading') {
      const trimmed = text.replace(/^\s+/, '');
      if (!trimmed) return '';
      phase = 'open';
      return trimmed;
    }
    return text;
  }

  return {
    get thinking() {
      return phase === 'thinking';
    },

    push(text) {
      if (phase === 'open' || phase === 'leading') return visible(text);
      buffer += text;
      if (phase === 'start') {
        const trimmed = buffer.replace(/^\s+/, '');
        if (!trimmed) return '';
        if (trimmed.length < THINK_OPEN.length && THINK_OPEN.startsWith(trimmed)) return '';
        if (!trimmed.startsWith(THINK_OPEN)) {
          buffer = '';
          phase = 'open';
          return trimmed;
        }
        phase = 'thinking';
        buffer = trimmed.slice(THINK_OPEN.length);
      }
      const close = buffer.indexOf(THINK_CLOSE);
      if (close < 0) {
        buffer = buffer.slice(-(THINK_CLOSE.length - 1));
        return '';
      }
      const rest = buffer.slice(close + THINK_CLOSE.length);
      buffer = '';
      phase = 'leading';
      return visible(rest);
    },

    /** Akış sonu: yalnızca `<think` önekine benzeyen ama tamamlanmayan baş metin görünürdür. */
    end() {
      if (phase !== 'start') return '';
      const trimmed = buffer.replace(/^\s+/, '');
      buffer = '';
      phase = 'open';
      return trimmed;
    }
  };
}

/**
 * Tek bir akış olayının yükünü yorumlar. Tanınmayan alanlar zararsızdır ve yok
 * sayılır; beklenen alanların türü yanlışsa olay bozuktur.
 */
function interpretChunk(payload, state) {
  if (!isPlainObject(payload)) throw invalid('STREAM_EVENT_MALFORMED');
  // Bazı ağ geçitleri akış ortasındaki hatayı veri olayı olarak gönderir; gövde okunmaz.
  if (payload.error != null) throw streamInterrupted('STREAM_ERROR_EVENT');
  if (state.model == null) state.model = reportedModel(payload.model);
  if (payload.usage != null) {
    if (!isPlainObject(payload.usage)) throw invalid('STREAM_EVENT_MALFORMED');
    state.usage = {
      promptTokens: tokenCount(payload.usage.prompt_tokens),
      completionTokens: tokenCount(payload.usage.completion_tokens),
      totalTokens: tokenCount(payload.usage.total_tokens)
    };
  }
  if (payload.choices == null) return { content: null, reasoning: false };
  if (!Array.isArray(payload.choices)) throw invalid('STREAM_EVENT_MALFORMED');
  const choice = payload.choices.find((entry) => entry?.index === 0) ?? payload.choices[0];
  if (choice == null) return { content: null, reasoning: false };
  if (!isPlainObject(choice)) throw invalid('STREAM_EVENT_MALFORMED');
  const delta = choice.delta ?? null;
  if (delta != null && !isPlainObject(delta)) throw invalid('STREAM_EVENT_MALFORMED');
  // İsteği yankılayan bir vekilin `user` iletisi model yanıtı sayılmaz.
  if (delta?.role != null && delta.role !== 'assistant') throw invalid('INVALID_ROLE');
  if (delta?.content != null && typeof delta.content !== 'string') throw invalid('STREAM_EVENT_MALFORMED');
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) state.finishReason = choice.finish_reason.slice(0, 40);
  const reasoning = [delta?.reasoning_content, delta?.reasoning].some((value) => typeof value === 'string' && value.length > 0);
  return { content: delta?.content ?? null, reasoning };
}

/**
 * Akışlı yanıtı olay dizisine çevirir: `{ type: 'text', text }`,
 * `{ type: 'reasoning' }` ve en sonda tek `{ type: 'done', finishReason,
 * model, usage }`. `[DONE]` gelince okuma durur ve bağlantı bırakılır. Akış
 * `[DONE]` ya da bitiş nedeni olmadan biterse yanıt KESİLMİŞTİR.
 */
export async function* readChatCompletionStream(body, { signal = null, limits = AI_STREAM_LIMITS } = {}) {
  const reader = body?.getReader?.();
  if (!reader) throw invalid('EMPTY_RESPONSE');
  const decoder = new TextDecoder('utf-8');
  const parser = createSseEventParser({ maxEventChars: limits.maxEventChars });
  const think = createLeadingThinkFilter();
  const state = { model: null, usage: null, finishReason: null, bytes: 0, textChars: 0 };
  let completed = false;

  const emit = function* (text, reasoning) {
    if (reasoning || think.thinking) yield { type: 'reasoning' };
    if (!text) return;
    state.textChars += text.length;
    if (state.textChars > limits.maxTextChars) throw invalid('STREAM_TEXT_TOO_LARGE');
    yield { type: 'text', text };
  };

  function* handle(events) {
    for (const event of events) {
      if (event.data === '[DONE]') {
        completed = true;
        return;
      }
      if (event.event === 'error') throw streamInterrupted('STREAM_ERROR_EVENT');
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        throw invalid('STREAM_EVENT_MALFORMED');
      }
      const { content, reasoning } = interpretChunk(payload, state);
      yield* emit(content == null ? '' : think.push(content), reasoning);
    }
  }

  try {
    while (!completed) {
      let step;
      try {
        step = await reader.read();
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw streamInterrupted();
      }
      if (step.done) break;
      state.bytes += step.value.byteLength;
      if (state.bytes > limits.maxStreamBytes) throw invalid('STREAM_TOO_LARGE');
      yield* handle(parser.push(decoder.decode(step.value, { stream: true })));
    }
    if (!completed) {
      yield* handle(parser.push(decoder.decode()));
      // Son boş satırı göndermeden kapanan akışın bekleyen verisi yalnızca `[DONE]` olabilir.
      if (!completed && parser.end() === '[DONE]') completed = true;
      if (!completed && state.finishReason) completed = true;
      if (!completed) throw streamInterrupted('STREAM_TRUNCATED');
    }
    yield* emit(think.end(), false);
    yield { type: 'done', finishReason: state.finishReason, model: state.model, usage: state.usage };
  } finally {
    // Erken bitişte (DONE, sınır aşımı, iptal) sağlayıcı bağlantısı bırakılır.
    reader.cancel().catch(() => {});
  }
}
