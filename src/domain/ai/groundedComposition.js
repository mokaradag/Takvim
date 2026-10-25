import { ANSWER_CHART_LIMITS, answerChartFence, answerChartLabel } from './answerChart.js';
import { escapedFactText } from './evidenceFacts.js';
import {
  describeRowCollection,
  narrativeGroups,
  narrativeLabel,
  narrativePlainValue,
  narrativeRowCollections,
  narrativeValue,
  renderGroupDetails,
  renderGroupRows
} from './evidenceNarrative.js';

/**
 * Kanıta dayalı yanıtın DOĞAL DİLDEKİ düzeni — saf, belirlenimci sözleşme.
 *
 * Sunucu doğrulanmış olgulardan bir "olgu sayfası" kurar: her değer bir yuvadır (`F1`), çok satırlı
 * koleksiyonlar tablo (`T1`), kaydın kalan ayrıntıları ayrıntı (`D1`), uygun sayısal sütunlar grafik
 * adayı (`G1`) olur. Model yalnızca kapalı bir blok listesi yazar: kendi cümleleri yuva kimliklerini
 * taşır, değerleri ise sunucu doğrulanmış biçimde yerleştirir; tablo, ayrıntı ve grafiği sunucu çizer,
 * kaynak işaretlerini sunucu ekler.
 *
 * Güvenceler: modelin metninde rakam, kaynak işareti, bağlantı ya da biçim sözdizimi yoktur (kaçışlanır
 * ya da reddedilir); her paragraf en az bir doğrulanmış yuvaya dayanır; satırın değeri o satırın adıyla
 * birlikte geçer; istenen her olgu yanıtta temsil edilir; bilinmeyen kimlik, yinelenen kaynak, aşırı
 * uzunluk ve biçim dışı alan reddedilir. Reddedilen düzen hiçbir zaman gösterilmez: çağıran,
 * doğrulanmış belirlenimci anlatıma döner. Model metni kanıt sayılmaz; doğal dil anlayışı için anahtar
 * sözcük ya da kalıp tablosu kullanılmaz.
 */

export const COMPOSITION_LIMITS = Object.freeze({
  maxSlots: 72,
  maxPreviewRows: 8,
  maxTables: 6,
  maxDetails: 6,
  maxCharts: 4,
  maxBlocks: 10,
  maxParagraphChars: 700,
  maxPoints: 8,
  maxPointChars: 240,
  maxHeadingChars: 80,
  maxHeadings: 3,
  maxAssessmentChars: 360,
  maxProseChars: 2400,
  maxBoldSpans: 4,
  maxValueChars: 160,
  maxQuestionChars: 600,
  maxResponseChars: 16000,
  simpleSlots: 4,
  simpleBlocks: 2
});

export const COMPOSITION_BLOCK_TYPES = Object.freeze(['paragraph', 'points', 'heading', 'rows', 'details', 'chart', 'assessment']);

const BLOCK_KEYS = Object.freeze({
  paragraph: [['type', 'text'], []],
  points: [['type', 'items'], []],
  heading: [['type', 'text'], []],
  rows: [['type', 'source'], ['style']],
  details: [['type', 'source'], []],
  chart: [['type', 'source'], ['style']],
  assessment: [['type', 'text'], []]
});
const ROW_STYLES = new Set(['list', 'table']);
const SLOT = /\{\s*F(\d{1,3})\s*\}/g;
const INVISIBLE = /[\u00ad\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const NUMERAL = /\p{N}/u;
const CODE_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_./-]*/gu;
/** Kaydın öznesini adlandıran yuvanın etiketi (kayıt türüne göre). */
const SUBJECT_NOUNS = Object.freeze({ task: ['Görev', 'Task'], project: ['Proje', 'Project'], person: ['Kişi', 'Person'] });
/** Satır adının bağlamı (anlatımda adın yanında yazılır); düzende satıra bağlı ayrı bir yuvadır. */
const CONTEXT_LABELS = Object.freeze({ project: ['Proje', 'Project'], organization: ['Birim', 'Organization'] });
const COUNT_MEASURES = new Set(['tasks', 'notifications', 'occurrences', 'events', 'people', 'projects', 'wbs-nodes', 'dependencies', 'baselines', 'tags', 'count']);

const leafOf = (field) => String(field).split('.').filter((part) => !/^\d+$/.test(part)).at(-1);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const citations = (ids) => [...new Set(ids)].map((id) => `【${id}】`).join('');

/** Kırpma ve temizleme sonrasında da her çubuk doğrulanmış bağlamıyla ayırt edilebilir olmalı. */
function chartLabels(rows) {
  const titles = rows.map((row) => answerChartLabel(row.title));
  const labels = rows.map((row, index) => {
    if (titles.indexOf(titles[index]) === titles.lastIndexOf(titles[index])) return titles[index];
    const context = Object.values(row.context || {}).filter(Boolean).join(' · ');
    if (!context) return titles[index];
    const max = ANSWER_CHART_LIMITS.maxLabelChars;
    const suffix = answerChartLabel(context, Math.floor((max - 3) / 2));
    return `${answerChartLabel(row.title, max - suffix.length - 3)} · ${suffix}`;
  });
  return new Set(labels).size === rows.length ? labels : null;
}

function exactKeys(value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return keys.every((key) => Object.hasOwn(value, key)) && present.every((key) => keys.includes(key) || optional.includes(key));
}

