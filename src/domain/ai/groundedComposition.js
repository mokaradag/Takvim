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
import { analystPropositions, singleSubjectPropositions, caveatPropositions, countProposition, taskCountLead, fluentParagraph, noteLabel, pointerSentence, populationProposition, rowPopulationComplete, tableLeadSentence, tablePropositions, titleCandidate } from './groundedPropositions.js';
import { ANSWER_DETAIL_CONTRACT, normalizeAnswerDetail } from './answerDetail.js';
import { analyticalSynthesis, aspectTitle, framingSentence, nextStepSentence, synthesisNarrative, findingScope } from './analyticalFindings.js';
import { PROSE_LIMITS, checkProse, proseText } from './groundedProse.js';

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
  // Aşama G: analitik özetin okuma tavanı altı bölümdür (kullanıcı yönergesi); her bölümün tablosu sayfaya sığar.
  maxTables: 6,
  // Aşama F: analitik özetin bölümleri iki özneyi karşılaştırabilir (bölüm × 2 ayrıntı); sayfa bundan küçük olursa
  // karşılaştırma sunucu düzenine hiç giremez ve bölüm bölüm tekrarlanan anlatıma düşer. Aşama G: 6 × 2.
  maxDetails: 12,
  maxCharts: 6,
  maxPropositions: 12,
  maxTitles: 3,
  maxBlocks: 12,
  maxSayBlocks: 4,
  maxSayItems: PROSE_LIMITS.maxSentences,
  maxNotes: 2,
  maxNoteItems: 3,
  maxValueChars: 160,
  maxQuestionChars: 600,
  maxResponseChars: 16000
});

export const COMPOSITION_BLOCK_TYPES = Object.freeze(['title', 'say', 'note', 'rows', 'details', 'chart']);

/**
 * Ayrıntı ayarının sayfa sınırları: Ayrıntılı daha çok bölüm, önerme ve blok taşır (daha geniş okuma ve daha derin
 * anlatım). Ayrıntısı bilinmeyen (eski) sayfa temel sınırlarla kurulur.
 */
export function compositionLimits(detail = null) {
  if (detail == null) return COMPOSITION_LIMITS;
  const normalized = normalizeAnswerDetail(detail);
  const contract = ANSWER_DETAIL_CONTRACT[normalized];
  const wide = normalized === 'detailed';
  // Aşama G: altı bölümlü (çok kapsamlı) özet her bölümün başlığını, anlatımını ve tablosunu taşıyabilir.
  return Object.freeze({ ...COMPOSITION_LIMITS, maxPropositions: contract.maxPropositions, maxBlocks: wide ? 32 : 24, maxSayBlocks: wide ? 10 : 8, maxNotes: contract.maxNotes,
    maxTitles: wide ? 8 : normalized === 'balanced' ? 6 : COMPOSITION_LIMITS.maxTitles });
}

/** Grafik türleri (istenen görselleştirme biçimi); sunucunun aday türleriyle aynı kapalı sözlük. */
export const COMPOSITION_CHART_TYPES = Object.freeze(['bar', 'donut', 'line', 'stacked', 'kpi', 'timeline']);

