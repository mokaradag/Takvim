/**
 * Rota AI yanıtlarının GÜVENLİ Markdown çözücüsü — saf, tarayıcıdan bağımsız.
 *
 * Çıktı yalnızca bir veri ağacıdır; HTML üretilmez ve model çıktısındaki HTML
 * YORUMLANMAZ (`<script>` gibi etiketler olduğu gibi metin olarak görünür).
 * Ağaç React öğelerine `AssistantMarkdown.jsx` içinde çevrilir; metin her
 * zaman React'in kaçışlı metin düğümüdür, `dangerouslySetInnerHTML` yoktur.
 *
 * Desteklenenler: paragraf ve satır sonu, başlık, madde ve numaralı liste
 * (iç içe), alıntı, çitli kod bloğu, tablo, yatay çizgi, kalın/italik/üstü
 * çizili metin, satır içi kod ve bağlantı. Bağlantı yalnızca `http`, `https`
 * ve `mailto` adreslerine verilir; görsel HİÇBİR ZAMAN yüklenmez, yalnızca
 * açık bir bağlantı olarak gösterilir.
 *
 * Çalışma süresi sınırlıdır: iç içe blok derinliği, satır içi vurgu
 * ayırıcılarının sayısı ve bağlantı adresinin uzunluğu üst sınırlıdır; akış
 * sırasında yarım kalan yapı (kapanmamış kod bloğu) güvenle çizilir.
 */

export const MARKDOWN_LIMITS = Object.freeze({
  maxDepth: 6,
  maxDelimiters: 400,
  maxLinkChars: 2048,
  maxLinkLabelChars: 1000,
  maxTableColumns: 24
});

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const PUNCTUATION = /[!-/:-@[-`{-~¡-¿‐-‧‰-⁞]/;

/* ── Bağlantı güvenliği ──────────────────────────────────────── */

/**
 * Model çıktısındaki adres güvenli mi? Yalnızca mutlak `http`, `https` ve
 * `mailto` adresleri kabul edilir; kullanıcı adı/parola taşıyan (yanıltıcı)
 * adresler, göreli adresler ve betik şemaları reddedilir. Güvenliyse
 * normalleştirilmiş adres, değilse `null` döner.
 */
export function safeLinkHref(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MARKDOWN_LIMITS.maxLinkChars || /[\s\u0000-\u001f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol !== 'mailto:' && (!url.hostname || url.username || url.password)) return null;
  return url.href;
}

/* ── Satır içi çözümleme ─────────────────────────────────────── */

function isWhitespace(char) {
  return char === undefined || char === '' || /\s/.test(char);
}

function isPunctuation(char) {
  return char !== undefined && PUNCTUATION.test(char);
}

function textNode(value) {
  return { type: 'text', value };
}

function pushText(tokens, value) {
  if (!value) return;
  const last = tokens[tokens.length - 1];
  if (last?.type === 'text') last.value += value;
  else tokens.push(textNode(value));
}

/** `index` konumundaki aynı karakter dizisinin uzunluğu (metin kopyalanmaz). */
function runLength(text, index, char) {
  let end = index;
  while (text[end] === char) end += 1;
  return end - index;
}

/**
 * Ters tırnak dizilerinin konumları, uzunluğa göre. Kapanış araması her satır
 * içi kod için metni baştan taramaz: çözümleme metin boyunda doğrusal kalır.
 */
function backtickRuns(text) {
  const byLength = new Map();
  let index = text.indexOf('`');
  while (index >= 0) {
    const length = runLength(text, index, '`');
    if (!byLength.has(length)) byLength.set(length, []);
    byLength.get(length).push(index);
    index = text.indexOf('`', index + length);
  }
  return byLength;
}

/** `after` konumundan sonra başlayan, TAM `length` uzunluğundaki ilk dizi; yoksa -1. */
function closingBacktickRun(runs, length, after) {
  const starts = runs.get(length);
  if (!starts) return -1;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] > after) high = middle;
    else low = middle + 1;
  }
  return low < starts.length ? starts[low] : -1;
}