function slotKind(fact) {
  if (fact.value === null) return 'empty';
  if (typeof fact.value === 'boolean') return 'flag';
  if (typeof fact.value === 'number') return /Percent$/.test(leafOf(fact.field)) ? 'percent' : 'number';
  if (['date', 'instant'].includes(fact.semantic?.valueType)) return 'date';
  return 'text';
}

/**
 * Olgu sayfasını kurar.
 *
 * @param {object} input
 * @param {{ index: number, presentation: { facts: object[], layout: string, empty: string[] }, topic?: string }[]} input.parts
 *   Doğrulanmış bölümler (plan sırasıyla).
 * @param {{ index: number, topic?: string, kind: 'unavailable'|'not_found' }[]} [input.missing] Tamamlanamayan bölümler.
 * @returns {{ view: object, render: object } | null} Model girdisi (`view`) ve sunucunun çizim verisi (`render`).
 */
export function buildComposition(input = {}) {
  // Sayfa sınırına sığmayan önizleme daraltılır; tablolar o zaman yalnızca tablo bloğuyla temsil edilir.
  for (const previewRows of [COMPOSITION_LIMITS.maxPreviewRows, 4, 2, 0]) {
    const built = composeSheet(input, previewRows);
    if (built !== undefined) return built;
  }
  return null;
}

