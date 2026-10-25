import { ANSWER_CHART_LIMITS, answerChartFence, answerChartLabel } from './answerChart.js';
import {
  describeRowCollection,
  narrativeGroups,
  narrativeLabel,
  narrativeRowCollections,
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
  maxTables: 6,
  maxDetails: 6,
  maxCharts: 4,
  maxBlocks: 10,
  maxValueChars: 160,
  maxQuestionChars: 600,
  maxResponseChars: 16000
});

export const COMPOSITION_BLOCK_TYPES = Object.freeze(['rows', 'details', 'chart']);

const BLOCK_KEYS = Object.freeze({
  rows: [['type', 'source'], ['style']],
  details: [['type', 'source'], []],
  chart: [['type', 'source'], ['style']]
});
const ROW_STYLES = new Set(['list', 'table']);
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

/**
 * Olgu sayfasını kurar.
 *
 * @param {object} input
 * @param {{ index: number, presentation: { facts: object[], layout: string, empty: string[] }, topic?: string }[]} input.parts
 *   Doğrulanmış bölümler (plan sırasıyla).
 * @param {{ index: number, topic?: string, kind: 'unavailable'|'not_found' }[]} [input.missing] Tamamlanamayan bölümler.
 * @returns {{ view: object, render: object } | null} Model girdisi (`view`) ve sunucunun çizim verisi (`render`).
 */
export function buildComposition({ parts = [], missing = [], locale = 'tr', question = '', previousQuestion = null, today = null } = {}) {
  const tables = new Map();
  const details = new Map();
  const charts = new Map();
  const viewTables = [];
  const viewDetails = [];
  const viewCharts = [];
  let overflow = false;

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
        const complete = described.rows.every((row) => row.entries.every(({ fact }) => fact.semantic?.complete === true));
        const rowCriteria = [...new Set(described.rows.map((row) => narrativeLabel(row.entries[0].fact, locale).criteria))];
        const criteria = rowCriteria.length === 1 ? rowCriteria[0] : group.envelope.map((fact) => narrativeLabel(fact, locale).criteria).find(Boolean) || '';
        const labels = chartLabels(described.rows);
        tables.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, group, collection, rows: described.rows.length, columns, complete, criteria, detail: null,
          layout: presentation.layout }));
        viewTables.push({ id, part: ordinal, title: described.head, rows: described.rows.length,
          ...(criteria ? { criteria: clip(criteria, COMPOSITION_LIMITS.maxValueChars) } : {}), columns, complete });
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
      const detailText = renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout });
      if (detailText) {
        if (details.size >= COMPOSITION_LIMITS.maxDetails) { overflow = true; continue; }
        const id = `D${details.size + 1}`;
        const ownedTables = [...tables.values()].filter((table) => table.group === group);
        details.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, text: detailText }));
        for (const table of ownedTables) tables.set(table.id, Object.freeze({ ...table, detail: id }));
        viewDetails.push({ id, part: ordinal, text: clip(renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout, cite: false }), COMPOSITION_LIMITS.maxValueChars) });
      }
    }
  }
  if (overflow || (!details.size && !tables.size)) return null;
  const partCount = new Set(parts.map((part) => part.index)).size + missing.length;
  const view = {
    language: locale === 'en' ? 'en' : 'tr',
    ...(today ? { today } : {}),
    question: clip(String(question || ''), COMPOSITION_LIMITS.maxQuestionChars),
    ...(previousQuestion ? { previousQuestion: clip(String(previousQuestion), COMPOSITION_LIMITS.maxQuestionChars) } : {}),
    parts: partCount,
    tables: viewTables,
    details: viewDetails,
    charts: viewCharts,
    missing: missing.map((item) => ({ part: item.index + 1, ...(item.topic ? { topic: item.topic } : {}) }))
  };
  return Object.freeze({ view: Object.freeze(view), render: Object.freeze({ locale: view.language, tables, details, charts, question: String(question || '') }) });
}

/** Tek ayrıntı ve sabit satır düzeni model seçimi gerektirmez. */
export function hasCompositionChoice(composition) {
  const { tables, details, charts } = composition.render;
  return charts.size > 0 || details.size > 1 || tables.size > 1
    || [...tables.values()].some((table) => !['table', 'list', 'prose'].includes(table.layout));
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
  const shown = new Set();
  const showDetail = (id) => {
    if (!id || shown.has(id)) return;
    const detail = render.details.get(id);
    if (!detail) return;
    out.push(detail.text);
    cited.push(detail.evidenceId);
    shown.add(id);
  };
  for (const block of validated.blocks) {
    if (block.type === 'rows') {
      const table = render.tables.get(block.source);
      showDetail(table.detail);
      out.push(renderGroupRows(table.group, table.collection, { locale, layout: block.style, stated: render.details.get(table.detail)?.text || '' }));
      cited.push(table.evidenceId);
    } else if (block.type === 'details') {
      showDetail(block.source);
    } else if (block.type === 'chart') {
      const candidate = render.charts.get(block.source);
      if (render.tables.get(candidate.table)?.evidenceId !== candidate.evidenceId) continue;
      showDetail(render.tables.get(candidate.table)?.detail);
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
  for (const detail of render.details.values()) {
    showDetail(detail.id);
  }
  return { text: out.join('\n\n'), citedIds: [...new Set(cited)], chart, charts, blocks: validated.blocks.length };
}