/**
 * Köşeli ve normal ayraç eşleri TEK geçişte bulunur (kaçışlı karakterler ve
 * satır içi kod atlanır; bağlantı hedefi satır aşmaz). Her `[` ya da `(` için
 * kapanış araması bir tablo okumasıdır: çok sayıda açık ayraç içeren metin
 * karesel süre üretmez.
 */
function bracketPairs(text, runs) {
  const pairs = new Map();
  const squares = [];
  const rounds = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '`') {
      const length = runLength(text, index, '`');
      const close = closingBacktickRun(runs, length, index);
      index = (close < 0 ? index : close) + length - 1;
    } else if (char === '[') {
      squares.push(index);
    } else if (char === ']') {
      if (squares.length) pairs.set(squares.pop(), index);
    } else if (char === '(') {
      rounds.push(index);
    } else if (char === ')') {
      if (rounds.length) pairs.set(rounds.pop(), index);
    } else if (char === '\n') {
      rounds.length = 0;
    }
  }
  return pairs;
}

/** `[` konumundaki bağlantı metninin kapanış `]` konumu; yoksa ya da metin çok uzunsa -1. */
function closingBracket(pairs, open) {
  const close = pairs.get(open);
  return close != null && close - open <= MARKDOWN_LIMITS.maxLinkLabelChars ? close : -1;
}

/** `(` konumundan başlayan bağlantı hedefi: `{ href, end }`; biçim uymuyorsa `null`. */
function linkDestination(text, pairs, open) {
  const close = pairs.get(open);
  if (close == null || close - open > MARKDOWN_LIMITS.maxLinkChars + 256) return null;
  const inner = text.slice(open + 1, close).trim();
  // İsteğe bağlı başlık (`"…"`) yok sayılır; hedef ilk boşluğa kadardır.
  const angle = inner.startsWith('<') ? inner.indexOf('>') : -1;
  const target = inner.startsWith('<') ? inner.slice(1, angle > 0 ? angle : undefined) : inner.split(/\s+/)[0];
  return { href: target || '', end: close };
}

const BARE_URL = /(?:https?:\/\/|mailto:)[^\s<>"'`]{1,2048}/iy;

/** Çıplak adresin sonundaki noktalama ve dengesiz kapanış ayraçları adrese dâhil edilmez. */
function trimBareUrl(candidate) {
  let url = candidate.replace(/[.,;:!?*_~]+$/, '');
  while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) {
    url = url.slice(0, -1).replace(/[.,;:!?*_~]+$/, '');
  }
  return url;
}

function delimiterToken(text, index, char, count) {
  const before = text[index - 1];
  const after = text[index + count];
  const leftFlanking = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const rightFlanking = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  let canOpen = leftFlanking;
  let canClose = rightFlanking;
  // `_` kelime içinde vurgu açmaz: `dosya_adi_v2` olduğu gibi kalır.
  if (char === '_') {
    canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
    canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
  }
  return { type: 'delim', char, count, canOpen, canClose };
}

/**
 * Metni belirteçlere ayırır: düz metin, satır içi kod, bağlantı, satır sonu
 * ve vurgu ayırıcıları. Ayırıcılar sonra `resolveEmphasis` ile eşlenir.
 */
