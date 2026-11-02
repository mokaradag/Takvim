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

export const ANALYSIS_CONTEXT_SCOPES = Object.freeze(['self', 'team', 'person', 'project', 'projects', 'all']);
export const ANALYSIS_CONTEXT_LIMITS = Object.freeze({ maxSubjects: 2, maxRows: 10, maxFocus: 3 });
const LEVELS = Object.freeze(['unit', 'department', 'directorate']);
const FOCUS = Object.freeze(['overview', 'status', 'priority', 'deadlines', 'overdue', 'upcoming', 'workload', 'projects', 'schedule', 'critical']);
const KEYS = new Set(['v', 'scope', 'level', 'subjects', 'within', 'focus', 'dateFrom', 'dateTo', 'visual', 'chart', 'table', 'rows', 'rowPopulation', 'pending', 'rowsOnly']);
const CHARTS = Object.freeze(['bar', 'donut', 'line', 'stacked', 'kpi', 'timeline']);
const PENDING_SCOPES = Object.freeze(['self', 'team', 'person', 'project', 'projects', 'all']);
const PENDING_KEYS = new Set(['language', 'scope', 'focus', 'names', 'level', 'within', 'dateFrom', 'dateTo', 'visual', 'chart', 'table']);
const shortText = (value) => typeof value === 'string' && value.trim().length >= 2 && value.length <= 120;

/**
 * Açıklama (aday seçimi) bekleyen analitik niyet: kabul edilmiş özetin kimliksiz biçimi. Seçimden sonra sunucu bu özeti
 * güncel yetkiyle yeniden yürütür (yön, ufuk, görselleştirme korunur). Adlar kullanıcının kendi iletisindeki metindir;
 * kimlik, yetki ya da kanıt taşımaz. Biçim dışı her değer bekleyen niyeti tamamen düşürür.
 */
export function normalizePendingAnalysis(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !PENDING_KEYS.has(key))) return null;
    if (!['tr', 'en'].includes(value.language) || !PENDING_SCOPES.includes(value.scope)) return null;
    const focus = value.focus;
    if (!Array.isArray(focus) || !focus.length || focus.length > ANALYSIS_CONTEXT_LIMITS.maxFocus || focus.some((item) => !FOCUS.includes(item)) || new Set(focus).size !== focus.length) return null;
    if (value.names != null && (!Array.isArray(value.names) || !value.names.length || value.names.length > 2 || !value.names.every(shortText))) return null;
    if (['person', 'project'].includes(value.scope) !== Boolean(value.names)) return null;
    if (value.level != null && (value.scope !== 'team' || !LEVELS.includes(value.level))) return null;
    if (value.within != null && !shortText(value.within)) return null;
    for (const key of ['dateFrom', 'dateTo']) if (value[key] != null && !isIsoDay(value[key])) return null;
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) return null;
    for (const key of ['visual', 'table']) if (value[key] != null && value[key] !== true) return null;
    if (value.chart != null && (!CHARTS.includes(value.chart) || value.visual !== true)) return null;
    return Object.freeze({ language: value.language, scope: value.scope, focus: Object.freeze([...focus]), ...(value.names ? { names: Object.freeze([...value.names]) } : {}),
      ...(value.level ? { level: value.level } : {}), ...(value.within ? { within: value.within } : {}), ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}),
      ...(value.dateTo ? { dateTo: value.dateTo } : {}), ...(value.visual ? { visual: true } : {}), ...(value.chart ? { chart: value.chart } : {}), ...(value.table ? { table: true } : {}) });
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
  return Object.freeze({ ...(prior ? base : { v: 1 }), pending: normalizedPending });
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

function identities(value, max, { unique = true } = {}) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > max) return null;
  const items = value.map(identity);
  if (items.some((item) => !item)) return null;
  const keys = items.map((item) => `${item.type}:${item.id}`);
  return !unique || new Set(keys).size === keys.length ? Object.freeze(items) : null;
}