const BLOCK_KEYS = Object.freeze({
  title: [['type', 'source'], []],
  // Paragraf ya sunucu kimliklerinin listesidir (`items`) ya da modelin yuvalı düzyazısıdır (`text`); ikisi birden olamaz.
  say: [['type'], ['items', 'text']],
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
/** Yığılmış durum grafiğinin başlığı, satırların gruplandığı boyuta göre. */
const STACKED_TITLES = Object.freeze({ project: ['Projelere göre durum', 'Status by project'], assignee: ['Kişilere göre durum', 'Status by person'],
  department: ['Bölümlere göre durum', 'Status by department'], unit: ['Birimlere göre durum', 'Status by unit'] });
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
  const base = { version: 1, type, locale, title: candidate.title, unit: candidate.unit, evidence: [...(candidate.evidenceIds || [candidate.evidenceId])] };
  if (type === 'stacked') return { ...base, series: candidate.series, items: candidate.stacked };
  if (type === 'kpi') return { ...base, items: candidate.kpi };
  if (type === 'timeline') return { ...base, items: candidate.timeline };
  return { ...base, items: candidate.items };
}

const unitOf = (fact) => (/Percent$/.test(leafOf(fact.field)) ? 'percent' : fact.semantic?.unit === 'hours' ? 'hours'
  : fact.semantic?.measure === 'days' ? 'days' : Number.isSafeInteger(fact.value) && (COUNT_MEASURES.has(fact.semantic?.measure) || fact.semantic?.measure == null) ? 'count' : 'number');

/** Karşılaştırma grafiğinin başlığı: karşılaştırılan ölçünün adı. */
function comparisonChartTitle(metric, locale) {
  const titles = { overdue: ['Gecikmiş görev', 'Overdue tasks'], open: ['Açık görev', 'Open tasks'], dueNext7Days: ['Yedi gün içinde terminli görev', 'Due within seven days'],
    done: ['Tamamlanan görev', 'Completed tasks'], total: ['Dönemde terminli açık görev', 'Open tasks due in period'], critical: ['Kritik/yüksek öncelikli açık görev', 'Critical/high-priority open tasks'] };
  return titles[metric]?.[locale === 'en' ? 1 : 0] || metric;
}

/**
 * Tablonun çok sütunlu ve tarih adayları: yığılmış çubuk (satır başına birbirini dışlayan durum bölümleri) ve zaman
 * çizelgesi (görev satırlarının termin tarihi). Değerler yalnızca tablonun doğrulanmış hücreleridir.
 */
function tableCharts({ group, described, collection, complete, labels, locale, table, nearest = false }) {
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
      // Aşama G: başlık satırların neye göre gruplandığını söyler ("Projelere göre durum"); grup bilinmiyorsa genel başlık.
      const groupBy = rows.flatMap((row) => row.cells.flat()).find((fact) => fact?.semantic?.groupBy)?.semantic.groupBy;
      const titled = STACKED_TITLES[groupBy] || ['Durum kırılımı', 'Status breakdown'];
      out.push({ table, column: indexes[0], columns: indexes, title: answerChartLabel(titled[locale === 'en' ? 1 : 0], ANSWER_CHART_LIMITS.maxTitleChars),
        unit: 'count', evidenceId: group.evidenceId, types: ['stacked'],
        series: indexes.map((index) => answerChartLabel(described.columns[index].label)),
        stacked: rows.map((row, position) => ({ label: labels[position], values: indexes.map((index) => row.cells[index][0].value) })) });
    }
  }
  // Zaman çizelgesi: görev satırlarının tek tarih sütunu (ör. termin); tarih sırasıyla, en çok sınır kadar satır.
  const dates = described.columns.map((column, index) => index).filter((index) => single(index)
    && rows.every((row) => row.cells[index][0].semantic?.valueType === 'date' && typeof row.cells[index][0].value === 'string' && DAY_VALUE.test(row.cells[index][0].value)));
  // Termine göre artan doğrulanmış sıralamanın başı kesik olsa da çizilir; başlık geçmiş ve gelecek için en erken terminleri adlandırır.
  const head = !complete && nearest && dates.length === 1 && rows.every((row) => row.cells[dates[0]][0].semantic?.metric === 'task.targetFinish');
  if (/(^|\.)tasks$/.test(collection) && dates.length === 1 && (complete || head) && rows.length <= ANSWER_CHART_LIMITS.maxTimelineItems) {
    const [index] = dates;
    const timeline = rows.map((row, position) => ({ label: labels[position], date: row.cells[index][0].value }))
      .map((item, order) => ({ ...item, order })).sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order)
      .map(({ label, date }) => ({ label, date }));
    const title = head ? (locale === 'en' ? `Earliest ${rows.length} deadlines` : `En erken ${rows.length} termin`) : described.columns[index].label;
    out.push({ table, column: index, title: answerChartLabel(title, ANSWER_CHART_LIMITS.maxTitleChars), unit: 'number',
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
 * Sayfadaki KAYIT ADLARI (proje, kişi, görev): modelin kendi sözcükleri bunları yuva dışında yazamaz. Kaynak yalnızca
 * doğrulanmış olgulardır (satır adları, varlık adları, süzgeçteki proje/kişi adı). Durum/öncelik etiketleri kayıt adı
 * değildir (ör. "tamamlandı" olağan sözcüktür); yalnızca kimlik taşıyan adlar toplanır.
 */
function entityNames(parts) {
  const names = new Set();
  const add = (value) => { if (typeof value === 'string' && value.trim()) names.add(value.trim()); };
  for (const part of parts) {
    for (const item of part.presentation?.facts || []) {
      const fact = item.fact || item;
      const semantic = fact?.semantic || {};
      if (typeof fact?.field === 'string' && /\.(title|name|displayName|projectName)$/.test(fact.field) && typeof fact.value === 'string') add(fact.value);
      add(semantic.entity?.name);
      add(semantic.filters?.project);
      add(semantic.filters?.person);
      add(semantic.row?.project);
      add(semantic.row?.name);
      if (['project', 'assignee'].includes(semantic.groupBy)) add(semantic.group?.label ?? null);
    }
  }
  return [...names];
}

/** Tablonun kesinlik önermesi: satırlar doğrulanmış nüfusun tamamı mı, yoksa gösterilen kısmı mı? */
function certaintyProposition(table, title, locale, names) {
  const en = locale === 'en';
  const name = String(title || '').replace(/\s+/g, ' ').trim();
  const record = !en && names.find((item) => name.startsWith(item) && (name.length === item.length || !/[\p{L}\p{N}\p{M}_]/u.test(name.charAt(item.length))));
  const lower = record ? name : name.charAt(0).toLocaleLowerCase(en ? 'en-US' : 'tr-TR') + name.slice(1);
  // Tablo, bölümünün adıyla anılır ("gecikmiş görevler tablosu"); ilk sütun adı ("Görev") nüfusu adlandırmaz.
  const subject = name ? (en ? `${lower.startsWith('your ') ? '' : 'the '}${lower} table` : `${lower} tablosu`) : (en ? 'this table' : 'bu tablo');
  const text = table.complete
    ? (en ? `${subject} covers every record you can see.` : `${subject} görebildiğiniz kayıtların tamamına dayanıyor.`)
    : (en ? `${subject} shows only part of the records; conclusions from it are limited.` : `${subject} kayıtların yalnızca bir kısmını gösteriyor; buradan çıkan sonuçlar sınırlıdır.`);
  const markdown = record ? text : `${text.charAt(0).toLocaleUpperCase(en ? 'en-US' : 'tr-TR')}${text.slice(1)}`;
  return { kind: 'certainty', tone: table.complete ? 'success' : 'info', evidenceId: table.evidenceId, markdown: escapedFactText(markdown).replace(/\\\./g, '.'),
    plain: markdown, parts: Object.freeze(record ? [{ value: record, strong: false }, text.slice(record.length)] : [text]) };
}

/**
 * Bölüm başlığı (sunucunun sabit konu adı; olgu taşımaz). Aynı araç bir bölümde başlık ölçüleri, başka bölümde satır
 * tablosu döndürebilir (ör. portföy özeti ve proje karşılaştırması): başlık, bölümün tablo taşıyıp taşımadığına göre ayrışır.
 */
const GROUP_SECTIONS = Object.freeze({ project: ['Proje dağılımı', 'By project'], status: ['Durum dağılımı', 'By status'], assignee: ['Kişilere göre dağılım', 'By person'],
  priority: ['Öncelik dağılımı', 'By priority'], deadline: ['Termin dağılımı', 'By deadline'], target_month: ['Aylara göre terminler', 'Deadlines by month'],
  department: ['Bölümlere göre dağılım', 'By department'], unit: ['Birimlere göre dağılım', 'By unit'] });

const LAYER_TITLES = Object.freeze({ self: ['Kendi işleriniz', 'Your work'], team: ['Ekibiniz', 'Your team'], unit: ['Biriminiz', 'Your unit'], department: ['Bölümünüz', 'Your department'],
  directorate: ['Direktörlüğünüz', 'Your directorate'], all: ['Görebildiğiniz bütün işler', 'All the work you can see'] });

function filtersOfPart(parts, ordinal) {
  return (parts.find((item) => item.index + 1 === ordinal)?.presentation?.facts || []).map((item) => item.fact?.semantic?.filters).find(Boolean) || {};
}

/** Kapsamın sunucu başlığı; adlı kişi/proje kapsamında sunucunun çözdüğü ad (kullanıcının yazımı değil). */
function layerTitle(layer, filters, locale) {
  const lang = locale === 'en' ? 1 : 0;
  if (layer.scope === 'person' && typeof filters.person === 'string' && filters.person.trim() && filters.person !== 'Seçilen kişi') return filters.person.trim();
  if (layer.scope === 'project' && typeof filters.project === 'string' && filters.project.trim()) return filters.project.trim();
  const key = layer.scope === 'team' && layer.level ? layer.level : ['projects', 'all'].includes(layer.scope) ? 'all' : layer.scope;
  return (LAYER_TITLES[key] || LAYER_TITLES.all)[lang];
}

function sectionTitle(tool, locale, { rows = false, groupBy = null } = {}) {
  const en = locale === 'en';
  // Gruplu analiz bölümü gruplama ölçütüyle adlandırılır (boş sonuçta da "Genel görünüm" değil).
  if (tool === 'rota_task_analytics' && GROUP_SECTIONS[groupBy]) return GROUP_SECTIONS[groupBy][en ? 1 : 0];
  const names = {
    rota_portfolio_summary: rows ? ['Proje karşılaştırması', 'Project comparison'] : ['Portföy özeti', 'Portfolio summary'],
    rota_workload_summary: ['Kişilere göre iş yükü', 'Workload by person'],
    rota_task_analytics: rows ? ['Dağılım', 'Breakdown'] : ['Genel görünüm', 'Overview'],
    rota_task_search: ['Görevler', 'Tasks']
  };
  return names[tool]?.[en ? 1 : 0] || null;
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
  visual = false, allowCharts = true, detail = null, analyst = false, chartType = null, chartTypes = null, table = false, followUp = null, certainty = false, outline = null,
  topics = null } = {}) {
  const answerDetail = normalizeAnswerDetail(detail);
  const limits = compositionLimits(detail);
  const requestedChart = COMPOSITION_CHART_TYPES.includes(chartType) ? chartType : null;
  // Aşama F: istenen bütün türler (en çok iki; ilk tür birincil). Her istenen tür için aday yeri ayrılır.
  const requestedCharts = requestedChart ? [requestedChart, ...(Array.isArray(chartTypes) ? chartTypes : [])]
    .filter((type, index, all) => COMPOSITION_CHART_TYPES.includes(type) && all.indexOf(type) === index).slice(0, 2) : [];
  const caveats = caveatPropositions(parts, locale);
  // Zorunlu çekinceler ve kesinlik bildirimleri isteğe bağlı önermelerden önce yer ayırır.
  const reservedPropositions = caveats.length + (certainty ? COMPOSITION_LIMITS.maxTables : 0);
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
  // Aşama F: bölümler arası bulgular (giriş ve sonuç). Yalnızca analitik özet yanıtında; sunucu yazar, model seçmez.
  const synthesis = analyst ? analyticalSynthesis(parts, { locale, detail: answerDetail, focus: outline?.focus || [] }) : null;
  const comparisonSlots = Math.min(2, (synthesis?.findings || []).filter((finding) => finding.kind === 'subjectComparison').reduce((sum, finding) => sum + Object.keys(finding.metrics).length, 0));
  // İki öznenin karşılaştırmasında tek öznenin gösterge kartı yanıltıcıdır (öteki özne kartta yoktur): karşılaştırma çubukları yeter.
  const scopedSubjects = new Set(parts.flatMap((part) => (part.presentation?.facts || []).map(({ fact }) => {
    const f = fact?.semantic?.filters || {};
    return f.personSicil != null ? `person:${f.personSicil}` : f.assignee === 'me' ? 'self' : f.projectId ? `project:${f.projectId}` : null;
  })).filter(Boolean));
  const comparing = scopedSubjects.size > 1;
  // Tek bölümde önermeler isteğe bağlıdır; çok bölümlü sayfada sınır bölümün türetilmiş olgularını düşüremez.
  const propose = (ordinal, proposition, extra = {}) => {
    if (!proposition || propositions.size >= (extra.required ? limits.maxPropositions : limits.maxPropositions - reservedPropositions)) return null;
    const id = `P${propositions.size + 1}`;
    propositions.set(id, Object.freeze({ id, part: ordinal, ...proposition, ...extra }));
    // Kaynak bağı modele kimlikle gösterilir: önerme hangi tablonun (T#) hangi sütununa (C#) dayanır; grafik yönlendirmesi bununla seçilir.
    const table = extra.table ?? null;
    viewPropositions.push({ id, part: ordinal, kind: proposition.kind, ...(proposition.tone && proposition.tone !== 'info' ? { tone: proposition.tone } : {}),
      ...(proposition.required || extra.required ? { required: true } : {}),
      ...(table ? { table } : {}), ...(table && Number.isInteger(proposition.column) ? { column: `C${proposition.column + 1}` } : {}),
      text: clip(proposition.plain, COMPOSITION_LIMITS.maxValueChars * 2) });
    return id;
  };
  // Başlık adayı nüfusu adlandırır (olgu taşımaz); her kanıt grubunda en çok bir aday.
  const entitle = (ordinal, group, facts, groupBy = null) => {
    if (titles.size >= limits.maxTitles || !facts.length) return;
    const populationFilters = facts.map((fact) => {
      const { project, ...filters } = fact.semantic?.filters || {};
      return filters.projectId ? { ...filters, project } : filters;
    });
    if (!populationFilters.every((filters) => JSON.stringify(filters) === JSON.stringify(populationFilters[0]))) return;
    const { project: rowProject, ...filters } = populationFilters[0];
    const text = titleCandidate({ tool: group.tool, filters: filters.projectId ? { ...filters, project: rowProject } : filters, groupBy, locale });
    if (!text || [...titles.values()].some((title) => title.text === text)) return;
    const id = `H${titles.size + 1}`;
    // Doğal başlık nüfusu (süzgeçleri) adlandırır: başlık çizildiyse aynı kanıtın tablosunda ölçüt satırı yinelenmez.
    titles.set(id, Object.freeze({ id, part: ordinal, text, markdown: `#### ${escapedFactText(text)}`, evidenceId: group.evidenceId }));
    viewTitles.push({ id, part: ordinal, text: clip(text, COMPOSITION_LIMITS.maxValueChars) });
  };

  for (const part of parts) {
    const presentation = table && part.presentation ? { ...part.presentation, layout: 'table' } : part.presentation;
    if (!presentation || !Array.isArray(presentation.facts)) continue;
    const ordinal = part.index + 1;
    // İş yükü kanıtının bağlam olguları (atama dağılımının tamlığı, sıfır sayılar) ayrıntı satırı olarak yazılmaz: tamlık
    // eksikse sunucu çekincesi (zorunlu önerme) bunu doğal dille söyler; sıfırdan büyük sorumlusuz/temsil edilemeyen iş sayısı
    // ayrıntıda kalır. Olgular analist ve çekince önermelerine aynen ulaşır (`parts` değişmez).
    // Tam nüfus olgusu (true) kişi önermelerinin önkoşuludur ve grupta kalır.
    const shown = presentation.facts.filter((item) => !((item.fact?.field === 'data.populationComplete' && item.fact.value === false)
      || (['data.unassignedOpenTasks', 'data.unrepresentedOpenTasks'].includes(item.fact?.field) && item.fact.value === 0)));
    for (const group of narrativeGroups(shown)) {
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
        const pageComplete = described.rows.every((row) => row.entries.every(({ fact }) => fact.semantic?.complete === true));
        const populationComplete = rowPopulationComplete(group.tool, presentation.facts.filter((item) => item.evidenceId === group.evidenceId).map((item) => item.fact));
        const complete = pageComplete && populationComplete;
        const rowCriteria = [...new Set(described.rows.map((row) => narrativeLabel(row.entries[0].fact, locale).criteria))];
        const criteria = rowCriteria.length === 1 ? rowCriteria[0] : group.envelope.map((fact) => narrativeLabel(fact, locale).criteria).find(Boolean) || '';
        const labels = chartLabels(described.rows);
        tables.set(id, Object.freeze({ id, part: ordinal, evidenceId: group.evidenceId, group, collection, rows: described.rows.length, columns, complete, criteria, detail: null,
          layout: presentation.layout, requestedLayout: presentation.requestedLayout }));
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
          if (!allowCharts) return;
          // İstenen tür, tek sütunlu çubuk adaylarının doldurduğu sınırın arkasında kalamaz: o türden aday yoksa bir yer ayrılır.
          const reserved = requestedCharts.some((type) => candidate.types.includes(type) && ![...charts.values()].some((item) => item.types.includes(type)))
            && charts.size < COMPOSITION_LIMITS.maxCharts + requestedCharts.length - comparisonSlots;
          if (charts.size >= COMPOSITION_LIMITS.maxCharts - comparisonSlots && !reserved) return;
          const chartId = `G${charts.size + 1}`;
          if (!candidate.types.every((type) => answerChartFence(chartSpec(candidate, type, locale)))) return;
          charts.set(chartId, Object.freeze({ id: chartId, part: ordinal, ...candidate }));
          viewCharts.push({ id: chartId, part: ordinal, ...(candidate.table ? { table: candidate.table } : {}), ...viewExtra, title: candidate.title, types: candidate.types });
        };
        // Termin ayları zaman dizisidir: yalnızca boşluksuz ardışık aylar çizgi olur (çizgi 24 noktaya kadar, çubuk 12'ye kadar).
        const monthly = group.tool === 'rota_task_analytics' && collection.endsWith('groups') && complete && described.rows.every((row) => MONTH.test(row.title))
          && contiguousMonths(described.rows.map((row) => row.title));
        described.columns.forEach((column, index) => {
          if (!column.numeric || !labels) return;
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
          // Görev gruplarının kayıt sayısı grafikte "Görev sayısı" adını taşır ("Kayıt sayısı" teknik alan adıdır).
          const taskCount = values.every(([fact]) => /(^|\.)groups\.\d+\.count$/.test(fact.field) && ['rota_task_analytics', 'rota_task_search'].includes(group.tool));
          const title = answerChartLabel(partTitle || (taskCount ? (locale === 'en' ? 'Task count' : 'Görev sayısı') : column.label), ANSWER_CHART_LIMITS.maxTitleChars);
          addChart({ table: id, column: index, title, unit, evidenceId: group.evidenceId,
            items: months ? described.rows.map((row, position) => ({ label: monthLabel(row.title, locale), value: values[position][0].value })) : items, types },
          { column: columns[index].id });
        });
        // Çok sütunlu (yığılmış) ve tarih (zaman çizelgesi) adayları tek sütun adaylarından sonra gelir; kimlikleri kaymaz.
        const nearest = part.ranking?.metric === 'task.targetFinish' && part.ranking.order === 'asc'
          || part.ranking?.metric === 'task.overdueDays' && part.ranking.order === 'desc'
          && presentation.facts.some(({ evidenceId, fact }) => evidenceId === group.evidenceId && fact.semantic?.filters?.deadline === 'overdue');
        for (const candidate of tableCharts({ group, described, collection, complete, labels, locale, table: id, nearest })) {
          // Gelecek dönem grafiği dönem dışı bugünkü gecikme listesinden çizilmez.
          const filters = described.rows[0]?.cells.flat().find((fact) => fact.semantic?.filters)?.semantic.filters;
          if (candidate.types.includes('timeline') && outline?.dateFrom && today && outline.dateFrom >= today
            && (filters?.dateFrom !== outline.dateFrom || filters?.dateTo !== outline.dateTo)) continue;
          addChart(candidate, Number.isInteger(candidate.column) ? { column: columns[candidate.column].id } : {});
        }
      }
      // Başlık ölçüleri (KPI kartları): satır koleksiyonu olmayan kaydın doğrulanmış sayıları.
      if (allowCharts && !comparing && !multi.size && (charts.size < COMPOSITION_LIMITS.maxCharts || requestedCharts.includes('kpi') && charts.size < COMPOSITION_LIMITS.maxCharts + requestedCharts.length
        && ![...charts.values()].some((item) => item.types.includes('kpi')))) {
        const kpi = kpiCandidate(group, locale);
        if (kpi && answerChartFence(chartSpec(kpi, 'kpi', locale))) {
          const chartId = `G${charts.size + 1}`;
          charts.set(chartId, Object.freeze({ id: chartId, part: ordinal, table: null, column: null, ...kpi }));
          viewCharts.push({ id: chartId, part: ordinal, title: kpi.title, types: kpi.types });
        }
      }
      // Görev sonucunda sayım, ölçüt listesi yerine doğal cümledir ("Ekibinizde şu anda **1** gecikmiş görev var."). Aşama F:
      // çok satırlı listede de (doğrulanmış anlatımla aynı biçimde); doğal cümle süzgeçleri söyleyemezse ölçütlü cümle kalır.
      const lead = taskCountLead(group, locale, { empty: (presentation.empty || []).includes(group.evidenceId) });
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
  const conclusions = analyst ? singleSubjectPropositions(analystPropositions(parts, locale), parts, locale) : [];
  // İki öznenin karşılaştırması: her karşılaştırılan ölçü için iki öznenin doğrulanmış değerlerinden çubuk grafik adayı (en çok iki).
  for (const compared of (synthesis?.findings || []).filter((item) => item.kind === 'subjectComparison' && allowCharts)) {
    const owner = parts.find((item) => item.presentation?.facts?.some((entry) => entry.evidenceId === compared.evidenceIds[0]));
    const ordered = Object.entries(compared.metrics).sort(([, left], [, right]) => Math.abs(right[0] - right[1]) - Math.abs(left[0] - left[1])).slice(0, 2);
    for (const [metric, values] of ordered) {
      if (!owner || charts.size >= COMPOSITION_LIMITS.maxCharts + requestedCharts.length) break;
      const items = compared.subjects.map((subject, index) => ({ label: answerChartLabel(subject.type === 'self' ? (locale === 'en' ? 'You' : 'Siz') : subject.name), value: values[index] }));
      const candidate = { table: null, column: null, title: answerChartLabel([comparisonChartTitle(metric, locale), findingScope(compared, locale)].filter(Boolean).join(' · '), ANSWER_CHART_LIMITS.maxTitleChars), unit: 'count',
        evidenceId: compared.evidenceIds[0], evidenceIds: [...compared.evidenceIds], items, types: ['bar'], comparison: true };
      if (!answerChartFence(chartSpec(candidate, 'bar', locale))) continue;
      const chartId = `G${charts.size + 1}`;
      charts.set(chartId, Object.freeze({ id: chartId, part: owner.index + 1, ...candidate }));
      viewCharts.push({ id: chartId, part: owner.index + 1, title: candidate.title, types: candidate.types });
    }
  }
  // Tamlığı kanıtlanmamış nüfusun sunucu çekincesi her zaman sayfadadır ve anlatılmak ZORUNDADIR (required): akıcı anlatım
  // eksik nüfusu tamamlanmış gibi gösteremez.
  for (const item of caveats) propose(item.part, item.proposition, { table: null, required: true });
  // Kesinlik takibi: her tablonun nüfusun tamamına dayanıp dayanmadığı sunucunun kendi önermesidir (model kapsam iddia etmez).
  if (certainty) {
    for (const table of tables.values()) {
      const name = [...titles.values()].find((item) => item.part === table.part)?.text || viewTables.find((item) => item.id === table.id)?.title;
      propose(table.part, certaintyProposition(table, name, locale, entityNames(parts)), { table: table.id, required: true });
    }
  }
  const availableRoom = limits.maxPropositions - propositions.size - derived.length;
  if (!caveats.length && !certainty && contentParts.size > 1 && availableRoom < 0) return null;
  const room = Math.max(0, limits.maxPropositions - propositions.size);
  for (const item of contentParts.size > 1 ? conclusions.slice(0, room) : conclusions) propose(item.part, item.proposition, { table: null, analyst: true });
  for (const { ordinal, proposition, table } of derived) propose(ordinal, proposition, { table });
  // Çok bölümlü sayfada başlık, ardından gelen blokların nüfusunu adlandırır: başlığı olmayan bir bölüm varsa onun
  // olguları başka bölümün başlığı altına düşebilir. Bu durumda başlık seçeneği hiç sunulmaz (seçim daralır, olgu değişmez).
  // Ayrıntılı yanıt bölümlere ayrılır: doğal başlığı olmayan bölüm, kanıtının sunucu konu adını başlık alır (olgu taşımaz).
  // Aşama F: üç ya da daha çok bölümlü analitik özet Dengeli ayrıntıda da bölüm başlıklarıyla yapılandırılır (giriş → bölümler →
  // öncelikler); başlık olgu taşımaz. Bir bölüm başlıksız kalırsa aşağıdaki kural bütün başlıkları kaldırır.
  const sectioned = answerDetail === 'detailed' || (analyst && answerDetail === 'balanced' && (contentParts.size >= 3 || outline?.layers?.length > 1));
  if (limits !== COMPOSITION_LIMITS && sectioned) {
    for (const part of [...contentParts].sort((a, b) => a - b)) {
      if ([...titles.values()].some((item) => item.part === part) || titles.size >= limits.maxTitles) continue;
      const table = [...tables.values()].find((item) => item.part === part);
      const owner = table?.group || [...details.values()].find((item) => item.part === part)?.source?.group;
      const groupBy = [...(owner?.main?.entries || []), ...[...(owner?.collections?.values() || [])].flatMap((rows) => [...rows.values()].flatMap((row) => row.entries))]
        .map(({ fact }) => fact.semantic?.groupBy).find(Boolean) || parts.find((item) => item.index + 1 === part)?.presentation?.facts?.map((item) => item.fact?.semantic?.groupBy).find(Boolean) || null;
      const text = sectionTitle(owner?.tool || null, locale, { rows: Boolean(table), groupBy });
      if (!text || [...titles.values()].some((item) => item.text === text)) continue;
      const id = `H${titles.size + 1}`;
      titles.set(id, Object.freeze({ id, part, text, markdown: `#### ${escapedFactText(text)}` }));
      viewTitles.push({ id, part, text });
    }
  }
  // Aşama G — çok kapsamlı özet: her bölüm kendi kapsamının sunucu başlığını alır ("Kendi işleriniz", "Ekibiniz · Kişilere göre
  // dağılım"); kapsamlar bildirim sırasıyla okunur. Bölümün kapsamı ve yönü planlayıcının açılımından gelir (`outline.sections`):
  // kanıt süzgecinden tahmin edilmez, adaş ya da aynı türden iki kapsam birbirine karışmaz. Özetin yanındaki açık istek bölümü
  // kendi konu adını alır. Başlık olgu taşımaz; adlı kapsamın adı kanıttaki çözülmüş addır. Bir bölüm adlandırılamazsa çok kapsamlı
  // başlıklar kurulmaz (aşağıdaki kural bütün başlıkları kaldırır).
  if (outline?.layers?.length > 1 && Array.isArray(outline.sections) && limits !== COMPOSITION_LIMITS && answerDetail !== 'short') {
    const layered = [...contentParts].sort((a, b) => a - b).map((part) => {
      const facts = parts.find((item) => item.index + 1 === part)?.presentation?.facts || [];
      const section = outline.sections[part - 1] || null;
      const groupBy = facts.map((item) => item.fact?.semantic?.groupBy).find(Boolean) || null;
      const tool = facts.map((item) => item.fact?.semantic?.provenance?.tool).find(Boolean) || null;
      return { part, layer: section ? section.layer : null, focus: section?.focus || null, groupBy, tool, evidenceId: facts[0]?.evidenceId || null,
        rows: facts.some((item) => item.fact?.semantic?.row) };
    });
    if (layered.every((item) => item.layer == null || outline.layers[item.layer])) {
      titles.clear();
      viewTitles.length = 0;
      const seenLayers = new Set();
      for (const item of layered) {
        // Görev listesi bölümünün konusu yönün adıdır ("Kilometre taşları", "Kritik işler"): aynı kapsamın iki listesi ayrışır.
        const topic = (item.tool === 'rota_task_search' && aspectTitle(item.focus, locale)) || sectionTitle(item.tool, locale, { rows: item.rows, groupBy: item.groupBy });
        let text = topic;
        if (item.layer != null) {
          const owner = layerTitle(outline.layers[item.layer], filtersOfPart(parts, item.part), locale);
          const first = !seenLayers.has(item.layer);
          seenLayers.add(item.layer);
          text = first && !item.rows ? owner : `${owner} · ${topic || owner}`;
          const aspect = aspectTitle(item.focus, locale);
          if ([...titles.values()].some((title) => title.text === text) && aspect) text = `${owner} · ${aspect}`;
        }
        if (!text || [...titles.values()].some((title) => title.text === text) || titles.size >= limits.maxTitles) continue;
        const id = `H${titles.size + 1}`;
        titles.set(id, Object.freeze({ id, part: item.part, text, markdown: `#### ${escapedFactText(text)}`, ...(item.evidenceId ? { evidenceId: item.evidenceId } : {}) }));
        viewTitles.push({ id, part: item.part, text });
      }
    }
  }
  // Bölümlerin doğal nüfus adları (başlıklar aşağıda kaldırılsa da açılış cümlesi için saklanır).
  const partNames = new Map([...titles.values()].map((item) => [item.part, item.text]));
  const titledParts = new Set([...titles.values()].map((item) => item.part));
  if (contentParts.size > 1 && [...contentParts].some((part) => !titledParts.has(part))) {
    titles.clear();
    viewTitles.length = 0;
  }
  // Aşama F: bölümler arası bulgu girişi yoksa çok bölümlü analitik özet bir çerçeve cümlesiyle açılır (olgu taşımaz; Kısa
  // yanıtta yoktur). Adlar sunucunun çözdüğü öznelerdir (kullanıcının yazımı değil).
  const subjectNames = (key) => [...new Map(parts.flatMap((part) => (part.presentation?.facts || []).map((item) => item.fact?.semantic?.filters)
    .filter((filters) => filters && (key === 'project' ? filters.projectId && typeof filters.project === 'string' : filters.assignee === 'person' && filters.personSicil != null && typeof filters.person === 'string' && filters.person.trim() && filters.person.trim() !== 'Seçilen kişi'))
    .map((filters) => [key === 'project' ? String(filters.projectId).toLowerCase() : String(filters.personSicil), filters[key]]))).values()].slice(0, 2);
  const framing = analyst && outline && !synthesis?.intro && contentParts.size >= 1 && !['previous', 'row'].includes(outline.scope)
    ? framingSentence({ scope: outline.scope, level: outline.level || null, focus: outline.focus || [], projects: subjectNames('project'), people: subjectNames('person'), withSelf: outline.withSelf === true, within: outline.within === true, locale })
    : null;
  // Analitik özet olmayan çok bölümlü yanıt da bir açılışla başlar: bölümleri doğal adlarıyla (ya da konu adıyla) sayar; olgu
  // taşımaz. Bir bölüm adlandırılamıyorsa açılış yazılmaz (eksik çerçeve kurulmaz).
  let listing = null;
  if (!analyst && !followUp && contentParts.size > 1) {
    const ordered = [...contentParts].sort((a, b) => a - b);
    const named = ordered.map((part) => {
      const title = partNames.get(part);
      const facts = parts.find((item) => item.index + 1 === part)?.presentation?.facts || [];
      const proper = entityNames([{ presentation: { facts } }]).some((name) => title?.startsWith(name) && (title.length === name.length || !/[\p{L}\p{N}\p{M}_]/u.test(title.charAt(name.length))));
      if (title) return proper ? title : `${title.charAt(0).toLocaleLowerCase(locale === 'en' ? 'en-US' : 'tr-TR')}${title.slice(1)}`;
      return topics?.get(part) || null;
    });
    if (named.every(Boolean)) {
      const unique = [...new Set(named)];
      const joined = unique.map(escapedFactText).flatMap((name, index) => [...(index ? [index === unique.length - 1 ? (locale === 'en' ? ' and ' : ' ve ') : ', '] : []), name]).join('');
      listing = Object.freeze({ markdown: locale === 'en' ? `Below are ${joined}.` : `Aşağıda ${joined} yer alıyor.` });
    }
  }
  const partCount = new Set(parts.map((part) => part.index)).size + missing.length;
  const view = {
    language: locale === 'en' ? 'en' : 'tr',
    ...(today ? { today } : {}),
    detail: answerDetail,
    ...(visual ? { visual: true } : {}),
    ...(visual && requestedChart ? { chart: requestedChart } : {}),
    ...(visual && requestedCharts.length > 1 ? { chartTypes: requestedCharts } : {}),
    ...(table ? { table: true } : {}),
    question: clip(String(question || ''), COMPOSITION_LIMITS.maxQuestionChars),
    ...(previousQuestion ? { previousQuestion: clip(String(previousQuestion), COMPOSITION_LIMITS.maxQuestionChars) } : {}),
    ...(followUp?.act ? { followUp: { act: followUp.act } } : {}),
    // Ayrıntılı yanıtın ana hattı: bölüm sırası, başlığı ve önermeleri (model her bölüm için ayrı paragraf yazar).
    ...(answerDetail === 'detailed' && limits !== COMPOSITION_LIMITS ? { sections: [...new Set(viewPropositions.map((item) => item.part))].sort((a, b) => a - b)
      .map((part) => ({ part, ...(viewTitles.find((item) => item.part === part) ? { title: viewTitles.find((item) => item.part === part).id } : {}),
        propositions: viewPropositions.filter((item) => item.part === part).map((item) => item.id) })) } : {}),
    parts: partCount,
    titles: viewTitles,
    propositions: viewPropositions,
    tables: viewTables,
    details: viewDetails,
    charts: viewCharts,
    missing: missing.map((item) => ({ part: item.index + 1, ...(item.topic ? { topic: item.topic } : {}) }))
  };
  return Object.freeze({ view: Object.freeze(view), render: Object.freeze({ locale: view.language, tables, details, charts, propositions, titles, question: String(question || ''),
    visual: Boolean(visual), chartType: visual ? requestedChart : null, chartTypes: visual ? Object.freeze(requestedCharts) : Object.freeze([]), table: Boolean(table), detail: answerDetail, limits,
    ...(synthesis && (synthesis.intro || synthesis.conclusion) ? { synthesis } : {}), ...(sectioned && titles.size ? { sectioned: true } : {}),
    ...(framing ? { framing } : listing ? { framing: listing } : {}), ...(analyst && outline && contentParts.size >= 1 ? { closing: nextStepSentence(outline.focus || [], locale) } : {}),
    // Çok bölümlü analitik rapor: tablolar kendi bölümünde cümlesiz kalmaz. Yalnızca tablo istenen yanıt tabloyla başlar.
    ...(analyst && contentParts.size > 1 ? { report: true } : {}) }) });
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
  const limits = render.limits || COMPOSITION_LIMITS;
  if (!Array.isArray(raw) || raw.length < 1) return fail('BLOCK_COUNT');
  const blocks = [];
  const usedSources = new Set();
  const usedPropositions = new Set();
  const spoken = new Set();
  let proseDropped = 0;
  let proseCut = 0;
  // Düzyazı yanıtında modelin bir grafik adayına çizemeyeceği türü yazması yalnızca o grafik bloğunu düşürür (aday ve
  // değerler sunucunundur); istenen tür varsa ensureChart doğrulanmış adayla ekler. Kimlik düzeni katı kalır.
  const proseResponse = raw.some((item) => item?.type === 'say' && Object.hasOwn(item, 'text'));
  let chartsDropped = 0;
  /*
   * Düzyazı yanıtında modelin SEÇİM hatası (bilinmeyen ya da yinelenen kaynak, bölümleri karışık not, sınırı aşan blok) bütün
   * düzeni düşürmez (bozuk biçimli blok — bilinmeyen tür ya da izinsiz alan — eskisi gibi düzenin tamamını reddeder): yalnızca o blok ya da öğe atılır. Model yalnızca sunucu kaynaklarını seçtiği için atılan seçim içerik
   * eklemez, yalnızca modelin payını azaltır; eksik kalan tablo, zorunlu çekince ve bölüm anlatımını sunucu tamamlar. Böylece zayıf
   * modelin tek bir blok hatası doğrulanmış yanıtı Derin anlatıma devrettirmez. Kimlik düzeninde (`items`) kurallar katı kalır.
   */
  let blocksDropped = 0;
  const soft = (code) => { if (!proseResponse) return fail(code); blocksDropped += 1; return null; };
  if (raw.length > limits.maxBlocks && !proseResponse) return fail('BLOCK_COUNT');
  const proseRejected = [];
  const proseSpoken = new Set();
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
  for (let index = 0; index < Math.min(raw.length, limits.maxBlocks); index += 1) {
    if (!Object.hasOwn(raw, index)) return fail('BLOCK_INVALID');
    const block = raw[index];
    const type = block?.type;
    if (!COMPOSITION_BLOCK_TYPES.includes(type) || !exactKeys(block, ...BLOCK_KEYS[type])) return fail('BLOCK_INVALID');
    if (type === 'title') {
      // Düzyazı yanıtında bölüm başlığını sunucu koyar (Ayrıntılı): başlık bölümün olgusudur, modelin seçtiği başlık
      // kimliği içerikle eşleşmeyebilir (zayıf modelin H3 yerine H4 yazması). Modelin başlık bloğu yok sayılır.
      if (proseResponse) continue;
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
      if (!Array.isArray(items) || items.length < 1 || (!proseResponse && items.length > COMPOSITION_LIMITS.maxNoteItems)) { const hard = soft('NOTE_INVALID'); if (hard) return hard; continue; }
      // Düzyazıda ayrıntı ayarının not sınırını aşan kutu da atılır (önermeleri kullanılmış sayılmaz; gerekirse sunucu anlatır).
      const noteCap = proseResponse ? Math.min(limits.maxNotes, ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].maxNotes) : limits.maxNotes;
      if (blocks.filter((item) => item.type === 'note').length >= noteCap) { const hard = soft('NOTE_INVALID'); if (hard) return hard; continue; }
      const kept = [];
      for (let position = 0; position < Math.min(items.length, COMPOSITION_LIMITS.maxNoteItems); position += 1) {
        if (!Object.hasOwn(items, position) || typeof items[position] !== 'string') { const hard = soft('NOTE_INVALID'); if (hard) return hard; continue; }
        if (!render.propositions?.has(items[position])) { const hard = soft('UNKNOWN_PROPOSITION'); if (hard) return hard; continue; }
        // Düzyazıda söylenen önerme cümlenin parçasıdır: kutudaki yinelemesi düşer (kimlik kümesi daralır, içerik eklenmez).
        if (proseSpoken.has(items[position]) && !emphasized.has(items[position])) continue;
        // Paragrafta söylenen önermenin not kutusunda vurgulanması yapısal olarak normalleştirilir (yalnızca kutuda kalır);
        // başka her yineleme reddedilir. Bu, kimlik kümesini daraltır, içerik eklemez.
        if (emphasized.has(items[position]) || (usedPropositions.has(items[position]) && !spoken.has(items[position]))) { const hard = soft('DUPLICATE_PROPOSITION'); if (hard) return hard; continue; }
        // Düzyazıda kutu tek bölümündür: ilk öğenin bölümünden olmayan öğe atılır (sunucu o bölümü kendi anlatımıyla tamamlar).
        if (proseResponse && kept.length && partOfItem(items[position]) !== partOfItem(kept[0])) { blocksDropped += 1; continue; }
        usedPropositions.add(items[position]);
        emphasized.add(items[position]);
        kept.push(items[position]);
      }
      if (!kept.length) continue;
      const scope = owned(kept.map(partOfItem));
      if (scope) return fail(scope);
      blocks.push({ type, items: kept });
      continue;
    }
    if (type === 'say') {
      // Paragraf ya sunucu önermelerinin kimlikleridir (`items`) ya da modelin yuvalı düzyazısıdır (`text`). Düzyazıda
      // modelden yalnızca yuva sırası alınır; yuva dışı metni çizilmez (groundedProse.js).
      const prose = Object.hasOwn(block, 'text');
      if (prose === Object.hasOwn(block, 'items')) return fail('BLOCK_INVALID');
      let items = block.items;
      if (prose) {
        const checked = checkProse(block.text, { known: (id) => Boolean(render.propositions?.has(id) || render.tables.has(id) || render.charts.has(id)),
          used: new Set([...usedPropositions, ...pointers.map((pointer) => pointer.id)]) });
        // Kurala uymayan düzyazı paragrafı tümüyle düşer (yalnızca modelin içeriği azalır); kapsamı sunucu tamamlar.
        // Bütün düzyazı paragrafları düşerse düzen reddedilir.
        if (!checked.ok) { proseRejected.push(checked.issue); continue; }
        items = checked.ids;
        proseDropped += checked.dropped;
        proseCut += checked.cut || 0;
      }
      if (!Array.isArray(items) || items.length < 1 || items.length > COMPOSITION_LIMITS.maxSayItems) return fail('SAY_INVALID');
      // Düzyazı paragrafı bölüm sınırında ardışık parçalara bölünür: her parça kendi bölümünün paragrafıdır (yalnızca
      // sınır eklenir; içerik, sıra ve kapsam değişmez). Kimlik paragrafında karışık bölüm önceki gibi reddedilir.
      const runs = prose ? items.reduce((out, id) => {
        if (out.length && partOfItem(out.at(-1).at(-1)) === partOfItem(id)) out.at(-1).push(id);
        else out.push([id]);
        return out;
      }, []) : [items];
      if (prose && blocks.filter((item) => item.type === 'say').length + runs.length > limits.maxSayBlocks) {
        proseRejected.push('SAY_INVALID');
        continue;
      }
      for (const run of runs) {
        if (blocks.filter((item) => item.type === 'say').length >= limits.maxSayBlocks) return fail('SAY_INVALID');
        const said = [];
        const placed = [];
        for (let position = 0; position < run.length; position += 1) {
          if (!Object.hasOwn(run, position) || typeof run[position] !== 'string') return fail('SAY_INVALID');
          const id = run[position];
          if (render.propositions?.has(id)) {
            if (usedPropositions.has(id)) { const hard = soft('DUPLICATE_PROPOSITION'); if (hard) return hard; continue; }
            usedPropositions.add(id);
            spoken.add(id);
            if (prose) proseSpoken.add(id);
            said.push(id);
          } else if (render.tables.has(id) || render.charts.has(id)) {
            if (pointers.some((pointer) => pointer.id === id)) { const hard = soft('DUPLICATE_POINTER'); if (hard) return hard; continue; }
            pointers.push({ id, at: blocks.length });
            said.push(id);
          } else if (!prose && render.details?.has(id)) {
            // Paragrafa yazılan D#, sunucunun doğrulanmış ayrıntısının yeridir: paragrafın hemen ardında kendi bloğu olarak
            // çizilir (details bloğuyla aynı; model metin yazmaz, ayrıntı bir kez kullanılır).
            if (usedSources.has(id)) return fail('DUPLICATE_SOURCE');
            usedSources.add(id);
            placed.push(id);
          } else { const hard = soft('UNKNOWN_PROPOSITION'); if (hard) return hard; }
        }
        // Başlık olsun ya da olmasın paragrafın tüm önermeleri aynı bölüme aittir.
        const scope = owned(run.map(partOfItem));
        if (scope) return fail(scope);
        // Düzyazı bloğunun metni kanonik yuva dizisidir: yeniden doğrulamada modelin atılan sözcükleri yeniden okunmaz.
        if (said.length) blocks.push({ type, items: said, ...(prose ? { prose: said.map((slot) => [{ slot }]), text: proseText(said) } : {}) });
        for (const source of placed) blocks.push({ type: 'details', source });
      }
      continue;
    }
    const source = block.source;
    if (typeof source !== 'string') { const hard = soft('SOURCE_INVALID'); if (hard) return hard; continue; }
    const known = type === 'rows' ? render.tables.get(source) : type === 'details' ? render.details.get(source) : render.charts.get(source);
    if (!known) { const hard = soft('UNKNOWN_SOURCE'); if (hard) return hard; continue; }
    const chartStyle = type === 'chart' ? block.style ?? known.types[0] : null;
    const sourceKey = type === 'chart' ? `${source}:${chartStyle}` : source;
    if (usedSources.has(sourceKey)) { const hard = soft('DUPLICATE_SOURCE'); if (hard) return hard; continue; }
    if (type === 'chart' && blocks.some((item) => item.type === 'chart' && item.source === source)
      && !(render.visual && (render.chartTypes || []).includes(chartStyle))) { const hard = soft('DUPLICATE_SOURCE'); if (hard) return hard; continue; }
    usedSources.add(sourceKey);
    const scope = owned([partOfSource(type, source)]);
    if (scope) return fail(scope);
    if (type === 'rows') {
      if (block.style != null && !ROW_STYLES.has(block.style) && !proseResponse) return fail('STYLE_INVALID');
      // Açıkça istenen düzen modelin seçiminden önce gelir; satır sırasını sunucu korur.
      const requested = render.table || known.layout === 'table' ? 'table' : ['list', 'prose'].includes(known.layout) ? 'list' : null;
      blocks.push({ type, source, style: requested ?? (ROW_STYLES.has(block.style) ? block.style : null) ?? (known.columns.length >= 2 ? 'table' : 'list') });
    } else if (type === 'chart') {
      if (block.style != null && !known.types.includes(block.style)) {
        if (!proseResponse) return fail('STYLE_INVALID');
        usedSources.delete(sourceKey);
        chartsDropped += 1;
        continue;
      }
      blocks.push({ type, source, style: chartStyle });
    } else blocks.push({ type, source });
  }
  // Düzyazı düzeninin sunucu tamamlaması: eksik tablo, söylenmemiş zorunlu çekince ve bölümün asgari anlatımı sunucu
  // içeriğiyle eklenir; grafik/not ile başlayan düzende ilk paragraf öne alınır. Modelin içeriğine hiçbir şey eklenmez.
  if (proseRejected.length && !blocks.some((block) => block.type === 'say' && block.prose)) return fail(proseRejected[0]);
  if (!blocks.length) return fail('LEAD_REQUIRED');
  const proseMode = blocks.some((block) => block.type === 'say' && block.prose);
  let supplemented = 0;
  if (proseMode) {
    const partOfBlock = (block) => (block.type === 'say' || block.type === 'note' ? render.propositions?.get(block.items.find((id) => render.propositions?.has(id)))?.part ?? partOfItem(block.items[0])
      : partOfSource(block.type, block.source));
    const insertForPart = (part, block, beforeRows = false) => {
      const indexes = blocks.map((item, index) => (partOfBlock(item) === part ? index : -1)).filter((index) => index >= 0);
      const firstRows = blocks.findIndex((item) => item.type === 'rows' && partOfBlock(item) === part);
      const at = beforeRows && firstRows >= 0 ? firstRows : indexes.length ? indexes.at(-1) + 1 : blocks.length;
      blocks.splice(at, 0, block);
      // Yönlendirmelerin paragraf konumu eklenen bloğa göre kayar.
      for (const pointer of pointers) if (pointer.at >= at) pointer.at += 1;
    };
    const contract = ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)];
    for (const part of [...new Set([...(render.propositions?.values() || [])].map((item) => item.part))]) {
      const available = [...render.propositions.values()].filter((item) => item.part === part);
      const said = available.filter((item) => usedPropositions.has(item.id)).length;
      const missingRequired = available.filter((item) => item.required && !usedPropositions.has(item.id));
      // Bölümün kendi paragrafı yoksa (model önermelerini yalnızca not kutusuna koydu ya da paragrafı düştü) en az bir önerme
      // paragraf olarak eklenir; anlatılacak önerme kalmadıysa bölümün not kutusu paragrafa çevrilir (aynı önermeler, kutu yerine cümle).
      const narrated = blocks.some((block) => block.type === 'say' && block.items.some((id) => render.propositions.get(id)?.part === part));
      if (!narrated && !available.some((item) => !usedPropositions.has(item.id))) {
        const at = blocks.findIndex((block) => block.type === 'note' && block.items.some((id) => render.propositions.get(id)?.part === part));
        if (at >= 0) {
          for (const id of blocks[at].items) emphasized.delete(id);
          blocks[at] = { type: 'say', items: [...blocks[at].items], supplemented: true };
          supplemented += 1;
        }
      }
      const deficit = Math.max(narrated ? 0 : 1, Math.min(contract.minNarrated, available.length) - said);
      const extra = [...missingRequired, ...available.filter((item) => !usedPropositions.has(item.id) && !item.required && item.analyst),
        ...available.filter((item) => !usedPropositions.has(item.id) && !item.required && !item.analyst)];
      const add = [...new Set([...missingRequired, ...extra.slice(0, Math.max(deficit, missingRequired.length))])].slice(0, COMPOSITION_LIMITS.maxSayItems);
      if (!add.length) continue;
      for (const item of add) { usedPropositions.add(item.id); spoken.add(item.id); }
      insertForPart(part, { type: 'say', items: add.map((item) => item.id), supplemented: true }, true);
      supplemented += add.length;
    }
    for (const table of render.tables.values()) {
      if (usedSources.has(table.id)) continue;
      usedSources.add(table.id);
      const requested = render.table || table.layout === 'table' ? 'table' : ['list', 'prose'].includes(table.layout) ? 'list' : null;
      insertForPart(table.part, { type: 'rows', source: table.id, style: requested ?? (table.columns.length >= 2 ? 'table' : 'list') });
      supplemented += 1;
    }
    // Grafik sayısı ayrıntı sözleşmesindedir: istenmeyen grafik yığını anlatımın yerine geçmez (fazlası çizilmez).
    const chartCap = Math.max(ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].visuals + (render.visual ? 1 : 0), render.visual ? (render.chartTypes || []).length : 0);
    let charts = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].type !== 'chart') continue;
      charts += 1;
      if (charts <= chartCap) continue;
      const removed = blocks[index].source;
      blocks.splice(index, 1);
      for (const pointer of pointers) if (pointer.at > index) pointer.at -= 1;
      // Çizilmeyen grafiğe yönlendiren cümle de düşer.
      for (const pointer of pointers.filter((item) => item.id === removed)) {
        const owner = blocks[pointer.at];
        if (owner?.prose) blocks[pointer.at] = { ...owner, items: owner.items.filter((id) => id !== removed),
          prose: owner.prose.filter((sentence) => !sentence.some((token) => token.slot === removed)) };
      }
      pointers.splice(0, pointers.length, ...pointers.filter((item) => item.id !== removed));
      index -= 1;
    }
    if (['chart', 'note'].includes(blocks[0].type)) {
      const lead = blocks.findIndex((block) => block.type === 'say' || block.type === 'rows');
      if (lead > 0) {
        blocks.unshift(...blocks.splice(lead, 1));
        for (const pointer of pointers) pointer.at = pointer.at === lead ? 0 : pointer.at < lead ? pointer.at + 1 : pointer.at;
      }
    }
    // Ayrıntılı yanıt: modelin koymadığı bölüm başlığı, o bölümün ilk bloğunun önüne sunucu tarafından konur. Başlık,
    // ardından gelen blokların bölümünü adlandırır: bölümler ardışık değilse (model bölümleri iç içe yazdıysa) başlık
    // yanlış blokları adlandırırdı; o yanıtta başlık konmaz (olgu değişmez, yalnızca başlık düşer).
    const sequence = blocks.filter((block) => block.type !== 'title').map(partOfBlock);
    const grouped = sequence.every((part, index) => index === 0 || part === sequence[index - 1] || !sequence.slice(0, index).includes(part));
    if (grouped && normalizeAnswerDetail(render.detail) === 'detailed' && render.limits && render.limits !== COMPOSITION_LIMITS) {
      for (const title of [...render.titles.values()].sort((a, b) => a.part - b.part)) {
        if (usedSources.has(title.id)) continue;
        const at = blocks.findIndex((block) => block.type !== 'title' && partOfBlock(block) === title.part);
        if (at < 0) continue;
        usedSources.add(title.id);
        blocks.splice(at, 0, { type: 'title', source: title.id });
        for (const pointer of pointers) if (pointer.at >= at) pointer.at += 1;
      }
    }
    while (blocks.at(-1)?.type === 'title') blocks.pop();
  }
  if (['chart', 'note'].includes(blocks[0].type) || blocks.at(-1).type === 'title') return fail('LEAD_REQUIRED');
  // Kısa yanıt zorunlu satır koleksiyonlarını korur; bölüm başına bir tablo ya da grafik gösterir.
  if (normalizeAnswerDetail(render.detail) === 'short') {
    const chartParts = blocks.filter((block) => block.type === 'chart').map((block) => partOfSource('chart', block.source));
    const requested = render.visual ? render.chartTypes || [] : [];
    for (const part of new Set(chartParts)) {
      const charts = blocks.filter((block) => block.type === 'chart' && partOfSource('chart', block.source) === part);
      if (charts.length > 1 && (charts.length > requested.length || new Set(charts.map((block) => block.style)).size !== charts.length
        || charts.some((block) => !requested.includes(block.style)))) return fail('BLOCK_COUNT');
    }
    const visualParts = new Set(chartParts);
    for (const block of blocks) if (block.type === 'rows' && block.style === 'table') {
      const part = partOfSource('rows', block.source);
      if (visualParts.has(part) && render.tables.get(block.source)?.requestedLayout !== 'table' && !render.table) block.style = 'list';
      else visualParts.add(part);
    }
  }
  if (blocks.filter((item) => item.type === 'title').length > limits.maxTitles) return fail('BLOCK_COUNT');
  // Yönlendirme ("aşağıdaki tablo" / "aşağıdaki grafik") paragraftan SONRA çizilen kendi bloğunadır. Cümle bloğun türünü
  // söyler: aynı türden yönlendirilmeyen bir blok (başka bir tablo ya da başka bir grafik) araya girerse "aşağıdaki"
  // yanlış bloğu gösterir ve reddedilir. Farklı türden blok (tablodan önce çizilen grafik) belirsizlik yaratmaz.
  // Düzyazıda geçersiz yönlendirme (yanlış hedef ya da kaynak) yalnızca sunucunun yönlendirme cümlesidir: reddedilmek yerine
  // düşürülür (bir sunucu cümlesi eksilir, olgu eklenmez). Kimlik paragrafında önceki gibi reddedilir.
  const dropPointers = new Map();
  for (const at of new Set(pointers.map((pointer) => pointer.at))) {
    const targets = pointers.filter((pointer) => pointer.at === at).map((pointer) => pointer.id);
    const prose = Boolean(blocks[at].prose);
    const drop = (id, code) => {
      if (!prose) return code;
      if (!dropPointers.has(at)) dropPointers.set(at, new Set());
      dropPointers.get(at).add(id);
      return null;
    };
    for (const id of targets) {
      const kind = render.tables.has(id) ? 'rows' : 'chart';
      const position = blocks.findIndex((item, place) => place > at && item.type === kind && item.source === id);
      if (position < 0 || blocks.slice(at + 1, position).some((item) => item.type === kind && !targets.includes(item.source))) {
        const code = drop(id, 'POINTER_TARGET');
        if (code) return fail(code);
      }
    }
    // Yönlendirilen blok paragrafın önermelerinden en az birini desteklemelidir: tablo kendi kanıtının önermelerini,
    // grafik yalnızca gösterdiği sütunun (aynı tablo ve sütun) önermelerini. Önermesiz yönlendirme paragrafı serbesttir.
    const said = blocks[at].items.map((id) => render.propositions?.get(id)).filter(Boolean);
    for (const id of targets) {
      if (said.length && !said.some((proposition) => supports(render, id, proposition))) {
        const code = drop(id, 'POINTER_PROVENANCE');
        if (code) return fail(code);
      }
    }
  }
  for (const [at, ids] of dropPointers) {
    const block = blocks[at];
    const prose = block.prose.map((sentence) => sentence.filter((token) => !(token.slot && ids.has(token.slot))))
      .filter((sentence) => sentence.some((token) => token.slot));
    blocks[at] = { ...block, items: block.items.filter((id) => !ids.has(id)), prose, droppedPointers: ids.size };
  }
  // Önizleme ya da grafik bütün satırların yerine geçmez; kapsam yalnızca sunucu bloğuyla sağlanır.
  if ([...render.tables.keys()].some((id) => !usedSources.has(id))) return fail('COVERAGE_INCOMPLETE');
  // Not kutusunda vurgulanan önerme paragraftan çıkar; boşalan paragraf düşer (yönlendirmelerin göreli sırası korunur).
  const normalized = emphasized.size ? blocks.map((block) => (block.type === 'say' && !block.prose ? { ...block, items: block.items.filter((id) => !emphasized.has(id)) } : block))
    .filter((block) => block.type !== 'say' || block.items.length) : blocks;
  if (!normalized.length || ['chart', 'note'].includes(normalized[0].type)) return fail('LEAD_REQUIRED');
  // Çizici tablo ayrıntılarını yerinde, kalanları sonda ekler; onlar da son başlığın kapsamına uymalıdır.
  const locatedDetails = new Set(blocks.filter((block) => block.type === 'details').map((block) => block.source));
  for (const table of render.tables.values()) if (usedSources.has(table.id)) locatedDetails.add(table.detail);
  // Çizici yerleştirilmeyen ayrıntıyı kendi bölümünün son parçasından sonra koyar: bölümün kendi başlığı varsa ayrıntı
  // o başlığın altında kalır (bölümlü düzen); yoksa son başlığın kapsamına uymalıdır.
  const titledSections = new Set(blocks.filter((block) => block.type === 'title').map((block) => render.titles.get(block.source)?.part));
  for (const detail of render.details.values()) {
    if (locatedDetails.has(detail.id) || usedPropositions.has(detail.covers) || titledSections.has(detail.part)) continue;
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
    // Düzyazı birden çok olguyu tek cümlede bağlayabilir: üst sınır kimlik paragrafından genişse de ayrıntıya göre artar.
    const ceiling = ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].maxNarrated + (proseMode ? PROSE_NARRATION_ALLOWANCE[normalizeAnswerDetail(render.detail)] : 0);
    if (available.filter((item) => usedPropositions.has(item.id)).length > ceiling) return fail('NARRATION_LIMIT');
  }
  // Ayrıntı ayarının not kutusu sınırı (kısa yanıt tek vurgu taşır).
  if (normalized.filter((block) => block.type === 'note').length > ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].maxNotes) return fail('NOTE_INVALID');
  // Sunucu çekincesi (eksik nüfus) her düzende söylenir: akıcı anlatım onu atlayıp eksik nüfusu tam gösteremez.
  if (propositions.some((item) => item.required && !usedPropositions.has(item.id))) return fail('CAVEAT_REQUIRED');
  if (normalized.length > limits.maxBlocks) return fail('BLOCK_COUNT');
  return { ok: true, blocks: normalized, ...(proseMode ? { prose: { dropped: proseDropped + blocksDropped, cut: proseCut, rejected: proseRejected.length, supplemented, charts: chartsDropped } } : {}) };
}

