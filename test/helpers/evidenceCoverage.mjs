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
import { strongTexts } from '../../src/features/ai/assistant/evidenceCardAnchors.js';
import { registerServerOnlyShim } from './serverOnlyShim.mjs';
registerServerOnlyShim();
const { decodeAuthorizationPopulation } = await import('../../src/server/ai/tools/evidenceAuthorization.js');
import { normalizeEvidenceCards } from '../../src/domain/ai/evidenceCards.js';
import { inlineText, parseAssistantMarkdown } from '../../src/features/ai/assistant/assistantMarkdown.js';

const NUMBER = /^(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d+)(?:['’]\p{L}+)?$/iu;
const PERCENT = /^%(\d{1,3}(?:\.\d{3})+|\d+)(,\d+)?(?:['’]\p{L}+)?$|^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?%$/iu;
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
  return match ? Number(match[1].replace(/[.,]/g, '')) : null;
}

/** Yüzde değeri ("%42", "%60'ı", "%0,33", "42%"). */
export function claimPercent(text) {
  const match = PERCENT.exec(String(text).trim());
  if (!match) return null;
  return Number(match[1] ? match[1].replaceAll('.', '') + (match[2] || '').replace(',', '.') : match[3].replaceAll(',', '') + (match[4] || ''));
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
    const evidenceIds = new Set();
    const visit = (list) => {
      for (const node of list || []) {
        if (node.type === 'strong') {
          const start = text.length;
          const value = inlineText(node.children);
          text += value;
          local.push({ text: value, start, end: text.length });
        } else if (node.type === 'text' || node.type === 'code') text += node.value;
        else if (node.type === 'cite') { evidenceIds.add(node.id); text += ' '; }
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
      claims.push({ text: claim.text, evidenceIds: [...evidenceIds], before: before.slice(-80), after: after.slice(0, 80), sentence: `${before.slice(sentenceStart)}${claim.text}${after.slice(0, sentenceEnd)}` });
    }
  }
  return claims.map((claim, strong) => ({ ...claim, strong }));
}

/** İddianın anlam sınıfı (bağdan bağımsız). */
export function claimCategory(claim, names = new Set()) {
  const value = claimNumber(claim.text);
  if (value != null && /(?:görebildiğiniz proje sayısı|gecikmiş görevi olan proje sayısı|number of (?:visible projects|projects with overdue tasks))\s*:?\s*$/iu.test(claim.before)) return 'entityCount';
  if (value != null && (ENTITY_FIRST.test(claim.after) || ENTITY_LOCATIVE.test(claim.before) && /^['’]/u.test(claim.after))) return 'entityCount';
  if (value != null && TIME_FIRST.test(claim.after)) return 'other';
  if (value != null && TASK_NOUN.test(claim.after)) return 'taskCount';
  if (value != null && /(?:tamamlanmış görevden dönen|completed tasks, the)\s*$/iu.test(claim.before)
    && /^\s*(?:tanesi|returned)/iu.test(claim.after)) return 'taskCount';
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
  if (finish !== 'stop') return null;
  if (claimNumber(claim.text) === 0) return 'sıfır-nüfus';
  if (/(?:\d[\d.,]*\s+(?:görev\p{L}* üzerinde|tasks?)\s+\d[\d.,]*\s+(?:hareket kayde|activity events)|\d[\d.,]*\s+(?:activity events|events)\s+(?:on|across)\s+\d[\d.,]*\s+tasks|görev önceki tamamlanmasının ardından yeniden açıldı|tasks? (?:was|were) reopened after an earlier completion)/iu.test(claim.sentence)
    || /(?:hareket kaydında|activity records show)\s*$/iu.test(claim.before)) return 'hareket-kaydı';
  if (/her iki okumada da|in both readings/iu.test(claim.before)
    && /gerçekleşen bitiş tarihi kayıtlı|recorded actual finish date/iu.test(claim.after)) return 'iki-ayrı-okuma';
  if (/\((?:en az|at least)\s*$/iu.test(claim.before) && /açık görevi olanlar|open tasks\)/iu.test(claim.after)) return 'eşik-sabiti';
  if (/(?:ikisinde|üçünde|hepsinde) de\s*$|each\)?\s*$/iu.test(claim.before) || /^\s*[^.]*\beach\b/iu.test(claim.after.slice(0, 30))) return 'eşitlik';
  if (/(?:^|\s)(?:en az|at least)\s*$/iu.test(claim.before)) return 'alt-sınır';
  return null;
}

/** Sayının hemen ardından gelen niteleme (en çok bir ara sözcükle) ve kart satırlarının sağlaması gereken koşul. */
const ITEM_PREDICATES = Object.freeze([
  [/^['’]?[a-zçğıöşü]*\s+(?:[^\s]+\s+)?(?:gecikmiş|overdue)(?!\p{L})/iu, (item) => item.overdue === true, 'gecikmiş'],
  [/^['’]?[a-zçğıöşü]*\s+(?:[^\s]+\s+)?(?:tamamlan|completed\b)/iu, (item) => item.status === 'done', 'tamamlanmış'],
  [/^['’]?[a-zçğıöşü]*\s+(?:açık|open)(?!\p{L})/iu, (item) => item.status !== 'done', 'açık'],
  [/^['’]?[a-zçğıöşü]*\s+(?:yapılacak|to-do)\b/iu, (item) => item.status === 'todo', 'yapılacak'],
  [/^['’]?[a-zçğıöşü]*\s+(?:devam eden|in-progress)\b/iu, (item) => item.status === 'in_progress', 'devam eden']
]);

/** Bağlı iddianın kartla tutarlılığı; tutarsızlık açıklaması ya da `null`. */
export function incorrectBinding(claim, card, expected = null) {
  const category = claim.category;
  if (unboundReason(claim, { finish: 'stop' }) === 'eşik-sabiti') return 'sabit eşik kart taşıyamaz';
  if (expected?.kind && expected.kind !== card.kind) return 'kart türü beklenen nüfusa uymuyor';
  if (expected?.taskIds) {
    const ids = new Set(expected.taskIds.map(id => id.toLowerCase()));
    if (card.total !== ids.size || !card.items?.length || card.items.some(item => !ids.has(item.id))
      || card.items.length === card.total && new Set(card.items.map(item => item.id)).size !== ids.size) return 'kartın görev kimlikleri beklenen nüfusa uymuyor';
  }
  if (expected?.entityNames && (card.total !== expected.entityNames.size || !card.rows?.length
    || card.rows.some(row => !expected.entityNames.has(row.name)))) return 'kartın varlıkları beklenen nüfusa uymuyor';
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
      if (values.length !== 2 || values.some(item => item == null)) return 'karşılaştırma işlenenleri geçersiz';
      const gap = Math.abs(values[1] - values[0]);
      const difference = /(?:fark|difference)(?:\s*[:=])?\s*$/iu.test(claim.before) || /^\s+(?:görev\s+|tasks?\s+)?(?:arttı|azaldı|daha (?:fazla|az)|more|fewer)/iu.test(claim.after);
      const wanted = expected?.comparisonField;
      const matches = wanted === 'previous' ? value === values[0] : wanted === 'current' ? value === values[1]
        : wanted === 'difference' || difference ? value === gap : values.includes(value);
      return matches ? null : `karşılaştırma kartının ilgili alanı ${value} değil`;
    }
    return `görev sayısı ${card.kind} kartına bağlı`;
  }
  if (category === 'entityCount') {
    const type = /^(?:\s*)(?:proje|project)/iu.test(claim.after) || /proje sayısı|number of .*projects/iu.test(claim.before) ? 'projects'
      : /^\s*(?:kişi|people|person)/iu.test(claim.after) ? 'people'
        : /^\s*(?:bölüm|birim|department|unit)/iu.test(claim.after) ? 'units' : null;
    if (type && card.kind !== type) return `varlık türü ${type}, kart ${card.kind}`;
    if (['people', 'projects', 'units'].includes(card.kind)) return card.total === claimNumber(claim.text) ? null : `varlık sayısı ${claim.text}, kart ${card.total}`;
    return `varlık sayısı ${card.kind} kartına bağlı`;
  }
  if (category === 'percent') {
    if (!['calc', 'compare'].includes(card.kind)) return `yüzde ${card.kind} kartına bağlı`;
    const value = claimPercent(claim.text);
    const shown = claimPercent(card.result.match(/%\d[\d.,]*/u)?.[0] || '');
    if (shown !== value) return `yüzde ${value}, kart sonucu ${card.result}`;
    const formulaPercent = claimPercent([...(card.formula || '').matchAll(/%\d[\d.,]*/gu)].at(-1)?.[0] || '');
    if (formulaPercent !== shown) return 'formüldeki sonuç kartın sonucuyla uyuşmuyor';
    const [first, second] = card.metrics.map(metric => claimNumber(metric.value));
    if (first == null || second == null) return 'hesap işlenenleri okunamadı';
    if (expected?.operands && (expected.operands[0] !== first || expected.operands[1] !== second)) return 'hesap işlenenleri beklenen değerlerle uyuşmuyor';
    if (card.kind === 'compare') {
      if (first <= 0 || shown !== Math.round(100 * Math.abs(second - first) / first)) return 'göreli değişim karşılaştırmanın işlenenlerinden çıkmıyor';
      if (first !== second && !card.result.includes(second > first ? 'artış' : 'azalış')) return 'göreli değişimin yönü yanlış';
      return null;
    }
    if (second <= 0 || first > second || !card.formula?.includes(`${card.metrics[0].value} / ${card.metrics[1].value} × 100`)) return 'hesap formülü işlenenlerle uyuşmuyor';
    const raw = 100 * first / second;
    const rounded = Math.round(raw);
    const bounded = first === 0 || first === second ? rounded : Math.min(99, Math.max(1, rounded));
    const allowed = new Set([rounded, bounded]);
    if (raw > 0 && raw < 1) allowed.add(Number(raw.toPrecision(3)));
    if (raw > 50 && rounded === 50) {
      for (let scale = 10; scale <= 1e6; scale *= 10) {
        const decimal = Math.floor(raw * scale) / scale;
        if (decimal > 50) { allowed.add(decimal); break; }
      }
    }
    return allowed.has(shown) ? null : 'yüzde işlenenlerden çıkmıyor';
  }
  if (category === 'name') {
    if (card.kind === 'task' && !expected?.taskIds) {
      return card.items.some(item => item.title === claim.text || claim.text.startsWith(`${item.title} · `)) ? null : 'görev kartının adı iddiayla uyuşmuyor';
    }
    if (card.kind === 'tasks') return null;
    return card.title === claim.text || card.title.endsWith(` · ${claim.text}`) || claim.text.endsWith(` · ${card.title}`) ? null : `ad "${claim.text}", kart "${card.title}"`;
  }
  return null;
}

/**
 * Bir yanıtın muhasebesi: her iddianın sınıfı, bağ durumu ve sonucu (doğru bağlı, gerekçeli bağsız, beklenmedik bağsız, yanlış bağlı).
 * `cards`: istemcinin doğruladığı tanımlayıcı (`normalizeEvidenceCards`), yoksa `null`.
 */
export function accountAnswer({ content, cards, finish, names, expectedClaim = null }) {
  const valid = normalizeEvidenceCards(cards);
  const visible = strongTexts(content);
  const byStrong = new Map((valid?.anchors || []).filter(anchor => visible[anchor.strong] === anchor.text)
    .map(anchor => [anchor.strong, valid.cards.find(card => card.id === anchor.card)]));
  return extractClaims(content).map((claim) => {
    const category = claimCategory(claim, names);
    const card = byStrong.get(claim.strong) || null;
    const enriched = { ...claim, category };
    if (finish !== 'stop' && !card) return { ...enriched, bound: false, result: 'ölçüm-dışı' };
    if (card) {
      const expected = expectedClaim?.(enriched);
      const wrong = incorrectBinding(enriched, card, expected);
      const identityVerified = !wrong && Boolean(expected?.taskIds || expected?.entityNames);
      const needsIdentity = ['taskCount', 'name', 'entityCount'].includes(category);
      return { ...enriched, bound: true, card: card.kind,
        result: wrong ? 'yanlış-bağlı' : needsIdentity && !identityVerified ? 'biçim-doğrulandı' : 'doğru-bağlı',
        ...(identityVerified ? { identityVerified } : {}), ...(wrong ? { reason: wrong } : {}) };
    }
    if (category !== 'taskCount') return { ...enriched, bound: false, result: 'bağsız' };
    const reason = unboundReason(enriched, { finish });
    return { ...enriched, bound: false, result: reason ? 'gerekçeli-bağsız' : 'beklenmedik-bağsız', ...(reason ? { reason } : {}) };
  });
}

/** İstemcide açılmayan bağ, kapsam sonuçlarından ayrıca hata olarak raporlanır. */
export function descriptorProblems(content, cards) {
  if (!cards) return [];
  const visible = strongTexts(content);
  const descriptor = normalizeEvidenceCards(cards);
  if (!descriptor) return ['kart tanımlayıcısı istemcide geçersiz'];
  return descriptor.anchors.filter(anchor => visible[anchor.strong] !== anchor.text).map(anchor => `açılmayan çapa: ${anchor.strong}`);
}

/** Açık seçimde boş veya bilinmeyen vaka kabul edilmez. */
export function selectEvidenceCases(cases, requested) {
  if (requested == null) return cases;
  const ids = new Set(requested.split(',').map(id => id.trim()).filter(Boolean));
  const unknown = [...ids].filter(id => !cases.some(item => item.id === id));
  if (!ids.size || unknown.length) throw new Error(`Geçersiz kanıt nitelendirme vakası: ${unknown.join(', ') || '(boş seçim)'}`);
  return cases.filter(item => ids.has(item.id));
}

/** Tek kaynaklı basit sayımları sentetik görev olgularıyla bağımsız doğrular. Birleşik önermeler açık beklenti gerektirir. */
export function fixtureTaskExpectation({ evidence, tasks, today }) {
  const byId = new Map(evidence.map(row => [row.evidenceId, row]));
  const taskById = new Map(tasks.map(task => [String(task.TaskId).toLowerCase(), task]));
  const byTitle = new Map();
  for (const task of tasks) {
    if (!byTitle.has(task.Title)) byTitle.set(task.Title, []);
    byTitle.get(task.Title).push(task.TaskId);
  }
  const candidates = new Map();
  return (claim) => {
    if (claim.category === 'name') {
      const [id, ...others] = byTitle.get(claim.text) || [];
      return id && !others.length ? { kind: 'task', taskIds: [id] } : null;
    }
    if (claim.category !== 'taskCount' || claim.evidenceIds.length !== 1 || claimNumber(claim.text) === 0) return null;
    const id = claim.evidenceIds[0];
    const row = byId.get(id);
    if (!['rota_task_search', 'rota_task_analytics'].includes(row?.tool) || row.data?.groupBy || row.data?.history
      || row.data?.filters?.hasDescription || row.data?.filters?.dateField || row.data?.filters?.dateFrom || row.data?.filters?.dateTo) return null;
    // Açık bir niteleme sayıdan hemen sonra gelmelidir. Gösterilen, birleşik ve tarihsel alt kümeler bu kısa yolu kullanmaz.
    const match = /^\s+(gecikmiş|overdue|açık|open|tamamlanmış|completed)\s+(?:görev(?:iniz|inizin|in|i)?|tasks?)\b/iu.exec(claim.after);
    if (!match || /(?:gösterilen|dönen|shown|returned|en az|at least)\s+$/iu.test(claim.before)) return null;
    const rule = match[1].toLocaleLowerCase('tr-TR');
    const key = `${id}:${rule}`;
    if (!candidates.has(key)) {
      const population = row.authorizationPopulation ? decodeAuthorizationPopulation(row.authorizationPopulation) : null;
      if (!population?.length) return null;
      const facts = population.map(ref => taskById.get(ref.taskId));
      if (facts.some(task => !task)) return null;
      const matching = facts.filter(task => {
        if (rule === 'completed' || rule === 'tamamlanmış') return task.Status === 'done';
        if (task.Status === 'done') return false;
        if (rule === 'open' || rule === 'açık') return true;
        return task.TargetFinish && String(task.TargetFinish).slice(0, 10) < today;
      });
      candidates.set(key, matching.map(task => task.TaskId));
    }
    const taskIds = candidates.get(key);
    return taskIds.length === claimNumber(claim.text) ? { kind: 'tasks', taskIds } : null;
  };
}