function tokenizeInline(text, { links, budget }) {
  const tokens = [];
  const runs = backtickRuns(text);
  const pairs = links && text.includes('[') ? bracketPairs(text, runs) : null;
  let nextAngleClose = -2;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length && isPunctuation(text[index + 1])) {
      pushText(tokens, text[index + 1]);
      index += 2;
      continue;
    }
    if (char === '\n') {
      tokens.push({ type: 'break' });
      index += 1;
      continue;
    }
    if (char === '`') {
      const length = runLength(text, index, '`');
      const close = closingBacktickRun(runs, length, index);
      if (close >= 0) {
        let code = text.slice(index + length, close).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        tokens.push({ type: 'code', value: code });
        index = close + length;
      } else {
        pushText(tokens, '`'.repeat(length));
        index += length;
      }
      continue;
    }
    if (pairs && (char === '[' || (char === '!' && text[index + 1] === '['))) {
      const image = char === '!';
      const open = image ? index + 1 : index;
      const close = closingBracket(pairs, open);
      const destination = close > 0 && text[close + 1] === '(' ? linkDestination(text, pairs, close + 1) : null;
      if (destination) {
        const label = text.slice(open + 1, close);
        const href = safeLinkHref(destination.href);
        const children = parseInline(label, { links: false });
        if (href) {
          tokens.push({ type: 'link', href, image, children: image && !label.trim() ? [textNode('Görsel')] : children });
        } else {
          // Güvenli olmayan hedef: yalnızca bağlantı metni görünür.
          tokens.push({ type: 'group', children });
        }
        index = destination.end + 1;
        continue;
      }
    }
    if (links && char === '<') {
      if (nextAngleClose !== -1 && nextAngleClose <= index) nextAngleClose = text.indexOf('>', index + 1);
      const end = nextAngleClose;
      const href = end > index && end - index <= MARKDOWN_LIMITS.maxLinkChars + 1
        ? safeLinkHref(text.slice(index + 1, end)) : null;
      if (href) {
        tokens.push({ type: 'link', href, image: false, children: [textNode(text.slice(index + 1, end))] });
        index = end + 1;
        continue;
      }
    }
    if (links && (char === 'h' || char === 'H' || char === 'm' || char === 'M') && (index === 0 || /[\s(]/.test(text[index - 1]))) {
      BARE_URL.lastIndex = index;
      const match = BARE_URL.exec(text);
      const candidate = match ? trimBareUrl(match[0]) : '';
      const href = candidate ? safeLinkHref(candidate) : null;
      if (href) {
        tokens.push({ type: 'link', href, image: false, children: [textNode(candidate)] });
        index += candidate.length;
        continue;
      }
    }
    if (char === '*' || char === '_' || char === '~') {
      const length = runLength(text, index, char);
      // Yalnızca tam iki `~` üstü çizili yazıdır; "~5 gün" düz metin kalır.
      const usable = char !== '~' || length === 2;
      if (usable && budget.delimiters < MARKDOWN_LIMITS.maxDelimiters) {
        budget.delimiters += 1;
        tokens.push(delimiterToken(text, index, char, length));
      } else {
        pushText(tokens, char.repeat(length));
      }
      index += length;
      continue;
    }
    let next = index + 1;
    while (next < text.length && !'\\\n`[!<*_~hHmM'.includes(text[next])) next += 1;
    pushText(tokens, text.slice(index, next));
    index = next;
  }
  return tokens;
}

function tokenToNode(token) {
  if (token.type === 'delim') return textNode(token.char.repeat(token.count));
  if (token.type === 'group') return { type: 'group', children: token.children };
  return token;
}

function mergeText(nodes) {
  const merged = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.value += node.value;
    else if (node.type === 'text') merged.push({ ...node });
    else merged.push(node);
  }
  return merged;
}

