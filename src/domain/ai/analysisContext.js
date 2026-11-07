import { canonicalActualId } from '../identity/actualId.js';
import { isIsoDay } from './isoDay.js';

/**
 * Aşama 4E — takip sorularının SUNUCUYA AİT kanonik analiz bağlamı.
 *
 * Doğrulanmış bir Rota yanıtının ardından sunucu, yanıtın analitik özünü kapalı ve küçük bir biçimde saklar: öznenin
 * kapsamı (self/team/person/project/projects/all, ekip düzeyi), sunucunun BAĞLADIĞI özne kimlikleri (en çok iki), analitik
 * yönler, termin ufku, görselleştirme isteği ve sıralı satırların kimlikleri (kişi ya da proje; "ilk kişi" göndergesi).
 * Model bu kimlikleri görmez; yalnızca türleri ve sayıları içeren bir not görür ve takipte `analysis.scope`
 * "previous" ya da "row" yazar. Bağlam yetki DEĞİLDİR: sonraki tur aynı kimlikleri güncel yetkiyle yeniden okur; önceki
 * kanıt, yeni turun kanıtı sayılmaz. Bozuk ya da tanınmayan bağlam hiç kullanılmaz (göndergesiz takip açıklama ister).
 */

export const ANALYSIS_CONTEXT_VERSION = 2;
export const ANALYSIS_CONTEXT_SCOPES = Object.freeze(['self', 'team', 'person', 'project', 'projects', 'all']);
export const ANALYSIS_CONTEXT_LIMITS = Object.freeze({ maxSubjects: 2, maxRows: 10, maxFocus: 4, maxPendingFocus: 4 });
const LEVELS = Object.freeze(['unit', 'department', 'directorate']);
const FOCUS = Object.freeze(['overview', 'status', 'priority', 'deadlines', 'overdue', 'upcoming', 'workload', 'projects', 'schedule', 'critical']);
const KEYS = new Set(['v', 'scope', 'level', 'subjects', 'within', 'focus', 'dateFrom', 'dateTo', 'visual', 'chart', 'charts', 'table', 'rows', 'rowPopulation', 'pending', 'rowsOnly', 'withSelf', 'relativeWindow']);
const VERSION_ONE_KEYS = new Set([...KEYS].filter((key) => !['withSelf', 'relativeWindow', 'charts'].includes(key)));
const CHARTS = Object.freeze(['bar', 'donut', 'line', 'stacked', 'kpi', 'timeline']);
const PENDING_SCOPES = Object.freeze([...ANALYSIS_CONTEXT_SCOPES, 'previous', 'row']);
const PENDING_KEYS = new Set(['language', 'scope', 'focus', 'names', 'level', 'within', 'dateFrom', 'dateTo', 'visual', 'chart', 'charts', 'table', 'withSelf', 'relativeWindow', 'rows', 'act']);
const shortText = (value) => typeof value === 'string' && value.trim().length >= 2 && value.length <= 120;
const validCharts = (value) => value.charts == null || value.visual === true && Array.isArray(value.charts) && value.charts.length >= 1 && value.charts.length <= 2
  && new Set(value.charts).size === value.charts.length && value.charts.every((type) => CHARTS.includes(type)) && value.chart === value.charts[0];

/**
 * Açıklama (aday seçimi) bekleyen analitik niyet: kabul edilmiş özetin kimliksiz biçimi. Seçimden sonra sunucu bu özeti
 * güncel yetkiyle yeniden yürütür (yön, ufuk, görselleştirme korunur). Adlar kullanıcının kendi iletisindeki metindir;
 * kimlik, yetki ya da kanıt taşımaz. Biçim dışı her değer bekleyen niyeti tamamen düşürür.
 */
