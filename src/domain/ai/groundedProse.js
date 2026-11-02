/**
 * KANITA BAĞLI ANLATIM YÜZEYİ (Aşama 4E kalite yakınsaması).
 *
 * 4D/4E'de model yalnızca sunucu önermelerinin KİMLİKLERİNİ seçiyordu; kullanıcıya ulaşan her cümle sunucunun sabit
 * kalıbıydı. Bu güvenliydi ama insan kalitesinde anlatımın mimari tavanıydı: bağlam kuran giriş, geçiş, sentez ve
 * "asıl sorun nerede" yorumu hiçbir zaman yazılamıyordu. Bu modül sınırı METİN değil OLGU düzeyinde çizer:
 *
 *   - Model paragrafı KENDİSİ yazar; olgular yalnızca `{P#}` yuvasıyla girer. Yuva sunucunun önerme cümlesinin
 *     tamamıyla (değer, ilişki, nüfus ve kapsam birlikte; çizimde vurgulu) değiştirilir. Model bir yuvayı bölemez,
 *     değerini ayrı kullanamaz, başka bir önermenin adıyla eşleyemez.
 *   - Modelin kendi sözcükleri yalnızca bağlaç, geçiş ve yorumdur. Yapısal olarak OLGU taşıyamaz: rakam (her yazı
 *     sisteminde), yüzde, tarih ayracı, bağlantı, Markdown/HTML, görünmez karakter yoktur; cümle başı dışında büyük
 *     harfle başlayan sözcük (özel ad biçimi) yoktur; sayfadaki hiçbir kayıt adı (proje, kişi, görev) yuvanın dışında
 *     geçmez. İzin verilen karakterler kapalı bir listedir (harf, birleşik işaret, boşluk, sınırlı noktalama).
 *   - Her cümle en az bir doğrulanmış yuva taşır: dayanaksız cümle (genel tavsiye, dolgu, olgusuz yargı) çizilmez.
 *     Dayanaksız cümle düşürülür; çoksa düzen reddedilir ve sunucunun belirlenimci anlatımı gösterilir.
 *
 * Denetimler dil anlamaz: sözcük listesi, çekim eki, sayı sözcüğü ya da kalıp yoktur; yalnızca karakter sınıfı,
 * büyük harf konumu, sunucunun kendi kayıt adlarıyla dize eşleşmesi ve yuva yapısı denetlenir. Yetki, kimlik, SQL ve
 * kanıt seçimi bu katmana hiç girmez: model yalnızca zaten doğrulanmış ve yetkili sayfayı görür.
 */

export const PROSE_LIMITS = Object.freeze({ maxChars: 2400, maxSentences: 12, maxFreeChars: 320, maxDropped: 2, minNameChars: 3 });

const SLOT = /\{([PTG][1-9][0-9]?)\}/gu;
/** Modelin kendi metninde izin verilen karakterler: harf, birleşik işaret, boşluk ve sınırlı noktalama. */
const ALLOWED = /^[\p{L}\p{M} .,;:!?'’"“”()\-–—/…]*$/u;
const TERMINAL = new Set(['.', '!', '?', '…']);
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’\-]*/gu;
const UPPER = /^[\p{Lu}\p{Lt}]/u;

const fail = (issue) => ({ ok: false, issue });

/** Kayıt adı karşılaştırması: büyük/küçük harf ve aksan farkı adı gizlemez. */
function fold(text, locale) {
  return String(text).normalize('NFKC').toLocaleLowerCase(locale === 'en' ? 'en-US' : 'tr-TR');
}

/**
 * Model paragrafını yuva ve metin parçalarına ayırır.
 * @returns {{ ok: true, tokens: ({ text: string } | { slot: string })[] } | { ok: false, issue: string }}
 */
export function tokenizeProse(text) {
  if (typeof text !== 'string') return fail('PROSE_INVALID');
  const source = text.normalize('NFC').trim();
  if (!source || source.length > PROSE_LIMITS.maxChars) return fail('PROSE_INVALID');
  const tokens = [];
  let last = 0;
  for (const match of source.matchAll(SLOT)) {
    if (match.index > last) tokens.push({ text: source.slice(last, match.index) });
    tokens.push({ slot: match[1] });
    last = match.index + match[0].length;
  }
  if (last < source.length) tokens.push({ text: source.slice(last) });
  return { ok: true, tokens };
}

