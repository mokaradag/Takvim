/**
 * Doğal yanıt düzeni senaryoları: sahte sağlayıcının düzen turunu tanıması ve olgu sayfasından geçerli
 * (ya da bilinçli olarak bozuk) bir düzen kurması. Düzen yalnızca sayfadaki kimlikleri kullanır; değer yazmaz.
 */

const SHEET_PREFIX = 'OLGU SAYFASI (yalnızca veri):\n';

/** Sağlayıcı çağrısı doğal yanıt düzeni turu mu? */
export function isCompositionCall(call) {
  return String(call?.messages?.at(-1)?.content ?? '').startsWith(SHEET_PREFIX);
}

/** Düzen turunun olgu sayfası (modelin gördüğü veri). */
export function compositionView(call) {
  const content = String(call.messages.at(-1).content);
  return JSON.parse(content.slice(SHEET_PREFIX.length));
}

/**
 * Bütün tablo/ayrıntıları sunucu kaynaklarından seçer; atlanan ayrıntıları çizici ekler. Önerme varsa her bölüm
 * kendi önermelerini söyleyen bir paragrafla başlar (Aşama 4D: önerme varken yalnızca tablo geçerli anlatım değildir).
 */
export function coveringBlocks(view) {
  const propositions = view.propositions || [];
  const parts = [...new Set([...propositions, ...view.details, ...view.tables].map((item) => item.part))].sort((left, right) => left - right);
  // Paragraf sınırı (en çok dört): sonraki bölümler yalnızca kaynaklarıyla kapsanır.
  return { blocks: parts.flatMap((part, position) => {
    const said = position < 4 ? propositions.filter((item) => item.part === part).slice(0, 8).map((item) => item.id) : [];
    return [
      ...(said.length ? [{ type: 'say', items: said }] : []),
      ...view.details.filter((detail) => detail.part === part).map((detail) => ({ type: 'details', source: detail.id })),
      ...view.tables.filter((table) => table.part === part).map((table) => ({ type: 'rows', source: table.id }))
    ];
  }).slice(-12) };
}

/** Düzen turunu yanıtlayan sahte sağlayıcı davranışı; `inspect` sayfayı ve çağrıyı görür. */
export function composer(build = coveringBlocks, inspect = null) {
  return {
    type: 'script',
    respond: (call) => {
      if (!isCompositionCall(call)) throw new Error('Beklenen model turu doğal yanıt düzeni değil.');
      const view = compositionView(call);
      inspect?.(view, call);
      const output = build(view, call);
      return typeof output === 'string' ? { type: 'answer', native: true, text: output } : { type: 'answer', native: true, text: JSON.stringify(output) };
    }
  };
}
