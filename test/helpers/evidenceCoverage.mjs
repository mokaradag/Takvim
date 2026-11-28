/**
 * Bilgin ICE-2 — kanıt kartı kapsamı muhasebesi (yalnızca sınama ve geliştirme aracı; üretim kodu değildir).
 *
 * Teslim edilen yanıtın her kalın ifadesi (iddia) bağlamıyla birlikte çıkarılır ve UYGULAMADAN BAĞIMSIZ kurallarla sınıflanır:
 * görev sayısı, varlık sayısı (kişi/proje/birim), yüzde, ad ya da diğer. Uygunluk yanıtın anlamından tanımlanır; bağın kurulup
 * kurulmadığı uygunluğu değiştirmez. Bağsız uygun iddia ya gerekçeli bir nedene (ör. hareket kaydı, eşitlik, sıfır nüfus) ya da
 * "beklenmedik bağsız" sınıfına düşer. Bağlı iddia kartıyla karşılaştırılır: sayı kartın toplamına, yüzde hesap sonucuna, ad
 * kartın başlığına eşit olmalı; "gecikmiş/tamamlanan/açık" nitelemesi kartın satırlarıyla çelişmemelidir.
 *
 * Bu sınıflayıcı yanıt METNİNİ okur; bu yalnızca sınamada kabul edilebilir. Üretimdeki bağ metin araması yapmaz.
 */
import { inlineText, parseAssistantMarkdown } from '../../src/features/ai/assistant/assistantMarkdown.js';