/** Düzyazının kimlik paragrafına göre ek anlatım payı (bölüm başına önerme). */
const PROSE_NARRATION_ALLOWANCE = Object.freeze({ short: 1, balanced: 4, detailed: 4 });

/** Bölüm başına en az anlatılacak önerme: ayrıntı ayarının sözleşmesi (eski sayfalarda varsayılan dengeli). */
function minNarrated(render) {
  return render.detail ? ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].minNarrated : MIN_NARRATED_PROPOSITIONS;
}

/** Görselleştirme tercihi: bölümlerde (açık + tamamlanan) yığılmış çubuk, dağılımda halka, zaman dizisinde çizgi; sonra çubuk, zaman çizelgesi, göstergeler. */
const STYLE_PREFERENCE = Object.freeze(['stacked', 'donut', 'line', 'bar', 'timeline', 'kpi']);
const preferredStyle = (candidate) => STYLE_PREFERENCE.find((style) => candidate.types.includes(style)) || candidate.types[0];

/**
 * Açıkça istenen görselleştirmenin en uygun adayı; yoksa `null`. İstenen tür (`chartType`, ör. halka, zaman çizelgesi)
 * bölüm sırasıyla BÜTÜN bölümlerde aranır (yalnızca ilk bölümde değil). Tür söylenmediyse veri grafiği gösterge
 * kartlarından önce gelir: genel görünümün göstergeleri (KPI) ancak başka uygun aday yoksa seçilir.
 */
