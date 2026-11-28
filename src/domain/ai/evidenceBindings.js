/**
 * Bilgin ICE-2 — belirlenimci kanıt bağlarının kurucuları (saf; yalnızca sunucunun düzen çiziminde kullanılır).
 *
 * Bağ, bir olgunun cümleye dönüştüğü noktada kurulur ve olgunun ANLAMSAL kimliğini taşır: kanıt kimliği (R#) ve kanıt
 * yükündeki alan yolu (ör. `data.groups.2.overdue`). Metinde sayı ya da ad aranmaz; aynı sayının farklı anlamları farklı
 * alan yollarıdır. Bağ yalnızca sunucuda yaşar; kart kurucusu (src/server/ai/assistant/evidenceCards.js) her bağı kanıt
 * yükünden ve canlı nüfus kaydından yeniden doğrular, tutarsız bağı kapalı reddeder. Model bağ görmez ve üretmez.
 */

/**
 * Canlı nüfus kaydı tutulan sayım alanları (bkz. src/server/ai/tools/rota/cardPopulation.js). Burada olmayan alana görev
 * koleksiyonu bağı kurulmaz: kart kurulamayacak bağ bağ bütçesini tüketmez.
 */
const TASK_SET_PATHS = Object.freeze({
  rota_task_analytics: /^(?:totalCount|data\.history\.undatedDone|data\.totals\.(?:total|todo|inProgress|done|open|overdue|dueToday|dueNext7Days|openWithoutTargetFinish|doneWithoutActualFinish|milestonesOpen)|data\.groups\.\d+\.(?:count|open|overdue|done)|data\.overdueAging\.buckets\.\d+\.count|data\.hours\.(?:taskCount|(?:plannedHours|actualHours|budget|spent)\.tasks(?:With|Without)Value))$/,
  rota_project_detail: /^data\.visibleTasks\.total$/,
  rota_workload_summary: /^data\.(?:openTaskCount|unassignedOpenTasks|unrepresentedOpenTasks|people\.\d+\.(?:openTasks|inProgress|overdue|dueNext7Days))$/,
  rota_portfolio_summary: /^data\.(?:totals\.(?:tasks|open|done|overdue|dueNext7Days|openWithoutTargetFinish)|projects\.\d+\.tasks\.(?:total|todo|inProgress|done|open|overdue|dueNext7Days|openWithoutTargetFinish|milestonesOpen))$/
});

/** Varlık satırı tutan araçlar ve satır yolları. */
const ENTITY_ROWS = Object.freeze({
  rota_workload_summary: /^data\.people\.\d+$/,
  rota_task_analytics: /^data\.groups\.\d+$/,
  rota_portfolio_summary: /^data\.projects\.\d+$/
});

/** Varlık olmayan grup anahtarları (atamasız, açıklanamayan, birimi belirsiz, kesik listenin "diğer"i). */
const NON_ENTITY_KEYS = new Set(['other', 'unassigned', 'unresolved', 'undisclosed', 'none', 'no_unit']);

const METRIC_TITLES = Object.freeze({
  overdue: ['Gecikmiş görevler', 'Overdue tasks'], open: ['Açık görevler', 'Open tasks'], openTasks: ['Açık görevler', 'Open tasks'],
  done: ['Tamamlanan görevler', 'Completed tasks'], inProgress: ['Devam eden görevler', 'In-progress tasks'], todo: ['Yapılacak görevler', 'To-do tasks'],
  dueNext7Days: ['7 gün içinde terminli görevler', 'Tasks due within 7 days'], dueToday: ['Bugün terminli görevler', 'Tasks due today'],
  openWithoutTargetFinish: ['Terminsiz açık görevler', 'Open tasks without a deadline'], doneWithoutActualFinish: ['Bitiş tarihi kayıtsız tamamlanan görevler', 'Completed tasks without a finish date'],
  milestonesOpen: ['Açık kilometre taşları', 'Open milestones'], unassignedOpenTasks: ['Sorumlusuz açık görevler', 'Unassigned open tasks'],
  unrepresentedOpenTasks: ['Kişi satırlarında temsil edilemeyen açık görevler', 'Open tasks not represented in the person rows'],
  undatedDone: ['Gerçekleşen bitiş tarihi kayıtlı olmayan tamamlanmış görevler', 'Completed tasks without a recorded finish date'],
  total: ['Görevler', 'Tasks'], tasks: ['Görevler', 'Tasks'], count: ['Görevler', 'Tasks'], totalCount: ['Görevler', 'Tasks'], openTaskCount: ['Açık görevler', 'Open tasks']
});