/** `undefined`: bu önizleme boyuyla sayfa sınırı aşıldı; `null`: düzen kurulamaz. */
function composeSheet({ parts = [], missing = [], locale = 'tr', question = '', previousQuestion = null, today = null }, previewRows) {
  const slots = new Map();
  const tables = new Map();
  const details = new Map();
  const charts = new Map();
  const viewFacts = [];
  const viewTables = [];
  const viewDetails = [];
  const viewCharts = [];
  let overflow = false;

  const addSlot = ({ part, evidenceId, facts, label, criteria = null, subject = null, table = null, row = null, record = null, role = 'value', markdown, plain, kind, required = true }) => {
    if (slots.size >= COMPOSITION_LIMITS.maxSlots) { overflow = true; return null; }
    const id = `F${slots.size + 1}`;
    const value = clip(String(plain ?? ''), COMPOSITION_LIMITS.maxValueChars);
    slots.set(id, Object.freeze({ id, part, evidenceId, markdown, kind, table, row, record, role, required, facts }));
    viewFacts.push({ id, part, label: clip(String(label || ''), COMPOSITION_LIMITS.maxValueChars), value, kind,
      ...(criteria ? { criteria: clip(criteria, COMPOSITION_LIMITS.maxValueChars) } : {}),
      ...(subject ? { subject: clip(String(subject), COMPOSITION_LIMITS.maxValueChars) } : {}),
      ...(table ? { table, row: row.index } : row?.detail ? { detail: row.detail, row: row.index } : {}), ...(role === 'label' ? { role } : {}) });
    return id;
  };
  const factSlot = (part, evidenceId, facts, extra = {}) => {
    const [first] = facts;
    const separator = first.field.includes('wbsPath') ? ' › ' : ', ';
    const kind = facts.length === 1 ? slotKind(first) : 'text';
    const values = facts.map((fact) => narrativeValue(fact, locale));
    const { label, criteria } = narrativeLabel(first, locale);
    // Satır olgularının ortak ölçütü tabloda bir kez yazılır.
    return addSlot({ part, evidenceId, facts, label: extra.label || label, criteria: extra.row ? null : criteria || null, kind,
      markdown: Object.freeze({ plain: values.join(separator), strong: values.map((value) => `**${value}**`).join(separator) }),
      plain: facts.map((fact) => narrativePlainValue(fact, locale)).join(separator), ...extra });
  };
  const rowSlots = (part, evidenceId, row, rowRef, label, cells, columns) => {
    const ids = [];
    const labelId = row.titleFacts.length ? factSlot(part, evidenceId, row.titleFacts, { table: rowRef.table, row: rowRef, role: 'label', label })
      : addSlot({ part, evidenceId, facts: [], label, table: rowRef.table, row: rowRef, role: 'label', kind: 'text',
        markdown: Object.freeze({ plain: escapedFactText(row.title), strong: `**${escapedFactText(row.title)}**` }), plain: row.title });
    if (labelId) ids.push(labelId);
    for (const [key, value] of Object.entries(row.context || {})) {
      if (!value) continue;
      // Bağlam yalnızca istenen olguysa (ör. "projesi ne?") kapsam için zorunludur; aksi hâlde satır adının eşlikçisidir.
      const id = addSlot({ part, evidenceId, facts: [], label: CONTEXT_LABELS[key][locale === 'en' ? 1 : 0], table: rowRef.table, row: rowRef, kind: 'text',
        required: row.entries.some(({ rel }) => rel.startsWith(`${key}.`)),
        markdown: Object.freeze({ plain: escapedFactText(value), strong: escapedFactText(value) }), plain: value });
      if (id) ids.push(id);
    }
    cells.forEach((facts, column) => {
      if (!facts.length) return;
      const id = factSlot(part, evidenceId, facts, { table: rowRef.table, row: rowRef, label: columns[column].label });
      if (id) ids.push(id);
    });
    return ids;
  };

  for (const part of parts) {
    const presentation = part.presentation;
    if (!presentation || !Array.isArray(presentation.facts)) continue;
    const ordinal = part.index + 1;
    for (const group of narrativeGroups(presentation.facts)) {
      const multi = new Set(narrativeRowCollections(group, presentation.layout));
      for (const collection of multi) {
        if (tables.size >= COMPOSITION_LIMITS.maxTables) { overflow = true; continue; }
        const id = `T${tables.size + 1}`;
        const described = describeRowCollection(group, collection, locale);
        const columns = described.columns.map((column, index) => ({ id: `C${index + 1}`, label: column.label, numeric: column.numeric }));
        const preview = [];
        described.rows.slice(0, previewRows).forEach((row, index) => {
          preview.push(rowSlots(ordinal, group.evidenceId, row, { table: id, index: index + 1 }, described.head, row.cells, columns));
        });
        const slotIds = preview.flat();
        const complete = described.rows.every((row) => row.entries.every(({ fact }) => fact.semantic?.complete === true));
        const rowCriteria = [...new Set(described.rows.map((row) => narrativeLabel(row.entries[0].fact, locale).criteria))];
        const criteria = rowCriteria.length === 1 ? rowCriteria[0] : group.envelope.map((fact) => narrativeLabel(fact, locale).criteria).find(Boolean) || '';
        const labels = chartLabels(described.rows);
        tables.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, group, collection, rows: described.rows.length, previewRows: preview.length, slotIds, columns, complete, criteria,
          layout: presentation.layout }));
        viewTables.push({ id, part: ordinal, title: described.head, rows: described.rows.length,
          ...(criteria ? { criteria: clip(criteria, COMPOSITION_LIMITS.maxValueChars) } : {}), previewRows: preview.length, columns, complete });
        // Grafik adayı: satır başına tek, sonlu ve negatif olmayan sayı taşıyan sütun.
        described.columns.forEach((column, index) => {
          if (!column.numeric || !labels || charts.size >= COMPOSITION_LIMITS.maxCharts) return;
          if (described.rows.length < ANSWER_CHART_LIMITS.minItems || described.rows.length > ANSWER_CHART_LIMITS.maxBarItems) return;
          const values = described.rows.map((row) => row.cells[index]);
          if (!values.every((facts) => facts.length === 1 && Number.isFinite(facts[0].value) && facts[0].value >= 0 && facts[0].value <= ANSWER_CHART_LIMITS.maxValue)) return;
          const sample = values[0][0];
          const unit = /Percent$/.test(leafOf(sample.field)) ? 'percent' : sample.semantic?.unit === 'hours' ? 'hours'
            : sample.semantic?.measure === 'days' ? 'days'
              : values.every((facts) => Number.isSafeInteger(facts[0].value)) && (COUNT_MEASURES.has(sample.semantic?.measure) || sample.semantic?.measure == null) ? 'count' : 'number';
          const total = values.reduce((sum, facts) => sum + facts[0].value, 0);
          const distribution = group.tool === 'rota_task_analytics' && collection.endsWith('groups') && complete
            && described.rows.length <= ANSWER_CHART_LIMITS.maxDonutItems && total > 0 && unit === 'count';
          const chartId = `G${charts.size + 1}`;
          const items = labels.map((label, position) => ({ label, value: values[position][0].value }));
          const types = distribution ? ['bar', 'donut'] : ['bar'];
          const title = answerChartLabel(column.label, ANSWER_CHART_LIMITS.maxTitleChars);
          if (!types.every((type) => answerChartFence({ version: 1, type, locale, title, unit, evidence: [group.evidenceId], items }))) return;
          charts.set(chartId, Object.freeze({ id: chartId, table: id, title, unit, evidenceId: group.evidenceId, items, types }));
          viewCharts.push({ id: chartId, table: id, column: columns[index].id, title: column.label, types });
        });
      }
      const recordSlots = [];
      const detailId = `D${details.size + 1}`;
      const byPattern = new Map();
      for (const entry of group.main.entries) {
        const key = `${entry.rel.replace(/\.\d+(?=\.|$)/g, '.*')}|${entry.fact.changeField || ''}`;
        if (!byPattern.has(key)) byPattern.set(key, []);
        byPattern.get(key).push(entry.fact);
      }
      const subject = group.main.anonymous ? null : group.main.subject;
      for (const facts of byPattern.values()) {
        const role = ['title', 'name'].includes(leafOf(facts[0].field)) && facts.length === 1 ? 'label' : 'value';
        const id = factSlot(ordinal, group.evidenceId, facts, { subject, role, record: group.evidenceId });
        if (id) recordSlots.push(id);
      }
      // Kaydın adı da doğrulanmış kanıttandır: model adı kopyalamadan yuvayla yazabilir (kapsam için zorunlu değil).
      if (subject && recordSlots.length && !recordSlots.some((id) => slots.get(id).role === 'label')) {
        const noun = SUBJECT_NOUNS[group.main.kind]?.[locale === 'en' ? 1 : 0] || (locale === 'en' ? 'Record' : 'Kayıt');
        const id = addSlot({ part: ordinal, evidenceId: group.evidenceId, facts: [], label: noun, kind: 'text', role: 'label', required: false, record: group.evidenceId,
          markdown: Object.freeze({ plain: escapedFactText(subject), strong: `**${escapedFactText(subject)}**` }), plain: subject });
        if (id) recordSlots.push(id);
      }
      for (const collection of group.collections.keys()) {
        if (multi.has(collection)) continue;
        const described = describeRowCollection(group, collection, locale);
        const [row] = described.rows;
        const rowRef = { table: null, index: 1, key: `${group.evidenceId}|${collection}`, detail: detailId };
        recordSlots.push(...rowSlots(ordinal, group.evidenceId, row, rowRef, described.head, row.cells, described.columns));
      }
      for (const fact of group.envelope) {
        if (!['totalCount', 'returnedCount'].includes(fact.field)) continue;
        const id = factSlot(ordinal, group.evidenceId, [fact], { subject });
        if (id) recordSlots.push(id);
      }
      const emptyProof = (presentation.empty || []).includes(group.evidenceId);
      const detailText = renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout });
      if (detailText) {
        if (details.size >= COMPOSITION_LIMITS.maxDetails) { overflow = true; continue; }
        const id = detailId;
        // Eksik, kısaltılmış ya da eşleşmesiz sonucun notu (yuvası yoktur) ve yuvasız ayrıntı her zaman gösterilir.
        // Sayısal özetin anlamı/kapsamı modelin serbest cümlesine bırakılamaz; doğrulanmış anlatım eşlik eder.
        const requiredScope = recordSlots.some((id) => {
          const slot = slots.get(id);
          return !slot.row && ['number', 'percent'].includes(slot.kind);
        });
        const required = !recordSlots.length || group.envelope.some((fact) => (fact.field === 'complete' && (fact.value === false || emptyProof))
          || (fact.field === 'truncated' && fact.value === true));
        details.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, text: detailText, slotIds: recordSlots, required, requiredScope }));
        viewDetails.push({ id, part: ordinal, ...(subject ? { subject: clip(String(subject), COMPOSITION_LIMITS.maxValueChars) } : {}), facts: recordSlots,
          ...(required || requiredScope ? { required: true } : {}) });
      }
    }
  }
  // Sayfa sınırı aşıldıysa düzen istenmez: bütün olguları temsil edemeyen sayfa yanlış bir yanıta yol açabilir.
  if (overflow) return tables.size || !previewRows ? undefined : null;
  if (!slots.size && !tables.size) return null;
  const partCount = new Set(parts.map((part) => part.index)).size + missing.length;
  const shape = partCount === 1 && !tables.size && slots.size <= COMPOSITION_LIMITS.simpleSlots ? 'simple' : 'standard';
  const view = {
    language: locale === 'en' ? 'en' : 'tr',
    ...(today ? { today } : {}),
    question: clip(String(question || ''), COMPOSITION_LIMITS.maxQuestionChars),
    ...(previousQuestion ? { previousQuestion: clip(String(previousQuestion), COMPOSITION_LIMITS.maxQuestionChars) } : {}),
    shape,
    parts: partCount,
    facts: viewFacts,
    tables: viewTables,
    details: viewDetails,
    charts: viewCharts,
    missing: missing.map((item) => ({ part: item.index + 1, ...(item.topic ? { topic: item.topic } : {}) }))
  };
  return Object.freeze({ view: Object.freeze(view), render: Object.freeze({ locale: view.language, slots, tables, details, charts, question: String(question || '') }) });
}