/** Parçaları cümlelere böler: sınır yalnızca modelin metnindeki bitiş noktalamasıdır (yuva içi metin sunucunundur). */
function sentencesOf(tokens) {
  const sentences = [];
  let current = [];
  for (const [position, token] of tokens.entries()) {
    if (token.slot) {
      // Arada metin olmadan bitişik iki yuva ("{P1}{P2}") da iki ayrı önerme cümlesidir.
      if (tokens[position - 1]?.slot && current.length) { current.push({ text: '.' }); sentences.push(current); current = []; }
      current.push(token);
      continue;
    }
    // Önerme cümlesi kendi noktasıyla biter: yuvadan sonra boşluk ve büyük harfle başlayan sözcük yeni cümledir
    // ("{P2} Buna ek olarak …"); örtük nokta eklenir.
    // Noktalamasız ardışık iki yuva ("{P1} {P2}") iki ayrı önerme cümlesidir.
    const adjacent = tokens[position - 1]?.slot && !token.text.trim() && tokens[position + 1]?.slot;
    if (tokens[position - 1]?.slot && (adjacent || /^\s+[\p{Lu}\p{Lt}]/u.test(token.text)) && current.length) {
      current.push({ text: '.' });
      sentences.push(current);
      current = [];
    }
    let buffer = '';
    for (let index = 0; index < token.text.length; index += 1) {
      const char = token.text[index];
      buffer += char;
      const next = token.text[index + 1];
      if (TERMINAL.has(char) && (next === undefined || next === ' ' || next === '"' || next === '”' || next === ')')) {
        // Kapanış tırnağı/ayracı cümleye aittir.
        while (token.text[index + 1] && ['"', '”', ')'].includes(token.text[index + 1])) { index += 1; buffer += token.text[index]; }
        current.push({ text: buffer });
        sentences.push(current);
        current = [];
        buffer = '';
      }
    }
    if (buffer) current.push({ text: buffer });
  }
  if (current.some((token) => token.slot || token.text.trim())) sentences.push(current);
  return sentences.map((sentence) => sentence.filter((token) => token.slot || token.text.length));
}

/**
 * Modelin metin parçalarının olgu taşıyamadığını denetler.
 * `names`: sayfadaki kayıt adları (proje, kişi, görev); hiçbiri yuva dışında geçemez.
 */
