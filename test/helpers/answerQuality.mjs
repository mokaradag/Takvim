/**
 * Yanıt metninin yapı ve dil kalitesi ölçüleri (Aşama F kalite kapısı). Yalnızca metne bakar; model çağrısı yoktur.
 * Ölçüler: çok bölümlülük (iki ya da daha çok kanıt), açılışın cümle olması, kapanış, cümlesiz tablo, mekanik kalıplar,
 * aynı cümlenin yinelenmesi ve tablo üstü ölçüt satırı sayısı.
 */
export const MECHANICAL_PATTERNS = Object.freeze([/Eşleşen/, /Kayıt sayısı:/, /\*\* \/ \*\*/, /sayısında en üstte/, /Atama dağılımı tam:/, /\*\*0\*\*'ı/,
  /\*\*0\*\*[^.\n]*bulunuyor/, /Etiket metni:/, /\*\*Sonuç:\*\*/]);
const ENDING = /(\*\*|#### )Öncelikli konular|\*\*Öne çıkan konu:\*\*|(yeterli|listeleyebilirim)\.\s*(\n\n_Not:[^\n]*)?\s*$/;
const NON_PROSE = /^(#### |\||_|```|- |\d+\. |> )/;

export function answerQuality(content) {
  const text = String(content || '');
  const blocks = text.split('\n\n').map((block) => block.trim()).filter((block) => block && !block.startsWith('_Not:'));
  const evidence = new Set(text.match(/【R\d+】/g) || []);
  let spoken = false;
  let bareTables = 0;
  for (const block of blocks) {
    if (block.startsWith('#### ')) spoken = false;
    else if (block.startsWith('|')) { if (!spoken) bareTables += 1; }
    else if (!NON_PROSE.test(block)) spoken = true;
  }
  const sentences = blocks.filter((block) => !NON_PROSE.test(block))
    .flatMap((block) => block.replace(/【R\d+】/g, '').split(/(?<=[.!?])\s+/)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 25);
  const duplicates = sentences.length - new Set(sentences).size;
  return {
    multi: evidence.size >= 2,
    opening: blocks.length > 0 && !NON_PROSE.test(blocks[0]),
    ending: ENDING.test(text),
    bareTables,
    mechanical: MECHANICAL_PATTERNS.filter((pattern) => pattern.test(text)).map(String),
    duplicates,
    captions: (text.match(/^_Ölçüt: /gm) || []).length
  };
}