export function preferredChart(render, { exclude = [] } = {}) {
  const candidates = [...render.charts.values()].filter((candidate) => !exclude.includes(candidate.id)).sort((left, right) => Number(Boolean(right.comparison)) - Number(Boolean(left.comparison)) || left.part - right.part);
  const comparison = candidates.find((candidate) => candidate.comparison && (!render.chartType || candidate.types.includes(render.chartType)));
  if (comparison) return { id: comparison.id, style: render.chartType || 'bar' };
  if (render.chartType) {
    const match = candidates.find((candidate) => candidate.types.includes(render.chartType));
    if (match) return { id: match.id, style: render.chartType };
  }
  const data = candidates.filter((candidate) => preferredStyle(candidate) !== 'kpi');
  const pool = data.length ? data : candidates;
  const firstPart = pool[0]?.part;
  for (const style of STYLE_PREFERENCE) {
    const found = pool.find((candidate) => candidate.part === firstPart && preferredStyle(candidate) === style);
    if (found) return { id: found.id, style };
  }
  return null;
}

/** İstenen grafik türü doğrulanmış kanıtla çizilebiliyor mu (sayfanın herhangi bir adayında)? */
export function chartTypeSupported(render) {
  return !render.chartType || [...render.charts.values()].some((candidate) => candidate.types.includes(render.chartType));
}

