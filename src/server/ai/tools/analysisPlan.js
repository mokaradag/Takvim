import 'server-only';
import { PLANNER_LIMITS } from '../../../domain/ai/plannerOutcome.js';
import { invalidArguments } from './toolErrors.js';
import { parseToolArguments } from './toolArguments.js';
import { TOOL_ERROR_CODES } from './toolErrors.js';

/**
 * Aşama 4E — ANALİTİK İSTEK ÖZETİ (`rota_plan.analysis`).
 *
 * "Bu hafta işlerim açısından durumumu değerlendir" ya da "ekibimin iş yükü dengeli mi?" gibi olağan yönetsel
 * sorular tek bir veritabanı sorusu değildir: yanıt birkaç bütünleyici okumadan oluşur. Zayıf model bu okumaları
 * kayıt defterinin ölçü kimlikleri, koleksiyonları ve sıralama kurallarıyla tek tek yazmak zorunda kaldığında
 * bildirim reddedilir (REQUEST_DECLARATION). Özet, aynı anlamsal kararı KÜÇÜK ve KAPALI bir sözlükle taşır:
 *
 *   - `scope`  : analizin öznesi (self, person, team, project, projects, all) ve gerekiyorsa `level`/`names`;
 *   - `focus`  : 1–3 analitik yön (overview, status, priority, deadlines, overdue, upcoming, workload, projects,
 *                schedule, critical);
 *   - `dateFrom`/`dateTo`: yaklaşan termin ufku;
 *   - `visual` : kullanıcı açıkça grafik/görselleştirme istiyor mu (plan düzeyinde de verilebilir).
 *
 * Kararın SAHİBİ modeldir: hangi kapsamın, hangi yönlerin ve hangi ufkun sorulduğunu o seçer. Sunucu kullanıcı
 * cümlesini yorumlamaz (anahtar sözcük, düzenli ifade ya da dil tablosu yoktur); yalnızca türlü özeti, her yön için
 * kayıt defterinin sabit ve sınırlı istek biçimine BELİRLENİMCİ olarak açar. Açılan istekler modelin yazacağı
 * isteklerle AYNI doğrulamadan geçer (şema, güvenilir metin, nüfus, yetenek, çok bölümlü hep-ya-hiç kabul) ve
 * veri okunmadan önce donar. Yetki her okumada araçlardadır: kapsam istemek kapsam vermez.
 */

export const ANALYSIS_SCOPES = Object.freeze(['self', 'person', 'team', 'project', 'projects', 'all', 'previous', 'row']);
export const ANALYSIS_LEVELS = Object.freeze(['unit', 'department', 'directorate']);
export const ANALYSIS_FOCUS = Object.freeze(['overview', 'status', 'priority', 'deadlines', 'overdue', 'upcoming', 'workload', 'projects', 'schedule', 'critical']);
export const ANALYSIS_LIMITS = Object.freeze({ maxFocus: PLANNER_LIMITS.maxRequests, maxNames: 2, rankLimit: 8 });

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const OPEN = Object.freeze(['todo', 'in_progress']);

/** Modelin gördüğü kapalı özet şeması; açıklamalar yalnızca sözleşmeyi anlatır, dili yorumlamaz. */
export function analysisSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['scope', 'focus'],
    description: 'Geniş/değerlendirme sorusunda request yerine; sunucu her yönü doğrulanmış okumalara açar.',
    properties: {
      scope: { type: 'string', enum: [...ANALYSIS_SCOPES], description: 'self kendi görevleri; person adı verilen kişi; team yönettiği ekip/birim/bölüm; project adı verilen proje; projects bütün projeleri; all görebildiği bütün görevler; previous önceki analizin öznesi (takip); row önceki sonucun rows satırlarındaki kişi/proje.' },
      rows: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 10 }, description: 'Yalnızca scope row: önceki sonucun 1 tabanlı satır(lar)ı.' },
      within: { type: 'string', minLength: 2, maxLength: 120, description: 'self/team/all/previous kapsamını adı verilen tek projeyle daraltır (kullanıcının yazdığı proje adı).' },
      level: { type: 'string', enum: [...ANALYSIS_LEVELS], description: 'Yalnızca team, düzey söylendiyse: unit birim; department bölüm/müdürlük; directorate direktörlük.' },
      names: { type: 'array', minItems: 1, maxItems: ANALYSIS_LIMITS.maxNames, items: { type: 'string', minLength: 2, maxLength: 120 }, description: 'person/project: kullanıcının yazdığı ad(lar), en çok 2.' },
      focus: { type: 'array', minItems: 1, maxItems: ANALYSIS_FOCUS.length, uniqueItems: true, items: { type: 'string', enum: [...ANALYSIS_FOCUS] },
        description: 'Önem sırasıyla 1-3 yön (fazlası okunmaz). overview sayılar; status durum; priority öncelik; deadlines termin kovaları; overdue gecikenler; upcoming yaklaşan; workload kişilere göre; projects projelere göre; schedule aylara göre; critical kritik/yüksek açık işler.' },
      dateFrom: { ...DATE, description: 'Termin ufkunun başı (upcoming, critical, schedule).' },
      dateTo: { ...DATE, description: 'Ufkun sonu.' },
      visual: { type: 'boolean' }
    }
  };
}