/** Vurgu ayırıcılarını eşler (CommonMark "process emphasis" yordamının sade bir biçimi). */
function resolveEmphasis(tokens) {
  const openers = [];
  let index = 0;
  while (index < tokens.length) {
    const closer = tokens[index];
    if (closer.type !== 'delim') {
      index += 1;
      continue;
    }
    let matched = false;
    if (closer.canClose) {
      for (let stackIndex = openers.length - 1; stackIndex >= 0; stackIndex -= 1) {
        const openerIndex = openers[stackIndex];
        const opener = tokens[openerIndex];
        if (opener.char !== closer.char) continue;
        const use = closer.char === '~' ? 2 : (opener.count >= 2 && closer.count >= 2 ? 2 : 1);
        const type = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        const inner = tokens.slice(openerIndex + 1, index).map(tokenToNode);
        const element = { type, children: mergeText(inner) };
        opener.count -= use;
        closer.count -= use;
        tokens.splice(openerIndex + 1, index - openerIndex - 1, element);
        openers.length = stackIndex + 1;
        index = openerIndex + 2;
        if (opener.count === 0) {
          tokens.splice(openerIndex, 1);
          openers.pop();
          index -= 1;
        }
        if (closer.count === 0) {
          tokens.splice(index, 1);
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (closer.canOpen) openers.push(index);
    index += 1;
  }
  return mergeText(tokens.map(tokenToNode));
}

/** Satır içi Markdown → düğüm listesi. */
export function parseInline(text, { links = true } = {}) {
  const budget = { delimiters: 0 };
  return resolveEmphasis(tokenizeInline(String(text ?? ''), { links, budget }));
}

/* ── Blok çözümleme ──────────────────────────────────────────── */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
// Numaralı madde en çok üç basamaklıdır: "1923. yılda" gibi Türkçe sıra sayıları liste sayılmaz.
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,3}[.)])(?:([ \t]+)(.*))?$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line) {
  return !line || !line.trim();
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

/** Satır başındaki sekmeler dört boşluğa açılır; girinti hesabı tek birimle yapılır. */
function expandLeadingTabs(line) {
  return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    '));
}

function listMarker(line) {
  const match = line.match(LIST_ITEM);
  if (!match) return null;
  const [, indent, marker, spacing = '', content = ''] = match;
  // Madde işaretinden sonra boşluk yoksa (ör. "-5") liste değildir; boş madde ise geçerlidir.
  if (!spacing && content === '' && line.length > indent.length + marker.length) return null;
  const ordered = /\d/.test(marker[0]);
  const gap = spacing.length >= 1 && spacing.length <= 4 ? spacing.length : 1;
  return {
    ordered,
    bullet: ordered ? null : marker,
    start: ordered ? Number.parseInt(marker, 10) : null,
    offset: indent.length + marker.length + gap,
    content: spacing.length > 4 ? `${spacing.slice(1)}${content}` : content
  };
}

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let current = '';
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignments(line) {
  return splitTableRow(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : null;
  });
}

function startsTable(lines, index) {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (!header?.includes('|') || !delimiter || !TABLE_DELIMITER.test(delimiter) || !delimiter.includes('-')) return false;
  const columns = splitTableRow(header).length;
  return columns >= 1 && columns <= MARKDOWN_LIMITS.maxTableColumns && splitTableRow(delimiter).length === columns;
}

/** Paragrafı kesen satır mı? Numaralı liste paragrafı yalnızca `1.` ile keser ("1923. yılda" düz metindir). */
function interruptsParagraph(lines, index) {
  const line = lines[index];
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || startsTable(lines, index)) return true;
  const marker = listMarker(line);
  return Boolean(marker && marker.content.trim() && (!marker.ordered || marker.start === 1));
}

function parseList(lines, start, depth) {
  const first = listMarker(lines[start]);
  const list = { type: 'list', ordered: first.ordered, start: first.start, tight: true, items: [] };
  let index = start;
  let marker = first;
  while (marker) {
    const itemLines = [marker.content];
    let sawBlank = false;
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (isBlank(line)) {
        sawBlank = true;
        itemLines.push('');
        index += 1;
        continue;
      }
      if (indentOf(line) >= marker.offset) {
        if (sawBlank) list.tight = false;
        sawBlank = false;
        itemLines.push(line.slice(marker.offset));
        index += 1;
        continue;
      }
      if (listMarker(line) || sawBlank || interruptsParagraph(lines, index)) break;
      // Tembel devam satırı: girintisiz ama paragrafı sürdüren metin.
      itemLines.push(line.trim());
      index += 1;
    }
    while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
    list.items.push(parseBlockLines(itemLines, depth + 1));
    const next = index < lines.length ? listMarker(lines[index]) : null;
    const sameKind = next && next.ordered === first.ordered && (first.ordered || next.bullet === first.bullet)
      && indentOf(lines[index]) < first.offset;
    if (!sameKind) break;
    if (sawBlank) list.tight = false;
    marker = next;
  }
  return { block: list, next: index };
}

