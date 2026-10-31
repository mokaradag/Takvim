import { ANSWER_CHART_LIMITS, answerChartFence, answerChartLabel } from './answerChart.js';
import {
  describeRowCollection,
  envelopeOnlyGroup,
  markdownPlainText,
  narrativeGroups,
  narrativeLabel,
  narrativeRowCollections,
  renderEnvelopeSentences,
  renderGroupDetails,
  renderGroupRows
} from './evidenceNarrative.js';
import { escapedFactText } from './evidenceFacts.js';
import { countProposition, noteLabel, pointerSentence, populationProposition, tablePropositions, titleCandidate } from './groundedPropositions.js';

/** Anlatımın en az önerme sayısı: sayfada bu kadar önerme varsa düzen en az bu kadarını söyler (azsa hepsini). */
export const MIN_NARRATED_PROPOSITIONS = 3;

/**
 * Doğrulanmış yanıtın KANITA BAĞLI ANLATIMI (Aşama 4D).
 *
 * Sunucu doğrulanmış olgulardan bir sayfa kurar: önermeler `P#` (sunucunun türettiği ve yazdığı olgusal
 * iddialar: sayım, en büyük/en küçük, çoğunluk, toplam, döküm), tablolar `T#`, kalan ayrıntılar `D#` ve
 * grafik adayları `G#`. Model YALNIZCA kimlik seçer ve sıralar: hangi önermelerin soruyu yanıtladığını,
 * paragraflara nasıl bölüneceğini, tablo/grafiğin nerede duracağını ve hangi bloğa yönlendirileceğini.
 * Model metni hiçbir zaman çizilmez: her cümleyi, değeri, ilişkiyi, kapsamı ve kaynak işaretini sunucu
 * yazar. Doğrulama yapısaldır (kimlik, tür, sıra, kapsam); doğal dil anlaşılmaya çalışılmaz, sözcük
 * listesi ya da kalıp yoktur. Geçersiz düzen reddedilir ve doğrulanmış belirlenimci anlatım gösterilir.
 */

export const COMPOSITION_LIMITS = Object.freeze({
  maxTables: 6,
  maxDetails: 6,
  maxCharts: 4,
  maxPropositions: 12,
  maxTitles: 3,
  maxBlocks: 12,
  maxSayBlocks: 4,
  maxSayItems: 8,
  maxNotes: 2,
  maxNoteItems: 3,
  maxValueChars: 160,
  maxQuestionChars: 600,
  maxResponseChars: 16000
});

export const COMPOSITION_BLOCK_TYPES = Object.freeze(['title', 'say', 'note', 'rows', 'details', 'chart']);