/** Yuvanın ardından yalnızca noktalama gelebilir: yan cümle bittiği yerde biter, modelin sözcüğü onu sürdüremez. */
const AFTER_SLOT = /^\s*(?:$|[.,;:!?)\u2026\u2013\u2014"\u201d-])/u;
/**
 * Sıralama bağlacı yan cümleyi değiştirmez, yeni yan cümle açar ("{P1} ve bunların çoğu …: {P2}."). Bağlaçtan sonraki
 * metin bir sonraki yuvanın çerçevesidir; ardında yuva yoksa cümle son yuvada biter (kuyruk çizilmez). Kapalı küme;
 * soru yorumu değil, modelin cümle söz dizimidir.
 */
const CONTINUATION = Object.freeze({
  tr: /^\s+(?:ve|ama|ancak|fakat|oysa|üstelik|ayrıca|dolayısıyla)\s/u,
  en: /^\s+(?:and|but|while|whereas|yet|so)\s/u
});
const continues = (text, locale) => CONTINUATION[locale === 'en' ? 'en' : 'tr'].test(text);

/**
 * Yuvayı ad öbeği gibi kullanan cümlenin onarımı ("Bu görev aynı zamanda {P4} olduğundan, …"): yuvanın ardından gelen
 * sözcük yan cümleyi sürdüremez. Cümle bir önceki geçerli yuvada biter; önceki yuva yoksa gömülü yuva tek başına (ya da
 * noktalamayla ayrılmış çerçevesiyle) kalır. Yalnızca modelin metnini KISALTIR; çizilen her parça yine denetlenir.
 * @returns {{ sentence: object[], cut: boolean }}
 */
function clauseCut(sentence, { pointer, locale }) {
  for (let index = 0; index < sentence.length; index += 1) {
    const token = sentence[index];
    if (!token.slot || pointer(token.slot)) continue;
    const next = sentence[index + 1];
    const blankBeforeSlot = next?.text != null && !next.text.trim() && sentence[index + 2]?.slot;
    if (!next || (!next.slot && !blankBeforeSlot && (AFTER_SLOT.test(next.text) || continues(next.text, locale)))) continue;
    const previous = sentence.slice(0, index).findLastIndex((item) => item.slot);
    if (previous >= 0) return { sentence: [...sentence.slice(0, previous + 1), { text: '.', trimmed: true }], cut: true };
    const lead = sentence.slice(0, index).map((item) => item.text || '').join('');
    const framed = !lead.trim() || /[:;,\u2013\u2014]\s*$/u.test(lead);
    return { sentence: [...(framed ? sentence.slice(0, index) : []), token, { text: '.', trimmed: true }], cut: true };
  }
  return { sentence, cut: false };
}

function freeTextIssue(sentence, { names, licensed = [], locale, pointer = () => false }) {
  let atStart = true;
  let free = 0;
  // Tablo/grafik yönlendirmesi kendi başına bir cümledir (sunucunun cümlesi); başka sözcük ya da yuva taşımaz.
  if (sentence.some((token) => token.slot && pointer(token.slot))
    && (sentence.filter((token) => token.slot).length > 1 || sentence.some((token) => token.text && /[\p{L}\p{N}]/u.test(token.text)))) return 'PROSE_POINTER';
  // Onarımdan (clauseCut) sonra kalan cümlede yuvayı sürdüren sözcük olamaz; savunma derinliği için yine denetlenir.
  for (let index = 0; index < sentence.length; index += 1) {
    const token = sentence[index];
    if (token.slot && !pointer(token.slot)) {
      const next = sentence[index + 1];
      const blankBeforeSlot = next?.text != null && !next.text.trim() && sentence[index + 2]?.slot;
      if (next && (next.slot || blankBeforeSlot || !(AFTER_SLOT.test(next.text) || continues(next.text, locale)))) return 'PROSE_CLAUSE';
    }
  }
  for (const token of sentence) {
    if (token.slot) { atStart = false; continue; }
    let text = token.text;
    free += text.length;
    if (!ALLOWED.test(text) || text.includes('://') || /(^|\s)www\./u.test(text)) return 'PROSE_CHARACTER';
    // Yuvanın kendi önermesinde geçen kayıt adı büyük harf denetiminden önce maskelenir (ad yuvanın önermesine aittir).
    for (const name of licensed) {
      const lowered = fold(text, locale);
      let at = lowered.indexOf(name);
      while (at >= 0) { text = `${text.slice(0, at)}${'x'.repeat(name.length)}${text.slice(at + name.length)}`; at = fold(text, locale).indexOf(name); }
    }
    for (const match of text.matchAll(WORD)) {
      const before = text.slice(0, match.index).trim();
      // Cümle başı: paragrafın/cümlenin ilk sözcüğü ya da iki nokta sonrasının ilk sözcüğü.
      const initial = atStart && !before.replace(/["\u201c(\u2013\u2014-]/gu, '').trim();
      const afterColon = /:\s*["\u201c]?$/u.test(before);
      if (UPPER.test(match[0]) && !initial && !afterColon && !(locale === 'en' && match[0] === 'I')) return 'PROSE_NAME';
    }
    if (text.trim()) atStart = false;
  }
  if (free > PROSE_LIMITS.maxFreeChars) return 'PROSE_LENGTH';
  const folded = fold(sentence.filter((token) => !token.slot).map((token) => token.text).join(' '), locale);
  for (const name of names) if (folded.includes(name)) return 'PROSE_NAME';
  return null;
}

/**
 * Model paragrafını doğrular ve cümlelere ayırır.
 *
 * Kural ihlali taşıyan CÜMLE düşürülür (çizilmez); düşürme yalnızca modelin içeriğini azaltır, hiçbir zaman olgu eklemez.
 * Yuvayı ad öbeği gibi kullanan cümle düşürülmez, yuvada kısaltılır (`clauseCut`); son yuvadan sonraki kuyruk çizilmez.
 * Denetim, çizilecek biçim üzerinde yapılır. Yuvasız çerçeve cümlesi ve yinelenen yuva temiz düşer (yumuşak); diğer
 * ihlaller (sert) tutulan cümleden çoksa ya da hiç cümle kalmazsa paragraf reddedilir (ilk sert ihlalin koduyla). Kayıt
 * adı ancak aynı cümledeki bir yuvanın kendi metninde geçiyorsa yazılabilir (çapraz eşleme olamaz: ad, yuvanın önermesine aittir).
 *
 * @param {string} text Modelin paragrafı (`{P#}`, `{T#}`, `{G#}` yuvalarıyla).
 * @param {{ known: (id: string) => boolean, names?: string[], locale?: string, slotText?: (id: string) => string, used?: Set<string> }} options
 * @returns {{ ok: true, ids: string[], sentences: object[][], dropped: number, cut: number, issues: string[] } | { ok: false, issue: string }}
 */
export function checkProse(text, { known, names = [], locale = 'tr', slotText = () => '', used = new Set() }) {
  if (typeof text !== 'string') return fail('PROSE_INVALID');
  // Biçim normalleştirmesi (yalnızca kaldırır): satır sonu boşluğa, vurgu işaretleri silinir.
  const normalized = text.replace(/\r?\n+/gu, ' ').replace(/\*\*|__|(?<![\p{L}])[*_]|[*_](?![\p{L}])/gu, '').replace(/[ \t]{2,}/gu, ' ');
  const tokenized = tokenizeProse(normalized);
  if (!tokenized.ok) return tokenized;
  const { tokens } = tokenized;
  const folded = [...new Set(names.map((name) => fold(name, locale)).filter((name) => name.length >= PROSE_LIMITS.minNameChars))];
  const all = sentencesOf(tokens);
  if (all.length > PROSE_LIMITS.maxSentences * 2) return fail('PROSE_LENGTH');
  const kept = [];
  const issues = [];
  const seen = new Set(used);
  const pointer = (id) => !id.startsWith('P');
  let cut = 0;
  for (const original of all) {
    const repaired = clauseCut(original, { pointer, locale });
    if (repaired.cut) cut += 1;
    const sentence = endAtLastSlot(repaired.sentence);
    const slots = sentence.filter((token) => token.slot).map((token) => token.slot);
    // Yuva söz dizimine benzeyen ama yuva olmayan parantez (ör. "{F1}", yarım yuva) ya da sayfada olmayan kimlik.
    let issue = sentence.some((token) => token.text && /[{}]/u.test(token.text)) ? 'PROSE_SLOT'
      : slots.some((id) => !known(id)) ? 'UNKNOWN_PROPOSITION'
        : slots.some((id) => seen.has(id)) || new Set(slots).size !== slots.length ? 'DUPLICATE_PROPOSITION'
          : !slots.length ? 'PROSE_UNGROUNDED' : null;
    if (!issue) {
      // Aynı cümledeki yuvanın kendi metninde geçen kayıt adı yazılabilir; denetimden önce maskelenir.
      const licensed = folded.filter((name) => slots.some((id) => fold(slotText(id) || '', locale).includes(name)));
      issue = freeTextIssue(sentence, { names: folded.filter((name) => !licensed.includes(name)), licensed, locale, pointer });
    }
    if (issue) { issues.push(issue); continue; }
    for (const id of slots) seen.add(id);
    kept.push(sentence);
  }
  if (kept.length > PROSE_LIMITS.maxSentences) return fail('PROSE_LENGTH');
  const hard = issues.filter((issue) => !SOFT_ISSUES.has(issue));
  if (!kept.length || hard.length > kept.length) return fail(hard[0] || issues[0] || 'PROSE_UNGROUNDED');
  const ids = kept.flatMap((sentence) => sentence.filter((token) => token.slot).map((token) => token.slot));
  return { ok: true, ids, sentences: kept, dropped: issues.length, cut, issues };
}

/**
 * Cümle son olgu yuvasıyla biter: yuvadan SONRA gelen model yorumu (ör. olgunun ötesine geçen değerlendirme, tahmin ya
 * da öneri) çizilmez; yalnızca bitiş noktalaması kalır. Yorum yuvadan önce, çerçeve olarak yazılabilir. Bu yalnızca
 * modelin metnini kısaltır, olgu eklemez.
 */
/** Temiz düşen ihlaller: yuvasız çerçeve cümlesi ve yinelenen yuva (kalan cümleler kendi başına kanıta bağlıdır). */
const SOFT_ISSUES = new Set(['PROSE_UNGROUNDED', 'DUPLICATE_PROPOSITION']);

function endAtLastSlot(sentence) {
  const last = sentence.findLastIndex((token) => token.slot);
  if (last < 0 || last === sentence.length - 1) return sentence;
  const tail = sentence.slice(last + 1).map((token) => token.text || '').join('');
  if (!/[\p{L}\p{N}]/u.test(tail)) return sentence;
  const terminal = /[!?]\s*["\u201d)]?\s*$/u.exec(tail)?.[0]?.trim()[0] || '.';
  return [...sentence.slice(0, last + 1), { text: terminal, trimmed: true }];
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
    return index === 0 ? caseHead(part, initial, locale) : part;
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
          // Modelin son sözcüğü yan cümlenin ilk sözcüğüyle aynıysa ("bu terminler {P}" → "terminler …") yinelenmez.
          const head = /^[\p{L}\p{M}]+/u.exec(clause.replace(/^\*\*/u, ''))?.[0];
          const tail = /([\p{L}\p{M}]+)\s*$/u.exec(text);
          if (head && tail && fold(head, locale) === fold(tail[1], locale)) text = text.slice(0, tail.index);
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
