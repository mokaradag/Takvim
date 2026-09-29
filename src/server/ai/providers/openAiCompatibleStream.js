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
  maxTextChars: 64000,
  /** Tek yanıtta kabul edilen en fazla araç çağrısı (fazlası yanıtı geçersiz kılar). */
  maxToolCalls: 16,
  /** Araç adının en büyük uzunluğu. */
  maxToolNameChars: 64,
  /** Tek araç çağrısının bağımsız değişken metni; aşan çağrı "aşırı büyük" işaretlenir, metni saklanmaz. */
  maxToolArgumentChars: 32 * 1024
});

const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

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

/** Bildirilen sayaç: yoksa `null`; varsa negatif olmayan tam sayı olmalıdır. */
function tokenCount(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('STREAM_EVENT_MALFORMED');
  return value;
}

/** Bildirilen model: yoksa ya da boşsa `null`; varsa metin olmalı ve sınırı aşmamalıdır. */
function reportedModel(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw invalid('STREAM_EVENT_MALFORMED');
  if (!value.trim()) return null;
  if (value.length > MAX_REPORTED_MODEL_LENGTH) throw invalid('MODEL_ID_TOO_LONG');
  return value;
}

/**
 * Yanıtın seçeneği: `index === 0` olan giriş. Dizin bildirmeyen uyumlu ağ
 * geçitleri için yalnızca İLK giriş dizinsizse o kullanılır; açıkça sıfırdan
 * farklı dizin taşıyan seçenek asıl yanıt sayılmaz.
 */
export function primaryChoice(choices) {
  const indexed = choices.find((entry) => isPlainObject(entry) && entry.index === 0);
  if (indexed) return indexed;
  const first = choices[0];
  if (first == null) return null;
  if (isPlainObject(first) && first.index != null) return null;
  return first;
}