const BLOCK_KEYS = Object.freeze({
  title: [['type', 'source'], []],
  say: [['type', 'items'], []],
  note: [['type', 'items'], []],
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
export function buildComposition({ parts = [], missing = [], locale = 'tr', question = '', previousQuestion = null, today = null, populations = new Map() } = {}) {
  const tables = new Map();
  const details = new Map();
  const charts = new Map();
  const propositions = new Map();
  const titles = new Map();
  const viewTitles = [];
  const viewTables = [];
  const viewDetails = [];
  const viewCharts = [];
  const viewPropositions = [];
  const derived = [];
  let overflow = false;
  // Önermeler isteğe bağlı bir anlatım katmanıdır: sınır aşılırsa fazlası sunulmaz, sayfa düşmez.
  const propose = (ordinal, proposition, extra = {}) => {
    if (!proposition || propositions.size >= COMPOSITION_LIMITS.maxPropositions) return null;
    const id = `P${propositions.size + 1}`;
    propositions.set(id, Object.freeze({ id, part: ordinal, ...proposition, ...extra }));
    // Kaynak bağı modele kimlikle gösterilir: önerme hangi tablonun (T#) hangi sütununa (C#) dayanır; grafik yönlendirmesi bununla seçilir.
    const table = extra.table ?? null;
    viewPropositions.push({ id, part: ordinal, kind: proposition.kind, ...(proposition.tone && proposition.tone !== 'info' ? { tone: proposition.tone } : {}),
      ...(table ? { table } : {}), ...(table && Number.isInteger(proposition.column) ? { column: `C${proposition.column + 1}` } : {}),
      text: clip(proposition.plain, COMPOSITION_LIMITS.maxValueChars * 2) });
    return id;
  };
  // Başlık adayı nüfusu adlandırır (olgu taşımaz); her kanıt grubunda en çok bir aday.
  const entitle = (ordinal, group, facts, groupBy = null) => {
    if (titles.size >= COMPOSITION_LIMITS.maxTitles || !facts.length) return;
    const { project: rowProject, ...filters } = facts[0].semantic?.filters || {};
    const text = titleCandidate({ tool: group.tool, filters: filters.projectId ? { ...filters, project: rowProject } : filters, groupBy, locale });
    if (!text || [...titles.values()].some((title) => title.text === text)) return;
    const id = `H${titles.size + 1}`;
    titles.set(id, Object.freeze({ id, part: ordinal, text, markdown: `#### ${escapedFactText(text)}` }));
    viewTitles.push({ id, part: ordinal, text: clip(text, COMPOSITION_LIMITS.maxValueChars) });
  };

  for (const part of parts) {
    const presentation = part.presentation;
    if (!presentation || !Array.isArray(presentation.facts)) continue;
    const ordinal = part.index + 1;
    for (const group of narrativeGroups(presentation.facts)) {
      // Yalnızca zarf sayısından oluşan ayrıntının sayımı bir önermedir; önerme söylenirse ayrıntı yinelenmez.
      const totalFact = group.envelope.find((fact) => fact.field === 'totalCount');
      const countFallback = () => {
        const text = renderEnvelopeSentences(group, { locale, empty: presentation.empty || [], only: ['totalCount'] }).join(' ');
        return text ? { markdown: text, plain: markdownPlainText(text) } : null;
      };
      const countId = envelopeOnlyGroup(group, presentation.layout)
        ? propose(ordinal, countProposition(group, totalFact, locale, totalFact ? countFallback() : null)) : null;
      if (totalFact) entitle(ordinal, group, [totalFact]);
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
        const partition = group.tool === 'rota_task_analytics' && collection.endsWith('groups');
        const rowFacts = described.rows.flatMap((row) => row.entries.map(({ fact }) => fact));
        entitle(ordinal, group, rowFacts, partition ? rowFacts[0]?.semantic?.groupBy || null : null);
        // Sayım ölçüsü seçilmemiş listede nüfusun tamamı kanıttaysa sayım, aynı kanıtın zarfından önerme olur.
        const population = populations.get(group.evidenceId) ?? null;
        if (!countId && !totalFact && population === described.rows.length) {
          // Doğal betim süzgeçlerin tamamını ifade edemezse sayım, aynı süzgeçlerin ölçütlü belirlenimci cümlesidir.
          const fallback = (filters) => {
            const subject = filters.projectId && typeof filters.project === 'string' ? filters.project : 'Rota';
            const fact = Object.freeze({ field: 'totalCount', value: population, subject, semantic: Object.freeze({ filters, complete: true }) });
            const text = renderEnvelopeSentences({ ...group, envelope: [fact] }, { locale, only: ['totalCount'] }).join(' ');
            return text ? { markdown: text, plain: markdownPlainText(text) } : null;
          };
          propose(ordinal, populationProposition({ group, described, size: population, locale, fallback }), { table: id });
        }
        // Türetilmiş önermeler bütün sayımlardan sonra eklenir: sınır bir sayımı düşürüp türetilmişi tutamaz.
        for (const proposition of tablePropositions({ group, described, distribution: partition, locale, population, collection })) derived.push({ ordinal, proposition, table: id });
        // Grafik adayı: satır başına tek, sonlu ve negatif olmayan sayı taşıyan sütun.
        described.columns.forEach((column, index) => {
          if (!column.numeric || !labels || charts.size >= COMPOSITION_LIMITS.maxCharts) return;
          if (described.rows.length < ANSWER_CHART_LIMITS.minItems || described.rows.length > ANSWER_CHART_LIMITS.maxBarItems) return;
          const values = described.rows.map((row) => row.cells[index]);
          if (!values.every((facts) => facts.length === 1 && Number.isFinite(facts[0].value) && facts[0].value >= 0 && facts[0].value <= ANSWER_CHART_LIMITS.maxValue)) return;
          const sample = values[0][0];
          // Bir sütunun bütün değerleri aynı doğrulanmış ölçü ve birimde olmalıdır.
          if (!values.every(([fact]) => fact.semantic?.measure === sample.semantic?.measure && fact.semantic?.unit === sample.semantic?.unit)) return;
          if (sample.semantic?.measure === 'lag' && sample.semantic.unit !== 'day') return;
          const unit = /Percent$/.test(leafOf(sample.field)) ? 'percent' : sample.semantic?.unit === 'hours' ? 'hours'
            : sample.semantic?.measure === 'days' || sample.semantic?.measure === 'lag' ? 'days'
              : values.every((facts) => Number.isSafeInteger(facts[0].value)) && (COUNT_MEASURES.has(sample.semantic?.measure) || sample.semantic?.measure == null) ? 'count' : 'number';
          const total = values.reduce((sum, facts) => sum + facts[0].value, 0);
          const distribution = group.tool === 'rota_task_analytics' && collection.endsWith('groups') && complete
            && values.every(([fact]) => fact.semantic?.row?.collectionSize === described.rows.length)
            && values.every(([fact]) => ['status', 'priority', 'project', 'deadline', 'target_month'].includes(fact.semantic?.groupBy))
            && described.rows.length <= ANSWER_CHART_LIMITS.maxDonutItems && total > 0 && unit === 'count';
          const chartId = `G${charts.size + 1}`;
          const items = labels.map((label, position) => ({ label, value: values[position][0].value }));
          const types = distribution ? ['bar', 'donut'] : ['bar'];
          const title = answerChartLabel(column.label, ANSWER_CHART_LIMITS.maxTitleChars);
          if (!types.every((type) => answerChartFence({ version: 1, type, locale, title, unit, evidence: [group.evidenceId], items }))) return;
          charts.set(chartId, Object.freeze({ id: chartId, table: id, column: index, title, unit, evidenceId: group.evidenceId, items, types }));
          viewCharts.push({ id: chartId, table: id, column: columns[index].id, title: column.label, types });
        });
      }
      const detailText = renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout });
      if (detailText) {
        if (details.size >= COMPOSITION_LIMITS.maxDetails) { overflow = true; continue; }
        const id = `D${details.size + 1}`;
        const ownedTables = [...tables.values()].filter((table) => table.group === group);
        // Sayım önermesinin yerine geçtiği ayrıntıda zorunlu zarf notları (gösterilen kısım, eksiklik) önermeyle birlikte çizilir.
        const notices = countId ? renderEnvelopeSentences(group, { locale, empty: presentation.empty || [], only: ['returnedCount', 'complete', 'truncated'] }) : [];
        details.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, text: detailText, covers: countId, notices: Object.freeze(notices) }));
        for (const table of ownedTables) tables.set(table.id, Object.freeze({ ...table, detail: id }));
        if (!countId) viewDetails.push({ id, part: ordinal, text: clip(renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout, cite: false }), COMPOSITION_LIMITS.maxValueChars) });
      }
    }
  }
  if (overflow || (!details.size && !tables.size)) return null;
  for (const { ordinal, proposition, table } of derived) propose(ordinal, proposition, { table });
  // Çok bölümlü sayfada başlık, ardından gelen blokların nüfusunu adlandırır: başlığı olmayan bir bölüm varsa onun
  // olguları başka bölümün başlığı altına düşebilir. Bu durumda başlık seçeneği hiç sunulmaz (seçim daralır, olgu değişmez).
  const contentParts = new Set([...tables.values(), ...details.values()].map((item) => item.part));
  const titledParts = new Set([...titles.values()].map((item) => item.part));
  if (contentParts.size > 1 && [...contentParts].some((part) => !titledParts.has(part))) {
    titles.clear();
    viewTitles.length = 0;
  }
  const partCount = new Set(parts.map((part) => part.index)).size + missing.length;
  const view = {
    language: locale === 'en' ? 'en' : 'tr',
    ...(today ? { today } : {}),
    question: clip(String(question || ''), COMPOSITION_LIMITS.maxQuestionChars),
    ...(previousQuestion ? { previousQuestion: clip(String(previousQuestion), COMPOSITION_LIMITS.maxQuestionChars) } : {}),
    parts: partCount,
    titles: viewTitles,
    propositions: viewPropositions,
    tables: viewTables,
    details: viewDetails,
    charts: viewCharts,
    missing: missing.map((item) => ({ part: item.index + 1, ...(item.topic ? { topic: item.topic } : {}) }))
  };
  return Object.freeze({ view: Object.freeze(view), render: Object.freeze({ locale: view.language, tables, details, charts, propositions, titles, question: String(question || '') }) });
}