/** Özetin biçim denetimi; sorun yolları `$.analysis…` biçimindedir (modelin değeri yansıtılmaz). */
export function parseAnalysis(raw) {
  let value;
  try { value = parseToolArguments(analysisSchema(), JSON.stringify(raw ?? null)); } catch (error) {
    if (error?.code !== TOOL_ERROR_CODES.INVALID_ARGUMENTS) throw error;
    throw invalidArguments((error.details || ['$:invalid']).map((detail) => String(detail).replace(/^\$/, '$.analysis')));
  }
  const problems = [];
  const named = ['person', 'project'].includes(value.scope);
  if (named && !value.names?.length) problems.push('$.analysis.names:required');
  if (!named && value.names?.length) problems.push('$.analysis.names:scope');
  if (value.level && value.scope !== 'team') problems.push('$.analysis.level:scope');
  if ((value.scope === 'row') !== (value.rows != null)) problems.push('$.analysis.rows:scope');
  if (value.within != null && !['self', 'team', 'all', 'previous'].includes(value.scope)) problems.push('$.analysis.within:scope');
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) problems.push('$.analysis.dateFrom:reversed');
  if (problems.length) throw invalidArguments(problems);
  return Object.freeze({ ...value, focus: Object.freeze([...value.focus]), ...(value.names ? { names: Object.freeze([...value.names]) } : {}) });
}

/** Özetin kapsam ipuçları: yalnızca sözleşmeden. */
export function analysisHints(problems) {
  const hints = [];
  const has = (prefix) => problems.some((problem) => String(problem).startsWith(prefix));
  if (has('$.analysis.names')) hints.push('analysis.names: person/project kapsamında kullanıcının yazdığı ad (zorunlu); diğer kapsamlarda verilmez');
  if (has('$.analysis.level')) hints.push('analysis.level yalnızca scope team ile');
  if (has('$.analysis.focus')) hints.push(`analysis.focus: önem sırasıyla 1-${ANALYSIS_LIMITS.maxFocus} öğe, ${ANALYSIS_FOCUS.join('|')}`);
  if (has('$.analysis.scope')) hints.push(`analysis.scope: ${ANALYSIS_SCOPES.join('|')}`);
  if (has('$.analysis.date')) hints.push('analysis.dateFrom/dateTo: YYYY-MM-DD, dateFrom ≤ dateTo');
  if (has('$.analysis.rows')) hints.push('analysis.rows yalnızca scope "row" ile: önceki yanıtın satır sırası ([1] ya da [1,2]); kapsam satırdaki kişi/projedir');
  if (has('$.analysis.within')) hints.push('analysis.within (tek proje adıyla daraltma) yalnızca scope self|team|all|previous ile');
  if (has('$.analysis:request')) hints.push('analysis ile request/additionalRequests/calls birlikte verilmez');
  return hints;
}

/* ── Belirlenimci açılım ───────────────────────────────────────────── */

const peopleScopes = new Set(['team', 'all', 'project', 'projects']);
/** Termin ufkunu (dateFrom/dateTo) okumasına uygulayan yönler. */
const WINDOW_FOCUS = new Set(['upcoming', 'critical', 'schedule']);

/**
 * Önceki analizin öznesi (sunucunun bağladığı kanonik bağlam): kapsam ve kimlikler ondan gelir; model kimlik görmez ve yazmaz.
 * Bağlam yoksa ya da satır yoksa gönderge yoktur (veri okunmadan açıklama istenir).
 */