/* ── Model yanıtının ayrıştırılması ve doğrulanması ────────────── */

/** Tek JSON nesnesi (tek kod çiti içinde de olabilir); değilse `null`. */
export function parseCompositionResponse(text) {
  if (typeof text !== 'string' || text.length > COMPOSITION_LIMITS.maxResponseChars) return null;
  const trimmed = text.trim();
  const body = trimmed.replace(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/, '$1').trim();
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Kullanıcının kendi yazdığı, harf ve rakam birlikte taşıyan kodlar (ör. MRG-24); yalnızca bunlar metinde rakam taşıyabilir. */
function userCodes(text) {
  const codes = new Set();
  for (const match of String(text || '').normalize('NFC').matchAll(CODE_TOKEN)) {
    const token = match[0].replace(/[./-]+$/, '');
    if (/\p{L}/u.test(token) && NUMERAL.test(token)) codes.add(token);
  }
  return codes;
}

function cleanProse(value) {
  return String(value).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

const EN_NUMBERS = new Set('zero two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion first second third fourth fifth sixth seventh eighth ninth tenth half halves quarter quarters once twice dozen dozens hundreds thousands millions billions trillions eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth'.split(' '));
const TR_NUMBERS = 'sıfır iki üç dört dörd beş altı yedi sekiz dokuz on yirmi otuz kırk elli altmış yetmiş seksen doksan yüz bin milyon milyar trilyon yarım çeyrek buçuk'.split(' ');
// Kapalı sözcük/ek sözlüğü: alt dize aramaz; "birim", "onay", "yüzey" sayı değildir.
const TR_NUMBER_SUFFIXES = ['', 'ı', 'i', 'u', 'ü', 'sı', 'si', 'su', 'sü', 'ın', 'in', 'un', 'ün', 'ının', 'inin', 'unun', 'ünün',
  'sının', 'sinin', 'sunun', 'sünün', 'a', 'e', 'ya', 'ye', 'yı', 'yi', 'yu', 'yü', 'sına', 'sine', 'sunu', 'sini', 'sını', 'sünü',
  'da', 'de', 'ta', 'te', 'dan', 'den', 'tan', 'ten', 'sında', 'sinde', 'sından', 'sinden', 'şer', 'ar', 'er',
  'ncı', 'nci', 'ncu', 'ncü', 'ıncı', 'inci', 'uncu', 'üncü', 'ncısı', 'ncisi', 'ıncısı', 'incisi', 'lar', 'ler', 'dır', 'dir', 'dur', 'dür',
  'miz', 'mız', 'muz', 'müz', 'mizin', 'mızın', 'muzun', 'müzün', 'niz', 'nız', 'nuz', 'nüz', 'nizin', 'nızın', 'nuzun', 'nüzün'];
const TR_NUMBER_FORMS = new Set(TR_NUMBERS.flatMap((word) => TR_NUMBER_SUFFIXES.map((suffix) => word + suffix)));
const TR_ONE_FORMS = new Set(['biri', 'birisi', 'birinin', 'birisinin', 'birine', 'birini', 'birinden', 'birkaçı', 'birkaç', 'birer', 'birinci', 'birincisi']);
const TR_PRONOUNS = new Set(['ona', 'onu', 'onun', 'onda', 'ondan', 'onlar', 'onlara', 'onları', 'onların', 'onlarda', 'onlardan']);

/** Sınırlı miktar denetimi; planlama ya da genel dil çözümleme yapmaz. Belirsiz miktar güvenle düşer. */
function writtenQuantity(text, locale) {
  const words = (text.match(/\p{L}+(?:['’]\p{L}+)?/gu) || []).map((word) => word.replace(/['’]/g, ''));
  return words.some((raw, index) => {
    const word = raw.toLocaleLowerCase('en-US');
    const before = words[index - 1]?.toLocaleLowerCase('en-US');
    const after = words[index + 1]?.toLocaleLowerCase('en-US');
    if (EN_NUMBERS.has(word)) return true;
    // "one can ..." ve belirli zamir "the one ..." miktar bildirmez; "one task/of ..." bildirir.
    if (word === 'one' || word === 'ones') return ['only', 'exactly', 'just'].includes(before) || !(before === 'the' && ['shown', 'listed', 'selected', 'that', 'which', 'here'].includes(after)
      || ['can', 'could', 'may', 'might', 'should', 'must'].includes(after));
    const turkish = raw.toLocaleLowerCase('tr-TR');
    if (locale === 'en' && turkish === 'on') return false; // İngilizcedeki "on" edattır.
    if (TR_ONE_FORMS.has(turkish)) return true;
    // Belirsiz "bir" için yalnızca sayısal olmayan kapalı kullanımlar serbesttir.
    if (turkish === 'bir') return !['sonraki', 'arada', 'bakışta', 'değerlendirme', 'öneri', 'görünüm'].includes(words[index + 1]?.toLocaleLowerCase('tr-TR'));
    if (TR_PRONOUNS.has(turkish) || turkish === 'yüz' && after === 'yüze' || turkish === 'yüze' && before === 'yüz') return false;
    return TR_NUMBER_FORMS.has(turkish);
  });
}

/**
 * Modelin düzyazısını parçalara ayırır: düz metin, kalın metin ve yuva. Biçim sözdizimi tanınmaz (yalnızca
 * dengeli `**` kalın yazıdır); rakam, kaynak işareti ve bağlantı reddedilir.
 */
function parseProse(raw, { max, render, codes, issues, allowSlots = true }) {
  if (typeof raw !== 'string') { issues.push('PROSE_INVALID'); return null; }
  const text = cleanProse(raw);
  if (!text || text.length > max) { issues.push(text ? 'PROSE_TOO_LONG' : 'PROSE_EMPTY'); return null; }
  if (/[【】]/.test(text)) { issues.push('CITATION_FORBIDDEN'); return null; }
  if (/:\/\/|mailto:|\bwww\./i.test(text)) { issues.push('LINK_FORBIDDEN'); return null; }
  const segments = [];
  let last = 0;
  for (const match of text.matchAll(SLOT)) {
    if (match.index > last) segments.push({ type: 'text', value: text.slice(last, match.index) });
    segments.push({ type: 'slot', id: `F${Number(match[1])}` });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  const slotIds = segments.filter((segment) => segment.type === 'slot').map((segment) => segment.id);
  if (slotIds.length && !allowSlots) { issues.push('HEADING_SLOT'); return null; }
  if (slotIds.some((id) => !render.slots.has(id))) { issues.push('UNKNOWN_SLOT'); return null; }
  for (const segment of segments) {
    if (segment.type !== 'text') continue;
    if (/[{}]/.test(segment.value)) { issues.push('SLOT_SYNTAX'); return null; }
    const outsideCodes = segment.value.replace(CODE_TOKEN, (value) => (codes.has(value.replace(/[./-]+$/, '')) ? ' ' : value));
    if (writtenQuantity(outsideCodes, render.locale)) { issues.push('UNSUPPORTED_NUMBER'); return null; }
    for (const match of segment.value.matchAll(CODE_TOKEN)) {
      const token = match[0].replace(/[./-]+$/, '');
      if (NUMERAL.test(token) && !codes.has(token)) { issues.push('UNSUPPORTED_NUMBER'); return null; }
    }
    if (NUMERAL.test(segment.value.replace(CODE_TOKEN, ''))) { issues.push('UNSUPPORTED_NUMBER'); return null; }
  }
  const markers = segments.filter((segment) => segment.type === 'text').reduce((count, segment) => count + (segment.value.match(/\*\*/g) || []).length, 0);
  const bold = markers > 0 && markers % 2 === 0 && markers / 2 <= COMPOSITION_LIMITS.maxBoldSpans;
  return { text, segments, slotIds, bold };
}

const NAMED_RECORDS = new WeakMap();

/** Değerin bağlı olduğu kayıt: satır (tablo ya da tek satırlı ayrıntı) ya da birden çok kayıtlı yanıtta kaydın kendisi. */
function slotBinding(slot, render) {
  if (slot.row) return { space: `${slot.evidenceId}|${slot.table || slot.row.key}`, owner: slot.row.index };
  if (!slot.record) return null;
  if (!NAMED_RECORDS.has(render)) {
    NAMED_RECORDS.set(render, new Set([...render.slots.values()].filter((other) => other.record && other.role === 'label').map((other) => other.record)));
  }
  return NAMED_RECORDS.get(render).size > 1 ? { space: 'record', owner: slot.record } : null;
}

/**
 * Bir paragraf ya da maddede her değer kendi kaydının adıyla eşleşir: ad aynı metinde geçer ve değer, kendinden
 * önceki (ör. "{ad} {değer}") ya da sonraki (ör. "{değer} gündür bekleyen {ad}") en yakın adın kaydıdır. Eşlemeler
 * kesişemez: metinde sonra gelen değer daha önceki bir ada bağlanamaz. Çapraz eşleme reddedilir.
 */
function pairingIssue(parsed, render) {
  const sequence = parsed.slotIds.map((id, position) => {
    const slot = render.slots.get(id);
    return { slot, position, bind: slotBinding(slot, render) };
  }).filter((item) => item.bind);
  for (const space of new Set(sequence.map((item) => item.bind.space))) {
    const items = sequence.filter((item) => item.bind.space === space);
    const labels = items.filter((item) => item.slot.role === 'label');
    const named = new Set([...render.slots.values()].filter((slot) => slot.role === 'label').map((slot) => slotBinding(slot, render))
      .filter((bind) => bind?.space === space).map((bind) => bind.owner));
    const values = items.filter((item) => item.slot.role !== 'label' && named.has(item.bind.owner));
    if (!values.length) continue;
    if (values.some((value) => !labels.some((label) => label.bind.owner === value.bind.owner))) return 'ROW_LABEL_REQUIRED';
    const nearest = (value, before) => (before ? labels.filter((label) => label.position < value.position).at(-1)
      : labels.find((label) => label.position > value.position));
    let reached = -1;
    for (const value of values) {
      const paired = [nearest(value, true), nearest(value, false)].find((label) => label?.bind.owner === value.bind.owner && label.position >= reached);
      if (!paired) return 'ROW_PAIRING';
      reached = paired.position;
    }
  }
  return null;
}

/**
 * Model düzenini olgu sayfasına göre doğrular.
 * @returns {{ ok: true, blocks: object[] } | { ok: false, issues: string[] }}
 */
export function validateComposition(composition, response, { userText = '' } = {}) {
  const issues = [];
  const fail = (code) => ({ ok: false, issues: [...new Set([...issues, code].filter(Boolean))] });
  const { view, render } = composition || {};
  if (!view || !render) return fail('COMPOSITION_UNAVAILABLE');
  if (!exactKeys(response, ['blocks'], ['language'])) return fail('SHAPE_INVALID');
  if (response.language != null && response.language !== view.language) return fail('LANGUAGE_MISMATCH');
  const raw = response.blocks;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > COMPOSITION_LIMITS.maxBlocks) return fail('BLOCK_COUNT');
  const codes = userCodes(userText);
  const blocks = [];
  const usedSources = new Set();
  const usedSlots = new Set();
  const proseKeys = new Set();
  let proseChars = 0;
  let omitted = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(raw, index)) return fail('BLOCK_INVALID');
    const block = raw[index];
    const type = block?.type;
    if (!COMPOSITION_BLOCK_TYPES.includes(type) || !exactKeys(block, ...BLOCK_KEYS[type])) return fail('BLOCK_INVALID');
    const prose = (value, max, options = {}) => {
      const parsed = parseProse(value, { max, render, codes, issues, ...options });
      if (parsed) {
        proseChars += parsed.text.length;
        parsed.slotIds.forEach((id) => usedSlots.add(id));
      }
      return parsed;
    };
    if (type === 'paragraph' || type === 'assessment' || type === 'heading') {
      const limit = { paragraph: COMPOSITION_LIMITS.maxParagraphChars, assessment: COMPOSITION_LIMITS.maxAssessmentChars, heading: COMPOSITION_LIMITS.maxHeadingChars }[type];
      const parsed = prose(block.text, limit, { allowSlots: type !== 'heading' });
      if (!parsed) return fail(null);
      if (type === 'paragraph' && !parsed.slotIds.length) return fail('UNANCHORED_PROSE');
      // Yorum dayandığı olguyu yuvayla gösterir; dayanaksız yorum yanıtı düşürmez, yalnızca gösterilmez.
      if (type === 'assessment' && !parsed.slotIds.length) {
        omitted += 1;
        continue;
      }
      const key = `${type}|${parsed.text.toLocaleLowerCase('tr-TR')}`;
      if (proseKeys.has(key)) return fail('DUPLICATE_BLOCK');
      proseKeys.add(key);
      blocks.push({ type, prose: parsed });
      continue;
    }
    if (type === 'points') {
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > COMPOSITION_LIMITS.maxPoints) return fail('POINTS_INVALID');
      const items = [];
      for (let item = 0; item < block.items.length; item += 1) {
        if (!Object.hasOwn(block.items, item)) return fail('POINTS_INVALID');
        const parsed = prose(block.items[item], COMPOSITION_LIMITS.maxPointChars);
        if (!parsed) return fail(null);
        if (!parsed.slotIds.length) return fail('UNANCHORED_PROSE');
        // Bir madde tek satırın değerlerini taşır: iki satırın değerleri aynı maddede eşlenemez.
        const rows = new Set(parsed.slotIds.map((id) => render.slots.get(id)).filter((slot) => slot.row && slot.role !== 'label').map((slot) => `${slot.evidenceId}|${slot.table || slot.row.key}|${slot.row.index}`));
        if (rows.size > 1) return fail('ROW_MIXED');
        items.push(parsed);
      }
      const key = `points|${items.map((item) => item.text.toLocaleLowerCase('tr-TR')).join('\u0000')}`;
      if (proseKeys.has(key)) return fail('DUPLICATE_BLOCK');
      proseKeys.add(key);
      blocks.push({ type, items });
      continue;
    }
    const source = block.source;
    if (typeof source !== 'string') return fail('SOURCE_INVALID');
    const known = type === 'rows' ? render.tables.get(source) : type === 'details' ? render.details.get(source) : render.charts.get(source);
    if (!known) return fail('UNKNOWN_SOURCE');
    if (usedSources.has(source)) return fail('DUPLICATE_SOURCE');
    usedSources.add(source);
    if (type === 'rows') {
      if (block.style != null && !ROW_STYLES.has(block.style)) return fail('STYLE_INVALID');
      // Kullanıcının açıkça istediği düzen (tablo, liste ya da düzyazı) modelin seçiminden önce gelir.
      const requested = known.layout === 'table' ? 'table' : ['list', 'prose'].includes(known.layout) ? 'list' : null;
      blocks.push({ type, source, style: requested ?? block.style ?? (known.columns.length >= 2 ? 'table' : 'list') });
    } else if (type === 'chart') {
      if (block.style != null && !known.types.includes(block.style)) return fail('STYLE_INVALID');
      blocks.push({ type, source, style: block.style ?? known.types[0] });
    } else blocks.push({ type, source });
  }
  if (proseChars > COMPOSITION_LIMITS.maxProseChars) return fail('PROSE_TOO_LONG');
  if (blocks[0]?.type !== 'paragraph') return fail('LEAD_REQUIRED');
  const headings = blocks.map((block, index) => (block.type === 'heading' ? index : -1)).filter((index) => index >= 0);
  if (headings.length) {
    const allowed = view.shape !== 'simple' && (view.parts > 1 || blocks.length >= 4) && headings.length <= COMPOSITION_LIMITS.maxHeadings;
    if (!allowed || headings.some((index) => index === blocks.length - 1 || blocks[index + 1]?.type === 'heading')) return fail('HEADING_MISPLACED');
  }
  const assessments = blocks.filter((block) => block.type === 'assessment').length;
  if (assessments > 1) return fail('ASSESSMENT_INVALID');
  if (view.shape === 'simple' && (blocks.length > COMPOSITION_LIMITS.simpleBlocks || blocks.some((block) => ['heading', 'chart', 'rows', 'points'].includes(block.type)))) {
    return fail('SHAPE_EXCEEDED');
  }
  // Satırın (ya da birden çok kayıtlı yanıtta kaydın) değeri kendi adıyla eşleşir: değer başka bir kayda iliştirilemez.
  const proseOf = (block) => (block.type === 'points' ? block.items : block.prose ? [block.prose] : []);
  for (const block of blocks) {
    for (const parsed of proseOf(block)) {
      const issue = pairingIssue(parsed, render);
      if (issue) return fail(issue);
    }
  }
  // Tablo yalnızca düzyazıda gösteriliyorsa satırlar doğrulanmış sırayla anılır (sıralama ve "ikinci görev" takibi buna dayanır).
  const firstSeen = new Map();
  for (const block of blocks) {
    for (const parsed of proseOf(block)) {
      for (const id of parsed.slotIds) {
        const slot = render.slots.get(id);
        if (!slot.table || slot.role !== 'label') continue;
        const seen = firstSeen.get(slot.table) || [];
        if (!seen.includes(slot.row.index)) seen.push(slot.row.index);
        firstSeen.set(slot.table, seen);
      }
    }
  }
  for (const [table, seen] of firstSeen) {
    if (!usedSources.has(table) && seen.some((index, position) => position > 0 && index < seen[position - 1])) return fail('ROW_ORDER');
  }
  // İstenen her olgu temsil edilir: yuvası kullanılır ya da bulunduğu tablo/ayrıntı bloğu yanıttadır.
  for (const table of render.tables.values()) {
    if (usedSources.has(table.id)) continue;
    if (table.rows > table.previewRows || table.slotIds.some((id) => render.slots.get(id).required && !usedSlots.has(id))) return fail('COVERAGE_INCOMPLETE');
  }
  // Tam tablosu gösterilen kümenin eşleşen kayıt sayısı tablonun satır sayısıdır; ayrıca yazılması gerekmez.
  const shownCount = (slot) => slot.facts.length === 1 && ['totalCount', 'returnedCount'].includes(slot.facts[0].field)
    && [...render.tables.values()].some((table) => table.evidenceId === slot.evidenceId && usedSources.has(table.id) && table.complete && table.rows === slot.facts[0].value);
  for (const detail of render.details.values()) {
    // Zorunlu ayrıntıyı model eklemediyse sunucu yanıtın sonuna ekler (renderComposition).
    if (usedSources.has(detail.id) || detail.required) continue;
    if (detail.slotIds.some((id) => render.slots.get(id).required && !usedSlots.has(id) && !shownCount(render.slots.get(id)))) return fail('COVERAGE_INCOMPLETE');
  }
  return { ok: true, blocks, omitted };
}