export function normalizePendingAnalysis(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !PENDING_KEYS.has(key))) return null;
    if (!['tr', 'en'].includes(value.language) || !PENDING_SCOPES.includes(value.scope)) return null;
    const focus = value.focus || (['previous', 'row'].includes(value.scope) ? [] : null);
    if (!Array.isArray(focus) || (!focus.length && !['previous', 'row'].includes(value.scope)) || focus.length > ANALYSIS_CONTEXT_LIMITS.maxPendingFocus || focus.some((item) => !FOCUS.includes(item)) || new Set(focus).size !== focus.length) return null;
    if (value.names != null && (!Array.isArray(value.names) || !value.names.length || value.names.length > 2 || !value.names.every(shortText))) return null;
    if (['person', 'project'].includes(value.scope) !== Boolean(value.names)) return null;
    if (value.level != null && (value.scope !== 'team' || !LEVELS.includes(value.level))) return null;
    if (value.withSelf != null && (typeof value.withSelf !== 'boolean' || !['person', 'previous', 'row'].includes(value.scope)
      || value.withSelf && (value.scope === 'person' && value.names?.length !== 1 || value.scope === 'row' && value.rows?.length !== 1))) return null;
    if (value.within != null && (!shortText(value.within) || !['self', 'team', 'all', 'previous'].includes(value.scope) && !(value.scope === 'person' && value.withSelf))) return null;
    if ((value.scope === 'row') !== (value.rows != null)) return null;
    if (value.rows && (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > 2 || new Set(value.rows).size !== value.rows.length || value.rows.some((row) => !Number.isInteger(row) || row < 1 || row > 10))) return null;
    if (value.act != null && !['explain', 'expand', 'summarize', 'prioritize', 'certainty'].includes(value.act)) return null;
    if (value.relativeWindow != null && (!['today', 'next_7_days', 'all_time'].includes(value.relativeWindow) || value.dateFrom || value.dateTo)) return null;
    for (const key of ['dateFrom', 'dateTo']) if (value[key] != null && !isIsoDay(value[key])) return null;
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) return null;
    for (const key of ['visual', 'table']) if (value[key] != null && typeof value[key] !== 'boolean') return null;
    if (value.chart != null && (!CHARTS.includes(value.chart) || value.visual !== true)) return null;
    if (!validCharts(value)) return null;
    return Object.freeze({ language: value.language, scope: value.scope, focus: Object.freeze([...focus]), ...(value.names ? { names: Object.freeze([...value.names]) } : {}),
      ...(value.level ? { level: value.level } : {}), ...(value.withSelf != null ? { withSelf: value.withSelf } : {}), ...(value.within ? { within: value.within } : {}),
      ...(value.rows ? { rows: Object.freeze([...value.rows]) } : {}), ...(value.act ? { act: value.act } : {}), ...(value.relativeWindow ? { relativeWindow: value.relativeWindow } : {}), ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}),
      ...(value.dateTo ? { dateTo: value.dateTo } : {}), ...(value.visual != null ? { visual: value.visual } : {}), ...(value.chart ? { chart: value.chart } : {}),
      ...(value.charts ? { charts: Object.freeze([...value.charts]) } : {}), ...(value.table != null ? { table: value.table } : {}) });
  } catch {
    return null;
  }
}

/** Açıklama turunun kaydı: önceki analiz bağlamı (varsa) değişmeden, yanında bekleyen niyet. */
export function withPendingAnalysis(previous, pending) {
  const normalizedPending = normalizePendingAnalysis(pending);
  const prior = normalizeAnalysisContext(previous);
  if (!normalizedPending) return prior;
  const { pending: _stale, ...base } = prior || {};
  return Object.freeze({ ...(prior ? base : { v: ANALYSIS_CONTEXT_VERSION }), pending: normalizedPending });
}

function identity(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['type', 'id'].includes(key))) return null;
  if (item.type === 'project') {
    const id = typeof item.id === 'string' ? canonicalActualId(item.id) : null;
    return id ? Object.freeze({ type: 'project', id }) : null;
  }
  if (item.type === 'person') {
    const id = typeof item.id === 'string' && /^[1-9][0-9]{0,9}$/.test(item.id) && Number(item.id) <= 2147483647 ? item.id : null;
    return id ? Object.freeze({ type: 'person', id }) : null;
  }
  return null;
}

function identities(value, max, { unique = true, positional = false } = {}) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > max) return null;
  const items = value.map((item) => item === null && positional ? null : identity(item));
  if (items.some((item, index) => !item && !(positional && value[index] === null))) return null;
  const keys = items.map((item) => item ? `${item.type}:${item.id}` : null);
  return !unique || new Set(keys).size === keys.length ? Object.freeze(items) : null;
}