/**
 * Model seçimi gerektirmeyen sayfa: tek ayrıntı, sabit satır düzeni ve tablo dışında tek başına duran tek
 * önerme. Önerme tabloyla ya da başka bir önermeyle birlikteyse anlatımın seçimi modelindir.
 */
export function hasCompositionChoice(composition) {
  const { tables, details, charts, propositions } = composition.render;
  return charts.size > 0 || details.size > 1 || tables.size > 1 || propositions.size > 1 || (propositions.size > 0 && tables.size > 0)
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
  const usedPropositions = new Set();
  const spoken = new Set();
  const emphasized = new Set();
  const pointers = [];
  // Bölüm sahipliği: başlık, ardından gelen blokların nüfusunu adlandırır; her blok tek bölümündür.
  const partOfSource = (type, source) => (type === 'title' ? render.titles.get(source)?.part : type === 'rows' ? render.tables.get(source)?.part
    : type === 'details' ? render.details.get(source)?.part : render.tables.get(render.charts.get(source)?.table)?.part);
  const partOfItem = (id) => render.propositions?.get(id)?.part ?? partOfSource(render.tables.has(id) ? 'rows' : 'chart', id);
  let titledPart = null;
  const owned = (parts) => {
    const unique = new Set(parts);
    if (unique.size !== 1) return 'PART_MIXED';
    const [part] = unique;
    return titledPart != null && part !== titledPart ? 'PART_SCOPE' : null;
  };
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.hasOwn(raw, index)) return fail('BLOCK_INVALID');
    const block = raw[index];
    const type = block?.type;
    if (!COMPOSITION_BLOCK_TYPES.includes(type) || !exactKeys(block, ...BLOCK_KEYS[type])) return fail('BLOCK_INVALID');
    if (type === 'title') {
      if (typeof block.source !== 'string' || !render.titles?.has(block.source)) return fail('UNKNOWN_SOURCE');
      if (usedSources.has(block.source)) return fail('DUPLICATE_SOURCE');
      usedSources.add(block.source);
      titledPart = render.titles.get(block.source).part;
      blocks.push({ type, source: block.source });
      continue;
    }
    if (type === 'note') {
      // Not kutusu yalnızca sunucu önermeleridir; rengini önermelerin sunucu tonu belirler.
      const items = block.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > COMPOSITION_LIMITS.maxNoteItems) return fail('NOTE_INVALID');
      if (blocks.filter((item) => item.type === 'note').length >= COMPOSITION_LIMITS.maxNotes) return fail('NOTE_INVALID');
      for (let position = 0; position < items.length; position += 1) {
        if (!Object.hasOwn(items, position) || typeof items[position] !== 'string') return fail('NOTE_INVALID');
        if (!render.propositions?.has(items[position])) return fail('UNKNOWN_PROPOSITION');
        // Paragrafta söylenen önermenin not kutusunda vurgulanması yapısal olarak normalleştirilir (yalnızca kutuda kalır);
        // başka her yineleme reddedilir. Bu, kimlik kümesini daraltır, içerik eklemez.
        if (emphasized.has(items[position]) || (usedPropositions.has(items[position]) && !spoken.has(items[position]))) return fail('DUPLICATE_PROPOSITION');
        usedPropositions.add(items[position]);
        emphasized.add(items[position]);
      }
      const scope = owned(items.map(partOfItem));
      if (scope) return fail(scope);
      blocks.push({ type, items: [...items] });
      continue;
    }
    if (type === 'say') {
      // Paragraf yalnızca sunucu önermelerinin ve sonraki bir bloğa yönlendirmenin kimlikleridir; metin taşımaz.
      const items = block.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > COMPOSITION_LIMITS.maxSayItems) return fail('SAY_INVALID');
      if (blocks.filter((item) => item.type === 'say').length >= COMPOSITION_LIMITS.maxSayBlocks) return fail('SAY_INVALID');
      for (let position = 0; position < items.length; position += 1) {
        if (!Object.hasOwn(items, position) || typeof items[position] !== 'string') return fail('SAY_INVALID');
        const id = items[position];
        if (render.propositions?.has(id)) {
          if (usedPropositions.has(id)) return fail('DUPLICATE_PROPOSITION');
          usedPropositions.add(id);
          spoken.add(id);
        } else if (render.tables.has(id) || render.charts.has(id)) {
          if (pointers.some((pointer) => pointer.id === id)) return fail('DUPLICATE_POINTER');
          pointers.push({ id, at: index });
        } else return fail('UNKNOWN_PROPOSITION');
      }
      const scope = owned(items.map(partOfItem));
      if (scope) return fail(scope);
      blocks.push({ type, items: [...items] });
      continue;
    }
    const source = block.source;
    if (typeof source !== 'string') return fail('SOURCE_INVALID');
    const known = type === 'rows' ? render.tables.get(source) : type === 'details' ? render.details.get(source) : render.charts.get(source);
    if (!known) return fail('UNKNOWN_SOURCE');
    if (usedSources.has(source)) return fail('DUPLICATE_SOURCE');
    usedSources.add(source);
    const scope = owned([partOfSource(type, source)]);
    if (scope) return fail(scope);
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
  if (['chart', 'note'].includes(blocks[0].type) || blocks.at(-1).type === 'title') return fail('LEAD_REQUIRED');
  if (blocks.filter((item) => item.type === 'title').length > COMPOSITION_LIMITS.maxTitles) return fail('BLOCK_COUNT');
  // Yönlendirme ("aşağıdaki tablo/grafik") paragrafın HEMEN ardından çizilen kanıt bloklarınadır: paragrafın k yönlendirmesi,
  // ondan sonraki ilk k tablo/grafik bloğudur. Araya başka bir tablo ya da grafik giremez.
  const evidenceAfter = (at) => blocks.slice(at + 1).filter((item) => item.type === 'rows' || item.type === 'chart').map((item) => item.source);
  for (const at of new Set(pointers.map((pointer) => pointer.at))) {
    const targets = pointers.filter((pointer) => pointer.at === at).map((pointer) => pointer.id);
    const next = evidenceAfter(at).slice(0, targets.length);
    if (next.length !== targets.length || targets.some((id) => !next.includes(id))) return fail('POINTER_TARGET');
    // Yönlendirilen blok paragrafın önermelerinden en az birini desteklemelidir: tablo kendi kanıtının önermelerini,
    // grafik yalnızca gösterdiği sütunun (aynı tablo ve sütun) önermelerini. Önermesiz yönlendirme paragrafı serbesttir.
    const said = blocks[at].items.map((id) => render.propositions?.get(id)).filter(Boolean);
    if (said.length && targets.some((id) => !said.some((proposition) => supports(render, id, proposition)))) return fail('POINTER_PROVENANCE');
  }
  // Önizleme ya da grafik bütün satırların yerine geçmez; kapsam yalnızca sunucu bloğuyla sağlanır.
  if ([...render.tables.keys()].some((id) => !usedSources.has(id))) return fail('COVERAGE_INCOMPLETE');
  // Not kutusunda vurgulanan önerme paragraftan çıkar; boşalan paragraf düşer (yönlendirmelerin göreli sırası korunur).
  const normalized = emphasized.size ? blocks.map((block) => (block.type === 'say' ? { ...block, items: block.items.filter((id) => !emphasized.has(id)) } : block))
    .filter((block) => block.type !== 'say' || block.items.length) : blocks;
  if (!normalized.length || ['chart', 'note'].includes(normalized[0].type)) return fail('LEAD_REQUIRED');
  // Çizici tablo ayrıntılarını yerinde, kalanları sonda ekler; onlar da son başlığın kapsamına uymalıdır.
  const locatedDetails = new Set(blocks.filter((block) => block.type === 'details').map((block) => block.source));
  for (const table of render.tables.values()) if (usedSources.has(table.id)) locatedDetails.add(table.detail);
  for (const detail of render.details.values()) {
    if (locatedDetails.has(detail.id) || usedPropositions.has(detail.covers)) continue;
    const scope = owned([detail.part]);
    if (scope) return fail(scope);
  }
  // Her bölüm kendi analist paragrafını ve mevcut önerme sayısına göre asgari anlatımını alır.
  const propositions = [...(render.propositions?.values() || [])];
  for (const part of new Set(propositions.map((item) => item.part))) {
    const available = propositions.filter((item) => item.part === part);
    const inSay = normalized.some((block) => block.type === 'say' && block.items.some((id) => render.propositions.get(id)?.part === part));
    if (!inSay || available.filter((item) => usedPropositions.has(item.id)).length < Math.min(MIN_NARRATED_PROPOSITIONS, available.length)) return fail('NARRATION_REQUIRED');
  }
  return { ok: true, blocks: normalized };
}