const lang = (locale) => (locale === 'en' ? 1 : 0);
const leafOf = (field) => String(field).split('.').at(-1);

/** Kanıt kimliği olgunun kendi kimliğindedir (`<tur>_R3:data.totals.open`); başka kaynaktan tahmin edilmez. */
export function factEvidenceId(fact) {
  const match = /_(R[1-9]\d*):/.exec(String(fact?.factId ?? ''));
  return match ? match[1] : null;
}

/** Ölçünün kart tonu (yalnızca kartın vurgu rengi; olgu değildir). */
export function metricTone(field) {
  const leaf = leafOf(field);
  if (leaf === 'overdue') return 'overdue';
  if (leaf === 'done') return 'done';
  if (leaf === 'inProgress') return 'progress';
  if (leaf === 'dueNext7Days' || leaf === 'dueToday') return 'due';
  if (leaf === 'unassignedOpenTasks') return 'unassigned';
  return 'neutral';
}

/** Ölçünün kart başlığı; `scope` (varlık adı ya da kapsam) varsa başa eklenir. */
export function metricTitle(field, locale = 'tr', scope = null) {
  const base = (METRIC_TITLES[leafOf(field)] || METRIC_TITLES.total)[lang(locale)];
  return scope ? `${scope} · ${base}` : base;
}

/** Alan yolu kayıtlı bir görev nüfusu mu? */
export function taskSetField(tool, field) {
  return Boolean(TASK_SET_PATHS[tool]?.test(String(field)));
}

/**
 * Görev koleksiyonu bağı (canlı nüfus kaydından). Alan kayıtlı değilse, sayı pozitif tam sayı değilse ya da kanıt kimliği
 * yoksa `null`.
 */
export function taskSetBind({ tool, evidenceId, field, count, title = null, locale = 'tr', scope = null }) {
  if (typeof evidenceId !== 'string' || !evidenceId || !taskSetField(tool, field) || !Number.isSafeInteger(count) || count < 1) return null;
  return { type: 'tasks', evidenceId, field: String(field), count, title: title || metricTitle(field, locale, scope), tone: metricTone(field) };
}

/** Olgudan görev koleksiyonu bağı: olgunun aracı, kanıtı ve alanı kendi kimliğidir. */
export function factTaskBind(fact, { locale = 'tr', scope = null, title = null } = {}) {
  if (!fact || !Number.isSafeInteger(fact.value)) return null;
  return taskSetBind({ tool: fact.semantic?.provenance?.tool, evidenceId: factEvidenceId(fact), field: fact.field, count: fact.value, title, locale, scope });
}

/** Satır yolu: olgunun satır bağlamı (`data.groups.3`). */
export function factRowPath(fact) {
  const path = fact?.semantic?.row?.path;
  return typeof path === 'string' ? path : null;
}

/** Varlık türü: aracın ve gruplamanın anlamından (iş yükü kişisi, portföy projesi, proje/birim/kişi grubu). */
export function entityKind(tool, groupBy = null) {
  if (tool === 'rota_workload_summary') return 'person';
  if (tool === 'rota_portfolio_summary') return 'project';
  if (tool === 'rota_task_analytics') return { project: 'project', department: 'department', unit: 'unit', assignee: 'person' }[groupBy] || null;
  return null;
}

