/**
 * Yanıt metninin yapı ve dil kalitesi ölçüleri (Aşama F kalite kapısı). Yalnızca metne bakar; model çağrısı yoktur.
 * Ölçüler: çok bölümlülük (iki ya da daha çok kanıt), açılışın cümle olması, kapanış, cümlesiz tablo, mekanik kalıplar,
 * aynı cümlenin yinelenmesi ve tablo üstü ölçüt satırı sayısı.
 */
export const MECHANICAL_PATTERNS = Object.freeze([/Eşleşen/, /Kayıt sayısı:/, /\*\*\d+(?:[.,]\d+)?\*\*\s*\/\s*\*\*\d+(?:[.,]\d+)?\*\*/, /sayısında en üstte/, /Atama dağılımı tam:/, /\*\*0\*\*'ı/,
  /\*\*0\*\*[^.\n]*bulunuyor/, /Etiket metni:/, /\*\*Sonuç:\*\*/]);
const PRIORITY_HEADING = /^(?:\*\*|#### )(?:Öncelikli konular|Priorities)(?:\*\*)?$/;

// Beklenen kapanışlar üretim işlevinden türetilmez; istemeden değişen metin kapıyı kendiliğinden geçemez.
const NEXT_STEPS = new Set([
  'Herhangi bir bölümü daha ayrıntılı görmek isterseniz söylemeniz yeterli.',
  'Belirli bir kişinin işlerini ayrıntılı görmek isterseniz adını yazmanız yeterli.',
  'Bir projeyi ayrıntılı incelemek isterseniz adını yazmanız yeterli.',
  'Belirli bir durumdaki görevleri listelememi isterseniz durumu yazmanız yeterli.',
  'Gecikmiş ya da yaklaşan görevleri tek tek görmek isterseniz listeleyebilirim.',
  'Yüksek öncelikli görevleri tek tek görmek isterseniz listeleyebilirim.',
  'Kritik açık işleri tek tek görmek isterseniz listeleyebilirim.',
  'Belirli bir ayın teslimatlarını görmek isterseniz ayı yazmanız yeterli.',
  'If you want any part of this in more detail, just ask.',
  "If you want one person's work in detail, just name them.",
  'If you want to look at one project in detail, just name it.',
  'If you want the tasks in a given status listed, just name the status.',
  'I can list the overdue or upcoming tasks one by one if you want.',
  'I can list the high-priority tasks one by one if you want.',
  'I can list the critical open tasks one by one if you want.',
  "If you want one month's deliveries, just name the month."
]);

/** Yalnızca son içerik bloğu kapanış olabilir; erken sonuç başlığı daha sonraki tabloyu gizleyemez. */
function hasEnding(blocks) {
  const last = blocks.at(-1) || '';
  return /^\*\*(?:Öne çıkan konu|Key point):\*\* .+/.test(last) && !last.includes('\n')
    // Öncelik kapanışı bir paragraftır: sıra bağlaçlarıyla en az iki öncelik ve kaynak atfı taşır.
    || /^(?:Özetle öncelik sırası şöyle: önce .+; (?:ardından|son olarak) .+|In short, the order of priority is: first .+; (?:then|finally) .+)\. (?:【R\d+】\s*)+$/.test(last) && !last.includes('\n')
    || NEXT_STEPS.has(last);
}
const NON_PROSE = /^(#### |\||_|```|- |\d+\. |> )/;

export function answerQuality(content) {
  const text = String(content || '');
  const blocks = text.split('\n\n').map((block) => block.trim()).filter((block) => block && !/^_(?:Not:|Note:)/.test(block));
  const evidence = new Set(text.match(/【R\d+】/g) || []);
  let spoken = false;
  let bareTables = 0;
  for (const block of blocks) {
    if (block.startsWith('#### ')) spoken = false;
    else if (block.startsWith('|')) { if (!spoken) bareTables += 1; }
    else if (!NON_PROSE.test(block)) spoken = true;
  }
  const sentences = blocks.filter((block) => !NON_PROSE.test(block) || /^\d+\. /.test(block))
    .flatMap((block) => block.replace(/^\d+\. /gm, '').replace(/【R\d+】/g, '').split(/(?<=[.!?])\s+|\n/)).map((sentence) => sentence.trim()).filter(Boolean);
  const duplicates = sentences.length - new Set(sentences).size;
  return {
    multi: evidence.size >= 2 || blocks.filter((block) => /^#### /.test(block) && !PRIORITY_HEADING.test(block)).length >= 2,
    opening: blocks.length > 0 && !NON_PROSE.test(blocks[0]) && /[.!?]$/.test(blocks[0].replace(/【R\d+】/g, '').trim()),
    ending: hasEnding(blocks),
    bareTables,
    mechanical: MECHANICAL_PATTERNS.filter((pattern) => pattern.test(text)).map(String),
    duplicates,
    captions: (text.match(/^_Ölçüt: /gm) || []).length
  };
}
