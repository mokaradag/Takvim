import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

const clipping = new AsyncLocalStorage();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function dataText(value, maxChars = 200) {
  if (value == null) return '';
  let text = String(value).replace(CONTROL, ' ').replace(/[【】]/g, (mark) => mark === '【' ? '(' : ')');
  text = text.replace(/\[(\s*R\d{1,3}\s*)\]/gi, '($1)');
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
    clipping.getStore()?.add(text);
  }
  return text;
}

function containsClipped(value, clipped) {
  if (typeof value === 'string') return clipped.has(value);
  if (Array.isArray(value)) return value.some((item) => containsClipped(item, clipped));
  return value && typeof value === 'object' && Object.values(value).some((item) => containsClipped(item, clipped));
}

/**
 * Aracın ürettiği metinlerden kısaltılanları izler. `project`, modele gidecek
 * izdüşümdür: yalnızca izdüşümden SONRA kalan kısaltılmış metin sonucu eksik
 * yapar (seçilmeyen serbest metin, kısaltılmış olsa da iz bırakmaz).
 */
export async function trackResultText(work, project = (data) => data) {
  const clipped = new Set();
  const outcome = await clipping.run(clipped, work);
  if (clipped.size && containsClipped(project(outcome.data), clipped)) {
    return { ...outcome, data: { ...outcome.data, textClipped: true }, complete: false, truncated: true };
  }
  return outcome;
}