/** Tekil varlık bağı (kişi, proje, örgüt birimi): satırın doğrulanmış ölçüleri ve önizlemesi. */
export function entityBind({ tool, evidenceId, row, groupBy = null, key = null }) {
  const entity = entityKind(tool, groupBy);
  if (!entity || typeof evidenceId !== 'string' || !ENTITY_ROWS[tool]?.test(String(row)) || (key != null && NON_ENTITY_KEYS.has(String(key)))) return null;
  return { type: 'entity', evidenceId, row: String(row), entity };
}

/** Olgunun satırının varlık bağı. */
export function factEntityBind(fact) {
  const tool = fact?.semantic?.provenance?.tool;
  return entityBind({ tool, evidenceId: factEvidenceId(fact), row: factRowPath(fact), groupBy: fact?.semantic?.groupBy || null,
    key: fact?.semantic?.group?.key ?? fact?.semantic?.row?.identity ?? null });
}

const COLLECTION_TITLES = Object.freeze({ person: ['Kişiler', 'People'], project: ['Projeler', 'Projects'], department: ['Bölümler', 'Departments'], unit: ['Birimler', 'Units'] });

/** Varlık koleksiyonu bağı ("**8** projede …"): satır yolları ve sayısı birebir aynı olmalıdır. */
export function entitiesBind({ tool, evidenceId, rows, groupBy = null, title = null, locale = 'tr', tone = 'neutral' }) {
  const entity = entityKind(tool, groupBy);
  const list = Array.isArray(rows) ? rows.map(String) : [];
  if (!entity || typeof evidenceId !== 'string' || !list.length || new Set(list).size !== list.length || !list.every((row) => ENTITY_ROWS[tool]?.test(row))) return null;
  return { type: 'entities', evidenceId, rows: list, count: list.length, entity, title: title || COLLECTION_TITLES[entity][lang(locale)], tone };
}

/** Hesap ya da karşılaştırma işleneni: kanıt + alan (ya da görev aramasının adlandırılmış satırları) + değer + etiket. */
export function operand({ evidenceId, field = null, taskIds = null, value, label }) {
  // `value: null` yalnızca alan yolu ile: değer kart kurulurken kanıt yükünden okunur (yanıt o değeri yazmıyorsa).
  if (typeof evidenceId !== 'string' || (!field && !Array.isArray(taskIds)) || !(value === null && field || Number.isSafeInteger(value) && value >= 0)) return null;
  return { evidenceId, ...(field ? { field: String(field) } : { taskIds: [...taskIds] }), value, label: String(label || '') };
}

/** Olgudan işlenen. */
export function factOperand(fact, label) {
  return fact ? operand({ evidenceId: factEvidenceId(fact), field: fact.field, value: fact.value, label }) : null;
}

/**
 * Doğrulanmış yüzde bağı. `rule`: `share` (sunucunun pay kuralı), `majority` (çoğunluk; %50'yi aşan en az ondalık) ya da
 * `round` (tamamlanma oranı). `shown` yanıtta yazılan sayıdır; kart kurucusu aynı kuralla yeniden hesaplar.
 */
export function calcBind({ numerator, denominator, shown, rule = 'share', title, tone = 'neutral' }) {
  if (!numerator || !denominator || typeof shown !== 'number' || !Number.isFinite(shown) || !['share', 'majority', 'round'].includes(rule)) return null;
  return { type: 'calc', numerator, denominator, shown, rule, title: String(title || ''), tone };
}

/** İki doğrulanmış değerin karşılaştırma bağı (ör. iki dönem ya da iki özne). */
export function compareBind({ items, title, tone = 'neutral', rate = null }) {
  if (!Array.isArray(items) || items.length !== 2 || items.some((item) => !item) || (rate != null && !Number.isSafeInteger(rate))) return null;
  // `rate`: yanıtta yazılan değişim yüzdesi (|sonraki − önceki| / önceki × 100, tam sayıya yuvarlanmış); kart aynı kuralla doğrular.
  return { type: 'compare', items, title: String(title || ''), tone, ...(rate != null ? { rate } : {}) };
}
