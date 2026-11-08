import { nextStepSentence } from '../../src/domain/ai/analyticalFindings.js';
/**
 * Yanıt metninin yapı ve dil kalitesi ölçüleri (Aşama F kalite kapısı). Yalnızca metne bakar; model çağrısı yoktur.
 * Ölçüler: çok bölümlülük (iki ya da daha çok kanıt), açılışın cümle olması, kapanış, cümlesiz tablo, mekanik kalıplar,
 * aynı cümlenin yinelenmesi ve tablo üstü ölçüt satırı sayısı.
 */
export const MECHANICAL_PATTERNS = Object.freeze([/Eşleşen/, /Kayıt sayısı:/, /\*\*\d+(?:[.,]\d+)?\*\*\s*\/\s*\*\*\d+(?:[.,]\d+)?\*\*/, /sayısında en üstte/, /Atama dağılımı tam:/, /\*\*0\*\*'ı/,
  /\*\*0\*\*[^.\n]*bulunuyor/, /Etiket metni:/, /\*\*Sonuç:\*\*/]);
const PRIORITY_HEADING = /^(?:\*\*|#### )(?:Öncelikli konular|Priorities)(?:\*\*)?$/;

const NEXT_STEPS = new Set(['tr', 'en'].flatMap((locale) => [[], ...['workload', 'projects', 'status', 'deadlines', 'priority', 'critical', 'schedule'].map((focus) => [focus])]
  .map((focus) => nextStepSentence(focus, locale).markdown)));

/** Yalnızca son içerik bloğu kapanış olabilir; erken sonuç başlığı daha sonraki tabloyu gizleyemez. */
function hasEnding(blocks) {
  const last = blocks.at(-1) || '';
  return /^\*\*(?:Öne çıkan konu|Key point):\*\* .+/.test(last) && !last.includes('\n')
    || PRIORITY_HEADING.test(blocks.at(-2) || '') && /^1\. [^\n]+(?:\n[2-9]\. [^\n]+)*$/.test(last)
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
  const sentences = blocks.filter((block) => !NON_PROSE.test(block))
    .flatMap((block) => block.replace(/【R\d+】/g, '').split(/(?<=[.!?])\s+/)).map((sentence) => sentence.trim()).filter(Boolean);
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
