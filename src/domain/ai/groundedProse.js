/**
 * Kanıt yuvalarının kapalı anlatım sözleşmesi. Model önerme sırasını ve paragraf sınırlarını seçer.
 * Serbest sözcükler doğrulanmış olgu sayılmaz: yalnızca sunucunun aşağıdaki tarafsız geçişlerinden biri seçilebilir.
 * Bu bir olgusallık kestirimi değildir; sözlük dışı metin reddedilir ve çağıran belirlenimci kanıt anlatımını kullanır.
 */
export const PROSE_LIMITS = Object.freeze({ maxChars: 2400, maxSentences: 8 });
export const PROSE_CONNECTORS = Object.freeze({
  tr: Object.freeze(['', 'Genel tabloya bakınca', 'Bunun yanında', 'Öte yandan', 'Ayrıca', 'Buna ek olarak', 'Son olarak']),
  en: Object.freeze(['', 'Looking at the evidence', 'In addition', 'Also', 'Finally'])
});
const SLOT = /\{([PTG][1-9][0-9]?)\}/gu;
const fail = (issue) => ({ ok: false, issue });

/** Yalnızca kapalı yuva söz dizimini ayrıştırır; doğal dil yorumlamaz. */
export function tokenizeProse(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > PROSE_LIMITS.maxChars) return fail('PROSE_INVALID');
  const tokens = [];
  let last = 0;
  for (const match of text.matchAll(SLOT)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index) });
    tokens.push({ slot: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return { ok: true, tokens };
}

/** Her cümle, sunucu geçişi ve tek bir tam önerme ya da yönlendirmedir. */
export function checkProse(text, { known, locale = 'tr', used = new Set() }) {
  const parsed = tokenizeProse(text);
  if (!parsed.ok) return parsed;
  const connectors = PROSE_CONNECTORS[locale === 'en' ? 'en' : 'tr'];
  const seen = new Set(used);
  const sentences = [];
  let lead = '';
  for (const token of parsed.tokens) {
    if (token.text != null) { lead += token.text; continue; }
    const connector = lead.trim().replace(/^[.;]\s*/u, '');
    if (!connectors.includes(connector) || token.slot[0] !== 'P' && connector) return fail('PROSE_UNTRUSTED');
    if (!known(token.slot)) return fail('UNKNOWN_PROPOSITION');
    if (seen.has(token.slot)) return fail('DUPLICATE_PROPOSITION');
    seen.add(token.slot);
    // Bağlaç sunucunun sabit dizgesinden alınır; modelin gönderdiği metin çizime taşınmaz.
    sentences.push([...(connector ? [{ text: `${connectors[connectors.indexOf(connector)]} ` }] : []), { slot: token.slot }, { text: '.' }]);
    lead = '';
  }
  if (lead.trim() && lead.trim() !== '.') return fail('PROSE_UNTRUSTED');
  if (!sentences.length) return fail('PROSE_UNGROUNDED');
  if (sentences.length > PROSE_LIMITS.maxSentences) return fail('PROSE_LENGTH');
  return { ok: true, ids: sentences.flatMap((sentence) => sentence.filter((token) => token.slot).map((token) => token.slot)), sentences, dropped: 0, cut: 0, issues: [] };
}

/** Sunucu metniyle başlayan yan cümlenin ilk harfi; veriyle (kayıt adı) başlayan yan cümle değiştirilmez. */
function caseHead(text, upper, locale) {
  const tag = locale === 'en' ? 'en-US' : 'tr-TR';
  const first = text.charAt(0);
  return `${upper ? first.toLocaleUpperCase(tag) : first.toLocaleLowerCase(tag)}${text.slice(1)}`;
}

/**
 * Önermenin yuva biçimi (son nokta düşer, değerler vurgulu ve kaçışlı). Cümle başındaki yuvanın sunucu metni büyük,
 * cümle içindeki küçük harfle başlar; kayıt adıyla başlayan önerme hiç değiştirilmez.
 */
export function propositionClause(proposition, { initial, locale, escape }) {
  const parts = Array.isArray(proposition.parts) ? proposition.parts : null;
  if (!parts?.length) {
    const markdown = String(proposition.markdown || '').trim();
    return markdown.endsWith('.') ? markdown.slice(0, -1) : markdown;
  }
  const trimmed = [...parts];
  const last = trimmed.at(-1);
  if (typeof last === 'string' && last.endsWith('.')) trimmed[trimmed.length - 1] = last.slice(0, -1);
  return trimmed.map((part, index) => {
    if (typeof part !== 'string') return part.strong ? `**${escape(part.value)}**` : escape(part.value);
    return escape(index === 0 ? caseHead(part, initial, locale) : part);
  }).join('');
}

/**
 * Doğrulanmış cümleleri Markdown paragrafına çevirir. Modelin sözcükleri kaçışlı düz metindir (vurgu taşımaz);
 * vurgulu her değer sunucunun yuvasından gelir. Yönlendirme yuvası (`{T#}`, `{G#}`) sunucunun kendi cümlesidir.
 */
export function renderProse(sentences, { proposition, pointer, locale, escape, escapeText = escapeProseText }) {
  const out = [];
  for (const sentence of sentences) {
    let text = '';
    let initial = true;
    const pointers = [];
    for (const token of sentence) {
      if (token.slot) {
        const item = proposition(token.slot);
        if (item) {
          const clause = propositionClause(item, { initial, locale, escape });
          text += clause;
        }
        else pointers.push(token.slot);
        initial = false;
        continue;
      }
      const words = token.text;
      text += escapeText(words);
      if (words.trim()) initial = /[.!?…]\s*$/u.test(words.trim()) ? true : false;
    }
    const cleaned = text.replace(/\s+/gu, ' ').replace(/\s+([,;:.!?)])/gu, '$1').trim();
    const bare = cleaned.replace(/[\s,;:–—-]+$/u, '');
    if (bare && /[\p{L}\p{N}*]/u.test(bare)) out.push(/[.!?…)"”]$/u.test(bare) ? bare : `${bare}.`);
    for (const id of pointers) { const sentenceText = pointer(id); if (sentenceText) out.push(sentenceText); }
  }
  return out.join(' ');
}

/**
 * Modelin metni Markdown taşıyamaz (izin listesi işaret karakterlerini dışlar); yine de kaçışlanır. Paragraf başındaki
 * tire liste açamaz.
 */
export function escapeProseText(text) {
  return String(text).replace(/([\\`*_{}[\]#+|<>~])/gu, '\\$1');
}

export function proseParagraph(markdown) {
  return /^[-–—]/u.test(markdown) ? `\\${markdown}` : markdown;
}