/**
 * Yönlendirilen blok önermeyi destekliyor mu (yapısal kaynak bağı)? Tablo: önerme o tablodan türetilmiştir ya da
 * tablosuz önerme (zarf sayımı) aynı kanıttandır. Grafik: önerme grafiğin tablosunun grafiğe dönüşen sütunundandır.
 */
function supports(render, id, proposition) {
  const table = render.tables.get(id);
  if (table) return proposition.table === id || (proposition.table == null && proposition.evidenceId === table.evidenceId && proposition.part === table.part);
  const chart = render.charts.get(id);
  return Boolean(chart) && proposition.table === chart.table && proposition.column === chart.column;
}

/* ── Çizim ─────────────────────────────────────────────────────── */

const citation = (ids) => [...new Set(ids)].map((id) => `【${id}】`).join('');

/**
 * Doğrulanmış düzeni Markdown yanıta çevirir. Önerme cümleleri, değerler, tablolar, ayrıntılar, grafik,
 * yönlendirmeler ve kaynak işaretleri sunucunundur; model metni çizime alınmaz. Söylenen sayım önermesi
 * ayrıntısının yerine geçer (zorunlu zarf notları önermeyle birlikte yazılır); söylenmeyen her ayrıntı
 * sunucu tarafından eklenir.
 * @returns {{ text: string, citedIds: string[], chart: string|null, charts: number, blocks: number, said: number, tables: number, notes: number, titled: boolean }}
 */