/* ── Çizim ─────────────────────────────────────────────────────── */

function proseMarkdown(parsed, render) {
  // Önce düz ve kalın koşular kurulur; kalın koşunun baş ve sondaki boşluğu dışarı taşınır (CommonMark
  // boşlukla başlayan ya da biten vurguyu açmaz/kapatmaz), boş kalın koşu yazılmaz.
  const runs = [{ bold: false, parts: [] }];
  for (const segment of parsed.segments) {
    if (segment.type === 'slot') {
      const run = runs.at(-1);
      const slot = render.slots.get(segment.id);
      run.parts.push(run.bold ? slot.markdown.plain : slot.markdown.strong);
      continue;
    }
    const pieces = parsed.bold ? segment.value.split('**') : [segment.value];
    pieces.forEach((piece, index) => {
      if (index > 0) runs.push({ bold: !runs.at(-1).bold, parts: [] });
      runs.at(-1).parts.push(escapedFactText(piece));
    });
  }
  return runs.map((run) => {
    const body = run.parts.join('');
    if (!run.bold) return body;
    const core = body.trim();
    if (!core) return body;
    return `${body.slice(0, body.indexOf(core[0]))}**${core}**${body.slice(body.lastIndexOf(core.at(-1)) + 1)}`;
  }).join('').replace(/\s+/g, ' ').trim();
}