function previousBase(analysis, previous) {
  if (!previous) throw invalidArguments(['$.analysis.scope:unavailable']);
  if (analysis.scope === 'row') {
    const rows = analysis.rows.map((row) => previous.rows[row - 1]);
    if (rows.some((row) => !row) || new Set(rows.map((row) => row.type)).size !== 1) throw invalidArguments(['$.analysis.rows:unavailable']);
    return { scope: rows[0].type, base: { filters: {}, entities: rows.map(({ type, id }) => ({ type, id })) } };
  }
  const scope = previous.scope;
  // Önceki daraltma (ör. ekip ∩ proje) öznenin parçasıdır: proje kimliği sunucunun bağladığı kimliktir.
  const within = previous.within ? [{ type: 'project', id: previous.within.id }] : [];
  if (['person', 'project'].includes(scope)) return { scope, base: { filters: {}, entities: [...previous.subjects.map(({ type, id }) => ({ type, id })), ...within] } };
  const base = scopeBase({ scope, level: previous.level });
  return { scope, base: { ...base, entities: [...base.entities, ...within] } };
}

/** Kapsamın nüfus koşulları ve varlıkları (modelin yazacağı istek alanları). */
function scopeBase(analysis) {
  switch (analysis.scope) {
    case 'self': return { filters: { assignee: 'me' }, entities: [] };
    case 'team': return { filters: { assignee: 'team', ...(analysis.level ? { teamLevel: analysis.level } : {}) }, entities: [] };
    case 'person': return { filters: {}, entities: analysis.names.map((text) => ({ type: 'person', text })) };
    case 'project': return { filters: {}, entities: analysis.names.map((text) => ({ type: 'project', text })) };
    default: return { filters: {}, entities: [] };
  }
}

const request = (fields) => ({ layout: 'auto', ...fields });

/** Görev satırının bağlam sütunları: kişi kapsamında sorumlu, proje dışı kapsamda proje. */
function rowContext(analysis, base) {
  const projectBound = analysis.scope === 'project' || base.entities.some((entity) => entity.type === 'project');
  return [...(peopleScopes.has(analysis.scope) ? ['task.assignees'] : []), ...(!projectBound ? ['task.project'] : [])];
}

/** Birden çok adlı kayıt (karşılaştırma): her ölçü kendi varlığına bağlanır; sıralı liste yerine kayıt başına değer. */
function comparison(base, metrics) {
  return request({ operation: 'value', metrics, population: { tool: 'rota_task_analytics' }, entities: base.entities,
    bindings: base.entities.flatMap((_, entity) => metrics.map((metric) => ({ metric, entity }))) });
}

function groups(base, groupBy, { open = true, window = null, split = false } = {}) {
  // Projelere göre iş, birbirini dışlayan bölümlerle (açık + tamamlanan = toplam) okunur: yığılmış çubuk adayıdır.
  return request({ operation: 'list', metrics: split ? ['tasks.open', 'tasks.done'] : ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy },
    ...(base.entities.length ? { entities: base.entities } : {}),
    filters: { ...base.filters, ...(open && !split ? { status: [...OPEN] } : {}), ...(window || {}) } });
}

function ranked(base, analysis, { metrics, rank, filters }) {
  const all = [...metrics, ...rowContext(analysis, base)].slice(0, 8);
  // Satırın proje adı birden çok yolda (ad/kod) taşınır: kayıt defterinin tek yolu açıkça bağlanır.
  const fields = all.includes('task.project') ? [{ metric: 'task.project', tool: 'rota_task_search', path: 'data.tasks.*.project.name' }] : [];
  return request({ operation: 'rank', metrics: all, rank: { ...rank, limit: ANALYSIS_LIMITS.rankLimit }, ...(fields.length ? { fields } : {}),
    population: { tool: 'rota_task_search', collection: 'tasks' }, ...(base.entities.length ? { entities: base.entities } : {}),
    filters: { ...base.filters, ...filters } });
}