/**
 * Açık görselleştirme isteği + geçerli aday → grafik ZORUNLU. Model düzeni grafik içermiyorsa sunucu en uygun adayı
 * kendi tablosunun hemen ardına (tablo yoksa bölümünün paragrafının ardına) ekler. Grafik doğrulanmış kanıtın sunucu
 * tanımıdır; ekleme yeni olgu üretmez. Sonuç yine `validateComposition` ile denetlenir.
 */
export function ensureChart(composition, validated) {
  const { render } = composition;
  if (!render.visual || !validated?.ok) return validated;
  const primary = ensureChartType(composition, validated, render.chartType);
  // Aşama F: ikinci istenen tür; birincil türün grafiği korunur (biçimi çevrilmez, yerine geçilmez).
  const second = (render.chartTypes || []).find((type) => type !== render.chartType);
  if (!primary?.ok) return primary;
  const kept = primary.blocks.filter((block) => block.type === 'chart' && block.style === render.chartType).map((block) => block.source);
  let result = second ? ensureChartType({ ...composition, render: { ...render, chartType: second } }, primary, second, { secondary: true, protect: kept }) : primary;
  if ((render.chartTypes || []).includes('timeline')) {
    for (const candidate of render.charts.values()) {
      if (!candidate.types.includes('timeline') || result.blocks.some((block) => block.type === 'chart' && block.style === 'timeline'
        && render.charts.get(block.source)?.evidenceId === candidate.evidenceId)) continue;
      if (result.blocks.filter((block) => block.type === 'chart').length >= ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].visuals + 1) break;
      result = ensureChartType(composition, result, 'timeline', { secondary: true, candidateId: candidate.id,
        protect: result.blocks.filter((block) => block.type === 'chart').map((block) => block.source) });
    }
  }
  return result.chartInserted || primary.chartInserted ? { ...result, chartInserted: true } : result;
}

