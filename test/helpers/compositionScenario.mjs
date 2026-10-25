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
 * Bütün olguları temsil eden geçerli düzen: kısa bir giriş paragrafı ve her tablo/ayrıntı bloğu.
 * Basit sayfada bütün yuvalar tek paragrafta kullanılır.
 */
export function coveringBlocks(view, { lead = null } = {}) {
  const english = view.language === 'en';
  if (view.shape === 'simple') {
    const ids = view.facts.map((fact) => `{${fact.id}}`).join(', ');
    return { blocks: [{ type: 'paragraph', text: lead ? lead(view) : (english ? `Verified result: ${ids}.` : `Doğrulanmış sonuç: ${ids}.`) }] };
  }
  // Giriş, kayda bağlı olmayan bir olguya (ör. toplam) ya da bir kaydın adına dayanır; adsız kayıt değeri birden çok
  // kayıtlı yanıtta reddedilir.
  const anchor = view.facts.find((fact) => fact.row == null && fact.role === 'label') || view.facts.find((fact) => fact.row == null && !fact.subject)
    || view.facts.find((fact) => fact.role === 'label');
  return { blocks: [
    { type: 'paragraph', text: lead ? lead(view) : (english ? `Here is what the verified data shows, starting with {${anchor.id}}.` : `Doğrulanmış veriye göre öne çıkan {${anchor.id}}.`) },
    ...view.tables.map((table) => ({ type: 'rows', source: table.id })),
    ...view.details.map((detail) => ({ type: 'details', source: detail.id }))
  ] };
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