/** Kapalı biçimli bağlam; uymuyorsa `null`. Dönen değer donmuş kopyadır. */
export function normalizeAnalysisContext(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || Object.keys(value).some((key) => !KEYS.has(key))) return null;
    const pending = value.pending == null ? null : normalizePendingAnalysis(value.pending);
    if (value.pending != null && !pending) return null;
    // Yalnızca bekleyen niyet (önceki analiz yokken açıklama): takip öznesi değildir; `scope` boştur.
    const empty = (key) => value[key] == null || (Array.isArray(value[key]) && !value[key].length);
    if (value.scope == null && pending && Object.keys(value).every((key) => ['v', 'pending', 'scope'].includes(key) || (['subjects', 'focus', 'rows'].includes(key) && empty(key)))) {
      return Object.freeze({ v: 1, scope: null, subjects: Object.freeze([]), focus: Object.freeze([]), rows: Object.freeze([]), pending });
    }
    if (!ANALYSIS_CONTEXT_SCOPES.includes(value.scope)) return null;
    if (value.level != null && (value.scope !== 'team' || !LEVELS.includes(value.level))) return null;
    const subjects = identities(value.subjects, ANALYSIS_CONTEXT_LIMITS.maxSubjects);
    // Satırlar KONUMSALDIR: aynı projede iki görev satırı aynı proje kimliğini iki kez taşır ("2. satır" sırası korunur).
    const rows = identities(value.rows, ANALYSIS_CONTEXT_LIMITS.maxRows, { unique: false });
    if (!subjects || !rows) return null;
    let rowPopulation = null;
    if (value.rowPopulation != null) {
      if (!value.rowPopulation || typeof value.rowPopulation !== 'object' || Array.isArray(value.rowPopulation)
        || Object.keys(value.rowPopulation).some((key) => !['scope', 'level', 'subjects'].includes(key))) return null;
      const normalized = normalizeAnalysisContext({ v: 1, ...value.rowPopulation });
      if (!normalized || !['self', 'team', 'person'].includes(normalized.scope) || rows.some((row) => row.type !== 'project')) return null;
      rowPopulation = { scope: normalized.scope, subjects: normalized.subjects, ...(normalized.level ? { level: normalized.level } : {}) };
    }
    if (['person', 'project'].includes(value.scope) && (!subjects.length || subjects.some((item) => item.type !== value.scope))) return null;
    if (!['person', 'project'].includes(value.scope) && subjects.length) return null;
    // Daraltma: kendi/ekip/bütün görevler kapsamının sunucunun bağladığı tek proje kimliğiyle kesişimi.
    const within = value.within == null ? null : identity(value.within);
    if (value.within != null && (!within || within.type !== 'project' || !['self', 'team', 'all', 'person', 'projects'].includes(value.scope))) return null;
    const focus = value.focus == null ? [] : value.focus;
    if (!Array.isArray(focus) || focus.length > ANALYSIS_CONTEXT_LIMITS.maxFocus || focus.some((item) => !FOCUS.includes(item)) || new Set(focus).size !== focus.length) return null;
    for (const key of ['dateFrom', 'dateTo']) if (value[key] != null && !isIsoDay(value[key])) return null;
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) return null;
    if (value.visual != null && typeof value.visual !== 'boolean') return null;
    if (value.chart != null && (!CHARTS.includes(value.chart) || value.visual !== true)) return null;
    if (value.table != null && typeof value.table !== 'boolean') return null;
    // Ayrıntılı istekle listelenen görevlerin bağlamı yalnızca satır göndergesidir (önceki özne olarak kullanılamaz).
    if (value.rowsOnly != null && (value.rowsOnly !== true || !rows.length || rows.some((row) => row.type !== 'project'))) return null;
    return Object.freeze({ v: 1, scope: value.scope, ...(value.level ? { level: value.level } : {}), subjects, ...(within ? { within } : {}), focus: Object.freeze([...focus]),
      ...(value.dateFrom ? { dateFrom: value.dateFrom } : {}), ...(value.dateTo ? { dateTo: value.dateTo } : {}), ...(value.visual ? { visual: true } : {}),
      ...(value.chart ? { chart: value.chart } : {}), ...(value.table ? { table: true } : {}), rows,
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
  const rows = context.rows.length ? { type: context.rows[0].type, count: context.rows.length } : null;
  return { scope: context.scope, ...(context.level ? { level: context.level } : {}), subjects: context.subjects.length, ...(context.within ? { withinProject: true } : {}),
    ...(context.focus.length ? { focus: context.focus } : {}),
    ...(context.dateFrom ? { dateFrom: context.dateFrom } : {}), ...(context.dateTo ? { dateTo: context.dateTo } : {}), ...(context.visual ? { visual: true } : {}),
    ...(context.chart ? { chart: context.chart } : {}), ...(context.table ? { table: true } : {}), ...(rows ? { rows } : {}) };
}