/** Akıl yürütme alanı: yoksa `false`; varsa metin olmalıdır. */
function reasoningPresent(value) {
  if (value == null) return false;
  if (typeof value !== 'string') throw invalid('STREAM_EVENT_MALFORMED');
  return value.length > 0;
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
  let sawThinking = false;
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
    get sawThinking() { return sawThinking; },
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
        sawThinking = true;
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
 * Araç çağrısı parçalarını birleştirir. OpenAI uyumlu akışta bir çağrının adı ve
 * JSON bağımsız değişkeni birden çok olaya bölünebilir; aynı yanıtta birden çok
 * çağrı `index` ile ayrılır. Parçalar yalnızca biriktirilir: bağımsız değişken
 * burada ÇÖZÜLMEZ ve çağrı akış tamamlanmadan dışarı verilmez.
 */
function accumulateToolCalls(fragments, state, limits) {
  if (!Array.isArray(fragments)) throw invalid('STREAM_EVENT_MALFORMED');
  let started = 0;
  for (const fragment of fragments) {
    if (!isPlainObject(fragment)) throw invalid('STREAM_EVENT_MALFORMED');
    if (fragment.type != null && fragment.type !== 'function') throw invalid('STREAM_TOOL_CALL_MALFORMED');
    const id = fragment.id == null || fragment.id === '' ? null : fragment.id;
    if (id != null && (typeof id !== 'string' || !TOOL_CALL_ID_PATTERN.test(id))) throw invalid('STREAM_TOOL_CALL_MALFORMED');
    let slot;
    if (Number.isSafeInteger(fragment.index) && fragment.index >= 0) {
      slot = state.toolCalls.find((entry) => entry.index === fragment.index);
    } else if (fragment.index != null) {
      throw invalid('STREAM_TOOL_CALL_MALFORMED');
    } else {
      // Dizin bildirmeyen ağ geçidi: kimlik değişmedikçe son çağrının devamıdır.
      const last = state.toolCalls[state.toolCalls.length - 1];
      slot = last && (id == null || last.id === id) ? last : null;
    }
    if (!slot) {
      if (state.toolCalls.length >= limits.maxToolCalls) throw invalid('STREAM_TOOL_CALLS_TOO_MANY');
      slot = {
        index: Number.isSafeInteger(fragment.index) ? fragment.index : state.toolCalls.length,
        id: null,
        name: '',
        arguments: '',
        oversize: false
      };
      state.toolCalls.push(slot);
      started += 1;
    }
    if (id != null) {
      if (slot.id != null && slot.id !== id) throw invalid('STREAM_TOOL_CALL_MALFORMED');
      slot.id = id;
    }
    const fn = fragment.function;
    if (fn == null) continue;
    if (!isPlainObject(fn)) throw invalid('STREAM_TOOL_CALL_MALFORMED');
    if (fn.name != null) {
      if (typeof fn.name !== 'string') throw invalid('STREAM_TOOL_CALL_MALFORMED');
      slot.name += fn.name;
      if (slot.name.length > limits.maxToolNameChars) throw invalid('STREAM_TOOL_CALL_MALFORMED');
    }
    if (fn.arguments != null) {
      if (typeof fn.arguments !== 'string') throw invalid('STREAM_TOOL_CALL_MALFORMED');
      if (!slot.oversize) {
        if (slot.arguments.length + fn.arguments.length > limits.maxToolArgumentChars) {
          slot.oversize = true;
          slot.arguments = '';
        } else {
          slot.arguments += fn.arguments;
        }
      }
    }
  }
  return started;
}

/**
 * Birleştirilmiş çağrılar: kimliği eksik olana kararlı bir kimlik verilir,
 * yinelenen kimlik ayrıştırılır. Adı olmayan çağrı da döner (yürütücü onu
 * tanınmayan araç olarak geri çevirir; model ona yanıt görmelidir).
 */
export function finalizeToolCalls(slots = []) {
  const used = new Set();
  return [...slots].sort((left, right) => left.index - right.index).map((slot, position) => {
    let id = slot.id || `call_${position + 1}`;
    while (used.has(id)) id = `${id}_${position + 1}`;
    used.add(id);
    return { id, name: slot.name.trim(), arguments: slot.arguments, oversize: slot.oversize };
  });
}

/**
 * Tek bir akış olayının yükünü yorumlar. Tanınmayan alanlar zararsızdır ve yok
 * sayılır; beklenen alanların türü yanlışsa olay bozuktur.
 */
function interpretChunk(payload, state) {
  if (!isPlainObject(payload)) throw invalid('STREAM_EVENT_MALFORMED');
  // Bazı ağ geçitleri akış ortasındaki hatayı veri olayı olarak gönderir; gövde okunmaz.
  if (payload.error != null) throw streamInterrupted('STREAM_ERROR_EVENT');
  // Model her olayda doğrulanır; akış ortasında başka bir modele geçiş gizlenmez.
  const model = reportedModel(payload.model);
  if (model != null) {
    if (state.model != null && state.model !== model) throw invalid('MODEL_CHANGED');
    state.model = model;
  }
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
  const choice = primaryChoice(payload.choices);
  if (choice == null) return { content: null, reasoning: false };
  if (!isPlainObject(choice)) throw invalid('STREAM_EVENT_MALFORMED');
  const delta = choice.delta ?? null;
  if (delta != null && !isPlainObject(delta)) throw invalid('STREAM_EVENT_MALFORMED');
  // İsteği yankılayan bir vekilin `user` iletisi model yanıtı sayılmaz.
  if (delta?.role != null && delta.role !== 'assistant') throw invalid('INVALID_ROLE');
  if (delta?.content != null && typeof delta.content !== 'string') throw invalid('STREAM_EVENT_MALFORMED');
  if (choice.finish_reason != null && typeof choice.finish_reason !== 'string') throw invalid('STREAM_EVENT_MALFORMED');
  const reasoning = [reasoningPresent(delta?.reasoning_content), reasoningPresent(delta?.reasoning)].some(Boolean);
  const toolFragments = state.collectTools && delta?.tool_calls != null ? delta.tool_calls : null;
  // Bitiş nedeni bildirildikten sonra gelen yanıt metni kabul edilmez (yalnızca kullanım gibi kuyruk olayları).
  if (state.finishReason && (delta?.content || reasoning || (Array.isArray(toolFragments) && toolFragments.length))) {
    throw invalid('CONTENT_AFTER_FINISH');
  }
  const started = toolFragments == null ? 0 : accumulateToolCalls(toolFragments, state, state.limits);
  if (choice.finish_reason && !state.finishReason) state.finishReason = choice.finish_reason.slice(0, 40);
  return { content: delta?.content ?? null, reasoning, started };
}

/**
 * Akışlı yanıtı olay dizisine çevirir: `{ type: 'text', text }`,
 * `{ type: 'reasoning' }` ve en sonda tek `{ type: 'done', finishReason,
 * model, usage }`. `[DONE]` gelince okuma durur ve bağlantı bırakılır. Akış
 * `[DONE]` ya da bitiş nedeni olmadan biterse yanıt KESİLMİŞTİR.
 *
 * `toolCalls: true` araç çağrılarını da biriktirir: her yeni çağrının ilk
 * parçasında içerik taşımayan `{ type: 'tool_call_started' }` olayı verilir,
 * birleştirilmiş çağrılar yalnızca akış TAMAMLANDIĞINDA `done.toolCalls` içinde
 * döner. Kesilen akışın yarım çağrısı hiçbir zaman dışarı verilmez.
 */
export async function* readChatCompletionStream(body, { signal = null, limits = AI_STREAM_LIMITS, toolCalls = false } = {}) {
  const reader = body?.getReader?.();
  if (!reader) throw invalid('EMPTY_RESPONSE');
  // Bozuk UTF-8 sessizce U+FFFD'ye çevrilip yanıt olarak saklanmaz.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (bytes) => {
    try {
      return decoder.decode(bytes, { stream: true });
    } catch {
      throw invalid('STREAM_ENCODING_INVALID');
    }
  };
  const parser = createSseEventParser({ maxEventChars: limits.maxEventChars });
  const think = createLeadingThinkFilter();
  const state = {
    model: null, usage: null, finishReason: null, bytes: 0, textChars: 0,
    collectTools: toolCalls === true, toolCalls: [], limits: { ...AI_STREAM_LIMITS, ...limits }
  };
  let completed = false;
  let reasoningSent = false;

  const emit = function* (text, reasoning) {
    if (!reasoningSent && (reasoning || think.sawThinking)) {
      reasoningSent = true;
      yield { type: 'reasoning' };
    }
    if (!text) return;
    state.textChars += text.length;
    if (state.textChars > limits.maxTextChars) throw invalid('STREAM_TEXT_TOO_LARGE');
    yield { type: 'text', text };
  };

  function* handle(events) {
    for (const event of events) {
      // Hata olayı, verisi `[DONE]` olsa da hatadır.
      if (event.event === 'error') throw streamInterrupted('STREAM_ERROR_EVENT');
      if (event.data === '[DONE]') {
        completed = true;
        return;
      }
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        throw invalid('STREAM_EVENT_MALFORMED');
      }
      const { content, reasoning, started } = interpretChunk(payload, state);
      yield* emit(content == null ? '' : think.push(content), reasoning);
      for (let index = 0; index < started; index += 1) yield { type: 'tool_call_started' };
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
      yield* handle(parser.push(decode(step.value)));
    }
    if (!completed) {
      let tail;
      try {
        tail = decoder.decode();
      } catch {
        // Akış çok baytlı bir karakterin ortasında bitti: yanıt kesilmiştir.
        throw streamInterrupted('STREAM_TRUNCATED');
      }
      yield* handle(parser.push(tail));
      // Son boş satırı göndermeden kapanan akışın bekleyen verisi yalnızca `[DONE]` olabilir.
      if (!completed) {
        const trailing = parser.end({ includeEvent: true });
        if (trailing.event === 'error') throw streamInterrupted('STREAM_ERROR_EVENT');
        if (trailing.data === '[DONE]') completed = true;
        else if (trailing.data != null) throw streamInterrupted('STREAM_TRUNCATED');
      }
      if (!completed && state.finishReason) completed = true;
      if (!completed) throw streamInterrupted('STREAM_TRUNCATED');
    }
    yield* emit(think.end(), false);
    yield state.collectTools
      ? { type: 'done', finishReason: state.finishReason, model: state.model, usage: state.usage, toolCalls: finalizeToolCalls(state.toolCalls) }
      : { type: 'done', finishReason: state.finishReason, model: state.model, usage: state.usage };
  } finally {
    // Erken bitişte (DONE, sınır aşımı, iptal) sağlayıcı bağlantısı bırakılır.
    reader.cancel().catch(() => {});
  }
}
