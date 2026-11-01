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
import { analystPropositions, countProposition, fluentParagraph, noteLabel, pointerSentence, populationProposition, tablePropositions, titleCandidate } from './groundedPropositions.js';
import { ANSWER_DETAIL_CONTRACT, normalizeAnswerDetail } from './answerDetail.js';

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
  maxCharts: 6,
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

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KPI_MIN_ITEMS = 3;
const DAY_VALUE = /^\d{4}-\d{2}-\d{2}$/;
/** Durum bölümleri: birbirini dışlar ve birlikte bir bütün verir (açık + tamamlanan = toplam); yığılmış çubuk ancak bunlarla. */
const PARTITIONS = Object.freeze([['tasks.todo', 'tasks.inProgress', 'tasks.done'], ['tasks.open', 'tasks.done'], ['tasks.todo', 'tasks.inProgress']]);
/** Yapılacak + devam eden ancak nüfus yalnızca açık işlerse tam durum kırılımıdır (tamamlananlar sessizce düşmez). */
const OPEN_ONLY_PARTITION = PARTITIONS[2];
const openOnly = (fact) => {
  const statuses = fact?.semantic?.filters?.statuses;
  return Array.isArray(statuses) && statuses.length === 2 && statuses.includes('todo') && statuses.includes('in_progress');
};
/** Birbirini izleyen termin ayları ("2026-09", "2026-10", …); boşluklu dizi zaman dizisi gibi eşit aralıkla çizilmez. */
function contiguousMonths(keys) {
  return keys.every((key, index) => {
    if (!index) return true;
    const [year, month] = keys[index - 1].split('-').map(Number);
    return key === (month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`);
  });
}

function monthLabel(key, locale) {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'tr-TR', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(`${key}-01T00:00:00Z`));
}

/** Adayın türüne göre kapalı grafik tanımı (doğrulama ve çizim aynı tanımı kullanır). */
function chartSpec(candidate, type, locale) {
  const base = { version: 1, type, locale, title: candidate.title, unit: candidate.unit, evidence: [candidate.evidenceId] };
  if (type === 'stacked') return { ...base, series: candidate.series, items: candidate.stacked };
  if (type === 'kpi') return { ...base, items: candidate.kpi };
  if (type === 'timeline') return { ...base, items: candidate.timeline };
  return { ...base, items: candidate.items };
}

const unitOf = (fact) => (/Percent$/.test(leafOf(fact.field)) ? 'percent' : fact.semantic?.unit === 'hours' ? 'hours'
  : fact.semantic?.measure === 'days' ? 'days' : Number.isSafeInteger(fact.value) && (COUNT_MEASURES.has(fact.semantic?.measure) || fact.semantic?.measure == null) ? 'count' : 'number');

/**
 * Tablonun çok sütunlu ve tarih adayları: yığılmış çubuk (satır başına birbirini dışlayan durum bölümleri) ve zaman
 * çizelgesi (görev satırlarının termin tarihi). Değerler yalnızca tablonun doğrulanmış hücreleridir.
 */
function tableCharts({ group, described, collection, complete, labels, locale, table }) {
  const out = [];
  const rows = described.rows;
  if (!labels || rows.length < ANSWER_CHART_LIMITS.minItems) return out;
  const single = (index) => rows.every((row) => row.cells[index]?.length === 1);
  const metricOf = (index) => rows[0].cells[index]?.[0]?.semantic?.metric;
  const numeric = described.columns.map((column, index) => (column.numeric && single(index) ? index : -1)).filter((index) => index >= 0);
  const partition = complete && PARTITIONS.find((set) => set.every((metric) => numeric.some((index) => metricOf(index) === metric))
    && (set !== OPEN_ONLY_PARTITION || rows.every((row) => openOnly(row.cells[numeric.find((index) => metricOf(index) === 'tasks.todo')]?.[0]))));
  if (partition && rows.length <= ANSWER_CHART_LIMITS.maxStackedItems) {
    const indexes = partition.map((metric) => numeric.find((index) => metricOf(index) === metric));
    const valid = indexes.every((index) => rows.every((row) => Number.isSafeInteger(row.cells[index][0].value) && row.cells[index][0].value >= 0
      && row.cells[index][0].semantic?.metric === metricOf(index)));
    if (valid) {
      out.push({ table, column: indexes[0], columns: indexes, title: answerChartLabel(locale === 'en' ? 'Status breakdown' : 'Durum kırılımı', ANSWER_CHART_LIMITS.maxTitleChars),
        unit: 'count', evidenceId: group.evidenceId, types: ['stacked'],
        series: indexes.map((index) => answerChartLabel(described.columns[index].label)),
        stacked: rows.map((row, position) => ({ label: labels[position], values: indexes.map((index) => row.cells[index][0].value) })) });
    }
  }
  // Zaman çizelgesi: görev satırlarının tek tarih sütunu (ör. termin); tarih sırasıyla, en çok sınır kadar satır.
  const dates = described.columns.map((column, index) => index).filter((index) => single(index)
    && rows.every((row) => row.cells[index][0].semantic?.valueType === 'date' && typeof row.cells[index][0].value === 'string' && DAY_VALUE.test(row.cells[index][0].value)));
  if (/(^|\.)tasks$/.test(collection) && dates.length === 1 && complete && rows.length <= ANSWER_CHART_LIMITS.maxTimelineItems) {
    const [index] = dates;
    const timeline = rows.map((row, position) => ({ label: labels[position], date: row.cells[index][0].value }))
      .map((item, order) => ({ ...item, order })).sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order)
      .map(({ label, date }) => ({ label, date }));
    out.push({ table, column: index, title: answerChartLabel(described.columns[index].label, ANSWER_CHART_LIMITS.maxTitleChars), unit: 'number',
      evidenceId: group.evidenceId, types: ['timeline'], timeline });
  }
  return out;
}

/** Satır koleksiyonu olmayan kaydın başlık ölçüleri: sonlu, negatif olmayan, birimi bilinen doğrulanmış sayılar (2–6). */
function kpiCandidate(group, locale) {
  const facts = group.main.entries.map(({ fact }) => fact).filter((fact) => typeof fact.value === 'number' && Number.isFinite(fact.value) && fact.value >= 0
    && fact.value <= ANSWER_CHART_LIMITS.maxValue && fact.semantic?.metric && (COUNT_MEASURES.has(fact.semantic?.measure) || /Percent$/.test(leafOf(fact.field))));
  const seen = new Set();
  const items = [];
  for (const fact of facts) {
    // Birim kartın değerindedir (ör. %14): etiketteki "(%)" eki yinelenmez.
    const label = answerChartLabel(capitalizeLabel(narrativeLabel(fact, locale).label.replace(/\s*\(%\)$/, ''), locale));
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({ label, value: fact.value, unit: unitOf(fact) });
  }
  // Bir ya da iki sayı kısa yanıttır: gösterge kartları ancak en az üç başlık ölçüsü olan genel görünümde.
  if (items.length < KPI_MIN_ITEMS) return null;
  return { title: answerChartLabel(locale === 'en' ? 'Key figures' : 'Öne çıkan göstergeler'), unit: 'number', evidenceId: group.evidenceId, types: ['kpi'],
    kpi: items.slice(0, ANSWER_CHART_LIMITS.maxKpiItems) };
}

const capitalizeLabel = (text, locale) => `${String(text).charAt(0).toLocaleUpperCase(locale === 'en' ? 'en-US' : 'tr-TR')}${String(text).slice(1)}`;

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
export function buildComposition({ parts = [], missing = [], locale = 'tr', question = '', previousQuestion = null, today = null, populations = new Map(),
  visual = false, detail = null, analyst = false } = {}) {
  const answerDetail = normalizeAnswerDetail(detail);
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
  // Tek bölümde önermeler isteğe bağlıdır; çok bölümlü sayfada sınır bölümün türetilmiş olgularını düşüremez.
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
        const addChart = (candidate, viewExtra = {}) => {
          if (charts.size >= COMPOSITION_LIMITS.maxCharts) return;
          const chartId = `G${charts.size + 1}`;
          if (!candidate.types.every((type) => answerChartFence(chartSpec(candidate, type, locale)))) return;
          charts.set(chartId, Object.freeze({ id: chartId, part: ordinal, ...candidate }));
          viewCharts.push({ id: chartId, part: ordinal, ...(candidate.table ? { table: candidate.table } : {}), ...viewExtra, title: candidate.title, types: candidate.types });
        };
        // Termin ayları zaman dizisidir: yalnızca boşluksuz ardışık aylar çizgi olur (çizgi 24 noktaya kadar, çubuk 12'ye kadar).
        const monthly = group.tool === 'rota_task_analytics' && collection.endsWith('groups') && complete && described.rows.every((row) => MONTH.test(row.title))
          && contiguousMonths(described.rows.map((row) => row.title));
        described.columns.forEach((column, index) => {
          if (!column.numeric || !labels || charts.size >= COMPOSITION_LIMITS.maxCharts) return;
          const rowLimit = monthly ? ANSWER_CHART_LIMITS.maxLineItems : ANSWER_CHART_LIMITS.maxBarItems;
          if (described.rows.length < ANSWER_CHART_LIMITS.minItems || described.rows.length > rowLimit) return;
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
          const items = labels.map((label, position) => ({ label, value: values[position][0].value }));
          // Zaman dizisi: termin ayına göre tam gruplar sıralı dönemlerdir (çizgi); diğer sütunlar kategorik karşılaştırmadır.
          const months = monthly && unit === 'count' && values.every(([fact]) => fact.semantic?.groupBy === 'target_month')
            && described.rows.length <= ANSWER_CHART_LIMITS.maxLineItems;
          const types = months ? (described.rows.length <= ANSWER_CHART_LIMITS.maxBarItems ? ['line', 'bar'] : ['line'])
            : distribution && described.rows.length <= ANSWER_CHART_LIMITS.maxBarItems ? ['bar', 'donut'] : ['bar'];
          // Dağılım ve zaman dizisi grafiği nüfusun sunucu başlığını taşır (ör. "Görevlerinizin durum dağılımı"); diğerleri sütun adını.
          const partTitle = distribution || months ? [...titles.values()].find((item) => item.part === ordinal)?.text : null;
          const title = answerChartLabel(partTitle || column.label, ANSWER_CHART_LIMITS.maxTitleChars);
          addChart({ table: id, column: index, title, unit, evidenceId: group.evidenceId,
            items: months ? described.rows.map((row, position) => ({ label: monthLabel(row.title, locale), value: values[position][0].value })) : items, types },
          { column: columns[index].id });
        });
        // Çok sütunlu (yığılmış) ve tarih (zaman çizelgesi) adayları tek sütun adaylarından sonra gelir; kimlikleri kaymaz.
        for (const candidate of tableCharts({ group, described, collection, complete, labels, locale, table: id })) {
          addChart(candidate, Number.isInteger(candidate.column) ? { column: columns[candidate.column].id } : {});
        }
      }
      // Başlık ölçüleri (KPI kartları): satır koleksiyonu olmayan kaydın doğrulanmış sayıları.
      if (!multi.size && charts.size < COMPOSITION_LIMITS.maxCharts) {
        const kpi = kpiCandidate(group, locale);
        if (kpi && answerChartFence(chartSpec(kpi, 'kpi', locale))) {
          const chartId = `G${charts.size + 1}`;
          charts.set(chartId, Object.freeze({ id: chartId, part: ordinal, table: null, column: null, ...kpi }));
          viewCharts.push({ id: chartId, part: ordinal, title: kpi.title, types: kpi.types });
        }
      }
      // Tek satırlık görev sonucunda sayım, ölçüt listesi yerine doğal cümledir ("Ekibinizde şu anda **1** gecikmiş görev var.").
      const single = !countId && totalFact && group.tool === 'rota_task_search' && !multi.size && [...group.collections.values()].some((rows) => rows.size === 1);
      const lead = single ? countProposition(group, totalFact, locale, null)?.markdown ?? null : null;
      const detailText = renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout, lead });
      if (detailText) {
        if (details.size >= COMPOSITION_LIMITS.maxDetails) { overflow = true; continue; }
        const id = `D${details.size + 1}`;
        const ownedTables = [...tables.values()].filter((table) => table.group === group);
        // Sayım önermesinin yerine geçtiği ayrıntıda zorunlu zarf notları (gösterilen kısım, eksiklik) önermeyle birlikte çizilir.
        const notices = countId ? renderEnvelopeSentences(group, { locale, empty: presentation.empty || [], only: ['returnedCount', 'complete', 'truncated'] }) : [];
        details.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, text: detailText, covers: countId, notices: Object.freeze(notices),
          source: Object.freeze({ group, empty: presentation.empty || [], layout: presentation.layout, lead }) }));
        for (const table of ownedTables) tables.set(table.id, Object.freeze({ ...table, detail: id }));
        if (!countId) viewDetails.push({ id, part: ordinal, text: clip(renderGroupDetails(group, { locale, empty: presentation.empty || [], layout: presentation.layout, cite: false }), COMPOSITION_LIMITS.maxValueChars) });
      }
    }
  }
  if (overflow || (!details.size && !tables.size)) return null;
  const contentParts = new Set([...tables.values(), ...details.values()].map((item) => item.part));
  // Analist önermeleri (analitik özette) sınırın içinde sayılır ve isteğe bağlı türetilmiş önermelerden ÖNCE eklenir:
  // tek bölümlü sayfada sınır türetilmiş olanı düşürür, sonucu (karşıtlık, yoğunlaşma, öncelik) değil.
  const conclusions = analyst ? analystPropositions(parts, locale) : [];
  if (contentParts.size > 1 && propositions.size + derived.length + conclusions.length > COMPOSITION_LIMITS.maxPropositions) return null;
  for (const item of conclusions) propose(item.part, item.proposition, { table: null, analyst: true });
  for (const { ordinal, proposition, table } of derived) propose(ordinal, proposition, { table });
  // Çok bölümlü sayfada başlık, ardından gelen blokların nüfusunu adlandırır: başlığı olmayan bir bölüm varsa onun
  // olguları başka bölümün başlığı altına düşebilir. Bu durumda başlık seçeneği hiç sunulmaz (seçim daralır, olgu değişmez).
  const titledParts = new Set([...titles.values()].map((item) => item.part));
  if (contentParts.size > 1 && [...contentParts].some((part) => !titledParts.has(part))) {
    titles.clear();
    viewTitles.length = 0;
  }
  const partCount = new Set(parts.map((part) => part.index)).size + missing.length;
  const view = {
    language: locale === 'en' ? 'en' : 'tr',
    ...(today ? { today } : {}),
    detail: answerDetail,
    ...(visual ? { visual: true } : {}),
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
  return Object.freeze({ view: Object.freeze(view), render: Object.freeze({ locale: view.language, tables, details, charts, propositions, titles, question: String(question || ''),
    visual: Boolean(visual), detail: answerDetail }) });
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
    : type === 'details' ? render.details.get(source)?.part : render.charts.get(source)?.part);
  const partOfItem = (id) => render.propositions?.get(id)?.part ?? partOfSource(render.tables.has(id) ? 'rows' : render.details?.has(id) ? 'details' : 'chart', id);
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
      const said = [];
      const placed = [];
      for (let position = 0; position < items.length; position += 1) {
        if (!Object.hasOwn(items, position) || typeof items[position] !== 'string') return fail('SAY_INVALID');
        const id = items[position];
        if (render.propositions?.has(id)) {
          if (usedPropositions.has(id)) return fail('DUPLICATE_PROPOSITION');
          usedPropositions.add(id);
          spoken.add(id);
          said.push(id);
        } else if (render.tables.has(id) || render.charts.has(id)) {
          if (pointers.some((pointer) => pointer.id === id)) return fail('DUPLICATE_POINTER');
          pointers.push({ id, at: blocks.length });
          said.push(id);
        } else if (render.details?.has(id)) {
          // Paragrafa yazılan D#, sunucunun doğrulanmış ayrıntısının yeridir: paragrafın hemen ardında kendi bloğu olarak
          // çizilir (details bloğuyla aynı; model metin yazmaz, ayrıntı bir kez kullanılır).
          if (usedSources.has(id)) return fail('DUPLICATE_SOURCE');
          usedSources.add(id);
          placed.push(id);
        } else return fail('UNKNOWN_PROPOSITION');
      }
      const scope = owned(items.map(partOfItem));
      if (scope) return fail(scope);
      if (said.length) blocks.push({ type, items: said });
      for (const source of placed) blocks.push({ type: 'details', source });
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
  // Yönlendirme ("aşağıdaki tablo" / "aşağıdaki grafik") paragraftan SONRA çizilen kendi bloğunadır. Cümle bloğun türünü
  // söyler: aynı türden yönlendirilmeyen bir blok (başka bir tablo ya da başka bir grafik) araya girerse "aşağıdaki"
  // yanlış bloğu gösterir ve reddedilir. Farklı türden blok (tablodan önce çizilen grafik) belirsizlik yaratmaz.
  for (const at of new Set(pointers.map((pointer) => pointer.at))) {
    const targets = pointers.filter((pointer) => pointer.at === at).map((pointer) => pointer.id);
    for (const id of targets) {
      const kind = render.tables.has(id) ? 'rows' : 'chart';
      const position = blocks.findIndex((item, place) => place > at && item.type === kind && item.source === id);
      if (position < 0 || blocks.slice(at + 1, position).some((item) => item.type === kind && !targets.includes(item.source))) return fail('POINTER_TARGET');
    }
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
    if (!inSay || available.filter((item) => usedPropositions.has(item.id)).length < Math.min(minNarrated(render), available.length)) return fail('NARRATION_REQUIRED');
    // Yanıt ayrıntısının üst sınırı da sözleşmedir: kısa/dengeli yanıt bütün önermeleri anlatamaz.
    if (available.filter((item) => usedPropositions.has(item.id)).length > ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].maxNarrated) return fail('NARRATION_LIMIT');
  }
  // Ayrıntı ayarının not kutusu sınırı (kısa yanıt tek vurgu taşır).
  if (normalized.filter((block) => block.type === 'note').length > ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].maxNotes) return fail('NOTE_INVALID');
  return { ok: true, blocks: normalized };
}

/** Bölüm başına en az anlatılacak önerme: ayrıntı ayarının sözleşmesi (eski sayfalarda varsayılan dengeli). */
function minNarrated(render) {
  return render.detail ? ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].minNarrated : MIN_NARRATED_PROPOSITIONS;
}

/** Görselleştirme tercihi: bölümlerde (açık + tamamlanan) yığılmış çubuk, dağılımda halka, zaman dizisinde çizgi; sonra çubuk, zaman çizelgesi, göstergeler. */
const STYLE_PREFERENCE = Object.freeze(['stacked', 'donut', 'line', 'bar', 'timeline', 'kpi']);
const preferredStyle = (candidate) => STYLE_PREFERENCE.find((style) => candidate.types.includes(style)) || candidate.types[0];

/** Açıkça istenen görselleştirmenin en uygun adayı (ilk bölümden başlayarak); yoksa `null`. */
export function preferredChart(render) {
  const candidates = [...render.charts.values()];
  for (const style of STYLE_PREFERENCE) {
    const found = candidates.find((candidate) => preferredStyle(candidate) === style);
    if (found) return { id: found.id, style };
  }
  return null;
}

/**
 * Açık görselleştirme isteği + geçerli aday → grafik ZORUNLU. Model düzeni grafik içermiyorsa sunucu en uygun adayı
 * kendi tablosunun hemen ardına (tablo yoksa bölümünün paragrafının ardına) ekler. Grafik doğrulanmış kanıtın sunucu
 * tanımıdır; ekleme yeni olgu üretmez. Sonuç yine `validateComposition` ile denetlenir.
 */
export function ensureChart(composition, validated) {
  const { render } = composition;
  if (!render.visual || !validated?.ok || validated.blocks.some((block) => block.type === 'chart')) return validated;
  const choice = preferredChart(render);
  if (!choice) return validated;
  const candidate = render.charts.get(choice.id);
  const blocks = [...validated.blocks];
  const tableAt = candidate.table ? blocks.findIndex((block) => block.type === 'rows' && block.source === candidate.table) : -1;
  const partSay = blocks.findIndex((block) => block.type === 'say' && block.items.some((id) => render.propositions.get(id)?.part === candidate.part));
  const at = tableAt >= 0 ? tableAt + 1 : partSay >= 0 ? partSay + 1 : blocks.length;
  blocks.splice(at, 0, { type: 'chart', source: choice.id, style: choice.style });
  const checked = validateComposition(composition, { blocks: blocks.map((block) => ({ ...block })) });
  return checked.ok ? { ...checked, chartInserted: true } : validated;
}

/**
 * Sunucunun belirlenimci düzeni (model düzeni yoksa ya da reddedildiyse): bölüm başına başlık, ayrıntı ayarı kadar önerme
 * (bölümün kendi paragrafında), istenmişse ya da gösterge kartıysa grafik ve bütün tablolar. Aynı doğrulayıcıdan geçer.
 */
export function defaultComposition(composition) {
  const { render } = composition;
  const contract = ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)];
  const chart = render.visual ? preferredChart(render) : null;
  // Bölümler grafik adaylarını da kapsar: yalnızca gösterge kartı olan bölüm açık grafik isteğinde düşmez.
  const parts = [...new Set([...render.propositions.values(), ...render.tables.values(), ...render.details.values(), ...render.charts.values()].map((item) => item.part))]
    .sort((a, b) => a - b);
  const blocks = [];
  for (const part of parts.slice(0, COMPOSITION_LIMITS.maxSayBlocks)) {
    const title = [...render.titles.values()].find((item) => item.part === part);
    if (title) blocks.push({ type: 'title', source: title.id });
    // Tablosu çizilen bölümde döküm cümlesi tabloyu yineler: yalnızca bölümün asgari anlatımı için gerekiyorsa söylenir.
    const tabled = [...render.tables.values()].some((table) => table.part === part);
    const available = [...render.propositions.values()].filter((item) => item.part === part);
    const preferred = tabled && available.filter((item) => item.kind !== 'breakdown').length >= Math.min(contract.minNarrated, available.length)
      ? available.filter((item) => item.kind !== 'breakdown') : available;
    // Bütçe önce analist sonuçlarına ayrılır (türetilmiş önermeler onları düşüremez); paragraf sırası önerme sırasıdır.
    const budget = Math.min(contract.maxNarrated, COMPOSITION_LIMITS.maxSayItems);
    const kept = new Set([...preferred.filter((item) => item.analyst), ...preferred.filter((item) => !item.analyst)].slice(0, budget).map((item) => item.id));
    const said = [...preferred.filter((item) => !item.analyst), ...preferred.filter((item) => item.analyst)].filter((item) => kept.has(item.id)).map((item) => item.id);
    // Analitik genel görünümün göstergeleri (KPI) ayrıntılı yanıtta ya da görselleştirme isteğinde gösterilir.
    const kpi = !chart && normalizeAnswerDetail(render.detail) === 'detailed' ? [...render.charts.values()].find((item) => item.part === part && item.types[0] === 'kpi') : null;
    const partChart = chart && render.charts.get(chart.id).part === part ? chart : kpi ? { id: kpi.id, style: 'kpi' } : null;
    const tabledPart = [...render.tables.values()].some((table) => table.part === part);
    if (said.length) blocks.push({ type: 'say', items: said });
    else if (!tabledPart) {
      // Önermesi ve tablosu olmayan bölüm (başlığı boş kalmaz): önce bölümün sunucu ayrıntısı, o da yoksa grafiğe yönlendiren
      // sunucu cümlesi (yalnızca gösterge kartı olan bölüm).
      const lead = [...render.details.values()].find((item) => item.part === part && ![...render.tables.values()].some((table) => table.detail === item.id));
      if (lead) blocks.push({ type: 'details', source: lead.id });
      else if (partChart) blocks.push({ type: 'say', items: [partChart.id] });
    }
    const tables = [...render.tables.values()].filter((table) => table.part === part);
    for (const table of tables) {
      blocks.push({ type: 'rows', source: table.id });
      if (partChart && render.charts.get(partChart.id).table === table.id) blocks.push({ type: 'chart', source: partChart.id, style: partChart.style });
    }
    if (partChart && render.charts.get(partChart.id).table == null) blocks.push({ type: 'chart', source: partChart.id, style: partChart.style });
  }
  if (!blocks.length || blocks.length > COMPOSITION_LIMITS.maxBlocks) return null;
  const checked = validateComposition(composition, { blocks });
  return checked.ok ? checked : null;
}

/**
 * Yönlendirilen blok önermeyi destekliyor mu (yapısal kaynak bağı)? Tablo: önerme o tablodan türetilmiştir ya da
 * tablosuz önerme (zarf sayımı) aynı kanıttandır. Grafik: önerme grafiğin tablosunun grafiğe dönüşen sütunundandır.
 */
function supports(render, id, proposition) {
  const table = render.tables.get(id);
  if (table) return proposition.table === id || (proposition.table == null && proposition.evidenceId === table.evidenceId && proposition.part === table.part);
  const chart = render.charts.get(id);
  if (!chart) return false;
  // Başlık ölçüleri (KPI) tablosuzdur: aynı kanıtın tablosuz önermelerini destekler.
  if (chart.table == null) return proposition.table == null && proposition.evidenceId === chart.evidenceId && proposition.part === chart.part;
  return proposition.table === chart.table && (chart.columns || [chart.column]).includes(proposition.column);
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
  // Çizilen her parça bölümüyle tutulur: modelin yerleştirmediği ayrıntı kendi bölümünün içine girer (yanıtın sonuna değil).
  const out = [];
  const emit = (text, part) => { if (text) out.push({ text, part }); };
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
  // Söylenen önermelerin ölçüleri aynı kanıtın ayrıntısında yinelenmez (ör. analist cümlesindeki açık/gecikmiş sayı).
  const stated = new Map();
  for (const id of saidIds) {
    const proposition = render.propositions.get(id);
    for (const metric of proposition.fluent?.states || []) {
      if (!stated.has(proposition.evidenceId)) stated.set(proposition.evidenceId, new Set());
      stated.get(proposition.evidenceId).add(metric);
    }
  }
  const detailText = (detail) => {
    const omit = stated.get(detail.evidenceId);
    return omit?.size && detail.source ? renderGroupDetails(detail.source.group, { locale, empty: detail.source.empty, layout: detail.source.layout, lead: detail.source.lead, omitMetrics: omit })
      : detail.text;
  };
  const pending = [];
  const showDetail = (id, place = true) => {
    if (!id || shown.has(id)) return;
    const detail = render.details.get(id);
    if (!detail) return;
    shown.add(id);
    const text = detailText(detail);
    if (!text) return;
    cited.push(detail.evidenceId);
    if (place) emit(text, detail.part);
    else pending.push({ text, part: detail.part });
  };
  // Çizilecek grafikler önceden belirlenir: yönlendirme yalnızca gerçekten çizilen bloğa yazılır.
  const fences = new Map();
  for (const block of validated.blocks) {
    if (block.type !== 'chart') continue;
    const candidate = render.charts.get(block.source);
    if (candidate.table != null && render.tables.get(candidate.table)?.evidenceId !== candidate.evidenceId) continue;
    const fence = answerChartFence(chartSpec(candidate, block.style, locale));
    if (fence) fences.set(block.source, fence);
  }
  const rowStyles = new Map(validated.blocks.filter((block) => block.type === 'rows').map((block) => [block.source, block.style]));
  const chartStyles = new Map(validated.blocks.filter((block) => block.type === 'chart').map((block) => [block.source, block.style]));
  const partOf = (id) => render.propositions?.get(id)?.part ?? render.tables.get(id)?.part ?? render.charts.get(id)?.part ?? null;
  for (const block of validated.blocks) {
    if (block.type === 'say') {
      // Paragraf sunucunun akıcı düzyazısıdır: aynı nüfusun önermeleri bağlaçla birleşir (§ fluentParagraph).
      const entries = [];
      const sources = [];
      for (const id of block.items) {
        const proposition = render.propositions?.get(id);
        if (proposition) {
          entries.push({ proposition }, ...(coveredBy.get(id)?.notices || []).map((text) => ({ text })));
          sources.push(proposition.evidenceId);
          said += 1;
        } else if (render.tables.has(id)) {
          entries.push({ text: pointerSentence({ type: 'rows', style: rowStyles.get(id) }, locale) });
        } else if (fences.has(id)) {
          entries.push({ text: pointerSentence({ type: 'chart', chartType: chartStyles.get(id), distribution: render.charts.get(id).types.includes('donut') }, locale) });
        }
      }
      if (!entries.length) continue;
      emit(`${fluentParagraph(entries, locale)}${sources.length ? ` ${citation(sources)}` : ''}`, partOf(block.items[0]));
      cited.push(...sources);
    } else if (block.type === 'title') {
      const title = render.titles.get(block.source);
      emit(title.markdown, title.part);
      titled = true;
    } else if (block.type === 'note') {
      const items = block.items.map((id) => render.propositions.get(id));
      const tones = new Set(items.map((item) => item.tone || 'info'));
      const tone = tones.size === 1 ? [...tones][0] : 'info';
      const sentence = fluentParagraph(items.flatMap((item) => [{ proposition: item }, ...(coveredBy.get(item.id)?.notices || []).map((text) => ({ text }))]), locale);
      const sources = items.map((item) => item.evidenceId);
      said += items.length;
      notes += 1;
      // Sunucunun not kutusu: tonu önermelerin sunucu tonudur; etiket ve cümleler sunucunundur.
      emit(`> [!${tone}]\n> **${noteLabel(tone, locale)}:** ${sentence} ${citation(sources)}`, items[0].part);
      cited.push(...sources);
    } else if (block.type === 'rows') {
      const table = render.tables.get(block.source);
      showDetail(table.detail);
      const detail = render.details.get(table.detail);
      const statedText = detail && coveredBy.get(detail.covers) === detail ? render.propositions.get(detail.covers).markdown : detail ? detailText(detail) : '';
      emit(renderGroupRows(table.group, table.collection, { locale, layout: block.style, stated: statedText }), table.part);
      cited.push(table.evidenceId);
      tables += 1;
    } else if (block.type === 'details') {
      showDetail(block.source);
    } else if (block.type === 'chart') {
      const fence = fences.get(block.source);
      if (!fence) continue;
      const candidate = render.charts.get(block.source);
      if (candidate.table != null) showDetail(render.tables.get(candidate.table)?.detail);
      emit(fence, candidate.part);
      cited.push(candidate.evidenceId);
      chart = block.style;
      charts += 1;
    }
  }
  // Bütün ayrıntılar sunucudan gelir; modelin atlaması kapsamı ya da kaydı düşüremez. Yerleştirilmeyen ayrıntı kendi
  // bölümünün son parçasından sonra (bölümün parçası yoksa sonraki bölümden önce) çizilir; bölüm sırası korunur.
  for (const detail of render.details.values()) showDetail(detail.id, false);
  for (const item of pending) {
    const last = out.map((chunk) => chunk.part).lastIndexOf(item.part);
    const later = out.findIndex((chunk) => chunk.part != null && item.part != null && chunk.part > item.part);
    const at = last >= 0 ? last + 1 : later >= 0 ? later : out.length;
    out.splice(at, 0, item);
  }
  return { text: out.map((chunk) => chunk.text).join('\n\n'), citedIds: [...new Set(cited)], chart, charts, blocks: validated.blocks.length, said, tables, notes, titled };
}