export function renderComposition(composition, validated) {
  const { render } = composition;
  const locale = render.locale;
  const out = [];
  const cited = [];
  let chart = null;
  let charts = 0;
  let said = 0;
  let tables = 0;
  let notes = 0;
  let titled = false;
  const shown = new Set();
  const saidIds = new Set(validated.blocks.filter((block) => ['say', 'note'].includes(block.type)).flatMap((block) => block.items).filter((id) => render.propositions?.has(id)));
  const coveredBy = new Map([...render.details.values()].filter((detail) => detail.covers && saidIds.has(detail.covers)).map((detail) => [detail.covers, detail]));
  // Önermesi söylenen ayrıntı hiçbir konumda yeniden yazılmaz.
  for (const detail of coveredBy.values()) shown.add(detail.id);
  const showDetail = (id) => {
    if (!id || shown.has(id)) return;
    const detail = render.details.get(id);
    if (!detail) return;
    out.push(detail.text);
    cited.push(detail.evidenceId);
    shown.add(id);
  };
  // Çizilecek grafikler önceden belirlenir: yönlendirme yalnızca gerçekten çizilen bloğa yazılır.
  const fences = new Map();
  for (const block of validated.blocks) {
    if (block.type !== 'chart') continue;
    const candidate = render.charts.get(block.source);
    if (render.tables.get(candidate.table)?.evidenceId !== candidate.evidenceId) continue;
    const fence = answerChartFence({ version: 1, type: block.style, locale, title: candidate.title, unit: candidate.unit, evidence: [candidate.evidenceId], items: candidate.items });
    if (fence) fences.set(block.source, fence);
  }
  const rowStyles = new Map(validated.blocks.filter((block) => block.type === 'rows').map((block) => [block.source, block.style]));
  for (const block of validated.blocks) {
    if (block.type === 'say') {
      const sentences = [];
      const sources = [];
      for (const id of block.items) {
        const proposition = render.propositions?.get(id);
        if (proposition) {
          sentences.push(proposition.markdown, ...(coveredBy.get(id)?.notices || []));
          sources.push(proposition.evidenceId);
          said += 1;
        } else if (render.tables.has(id)) {
          sentences.push(pointerSentence({ type: 'rows', style: rowStyles.get(id) }, locale));
        } else if (fences.has(id)) {
          sentences.push(pointerSentence({ type: 'chart', distribution: render.charts.get(id).types.includes('donut') }, locale));
        }
      }
      if (!sentences.length) continue;
      out.push(`${sentences.join(' ')}${sources.length ? ` ${citation(sources)}` : ''}`);
      cited.push(...sources);
    } else if (block.type === 'title') {
      out.push(render.titles.get(block.source).markdown);
      titled = true;
    } else if (block.type === 'note') {
      const items = block.items.map((id) => render.propositions.get(id));
      const tones = new Set(items.map((item) => item.tone || 'info'));
      const tone = tones.size === 1 ? [...tones][0] : 'info';
      const sentences = items.flatMap((item) => [item.markdown, ...(coveredBy.get(item.id)?.notices || [])]);
      const sources = items.map((item) => item.evidenceId);
      said += items.length;
      notes += 1;
      // Sunucunun not kutusu: tonu önermelerin sunucu tonudur; etiket ve cümleler sunucunundur.
      out.push(`> [!${tone}]\n> **${noteLabel(tone, locale)}:** ${sentences.join(' ')} ${citation(sources)}`);
      cited.push(...sources);
    } else if (block.type === 'rows') {
      const table = render.tables.get(block.source);
      showDetail(table.detail);
      const detail = render.details.get(table.detail);
      const stated = detail && coveredBy.get(detail.covers) === detail ? render.propositions.get(detail.covers).markdown : detail?.text || '';
      out.push(renderGroupRows(table.group, table.collection, { locale, layout: block.style, stated }));
      cited.push(table.evidenceId);
      tables += 1;
    } else if (block.type === 'details') {
      showDetail(block.source);
    } else if (block.type === 'chart') {
      const fence = fences.get(block.source);
      if (!fence) continue;
      const candidate = render.charts.get(block.source);
      showDetail(render.tables.get(candidate.table)?.detail);
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
  return { text: out.join('\n\n'), citedIds: [...new Set(cited)], chart, charts, blocks: validated.blocks.length, said, tables, notes, titled };
}
