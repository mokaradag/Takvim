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
 * Doğrulanmış yanıtın kapalı sunum düzeni.
 * Model yalnızca sunucunun tablo, ayrıntı ve grafik kimliklerini seçer/sıralar.
 * Serbest metin olgusal ilişkiyi kanıtlayamaz; hiçbir model cümlesi kabul edilmez.
 * Bütün değerleri, kayıt ilişkilerini, kapsamı ve kaynakları sunucu çizer.
 */

export const COMPOSITION_LIMITS = Object.freeze({
  maxSlots: 72,
  maxPreviewRows: 8,
  maxTables: 6,
  maxDetails: 6,
  maxCharts: 4,
  maxBlocks: 10,
  maxValueChars: 160,
  maxQuestionChars: 600,
  maxResponseChars: 16000,
  simpleSlots: 4
});

export const COMPOSITION_BLOCK_TYPES = Object.freeze(['rows', 'details', 'chart']);

const BLOCK_KEYS = Object.freeze({
  rows: [['type', 'source'], ['style']],
  details: [['type', 'source'], []],
  chart: [['type', 'source'], ['style']]
});
const ROW_STYLES = new Set(['list', 'table']);
/** Kaydın öznesini adlandıran yuvanın etiketi (kayıt türüne göre). */
const SUBJECT_NOUNS = Object.freeze({ task: ['Görev', 'Task'], project: ['Proje', 'Project'], person: ['Kişi', 'Person'] });
/** Satır adının bağlamı (anlatımda adın yanında yazılır); düzende satıra bağlı ayrı bir yuvadır. */
const CONTEXT_LABELS = Object.freeze({ project: ['Proje', 'Project'], organization: ['Birim', 'Organization'] });
const COUNT_MEASURES = new Set(['tasks', 'notifications', 'occurrences', 'events', 'people', 'projects', 'wbs-nodes', 'dependencies', 'baselines', 'tags', 'count']);

const leafOf = (field) => String(field).split('.').filter((part) => !/^\d+$/.test(part)).at(-1);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

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

/** Model yalnızca sunucu kaynaklarını seçer; metin ve yuvalar olgusal yetki kazanamaz. */
export function validateComposition(composition, response) {
  const fail = (code) => ({ ok: false, issues: [code] });
  const { view, render } = composition || {};
  if (!view || !render) return fail('COMPOSITION_UNAVAILABLE');
  if (!exactKeys(response, ['blocks'], ['language'])) return fail('SHAPE_INVALID');
  if (response.language != null && response.language !== view.language) return fail('LANGUAGE_MISMATCH');
  const raw = response.blocks;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > COMPOSITION_LIMITS.maxBlocks) return fail('BLOCK_COUNT');
  const blocks = [];
  const usedSources = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(raw, index)) return fail('BLOCK_INVALID');
    const block = raw[index];
    const type = block?.type;
    if (!COMPOSITION_BLOCK_TYPES.includes(type) || !exactKeys(block, ...BLOCK_KEYS[type])) return fail('BLOCK_INVALID');
    const source = block.source;
    if (typeof source !== 'string') return fail('SOURCE_INVALID');
    const known = type === 'rows' ? render.tables.get(source) : type === 'details' ? render.details.get(source) : render.charts.get(source);
    if (!known) return fail('UNKNOWN_SOURCE');
    if (usedSources.has(source)) return fail('DUPLICATE_SOURCE');
    usedSources.add(source);
    if (type === 'rows') {
      if (block.style != null && !ROW_STYLES.has(block.style)) return fail('STYLE_INVALID');
      // Açıkça istenen düzen modelin seçiminden önce gelir; satır sırasını sunucu korur.
      const requested = known.layout === 'table' ? 'table' : ['list', 'prose'].includes(known.layout) ? 'list' : null;
      blocks.push({ type, source, style: requested ?? block.style ?? (known.columns.length >= 2 ? 'table' : 'list') });
    } else if (type === 'chart') {
      if (block.style != null && !known.types.includes(block.style)) return fail('STYLE_INVALID');
      blocks.push({ type, source, style: block.style ?? known.types[0] });
    } else blocks.push({ type, source });
  }
  if (blocks[0].type === 'chart') return fail('LEAD_REQUIRED');
  // Önizleme ya da grafik bütün satırların yerine geçmez; kapsam yalnızca sunucu bloğuyla sağlanır.
  if ([...render.tables.keys()].some((id) => !usedSources.has(id))) return fail('COVERAGE_INCOMPLETE');
  // Atlanan ayrıntıları (kapsam ve eksik sonuç notları dahil) çizici her zaman ekler.
  return { ok: true, blocks };
}

/* ── Çizim ─────────────────────────────────────────────────────── */

/**
 * Doğrulanmış düzeni Markdown yanıta çevirir. Değerler, tablolar, ayrıntılar, grafik ve kaynak
 * işaretleri sunucunundur; model metni çizime alınmaz.
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
    if (block.type === 'rows') {
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
  }
  // Bütün ayrıntılar sunucudan gelir; modelin atlaması kapsamı ya da kaydı düşüremez.
  const shown = new Set(validated.blocks.filter((block) => block.type === 'details').map((block) => block.source));
  for (const detail of render.details.values()) {
    if (shown.has(detail.id)) continue;
    out.push(detail.text);
    cited.push(detail.evidenceId);
  }
  return { text: out.join('\n\n'), citedIds: [...new Set(cited)], chart, charts, blocks: validated.blocks.length };
}
