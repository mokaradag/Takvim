/**
 * Etkileşimli kanıt kartlarının (ICE) konum gezintisi — saf, tarayıcıdan bağımsız.
 *
 * Bağ, yanıtın kalın (strong) düğümlerinin ÇİZİM SIRASIYLA numarasıdır. Sunucu bağı aynı saf çözücü ve aynı gezintiyle
 * bulur (`resolveBindingAnchors`); tarayıcı çizim sırasında aynı sırayı sayar. Gezinti `AssistantMarkdown.jsx` içindeki
 * `renderBlock`/`renderInline` sırasının birebir aynısıdır: önce düğüm, sonra çocukları; tabloda başlık, sonra satırlar.
 * Grafik ve kod blokları kalın düğüm taşımaz.
 */
import { inlineText, parseAssistantMarkdown } from './assistantMarkdown.js';

function walkInline(nodes, visit) {
  for (const node of nodes || []) {
    if (node.type === 'strong') visit(node);
    if (Array.isArray(node.children)) walkInline(node.children, visit);
  }
}

/** Tek bloğun kalın düğümleri, çizim sırasıyla. */
export function walkBlockStrong(block, visit) {
  switch (block?.type) {
    case 'paragraph':
    case 'heading':
      walkInline(block.children, visit);
      break;
    case 'quote':
      for (const child of block.children || []) walkBlockStrong(child, visit);
      break;
    case 'list':
      for (const item of block.items || []) for (const child of item) walkBlockStrong(child, visit);
      break;
    case 'table':
      for (const cell of block.header || []) walkInline(cell, visit);
      for (const row of block.rows || []) for (const cell of row) walkInline(cell, visit);
      break;
    default:
      break;
  }
}

/** Blok başına kalın düğüm başlangıç sırası (önek toplamı). */
export function blockStrongStarts(blocks = []) {
  const starts = [];
  let next = 0;
  for (const block of blocks) {
    starts.push(next);
    walkBlockStrong(block, () => { next += 1; });
  }
  return starts;
}

/** Metnin kalın düğümlerinin görünen metinleri, çizim sırasıyla (kanıta dayalı yanıt çözümü). */
export function strongTexts(text) {
  const out = [];
  for (const block of parseAssistantMarkdown(text, { rotaData: true })) walkBlockStrong(block, (node) => out.push(inlineText(node.children)));
  return out;
}