function proseCitations(parsed, render) {
  return citations(parsed.slotIds.map((id) => render.slots.get(id).evidenceId));
}

const ASSESSMENT_LABEL = Object.freeze({ tr: 'Değerlendirme', en: 'Assessment' });

/**
 * Doğrulanmış düzeni Markdown yanıta çevirir. Değerler, tablolar, ayrıntılar, grafik ve kaynak
 * işaretleri sunucunundur; modelin metni kaçışlanmış düz metindir.
 * @returns {{ text: string, citedIds: string[], chart: string|null, charts: number, blocks: number }}
 */
export function renderComposition(composition, validated) {
  const { render } = composition;
  const locale = render.locale;
  const out = [];
  const cited = [];
  let chart = null;
  let charts = 0;
  for (const block of validated.blocks) {
    if (block.type === 'paragraph') {
      out.push(`${proseMarkdown(block.prose, render)} ${proseCitations(block.prose, render)}`);
    } else if (block.type === 'assessment') {
      const marks = block.prose.slotIds.length ? ` ${proseCitations(block.prose, render)}` : '';
      out.push(`> **${ASSESSMENT_LABEL[locale]}:** ${proseMarkdown(block.prose, render)}${marks}`);
    } else if (block.type === 'heading') {
      out.push(`### ${escapedFactText(block.prose.text)}`);
    } else if (block.type === 'points') {
      out.push(block.items.map((item) => `- ${proseMarkdown(item, render)} ${proseCitations(item, render)}`).join('\n'));
    } else if (block.type === 'rows') {
      const table = render.tables.get(block.source);
      out.push(renderGroupRows(table.group, table.collection, { locale, layout: block.style }));
      cited.push(table.evidenceId);
    } else if (block.type === 'details') {
      const detail = render.details.get(block.source);
      out.push(detail.text);
      cited.push(detail.evidenceId);
    } else if (block.type === 'chart') {
      const candidate = render.charts.get(block.source);
      if (render.tables.get(candidate.table)?.evidenceId !== candidate.evidenceId) continue;
      const fence = answerChartFence({ version: 1, type: block.style, locale, title: candidate.title, unit: candidate.unit, evidence: [candidate.evidenceId],
        items: candidate.items });
      if (!fence) continue;
      out.push(fence);
      cited.push(candidate.evidenceId);
      chart = block.style;
      charts += 1;
    }
    for (const parsed of block.type === 'points' ? block.items : block.prose ? [block.prose] : []) {
      for (const id of parsed.slotIds) cited.push(render.slots.get(id).evidenceId);
    }
  }
  // Zorunlu ayrıntı (eksik/kısaltılmış sonuç, eşleşme yok, yuvasız bölüm) düzende yoksa sunucu ekler.
  const shown = new Set(validated.blocks.filter((block) => block.type === 'details').map((block) => block.source));
  for (const detail of render.details.values()) {
    if ((!detail.required && !detail.requiredScope) || shown.has(detail.id)) continue;
    out.push(detail.text);
    cited.push(detail.evidenceId);
  }
  // Tablo yerine yuvalar/grafik kullanıldığında da sayımın ortak ölçütü sunucudan gelir.
  const shownTables = new Set(validated.blocks.filter((block) => block.type === 'rows').map((block) => block.source));
  for (const table of render.tables.values()) {
    if (!table.criteria || shownTables.has(table.id)) continue;
    out.push(`_${locale === 'en' ? 'Criteria' : 'Ölçüt'}: ${escapedFactText(table.criteria)}_ ${citations([table.evidenceId])}`);
    cited.push(table.evidenceId);
  }
  return { text: out.join('\n\n'), citedIds: [...new Set(cited)], chart, charts, blocks: validated.blocks.length };
}