function parseBlockLines(lines, depth) {
  const blocks = [];
  if (depth > MARKDOWN_LIMITS.maxDepth) {
    const text = lines.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', children: parseInline(text) });
    return blocks;
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const start = index;
    const fence = line.match(FENCE);
    if (fence) {
      const [, run, language] = fence;
      const indent = indentOf(line);
      const body = [];
      let closed = false;
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        const closing = candidate.trim();
        if (closing.length >= run.length && closing === run[0].repeat(closing.length)) {
          closed = true;
          index += 1;
          break;
        }
        body.push(candidate.slice(Math.min(indent, indentOf(candidate))));
        index += 1;
      }
      blocks.push({ type: 'code', language: language.slice(0, 32), text: body.join('\n'), closed, source: lines.slice(start, index).join('\n') });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const content = heading[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(content), source: line });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule', source: line });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length && !isBlank(lines[index]) && (QUOTE.test(lines[index]) || !interruptsParagraph(lines, index))) {
        quoted.push(lines[index].replace(QUOTE, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseBlockLines(quoted, depth + 1), source: lines.slice(start, index).join('\n') });
      continue;
    }
    if (listMarker(line)) {
      const { block, next } = parseList(lines, index, depth);
      index = next;
      blocks.push({ ...block, source: lines.slice(start, index).join('\n') });
      continue;
    }
    if (startsTable(lines, index)) {
      const header = splitTableRow(line);
      const align = tableAlignments(lines[index + 1]);
      const rows = [];
      index += 2;
      while (index < lines.length && !isBlank(lines[index]) && lines[index].includes('|')) {
        const cells = splitTableRow(lines[index]).slice(0, header.length);
        while (cells.length < header.length) cells.push('');
        rows.push(cells.map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({
        type: 'table',
        align: header.map((_, column) => align[column] ?? null),
        header: header.map((cell) => parseInline(cell)),
        rows,
        source: lines.slice(start, index).join('\n')
      });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]) && !interruptsParagraph(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')), source: lines.slice(start, index).join('\n') });
  }
  return blocks;
}

/**
 * Yanıt metni → blok listesi. Her üst düzey blok kendi kaynak metnini
 * (`source`) taşır: akış sırasında yalnızca değişen son blok yeniden çizilir.
 */
export function parseAssistantMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandLeadingTabs);
  return parseBlockLines(lines, 0);
}

/** Düğüm ağacının görünen düz metni (erişilebilir ad ve testler için). */
export function inlineText(nodes = []) {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.value;
    if (node.type === 'break') return '\n';
    return inlineText(node.children);
  }).join('');
}

/** Tamamlanan blokları korur; son iki blok ileri bakış için yeniden çözülür. */
export function createAssistantMarkdownParser() {
  let previous = '';
  let blocks = [];
  let starts = [];
  return (text) => {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandLeadingTabs).join('\n');
    if (normalized === previous) return blocks;
    const keep = normalized.startsWith(previous) ? Math.max(0, blocks.length - 2) : 0;
    const offset = keep ? starts[keep] : 0;
    const tail = parseBlockLines(normalized.slice(offset).split('\n'), 0);
    let cursor = offset;
    const tailStarts = tail.map((block) => {
      const start = normalized.indexOf(block.source, cursor);
      cursor = start + block.source.length;
      return start;
    });
    blocks = [...blocks.slice(0, keep), ...tail];
    starts = [...starts.slice(0, keep), ...tailStarts];
    previous = normalized;
    return blocks;
  };
}