/** Tek yönün isteği; kapsamda anlamı yoksa `null` (yön düşer, diğerleri kalır). */
function focusRequest(focus, analysis, base) {
  const compare = base.entities.filter((entity) => entity.type === (analysis.scope === 'person' ? 'person' : 'project')).length > 1 && ['person', 'project'].includes(analysis.scope);
  const window = analysis.dateFrom || analysis.dateTo ? { ...(analysis.dateFrom ? { dateFrom: analysis.dateFrom } : {}), ...(analysis.dateTo ? { dateTo: analysis.dateTo } : {}) } : null;
  // Karşılaştırmada kayıt başına değerler: açık, gecikmiş ve yaklaşan iş (yön ne olursa olsun tek karşılaştırma bölümü; tekilleşir).
  if (compare) return comparison(base, ['tasks.open', 'tasks.overdue', 'tasks.dueNext7Days']);
  switch (focus) {
    case 'overview':
      if (analysis.scope === 'projects') {
        return request({ operation: 'value', metrics: ['projects.total', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days', 'projects.withOverdue'],
          population: { tool: 'rota_portfolio_summary' } });
      }
      return request({ operation: 'value', metrics: ['tasks.total', 'tasks.open', 'tasks.done', 'tasks.overdue', 'tasks.dueNext7Days', 'tasks.completionRatePercent'],
        population: { tool: 'rota_task_analytics' }, ...(base.entities.length ? { entities: base.entities } : {}), filters: { ...base.filters } });
    case 'status': return groups(base, 'status', { open: false });
    case 'priority': return groups(base, 'priority');
    case 'deadlines': return groups(base, 'deadline');
    case 'schedule': return groups(base, 'target_month', { window: window ? { ...window } : null });
    case 'overdue':
      return ranked(base, analysis, { metrics: ['tasks.total', 'task.title', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc' }, filters: { deadline: 'overdue' } });
    case 'upcoming':
      return ranked(base, analysis, { metrics: ['tasks.total', 'task.title', 'task.targetFinish', 'task.status'], rank: { metric: 'task.targetFinish', order: 'asc' },
        filters: { status: [...OPEN], ...(window ? { ...window } : { deadline: 'due_next_7_days' }) } });
    case 'critical':
      return ranked(base, analysis, { metrics: ['tasks.total', 'task.title', 'task.priority', 'task.targetFinish'], rank: { metric: 'task.targetFinish', order: 'asc' },
        filters: { status: [...OPEN], priority: ['critical', 'high'], ...(window || {}) } });
    case 'workload':
      if (analysis.scope === 'self') return groups(base, 'project', { split: true });
      if (analysis.scope === 'person') {
        return request({ operation: 'list', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], population: { tool: 'rota_workload_summary', collection: 'people' },
          entities: base.entities });
      }
      return request({ operation: 'rank', metrics: ['person.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], rank: { metric: 'tasks.open', order: 'desc', limit: ANALYSIS_LIMITS.rankLimit },
        population: { tool: 'rota_workload_summary', collection: 'people' }, ...(base.entities.length ? { entities: base.entities } : {}),
        ...(analysis.scope === 'team' ? { filters: { ...base.filters } } : {}) });
    case 'projects':
      if (analysis.scope === 'project') return null;
      if (analysis.scope === 'projects' || analysis.scope === 'all') {
        return request({ operation: 'rank', metrics: ['project.name', 'tasks.open', 'tasks.overdue', 'tasks.dueNext7Days'], rank: { metric: 'tasks.overdue', order: 'desc', limit: ANALYSIS_LIMITS.rankLimit },
          population: { tool: 'rota_portfolio_summary', collection: 'projects' } });
      }
      return groups(base, 'project', { split: true });
    default:
      return null;
  }
}

/**
 * Özetin bölümleri: her yön en çok bir istek; eşdeğer istekler tekilleşir; çok bölümlü planın sınırı aşılmaz.
 * Sonuç modelin yazacağı ham istek nesneleridir (`request` + `additionalRequests`), doğrulama sonrasındadır.
 */
export function expandAnalysis(analysis, { previous = null } = {}) {
  // Takip: önceki öznenin kapsamı; yön, ufuk ve görselleştirme yeni sorunundur (model yeniden bildirir).
  const narrowed = (base) => (analysis.within ? { ...base, entities: [...base.entities.filter((entity) => entity.type !== 'project'), { type: 'project', text: analysis.within }] } : base);
  if (['previous', 'row'].includes(analysis.scope)) {
    const resolved = previousBase(analysis, previous);
    analysis = { ...analysis, scope: resolved.scope };
    return expandWith(analysis, narrowed(resolved.base));
  }
  return expandWith(analysis, narrowed(scopeBase(analysis)));
}

/**
 * Okunacak yönler (en çok PLANNER_LIMITS.maxRequests): modelin önem sırası korunur. Liste bütçeyi aşarsa overview'ün
 * sayılarıyla zaten verilen status önce düşer; bildirilen termin ufkunu taşıyan bir yön ve portföyde proje satırları
 * her zaman yer alır (modelin listesinden, yoksa upcoming / projects). Yalnızca türlü değerlerle çalışır.
 */
export function effectiveFocus(analysis) {
  const limit = PLANNER_LIMITS.maxRequests;
  let focus = [...analysis.focus];
  if (focus.length > limit && focus.includes('overview')) focus = focus.filter((item) => item !== 'status');
  focus = focus.slice(0, limit);
  const window = (analysis.dateFrom || analysis.dateTo) && !focus.some((item) => WINDOW_FOCUS.has(item));
  const required = [...(window ? [analysis.focus.find((item) => WINDOW_FOCUS.has(item)) || 'upcoming'] : []),
    ...(analysis.scope === 'projects' && !focus.includes('projects') ? ['projects'] : [])];
  return required.length ? [...focus.filter((item) => !required.includes(item)).slice(0, limit - required.length), ...required] : focus;
}

function expandWith(analysis, base) {
  const parts = [];
  const seen = new Set();
  for (const focus of effectiveFocus(analysis)) {
    const item = focusRequest(focus, analysis, base);
    if (!item) continue;
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(item);
  }
  // Kapsamda anlamı olmayan yönlerin yerine kapsamın genel görünümü okunur (ör. tek projede "projelere göre").
  if (!parts.length) parts.push(focusRequest('overview', analysis, base));
  return parts;
}

/** Açılan isteklerin sorun yolları modelin yazdığı özet alanlarına çevrilir (hangi alanı düzelteceğini görür). */
export function analysisDetails(details = []) {
  return [...new Set(details.map((detail) => {
    const text = String(detail);
    if (/entities\[\d+\](?:\.text)?:untrusted$/.test(text) || /entities(?:\[\d+\])?:dropped$/.test(text)) return '$.analysis.names:untrusted';
    if (/filters\.(?:dateFrom|dateTo|period)/.test(text)) return '$.analysis.dateFrom:invalid';
    if (/filters\.(?:assignee|teamLevel)/.test(text)) return '$.analysis.scope:unsupported';
    if (/^\$\.analysis\./.test(text)) return text;
    return '$.analysis:invalid';
  }))];
}

/**
 * Reddedilen ayrıntılı isteğin (request) EŞDEĞER analitik özeti — düzeltme ipucu olarak. Yalnızca isteğin türlü
 * alanlarından türetilir (nüfus aracı, gruplama, termin koşulu, sorumlu koşulu, varlık türleri); kullanıcının cümlesi
 * okunmaz. Not sistem yetkisiyle gittiği için serbest metin (varlık adı) ASLA yankılanmaz: adlı kapsamda adların
 * modelin kendi entities[].text değerleri olduğu yalnızca yapısal olarak söylenir. Eşleme yoksa `null`. Model öneriyi
 * benimsemek zorunda değildir; karar yine onundur.
 */
export function analysisSuggestion(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const tool = request.population?.tool;
  const filters = request.filters && typeof request.filters === 'object' ? request.filters : {};
  const entities = Array.isArray(request.entities) ? request.entities.filter((entity) => entity && typeof entity === 'object') : [];
  const groupBy = request.population?.groupBy;
  const focus = tool === 'rota_workload_summary' ? 'workload' : tool === 'rota_portfolio_summary' ? 'projects'
    : tool === 'rota_task_analytics' ? ({ status: 'status', priority: 'priority', deadline: 'deadlines', target_month: 'schedule', project: 'projects', assignee: 'workload' }[groupBy] || 'overview')
      : tool === 'rota_task_search' ? (filters.deadline === 'overdue' ? 'overdue' : (filters.dateFrom || filters.dateTo || String(filters.deadline || '').startsWith('due_')) ? 'upcoming'
        : Array.isArray(filters.priority) && filters.priority.length ? 'critical' : null) : null;
  if (!focus) return null;
  const named = (type) => entities.some((entity) => entity.type === type);
  const scope = filters.assignee === 'me' ? 'self' : filters.assignee === 'team' ? 'team' : named('person') ? 'person' : named('project') ? 'project'
    : tool === 'rota_portfolio_summary' ? 'projects' : 'all';
  const level = scope === 'team' && ANALYSIS_LEVELS.includes(filters.teamLevel) ? filters.teamLevel : null;
  const brief = { scope, ...(level ? { level } : {}), focus: [focus] };
  const names = scope === 'person' || scope === 'project' ? ` (ayrıca analysis.names: reddedilen isteğin ${scope} entities[].text değerleri, en çok ${ANALYSIS_LIMITS.maxNames})` : '';
  return `Bu soru analitik özetle de bildirilebilir (sunucu okumaları kendisi kurar): {"intent":"rota","language":"tr","analysis":${JSON.stringify(brief)}}${names}`;
}