function ensureChartType(composition, validated, chartType, { secondary = false, protect = [], candidateId = null } = {}) {
  const render = { ...composition.render, chartType };
  const chartBlocks = validated.blocks.filter((block) => block.type === 'chart');
  // İstenen tür çizilebiliyorsa modelin başka türü seçmesi isteği karşılamaz: istenen tür eklenir.
  const satisfied = render.chartType && chartTypeSupported(render) ? chartBlocks.some((block) => block.style === render.chartType) : chartBlocks.length > 0;
  if (satisfied && !candidateId) return validated;
  // Modelin seçtiği aday istenen türü de çizebiliyorsa yalnızca biçimi istenen türe çevrilir (aynı doğrulanmış kanıt).
  const convertible = render.chartType && !secondary ? chartBlocks.find((block) => render.charts.get(block.source)?.types.includes(render.chartType)) : null;
  if (convertible) {
    const converted = validateComposition(composition, { blocks: validated.blocks.map((block) => (block === convertible ? { ...responseBlock(block), style: render.chartType } : responseBlock(block))) });
    return converted.ok ? { ...converted, chartInserted: true } : validated;
  }
  const choice = candidateId ? { id: candidateId, style: chartType } : preferredChart(render, { exclude: secondary ? [] : chartBlocks.map((block) => block.source) });
  // İkinci tür yalnızca o türü gerçekten çizebilen adayla eklenir (başka türe kaçılmaz; çizilemezse türe özgü not verilir).
  if (!choice || (secondary && choice.style !== chartType)) return validated;
  const candidate = render.charts.get(choice.id);
  const blocks = [...validated.blocks];
  const tableAt = candidate.table ? blocks.findIndex((block) => block.type === 'rows' && block.source === candidate.table) : -1;
  const partSay = blocks.findIndex((block) => block.type === 'say' && block.items.some((id) => render.propositions.get(id)?.part === candidate.part));
  const at = tableAt >= 0 ? tableAt + 1 : partSay >= 0 ? partSay + 1 : blocks.length;
  blocks.splice(at, 0, { type: 'chart', source: choice.id, style: choice.style });
  const limit = (render.limits || COMPOSITION_LIMITS).maxBlocks;
  // Blok sınırı doluysa en az bilgi taşıyan yer (gösterge kartı, kanıtı aynı olan ikinci grafik) grafiğe bırakılır.
  if (blocks.length > limit) {
    const spare = blocks.findIndex((block) => block.type === 'chart' && block.source !== choice.id && !protect.includes(block.source));
    if (spare >= 0) blocks.splice(spare, 1);
  }
  const chartCap = ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(render.detail)].visuals + 1;
  // İstenen grafik için hem blok hem çizim bütçesi ayrılır; eklenen aday yeniden doğrulamada düşemez.
  while (blocks.filter((block) => block.type === 'chart').length > chartCap) {
    const spare = blocks.findIndex((block) => block.type === 'chart' && block.source !== choice.id && !protect.includes(block.source));
    if (spare < 0) break;
    blocks.splice(spare, 1);
  }
  const checked = validateComposition(composition, { blocks: blocks.map(responseBlock) });
  return checked.ok && checked.blocks.some((block) => block.type === 'chart' && block.source === choice.id && block.style === choice.style)
    ? { ...checked, chartInserted: true } : validated;
}