/** Kapalı biçimli bağlam; uymuyorsa `null`. Dönen değer donmuş kopyadır. */
export function normalizeAnalysisContext(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![1, ANALYSIS_CONTEXT_VERSION].includes(value.v) || Object.keys(value).some((key) => !KEYS.has(key))) return null;
    if (value.v === 1 && (Object.keys(value).some((key) => !VERSION_ONE_KEYS.has(key)) || value.focus?.length > 3)) return null;
    const pending = value.pending == null ? null : normalizePendingAnalysis(value.pending);
    if (value.pending != null && !pending) return null;
    // Yalnızca bekleyen niyet (önceki analiz yokken açıklama): takip öznesi değildir; `scope` boştur.
    const empty = (key) => value[key] == null || (Array.isArray(value[key]) && !value[key].length);
    if (value.scope == null && pending && Object.keys(value).every((key) => ['v', 'pending', 'scope'].includes(key) || (['subjects', 'focus', 'rows'].includes(key) && empty(key)))) {
      return Object.freeze({ v: ANALYSIS_CONTEXT_VERSION, scope: null, subjects: Object.freeze([]), focus: Object.freeze([]), rows: Object.freeze([]), pending });
    }
    if (!ANALYSIS_CONTEXT_SCOPES.includes(value.scope)) return null;
    if (value.level != null && (value.scope !== 'team' || !LEVELS.includes(value.level))) return null;
    const subjects = identities(value.subjects, ANALYSIS_CONTEXT_LIMITS.maxSubjects);
    // Satırlar KONUMSALDIR: aynı projede iki görev satırı aynı proje kimliğini iki kez taşır ("2. satır" sırası korunur).
    const rows = identities(value.rows, ANALYSIS_CONTEXT_LIMITS.maxRows, { unique: false, positional: true });
    if (!subjects || !rows) return null;
    let rowPopulation = null;
    if (value.rowPopulation != null) {
      if (!value.rowPopulation || typeof value.rowPopulation !== 'object' || Array.isArray(value.rowPopulation)
        || Object.keys(value.rowPopulation).some((key) => !['scope', 'level', 'subjects'].includes(key))) return null;
      const normalized = normalizeAnalysisContext({ v: 1, ...value.rowPopulation });
      if (!normalized || !['self', 'team', 'person'].includes(normalized.scope) || rows.some((row) => row && row.type !== 'project')) return null;
      rowPopulation = { scope: normalized.scope, subjects: normalized.subjects, ...(normalized.level ? { level: normalized.level } : {}) };
    }
    if (['person', 'project'].includes(value.scope) && (!subjects.length || subjects.some((item) => item.type !== value.scope))) return null;
    if (!['person', 'project'].includes(value.scope) && subjects.length) return null;
    // Daraltma: kendi/ekip/bütün görevler kapsamının sunucunun bağladığı tek proje kimliğiyle kesişimi.
    const within = value.within == null ? null : identity(value.within);
    if (value.within != null && (!within || within.type !== 'project' || !['self', 'team', 'all', 'person', 'projects'].includes(value.scope))) return null;
    if (value.withSelf != null && (value.withSelf !== true || value.scope !== 'person' || subjects.length !== 1)) return null;
    if (value.relativeWindow != null && (!['today', 'next_7_days', 'all_time'].includes(value.relativeWindow) || value.dateFrom || value.dateTo)) return null;
    const focus = value.focus == null ? [] : value.focus;
    if (!Array.isArray(focus) || focus.length > ANALYSIS_CONTEXT_LIMITS.maxFocus || focus.some((item) => !FOCUS.includes(item)) || new Set(focus).size !== focus.length) return null;
    for (const key of ['dateFrom', 'dateTo']) if (value[key] != null && !isIsoDay(value[key])) return null;
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) return null;
    if (value.visual != null && typeof value.visual !== 'boolean') return null;
    if (value.chart != null && (!CHARTS.includes(value.chart) || value.visual !== true)) return null;
    if (!validCharts(value)) return null;
    if (value.table != null && typeof value.table !== 'boolean') return null;
    // Ayrıntılı istekle listelenen görevlerin bağlamı yalnızca satır göndergesidir (önceki özne olarak kullanılamaz).
    if (value.rowsOnly != null && (value.rowsOnly !== true || !rows.length || rows.some((row) => row && row.type !== 'project'))) return null;
    return Object.freeze({ v: ANALYSIS_CONTEXT_VERSION, scope: value.scope, ...(value.level ? { level: value.level } : {}), subjects, ...(value.withSelf ? { withSelf: true } : {}), ...(value.relativeWindow ? { relativeWindow: value.relativeWindow } : {}), ...(within ? { within } : {}), focus: Object.freeze([...focus]),
      ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}), ...(value.dateTo ? { dateTo: value.dateTo } : {}), ...(value.visual ? { visual: true } : {}),
      ...(value.chart ? { chart: value.chart } : {}), ...(value.charts ? { charts: Object.freeze([...value.charts]) } : {}), ...(value.table ? { table: true } : {}), rows,
      ...(rowPopulation ? { rowPopulation: Object.freeze(rowPopulation) } : {}), ...(pending ? { pending } : {}), ...(value.rowsOnly ? { rowsOnly: true } : {}) });
  } catch {
    return null;
  }
}

/**
 * Planlayıcının gördüğü göndergesiz özet: kimlik ya da ad taşımaz, yalnızca türler ve sayılar. Önceki kullanıcı
 * sorusu zaten geçmiştedir; bu not yalnızca sunucunun bağladığı öznenin VARLIĞINI ve biçimini söyler.
 */
export function analysisContextSummary(context) {
  const row = context.rows.find(Boolean);
  const rows = row ? { type: row.type, count: context.rows.length } : null;
  return { scope: context.scope, ...(context.rowsOnly ? { rowsOnly: true } : {}), ...(context.level ? { level: context.level } : {}), subjects: context.subjects.length, ...(context.withSelf ? { withSelf: true } : {}), ...(context.relativeWindow ? { relativeWindow: context.relativeWindow } : {}), ...(context.within ? { withinProject: true } : {}),
    ...(context.focus.length ? { focus: context.focus } : {}),
    ...(context.dateFrom ? { dateFrom: context.dateFrom } : {}), ...(context.dateTo ? { dateTo: context.dateTo } : {}), ...(context.visual ? { visual: true } : {}),
    ...(context.chart ? { chart: context.chart } : {}), ...(context.charts ? { charts: context.charts } : {}), ...(context.table ? { table: true } : {}), ...(rows ? { rows } : {}) };
}
