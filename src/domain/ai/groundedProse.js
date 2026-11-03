/**
 * Kanıt yuvalarının kapalı anlatım sözleşmesi.
 *
 * Model paragrafta yalnızca hangi sunucu önermelerinin (`{P#}`) ve yönlendirmelerinin (`{T#}`, `{G#}`) hangi sırayla
 * söyleneceğini seçer. Yuva dışındaki HİÇBİR model metni çizilmez: ne serbest sözcük ne de bağlaç. Bağlaç da bir ilişki
 * iddiasıdır ("öte yandan" karşıtlık söyler); ilişkiyi yalnızca sunucu, aynı kanıtın önermeleri arasında doğrulayarak
 * kurar (groundedPropositions.js § fluentParagraph). Yuva dışı metin bu yüzden yorumlanmaz, ayıklanmaz ya da olgusallığı
 * kestirilmez: yalnızca atılır ve sayılır. Kullanıcıya ulaşan her sözcük sunucunundur.
 */
export const PROSE_LIMITS = Object.freeze({ maxChars: 2400, maxSentences: 8 });
const SLOT = /\{([PTG][1-9][0-9]?)\}/gu;
/** Yuvaları ayıran boşluk ve noktalama atılan metin sayılmaz (gözlem sayacı yalnızca sözcük taşıyan parçaları sayar). */
const SEPARATOR = /^[\s.,;:]*$/u;
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

/**
 * Paragrafın yuva dizisini çıkarır. Bilinmeyen ya da yinelenen yuva paragrafı reddeder; yuva dışı metin çizime hiç
 * girmez ve `dropped` ile (çizilmeyen sözcüklü parça sayısı) raporlanır. Her yuva kendi tek öğeli cümlesidir; cümle
 * kurulumu ve birleştirme sunucunundur.
 * @returns {{ ok: true, ids: string[], sentences: { slot: string }[][], dropped: number, cut: 0, issues: [] } | { ok: false, issue: string }}
 */
export function checkProse(text, { known, used = new Set() }) {
  const parsed = tokenizeProse(text);
  if (!parsed.ok) return parsed;
  const seen = new Set(used);
  const ids = [];
  let dropped = 0;
  for (const token of parsed.tokens) {
    if (token.text != null) {
      if (!SEPARATOR.test(token.text)) dropped += 1;
      continue;
    }
    if (!known(token.slot)) return fail('UNKNOWN_PROPOSITION');
    if (seen.has(token.slot)) return fail('DUPLICATE_PROPOSITION');
    seen.add(token.slot);
    ids.push(token.slot);
  }
  if (!ids.length) return fail('PROSE_UNGROUNDED');
  if (ids.length > PROSE_LIMITS.maxSentences) return fail('PROSE_LENGTH');
  return { ok: true, ids, sentences: ids.map((slot) => [{ slot }]), dropped, cut: 0, issues: [] };
}

/** Yuva dizisinin kanonik metni: yeniden doğrulamada modelin atılan sözcükleri taşınmaz. */
export function proseText(ids) {
  return ids.map((id) => `{${id}}`).join(' ');
}