const NUMBER = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:['’][a-zçğıöşü]+)?$/iu;
const PERCENT = /^%(\d+(?:,\d+)?)(?:['’][a-zçğıöşü]+)?$|^(\d+(?:\.\d+)?)%$/iu;
const TASK_NOUN = /^\s*(?:[^\s.;:!?()]+\s+){0,5}?(?:görev|kilometre taşı|tasks?\b|milestones?\b)/iu;
const ENTITY_NOUN = /^\s*(?:[^\s.;:!?()]+\s+){0,2}?(?:proje|kişi|bölüm|birim|projects?\b|people\b|persons?\b|departments?\b|units?\b)/iu;
/** Sayının hemen ardından gelen ilk sözcük varlık adıysa ("**9** projenin") ya da "N projenin **8**'inde" kalıbındaysa varlık sayısıdır. */
const ENTITY_FIRST = /^\s*(?:proje|kişi|bölüm|birim|projects?\b|people\b|persons?\b|departments?\b|units?\b)/iu;
const ENTITY_LOCATIVE = /(?:projenin|kişinin|bölümün|birimin|projects|people)\s*$/iu;
/** Süre birimi (hafta, ay, gün): "Son **3** tam haftada" bir görev sayısı değildir. */
const TIME_FIRST = /^\s*(?:tam\s+)?(?:hafta|ay\b|aylık|gün|weeks?\b|months?\b|days?\b|full\s+(?:weeks?|months?))/iu;

/** Türkçe/İngilizce biçimli tam sayı (binlik ayırıcı, iyelik eki). */
export function claimNumber(text) {
  const match = NUMBER.exec(String(text).trim());
  return match ? Number(match[1].replace(/\./g, '')) : null;
}

/** Yüzde değeri ("%42", "%60'ı", "%0,33", "42%"). */
export function claimPercent(text) {
  const match = PERCENT.exec(String(text).trim());
  if (!match) return null;
  return Number((match[1] || match[2]).replace(',', '.'));
}

function units(blocks, out = []) {
  for (const block of blocks || []) {
    if (block.type === 'paragraph' || block.type === 'heading') out.push(block.children);
    else if (block.type === 'quote') units(block.children, out);
    else if (block.type === 'list') for (const item of block.items || []) units(item, out);
    else if (block.type === 'table') {
      for (const cell of block.header || []) out.push(cell);
      for (const row of block.rows || []) for (const cell of row) out.push(cell);
    }
  }
  return out;
}

/** Kalın ifadeler ÇİZİM SIRASIYLA (strongTexts ile aynı sıra) ve bulundukları cümle parçasının bağlamı. */
export function extractClaims(content) {
  const claims = [];
  for (const nodes of units(parseAssistantMarkdown(content, { rotaData: true }))) {
    let text = '';
    const local = [];
    const visit = (list) => {
      for (const node of list || []) {
        if (node.type === 'strong') {
          const start = text.length;
          const value = inlineText(node.children);
          text += value;
          local.push({ text: value, start, end: text.length });
        } else if (node.type === 'text' || node.type === 'code') text += node.value;
        else if (node.type === 'cite') text += ' ';
        else if (node.type === 'break') text += '\n';
        else if (Array.isArray(node.children)) visit(node.children);
      }
    };
    visit(nodes);
    for (const claim of local) {
      const before = text.slice(0, claim.start);
      const after = text.slice(claim.end);
      const sentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1;
      const sentenceEnd = (() => { const index = after.search(/\.(\s|$)/); return index < 0 ? after.length : index; })();
      claims.push({ text: claim.text, before: before.slice(-80), after: after.slice(0, 80), sentence: `${before.slice(sentenceStart)}${claim.text}${after.slice(0, sentenceEnd)}` });
    }
  }
  return claims.map((claim, strong) => ({ ...claim, strong }));
}

/** İddianın anlam sınıfı (bağdan bağımsız). */
export function claimCategory(claim, names = new Set()) {
  const value = claimNumber(claim.text);
  if (value != null && (ENTITY_FIRST.test(claim.after) || ENTITY_LOCATIVE.test(claim.before) && /^['’]/u.test(claim.after))) return 'entityCount';
  if (value != null && TIME_FIRST.test(claim.after)) return 'other';
  if (value != null && TASK_NOUN.test(claim.after)) return 'taskCount';
  if (value != null && /(?:açık|gecikmiş|tamamlanmış|yapılacak|devam eden)\s+$/iu.test(claim.before) && /^['’]?[a-zçğıöşü]*\s/iu.test(claim.after) && TASK_NOUN.test(` ${claim.before.slice(-30)}`)) return 'taskCount';
  if (value != null && /(?:görevin|görevden|görev arasında|kilometre taşından|kilometre taşının)\s+$/iu.test(claim.before)) return 'taskCount';
  if (value != null && ENTITY_NOUN.test(claim.after)) return 'entityCount';
  if (claimPercent(claim.text) != null) return 'percent';
  if (names.has(claim.text) || [...names].some((name) => claim.text.endsWith(` · ${name}`))) return 'name';
  return 'other';
}

/**
 * Bağsız görev sayısının gerekçesi (yanıtın anlamından; uygulamadan bağımsız). `null`: gerekçe yok (beklenmedik bağsız).
 * Gerekçeler: başarılı olmayan sonuç (kart yalnızca doğrulanmış başarılı yanıtta), sıfır nüfus, hareket kaydı sayıları
 * (denetim kayıtları; silinmiş görevleri de içerir), sabit eşik, eşitlikte birden çok nüfus, alt sınır.
 */
export function unboundReason(claim, { finish }) {
  if (finish !== 'stop') return 'başarılı-olmayan-sonuç';
  if (claimNumber(claim.text) === 0) return 'sıfır-nüfus';
  if (/hareket|activity|reopened|yeniden açıldı|silindi|yalnızca güncellendi|deleted|only updated/iu.test(claim.sentence)) return 'hareket-kaydı';
  if (/\((?:en az|at least)\s*$/iu.test(claim.before) && /açık görevi olanlar|open tasks\)/iu.test(claim.after)) return 'eşik-sabiti';
  if (/(?:ikisinde|üçünde|hepsinde) de\s*$|each\)?\s*$/iu.test(claim.before) || /^\s*[^.]*\beach\b/iu.test(claim.after.slice(0, 30))) return 'eşitlik';
  if (/(?:^|\s)(?:en az|at least)\s*$/iu.test(claim.before)) return 'alt-sınır';
  return null;
}

/** Sayının hemen ardından gelen niteleme (en çok bir ara sözcükle) ve kart satırlarının sağlaması gereken koşul. */
const ITEM_PREDICATES = Object.freeze([
  [/^['’]?[a-zçğıöşü]*\s+(?:[^\s]+\s+)?(?:gecikmiş|overdue)\b/iu, (item) => item.overdue === true, 'gecikmiş'],
  [/^['’]?[a-zçğıöşü]*\s+(?:[^\s]+\s+)?(?:tamamlan|completed\b)/iu, (item) => item.status === 'done', 'tamamlanmış'],
  [/^['’]?[a-zçğıöşü]*\s+(?:açık|open)\b/iu, (item) => item.status !== 'done', 'açık'],
  [/^['’]?[a-zçğıöşü]*\s+(?:yapılacak|to-do)\b/iu, (item) => item.status === 'todo', 'yapılacak'],
  [/^['’]?[a-zçğıöşü]*\s+(?:devam eden|in-progress)\b/iu, (item) => item.status === 'in_progress', 'devam eden']
]);

/** Bağlı iddianın kartla tutarlılığı; tutarsızlık açıklaması ya da `null`. */
export function incorrectBinding(claim, card) {
  const category = claim.category;
  if (category === 'taskCount') {
    const value = claimNumber(claim.text);
    if (card.kind === 'tasks') {
      if (card.total !== value) return `sayı ${value}, kart toplamı ${card.total}`;
      for (const [pattern, predicate, label] of ITEM_PREDICATES) {
        if (pattern.test(claim.after) && card.items.some((item) => !predicate(item))) return `"${label}" iddiasıyla çelişen kart satırı`;
      }
      return null;
    }
    if (card.kind === 'task') return value === 1 ? null : `tekil görev kartı ${value} sayısına bağlı`;
    if (card.kind === 'compare') {
      const values = card.metrics.map((metric) => claimNumber(metric.value));
      const gap = Math.abs(values[1] - values[0]);
      return values.includes(value) || gap === value ? null : `karşılaştırma kartı ${value} değerini içermiyor`;
    }
    return `görev sayısı ${card.kind} kartına bağlı`;
  }
  if (category === 'entityCount') {
    if (['people', 'projects', 'units'].includes(card.kind)) return card.total === claimNumber(claim.text) ? null : `varlık sayısı ${claim.text}, kart ${card.total}`;
    return `varlık sayısı ${card.kind} kartına bağlı`;
  }
  if (category === 'percent') {
    if (!['calc', 'compare'].includes(card.kind)) return `yüzde ${card.kind} kartına bağlı`;
    const value = claimPercent(claim.text);
    const shown = claimPercent(card.result.replace(/^.*?(%[\d,]+).*$/u, '$1')) ?? claimPercent(card.result.match(/%[\d.,]+/u)?.[0] || '');
    return shown === value ? null : `yüzde ${value}, kart sonucu ${card.result}`;
  }
  if (category === 'name') {
    if (['tasks', 'task'].includes(card.kind)) return null;
    return card.title === claim.text || card.title.endsWith(` · ${claim.text}`) || claim.text.endsWith(` · ${card.title}`) ? null : `ad "${claim.text}", kart "${card.title}"`;
  }
  return null;
}

/**
 * Bir yanıtın muhasebesi: her iddianın sınıfı, bağ durumu ve sonucu (doğru bağlı, gerekçeli bağsız, beklenmedik bağsız, yanlış bağlı).
 * `cards`: istemcinin doğruladığı tanımlayıcı (`normalizeEvidenceCards`), yoksa `null`.
 */
export function accountAnswer({ content, cards, finish, names }) {
  const byStrong = new Map((cards?.anchors || []).map((anchor) => [anchor.strong, cards.cards.find((card) => card.id === anchor.card)]));
  return extractClaims(content).map((claim) => {
    const category = claimCategory(claim, names);
    const card = byStrong.get(claim.strong) || null;
    const enriched = { ...claim, category };
    if (card) {
      const wrong = incorrectBinding(enriched, card);
      return { ...enriched, bound: true, card: card.kind, result: wrong ? 'yanlış-bağlı' : 'doğru-bağlı', ...(wrong ? { reason: wrong } : {}) };
    }
    if (category !== 'taskCount') return { ...enriched, bound: false, result: 'bağsız' };
    const reason = unboundReason(enriched, { finish });
    return { ...enriched, bound: false, result: reason ? 'gerekçeli-bağsız' : 'beklenmedik-bağsız', ...(reason ? { reason } : {}) };
  });
}