/** Doğrulanmış blok, yeniden doğrulama için modelin yanıt biçimine döner (düzyazı kendi metniyle). */
export function responseBlock(block) {
  if (block.type === 'say') return block.prose ? { type: 'say', text: block.text } : { type: 'say', items: [...block.items] };
  if (block.type === 'note') return { type: 'note', items: [...block.items] };
  if (block.type === 'rows' || block.type === 'chart') return { type: block.type, source: block.source, ...(block.style ? { style: block.style } : {}) };
  return { type: block.type, source: block.source };
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
  const limits = render.limits || COMPOSITION_LIMITS;
  for (const part of parts.slice(0, limits.maxSayBlocks)) {
    const title = [...render.titles.values()].find((item) => item.part === part);
    if (title) blocks.push({ type: 'title', source: title.id });
    // Tablosu çizilen bölümde döküm cümlesi tabloyu yineler: yalnızca bölümün asgari anlatımı için gerekiyorsa söylenir.
    const tabled = [...render.tables.values()].some((table) => table.part === part);
    const available = [...render.propositions.values()].filter((item) => item.part === part);
    const preferred = tabled && available.filter((item) => item.kind !== 'breakdown').length >= Math.min(contract.minNarrated, available.length)
      ? available.filter((item) => item.kind !== 'breakdown') : available;
    // Bütçe önce analist sonuçlarına ayrılır (türetilmiş önermeler onları düşüremez); paragraf sırası önerme sırasıdır.
    const budget = Math.min(contract.maxNarrated, COMPOSITION_LIMITS.maxSayItems);
    // Sunucu çekincesi (required) bütçeden önce gelir: eksik nüfus notu hiçbir ayrıntı düzeyinde düşmez.
    const kept = new Set([...preferred.filter((item) => item.required), ...preferred.filter((item) => item.analyst && !item.required),
      ...preferred.filter((item) => !item.analyst && !item.required)].slice(0, budget).map((item) => item.id));
    const said = [...preferred.filter((item) => !item.analyst && !item.required), ...preferred.filter((item) => item.analyst), ...preferred.filter((item) => item.required)]
      .filter((item) => kept.has(item.id)).map((item) => item.id);
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
  if (!blocks.length || blocks.length > limits.maxBlocks) return null;
  const checked = validateComposition(composition, { blocks });
  if (!checked.ok) return null;
  // Sunucu düzeni de bütün istenen türleri ve aynı türdeki özne zaman çizelgelerini tamamlar.
  return render.visual ? ensureChart(composition, checked) : checked;
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
 * @returns {{ text: string, citedIds: string[], chart: string|null, charts: number, blocks: number, said: number, suppressed?: number, tables: number, notes: number, titled: boolean }}
 */
export function renderComposition(composition, validated) {
  const { render } = composition;
  const locale = render.locale;
  // Çizilen her parça bölümüyle tutulur: modelin yerleştirmediği ayrıntı kendi bölümünün içine girer (yanıtın sonuna değil).
  const out = [];
  // Hangi bölümde düzyazı söylendi: tablo kendi bölümünde cümlesiz kalmaz (aşağıda yönlendirme cümlesi alır).
  const spoken = new Set();
  const emit = (text, part, rowBearing = false) => {
    if (!text) return;
    if (!/^(#### |\||```|_)/.test(text)) spoken.add(part);
    out.push({ text, part, rowBearing });
  };
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
  // Değer bildiren önermeler (Aşama F): ölçü, ayrıntının toplamları bildirilen değerlerle birebir eşitse yinelenmez.
  const claimed = new Map();
  for (const id of saidIds) {
    const proposition = render.propositions.get(id);
    for (const metric of proposition.fluent?.states || []) {
      if (!stated.has(proposition.evidenceId)) stated.set(proposition.evidenceId, new Set());
      stated.get(proposition.evidenceId).add(metric);
    }
    for (const claim of proposition.fluent?.claims || []) claimed.set(proposition.evidenceId, [...(claimed.get(proposition.evidenceId) || []), claim]);
  }
  // Girişin (karşılaştırma) söylediği toplam ölçüler de aynı kanıtın ayrıntısında yinelenmez.
  for (const { evidenceId, metric } of render.synthesis?.intro?.states || []) {
    if (!stated.has(evidenceId)) stated.set(evidenceId, new Set());
    stated.get(evidenceId).add(metric);
  }
  // Aşama F: aynı nüfusun (aynı araç, aynı süzgeçler) durum dağılımı tablosu çizildiyse, toplamlar ayrıntısındaki toplam,
  // tamamlanan, açık sayısı ve tamamlanma oranı o tablodan BİREBİR türetilebiliyorsa yinelenmez (değer eşitliği doğrulanır).
  const signature = (group) => {
    const filters = [...(group?.main?.entries || []), ...[...(group?.collections?.values() || [])].flatMap((rows) => [...rows.values()].flatMap((row) => row.entries))]
      .map(({ fact }) => fact.semantic?.filters).filter(Boolean);
    const signatures = [...new Set(filters.map((value) => JSON.stringify(Object.entries(value).filter(([, item]) => item != null && item !== '').sort(([a], [b]) => a.localeCompare(b)))))].sort();
    return signatures.length ? `${group.tool}|${JSON.stringify(signatures)}` : null;
  };
  const statusTotals = (group) => {
    const rows = [...(group?.collections?.get('data.groups')?.values() || [])];
    const counts = new Map(rows.map((row) => [row.entries.find(({ fact }) => fact.semantic?.groupBy === 'status')?.fact.semantic.group?.key,
      row.entries.find(({ fact }) => /\.count$/.test(fact.field))?.fact.value]));
    if (!rows.length || [...counts].some(([key, value]) => !key || !Number.isSafeInteger(value))) return null;
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const done = counts.get('done') ?? 0;
    return total > 0 ? { 'tasks.total': total, 'tasks.done': done, 'tasks.open': total - done, 'tasks.completionRatePercent': Math.round((done / total) * 100) } : null;
  };
  const derived = (detail) => {
    const sig = signature(detail.source?.group);
    if (!sig) return [];
    const peer = [...render.tables.values()].find((table) => drawnTables.has(table.id) && table.complete && table.evidenceId !== detail.evidenceId && signature(table.group) === sig && statusTotals(table.group));
    if (!peer) return [];
    const totals = statusTotals(peer.group);
    if (!stated.get(peer.evidenceId)?.has('tasks.completionRatePercent')) delete totals['tasks.completionRatePercent'];
    return (detail.source.group.main?.entries || []).filter(({ fact }) => Object.hasOwn(totals, fact.semantic?.metric) && totals[fact.semantic.metric] === fact.value)
      .map(({ fact }) => fact.semantic.metric);
  };
  const detailText = (detail) => {
    const omit = new Set([...(stated.get(detail.evidenceId) || []), ...derived(detail)]);
    const entries = detail.source?.group?.main?.entries || [];
    const valueOf = (metric) => entries.find(({ fact }) => fact.semantic?.metric === metric)?.fact.value;
    for (const claim of claimed.get(detail.evidenceId) || []) {
      if (Object.entries(claim.values).every(([metric, value]) => valueOf(metric) === value)) omit.add(claim.metric);
    }
    return omit.size && detail.source ? renderGroupDetails(detail.source.group, { locale, empty: detail.source.empty, layout: detail.source.layout, lead: detail.source.lead, omitMetrics: omit })
      : detail.text;
  };
  const pending = [];
  const showDetail = (id, place = true) => {
    if (!id || shown.has(id)) return;
    const detail = render.details.get(id);
    if (!detail) return;
    shown.add(id);
    const text = detailText(detail);
    // Aşama F: ayrıntının söylediği toplu ölçüler de aynı kanıtın sonraki ayrıntısında yinelenmez (ör. genel görünümde
    // söylenen gecikmiş sayısı gecikme bölümünde yeniden yazılmaz). Aynı kanıtın aynı toplu ölçüsü tek değerdir.
    for (const { fact } of detail.source?.group?.main?.entries || []) {
      if (!fact.semantic?.metric) continue;
      if (!stated.has(detail.evidenceId)) stated.set(detail.evidenceId, new Set());
      stated.get(detail.evidenceId).add(fact.semantic.metric);
    }
    if (!text) return;
    cited.push(detail.evidenceId);
    const rowBearing = detail.source && detail.source.layout !== 'table'
      && [...detail.source.group.collections.values()].some((rows) => rows.size === 1);
    if (place) emit(text, detail.part, rowBearing);
    else pending.push({ text, part: detail.part, rowBearing });
  };
  // Çizilecek grafikler önceden belirlenir: yönlendirme yalnızca gerçekten çizilen bloğa yazılır.
  const fences = new Map();
  for (const block of validated.blocks) {
    if (block.type !== 'chart') continue;
    const candidate = render.charts.get(block.source);
    if (candidate.table != null && render.tables.get(candidate.table)?.evidenceId !== candidate.evidenceId) continue;
    const fence = answerChartFence(chartSpec(candidate, block.style, locale));
    if (fence) { fences.set(`${block.source}:${block.style}`, fence); if (!fences.has(block.source)) fences.set(block.source, fence); }
  }
  const rowStyles = new Map(validated.blocks.filter((block) => block.type === 'rows').map((block) => [block.source, block.style]));
  // Aşama G: bölümün tek girişi olan tablo içeriğini adlandıran cümleyle açılır; liste biçiminde genel yönlendirme kalır.
  const tableLead = (table, style) => {
    if (!table || style === 'list') return pointerSentence({ type: 'rows', style }, locale);
    const rows = [...(table.group.collections.get(table.collection)?.values() || [])].flatMap((row) => row.entries);
    const groupBy = rows.find(({ fact }) => fact.semantic?.groupBy)?.fact.semantic.groupBy || null;
    return tableLeadSentence({ collection: table.collection, groupBy, columns: table.columns }, locale);
  };
  // Türsüz G# göndergesi aynı kaynağın ilk çizilen grafiğini gösterir.
  const chartStyles = new Map();
  for (const block of validated.blocks.filter((block) => block.type === 'chart')) if (!chartStyles.has(block.source)) chartStyles.set(block.source, block.style);
  const partOf = (id) => render.propositions?.get(id)?.part ?? render.tables.get(id)?.part ?? render.charts.get(id)?.part ?? null;
  const discourse = { named: new Map(), attended: new Map() };
  const namedPopulations = new Set();
  const tableLeads = new Set();
  const captions = new Set();
  // Satırları çizilen tablonun döküm cümlesi ("Durumlara göre: Yapılacak 38, …") aynı sayıları yineler: söylenmez.
  const drawnTables = new Set(validated.blocks.filter((block) => block.type === 'rows').map((block) => block.source));
  // Aşama F: bölümlü analitik özette yapı sunucunundur: modelin düzeni bir bölümün başlığını seçmediyse başlık o bölümün ilk
  // bloğundan önce eklenir (başlık olgu taşımaz; sıra ve içerik modelin seçimidir).
  const blockPart = (block) => (block.type === 'say' || block.type === 'note' ? partOf(block.items[0])
    : block.type === 'details' ? render.details.get(block.source)?.part ?? null : block.type === 'title' ? render.titles.get(block.source)?.part ?? null : partOf(block.source));
  const sequence = [];
  const contiguousOf = (blocks) => {
    const order = blocks.map(blockPart).filter((part) => part != null).filter((part, index, all) => index === 0 || all[index - 1] !== part);
    return new Set(order).size === order.length;
  };
  // Model bölümleri iç içe dizdiyse (ör. önce bütün paragraflar, sonra bütün tablolar) bölümlü özette bloklar bölümlerine
  // toplanır: bölüm sırası ilk görünüşe, bölüm içi sıra modelin seçimine göredir; karışık paragraf bölüm sınırında ayrılır.
  // Paragrafın metni her zaman sunucunun önermelerinden kurulur (modelin yuvalı metni yalnızca sırayı taşır), bu yüzden bölmek
  // anlam kaybetmez.
  let laid = validated.blocks;
  if (render.sectioned && !contiguousOf(laid)) {
    const pieces = laid.flatMap((block) => {
      if (block.type !== 'say' || block.items.length < 2) return [block];
      const runs = [];
      for (const id of block.items) {
        const part = partOf(id);
        if (runs.length && runs.at(-1).part === part) runs.at(-1).items.push(id);
        else runs.push({ part, items: [id] });
      }
      return runs.map((run) => ({ type: 'say', items: run.items }));
    });
    const parts = [...new Set(pieces.map(blockPart).filter((part) => part != null))];
    laid = [...parts.flatMap((part) => pieces.filter((block) => blockPart(block) === part)), ...pieces.filter((block) => blockPart(block) == null)];
  }
  // Başlık yalnızca bölümler bitişikse eklenir: aksi hâlde başlık başka bölümün bloklarını adlandırırdı.
  if (render.sectioned && contiguousOf(laid)) {
    const chosen = new Set(laid.filter((block) => block.type === 'title').map((block) => render.titles.get(block.source)?.part));
    for (const block of laid) {
      const part = blockPart(block);
      const title = part != null && !chosen.has(part) ? [...render.titles.values()].find((item) => item.part === part) : null;
      if (title) { sequence.push({ type: 'title', source: title.id }); chosen.add(part); }
      sequence.push(block);
    }
  } else sequence.push(...laid);
  for (const block of sequence.filter((block) => block.type === 'title')) {
    const title = render.titles.get(block.source);
    if (title?.evidenceId) namedPopulations.add(title.evidenceId);
  }
  for (const block of sequence) {
    if (block.type === 'say') {
      // Paragraf (kimlik listesi ya da modelin yuvalı düzyazısı) sunucunun akıcı düzyazısıdır: model yalnızca sırayı seçmiştir;
      // aynı nüfusun önermeleri sunucunun doğrulanmış bağlarıyla birleşir (§ fluentParagraph).
      const entries = [];
      const emitted = [];
      // Aşama F: paragraftaki önermeler kaynağına (nüfusuna) göre kararlı biçimde toplanır: model sırası "A: …, B: …, A: …, B: …"
      // diye özneler arasında gidip gelse de aynı öznenin cümleleri art arda gelir ve akıcı bağla birleşir (olgu değişmez).
      const populations = [];
      for (const id of block.items) {
        const source = render.propositions?.get(id)?.evidenceId ?? null;
        if (source != null && !populations.includes(source)) populations.push(source);
      }
      const ordered = block.items.every((id) => render.propositions?.has(id))
        ? populations.flatMap((source) => block.items.filter((id) => render.propositions.get(id).evidenceId === source)) : block.items;
      // Paragraf bir önerme söylüyorsa tablo yuvası ayrı bir "aşağıdaki tabloda görebilirsiniz" cümlesi üretmez: tablo hemen ardından
      // gelir ve kısa yönlendirme cümlesi paragrafı kesik kesik yapar. Yalnızca tablo yuvasından oluşan paragraf tabloyu adlandırır.
      // Grafik yuvası grafiği tanıtır ve kalır (grafiğin yeri bu cümleye bağlıdır).
      // Bastırma yalnızca tablo bu paragraftan HEMEN SONRA çiziliyorsa geçerlidir: arada bir grafik varsa tablo kendi girişini taşır.
      const speaks = ordered.some((id) => render.propositions?.has(id));
      const after = sequence.slice(sequence.indexOf(block) + 1).find((other) => !['say', 'title'].includes(other.type));
      const adjacent = (id) => after?.type === 'rows' && after.source === id;
      for (const id of ordered) {
        const proposition = render.propositions?.get(id);
        if (proposition?.kind === 'breakdown' && proposition.table && drawnTables.has(proposition.table)
          && block.items.some((other) => other !== id && render.propositions?.has(other) && render.propositions.get(other).kind !== 'breakdown')) continue;
        if (proposition) {
          entries.push({ proposition }, ...(coveredBy.get(id)?.notices || []).map((text) => ({ text })));
        } else if (render.tables.has(id)) {
          if (!speaks || !adjacent(id)) entries.push({ text: tableLead(render.tables.get(id), rowStyles.get(id)) });
        } else if (fences.has(id)) {
          entries.push({ text: pointerSentence({ type: 'chart', chartType: chartStyles.get(id), distribution: render.charts.get(id).types.includes('donut') }, locale) });
        }
      }
      // Yanıtın paragrafları adlandırma durumunu paylaşır: önceki paragrafın söylediği olgu yinelenmez; boşalan paragraf çizilmez.
      const text = entries.length ? fluentParagraph(entries, locale, discourse, emitted) : '';
      if (!text) continue;
      const sources = emitted.map((proposition) => proposition.evidenceId);
      said += emitted.length;
      emit(`${text}${sources.length ? ` ${citation(sources)}` : ''}`, partOf(block.items[0]));
      cited.push(...sources);
    } else if (block.type === 'title') {
      const title = render.titles.get(block.source);
      emit(title.markdown, title.part);
      titled = true;
      if (title.evidenceId) namedPopulations.add(title.evidenceId);
    } else if (block.type === 'note') {
      const items = block.items.map((id) => render.propositions.get(id));
      const tones = new Set(items.map((item) => item.tone || 'info'));
      const tone = tones.size === 1 ? [...tones][0] : 'info';
      const emitted = [];
      const sentence = fluentParagraph(items.flatMap((item) => [{ proposition: item }, ...(coveredBy.get(item.id)?.notices || []).map((text) => ({ text }))]), locale, discourse, emitted);
      if (!sentence) continue;
      const sources = emitted.map((item) => item.evidenceId);
      said += emitted.length;
      notes += 1;
      // Sunucunun not kutusu: tonu önermelerin sunucu tonudur; etiket ve cümleler sunucunundur.
      emit(`> [!${tone}]\n> **${noteLabel(tone, locale)}:** ${sentence} ${citation(sources)}`, items[0].part);
      cited.push(...sources);
    } else if (block.type === 'rows') {
      const table = render.tables.get(block.source);
      showDetail(table.detail);
      const detail = render.details.get(table.detail);
      const statedText = detail && coveredBy.get(detail.covers) === detail ? render.propositions.get(detail.covers).markdown : detail ? detailText(detail) : '';
      // Aşama F: bölümünde hiçbir cümle söylenmemiş tablo, ölçüt satırı yerine bir yönlendirme cümlesiyle açılır.
      if (render.report && !spoken.has(table.part) && !tableLeads.has(table.part)) {
        tableLeads.add(table.part);
        emit(tableLead(table, block.style), table.part);
      }
      let rowsText = renderGroupRows(table.group, table.collection, { locale, layout: block.style, stated: statedText,
        criteriaStated: Boolean(detail?.source?.lead) || namedPopulations.has(table.evidenceId) });
      // Aynı ölçüt satırı yanıtta ikinci kez yazılmaz (aynı nüfusun ikinci tablosu).
      const caption = /^_[^\n]+_\n\n/.exec(rowsText)?.[0];
      const captionKey = `${signature(table.group) || table.evidenceId}|${caption}`;
      if (caption && captions.has(captionKey)) rowsText = rowsText.slice(caption.length);
      else if (caption) captions.add(captionKey);
      emit(rowsText, table.part, true);
      cited.push(table.evidenceId);
      tables += 1;
    } else if (block.type === 'details') {
      showDetail(block.source);
    } else if (block.type === 'chart') {
      const fence = fences.get(`${block.source}:${block.style}`);
      if (!fence) continue;
      const candidate = render.charts.get(block.source);
      if (candidate.table != null) showDetail(render.tables.get(candidate.table)?.detail);
      emit(fence, candidate.part, candidate.table != null);
      cited.push(...(candidate.evidenceIds || [candidate.evidenceId]));
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
  if (render.visual && (render.chartTypes || []).includes('timeline')) {
    const plotted = new Set(validated.blocks.filter((block) => block.type === 'chart' && block.style === 'timeline').map((block) => render.charts.get(block.source)?.evidenceId));
    for (const candidate of render.charts.values()) {
      if (!candidate.types.includes('timeline') || plotted.has(candidate.evidenceId)) continue;
      const group = render.tables.get(candidate.table)?.group;
      const filters = [...(group?.collections?.values() || [])].flatMap((rows) => [...rows.values()].flatMap((row) => row.entries)).find(({ fact }) => fact.semantic?.filters)?.fact.semantic.filters;
      const scope = escapedFactText(findingScope({ filters }, locale) || candidate.title);
      out.push({ text: locale === 'en' ? `_${scope}: the timeline is not shown; the task rows remain in the table._`
        : `_${scope}: zaman çizelgesi gösterilmedi; görev satırları tabloda yer alıyor._`, part: candidate.part, rowBearing: false });
      plotted.add(candidate.evidenceId);
    }
  }
  // Aşama F: sunucunun bölümler arası girişi yanıtın başına, öncelik sonucu sonuna yazılır (model düzeni ve gövde değişmez).
  // Bulgu cümlelerinin kaynakları yalnızca aynı sayfanın doğrulanmış kanıtlarıdır.
  const synthesis = render.synthesis || null;
  if (synthesis?.intro) {
    // Aşama G: giriş (asıl yanıt) ve bölümler arası analiz paragrafı ayrı paragraflardır; her biri kendi kaynaklarını taşır.
    const insights = synthesis.intro.insights;
    if (insights) {
      // Karışık kapsamda her kapsamın analizi ayrı paragraftır (kendi kaynaklarıyla); tek kapsamda tek paragraf.
      for (const paragraph of [...(insights.paragraphs || [insights])].reverse()) {
        out.unshift({ text: `${paragraph.markdown} ${citation(paragraph.evidenceIds)}`, part: null, rowBearing: false });
      }
      cited.push(...insights.evidenceIds);
    }
    out.unshift({ text: `${synthesis.intro.markdown} ${citation(synthesis.intro.evidenceIds)}`, part: null, rowBearing: false });
    cited.push(...synthesis.intro.evidenceIds);
  } else if (render.framing) out.unshift({ text: render.framing.markdown, part: null, rowBearing: false });
  // Sonuç, gövdenin söylem belleğiyle kurulur: gövdede gün sayısıyla anılan en uzun gecikme sonuçta yalnızca adıyla anılır.
  const ratiosSaid = new Set(sequence.filter((block) => ['say', 'note'].includes(block.type)).flatMap((block) => block.items)
    .map((id) => render.propositions.get(id)).filter((item) => item?.kind === 'pressure').map((item) => item.evidenceId));
  const conclusion = synthesis ? synthesisNarrative(synthesis.findings, { locale, detail: render.detail,
    said: (finding) => (finding.kind === 'overdueShare' || finding.kind === 'subjectOverdue'
      ? finding.kind === 'overdueShare' ? ratiosSaid.has(finding.evidenceIds[0]) : stated.get(finding.evidenceIds[0])?.has('tasks.overdue')
      : [discourse.named, discourse.attended].some((memory) => memory.get(`${finding.evidenceIds[0]}\u0000${finding.entity?.name}`) === finding.metrics?.days)) }).conclusion : null;
  if (conclusion) {
    // Başlıklı yanıtta öncelik listesi kendi bölüm başlığını alır; başlıksız yanıtta kalın satırla açılır. Her madde kendi kaynağını taşır.
    const heading = titled ? `#### ${conclusion.heading}` : `**${conclusion.heading}**`;
    const list = conclusion.items.map((item, index) => `${index + 1}. ${item.markdown} ${citation(item.evidenceIds)}`).join('\n');
    // Tek öncelik liste değil, etiketli tek satırdır.
    const [only] = conclusion.items;
    out.push({ text: conclusion.items.length === 1 ? `**${conclusion.heading}:** ${only.markdown} ${citation(only.evidenceIds)}` : `${heading}\n\n${list}`, part: null, rowBearing: false });
    cited.push(...conclusion.evidenceIds);
  } else if (render.closing) {
    // Kanıtlı öncelik yoksa yanıt bir sonraki adım önerisiyle kapanır (olgu taşımaz).
    out.push({ text: render.closing.markdown, part: null, rowBearing: false });
  }
  // Son sıraya eklenen ayrıntılar ve tek satırlı düzyazı da görünürdür; takip sırası nihai çizimin sırasıdır.
  const rowParts = [...new Set(out.filter((chunk) => chunk.rowBearing).map((chunk) => chunk.part))];
  // Doğrulanmış yinelenen olgular nitelendirmede temsil edilir; görünür önerme sayısı ve atıflar değişmez.
  return { text: out.map((chunk) => chunk.text).join('\n\n'), closing: conclusion || render.closing ? out.at(-1)?.text : null, citedIds: [...new Set(cited)], chart, charts, blocks: validated.blocks.length, said, tables, notes, titled, rowParts,
    ...(synthesis ? { findings: synthesis.findings.length } : {}),
    ...(saidIds.size > said ? { suppressed: saidIds.size - said } : {}),
    chartTypes: validated.blocks.filter((block) => block.type === 'chart' && fences.has(`${block.source}:${block.style}`)).map((block) => block.style) };
}
