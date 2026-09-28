/**
 * Rota AI sohbet sözleşmesi — sunucu ile tarayıcının ORTAK, saf sözlüğü.
 *
 * Tarayıcı ile MERGEN Rota sunucusu arasındaki akış protokolü, kullanıcıya
 * dönük sohbet kipleri, sınırlar ve konuşma başlığı kuralı burada tanımlanır.
 * Kiplerin hangi model profiline bağlandığı BURADA DEĞİL, yalnızca sunucuda
 * bilinir: tarayıcı profil ya da model adı göndermez, yalnızca kip seçer.
 */

/** Akış protokolünün sürümü; `accepted` olayı ve yanıt başlığı taşır. */
export const ASSISTANT_PROTOCOL_VERSION = 1;
export const ASSISTANT_STREAM_CONTENT_TYPE = 'text/event-stream';
export const ASSISTANT_PROTOCOL_HEADER = 'x-mergen-rota-assistant-protocol';

/**
 * Akış olayları. `done` ve `error` SONLANDIRICIDIR: her akış bunlardan tam
 * olarak biriyle biter. Akış başladıktan sonra HTTP durumu değişemediği için
 * sonradan oluşan hata `error` olayıyla bildirilir.
 */
export const ASSISTANT_STREAM_EVENTS = Object.freeze({
  ACCEPTED: 'accepted',
  STATUS: 'status',
  DELTA: 'delta',
  DONE: 'done',
  ERROR: 'error'
});

/** `status` olayının evreleri; model ilerlemesi UYDURULMAZ, yalnızca gerçek geçişler bildirilir. */
export const ASSISTANT_STREAM_PHASES = Object.freeze({
  GENERATING: 'generating',
  THINKING: 'thinking'
});

export const ASSISTANT_MODES = Object.freeze({
  STANDARD: 'standard',
  DEEP: 'deep'
});

const MODE_LABELS = Object.freeze({
  [ASSISTANT_MODES.STANDARD]: 'Standart',
  [ASSISTANT_MODES.DEEP]: 'Derin düşünme'
});

export const ASSISTANT_LIMITS = Object.freeze({
  /** Tek kullanıcı iletisinin en büyük uzunluğu (karakter). */
  maxMessageChars: 8000,
  /** Tek asistan yanıtının en büyük uzunluğu; akış bu sınırda güvenle kesilir. */
  maxAnswerChars: 64000,
  /** Bir konuşmadaki en fazla ileti (kullanıcı + asistan). */
  maxConversationMessages: 100,
  /** Konuşma listesinin sayfa boyutu. */
  conversationPageSize: 30,
  /** Konuşma başlığının en büyük uzunluğu. */
  maxTitleChars: 60
});

export const ASSISTANT_CONTEXT_POLICY = Object.freeze({
  historyWindow: 40,
  maxHistoryMessages: 20,
  maxContextChars: 48000,
  maxMessageChars: 12000
});

const ASSISTANT_CONTEXT_CLIPPED_SUFFIX = '\n[…ileti bağlam için kısaltıldı]';

function clipAssistantContextMessage(content) {
  const text = String(content ?? '');
  const limit = ASSISTANT_CONTEXT_POLICY.maxMessageChars;
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - ASSISTANT_CONTEXT_CLIPPED_SUFFIX.length);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}${ASSISTANT_CONTEXT_CLIPPED_SUFFIX}`;
}

/** Sunucu ve istemcinin aynı bağlam-kısaltma kararını üretmesi için saf seçim. */
export function selectAssistantContextHistory({
  history = [], userContent, priorMessageCount = history.length
} = {}) {
  const answers = new Map(history.filter((message) => message.role === 'assistant').map((message) => [message.replyToId, message]));
  const pairs = history
    .filter((message) => message.role === 'user' && answers.has(message.id))
    .map((message) => [message, answers.get(message.id)]);
  const current = String(userContent ?? '');
  let budget = ASSISTANT_CONTEXT_POLICY.maxContextChars - current.length;
  const included = [];
  let clippedMessages = 0;
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    if ((included.length + 1) * 2 > ASSISTANT_CONTEXT_POLICY.maxHistoryMessages) break;
    const [question, answer] = pairs[index];
    const pair = [clipAssistantContextMessage(question.content), clipAssistantContextMessage(answer.content)];
    const size = pair[0].length + pair[1].length;
    if (size > budget) break;
    budget -= size;
    included.unshift(pair);
    clippedMessages += Number(pair[0] !== String(question.content ?? '')) + Number(pair[1] !== String(answer.content ?? ''));
  }
  const includedMessages = included.length * 2;
  const completedMessages = pairs.length * 2;
  return {
    pairs: included,
    trimmed: included.length < pairs.length || priorMessageCount > history.length || clippedMessages > 0,
    includedMessages,
    clippedMessages,
    omittedMessages: Math.max(0, completedMessages - includedMessages) + Math.max(0, priorMessageCount - history.length)
  };
}

export const ASSISTANT_DEFAULT_TITLE = 'Yeni konuşma';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAssistantMode(value) {
  return Object.hasOwn(MODE_LABELS, String(value ?? ''));
}

export function assistantModeLabel(mode) {
  return MODE_LABELS[mode] || MODE_LABELS[ASSISTANT_MODES.STANDARD];
}

/** Konuşma, ileti ve tur kimlikleri GUID biçimindedir; başka hiçbir biçim kabul edilmez. */
export function isAssistantId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Kullanıcı iletisini doğrular ve kanonik biçime getirir: satır sonları `\n`
 * olur, görünmeyen denetim karakterleri (sekme ve satır sonu dışında) atılır.
 * Yalnızca boşluktan oluşan ileti gönderilmez.
 *
 * @returns {{ok: true, value: string} | {ok: false, reason: string, message: string}}
 */
export function normalizeAssistantMessageText(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function normalizeAssistantMessage(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'MESSAGE_REQUIRED', message: 'İleti boş olamaz.' };
  const text = normalizeAssistantMessageText(value);
  if (!text) return { ok: false, reason: 'MESSAGE_REQUIRED', message: 'İleti boş olamaz.' };
  if (text.length > ASSISTANT_LIMITS.maxMessageChars) {
    return {
      ok: false,
      reason: 'MESSAGE_TOO_LONG',
      message: `İleti en fazla ${ASSISTANT_LIMITS.maxMessageChars.toLocaleString('tr-TR')} karakter olabilir.`
    };
  }
  return { ok: true, value: text };
}

/**
 * İlk kullanıcı iletisinden BELİRLENİMCİ konuşma başlığı. Başlık için ayrıca
 * model çağrılmaz. Biçim işaretleri ve fazla boşluk atılır; uzun metin sözcük
 * sınırında kısaltılır.
 */
export function conversationTitleFrom(message) {
  const limit = ASSISTANT_LIMITS.maxTitleChars;
  const plain = String(message ?? '')
    .replace(/\r\n?/g, '\n')
    // Satır başı işaretleri (başlık, alıntı) satır sınırları henüz korunurken HER satırda atılır.
    .replace(/(^|\n)[ \t]{0,3}(?:#{1,6}(?:[ \t]+|(?=\n)|$)|>[ \t]?)/g, '$1')
    // Bağlantı/görsel hedefini başlığa taşımadan yalnızca görünür etiketi koru.
    .replace(/!?\[([^\r\n]*?)\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)/g, '$1')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/(`+|\*\*|__|~~)(?=\S)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return ASSISTANT_DEFAULT_TITLE;
  if (plain.length <= limit) return plain;
  let cut = plain.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary >= limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
