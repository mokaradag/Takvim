import 'server-only';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { accessReasonLabel, describeTaskScope, isCompleteTaskView, projectAccess, SCOPE_KINDS } from './rotaScope.js';
import { readProjectSearch, readTaskFacts } from './rotaToolStore.js';
import { collectionRanking, internalPageRequired } from '../../../../domain/ai/evidencePopulation.js';
import { rowMetricFields } from '../../../../domain/ai/requestContract.js';
import { scaledDecimal } from '../../../../domain/numbers/fixedDecimal.js';
import { METRICS } from '../../../../domain/ai/claimableEvidence.js';
import {
  assigneeView,
  isOverdue,
  overdueDays,
  paginate,
  priorityLabel,
  statusLabelOf
} from './taskFacts.js';

/** Sınırlı iç koleksiyon sayfaları mevcut imleç zarfını kullanır. */
export function collectionPage(call, tool, collection, args, rows, limit) {
  if (!internalPageRequired(call.request, tool, collection)) return { page: rows.slice(0, limit), offset: 0, nextCursor: null };
  const rank = call.request.rank;
  const ordering = collectionRanking(tool, collection, rank);
  let ordered = rows;
  let field = null;
  if (rank && ordering?.metric === rank.metric && ordering.order === rank.order) {
    const bindings = (call.request.fields || []).filter((item) => item.tool === tool && item.metric === rank.metric);
    const fields = rowMetricFields(tool, collection, rank.metric).filter((name) => !bindings.length
      || bindings.some((item) => item.path === `data.${collection}.*.${name}`));
    const value = (row, name) => name.split('.').reduce((item, key) => item?.[key], row);
    field = fields.find((name) => rows.some((row) => value(row, name) !== undefined)) || fields[0];
    const comparable = (row) => METRICS[rank.metric] === 'hours' ? scaledDecimal(value(row, field), 2) : value(row, field);
    if (field) ordered = [...rows].sort((left, right) => {
      const a = comparable(left); const b = comparable(right);
      return a == null ? b == null ? 0 : 1 : b == null ? -1 : (a < b ? -1 : a > b ? 1 : 0) * (rank.order === 'asc' ? 1 : -1);
    });
    limit = Math.min(limit, (rank.limit || 1) + 1);
  }
  const { cursor: _cursor, limit: _limit, ...population } = args;
  const page = paginate(tool, { collection, population, rank: rank || null }, ordered, { limit, cursor: call.cursor || null, anchor: ordered.map((row) =>
    row.taskId ?? row.seriesTaskId ?? row.sicil ?? row.key ?? row.projectId ?? row.wbsId) });
  const next = ordered[page.offset + page.page.length];
  return { ...page, ...(rank && field ? { rankingBoundary: { collection, metric: rank.metric, order: rank.order,
    returnedCount: page.page.length, nextValue: next ? field.split('.').reduce((value, key) => value?.[key], next) ?? null : null } } : {}) };
}

/** Sayfalı okuma aynı yetki altında aynı maddileştirilmiş nüfusu kullanır. */
export function collectionSnapshot(call, tool, args, load) {
  if (!internalPageRequired(call.request, tool)) return load();
  const { cursor: _cursor, limit: _limit, ...population } = args;
  return call.snapshot(JSON.stringify([tool, population, call.today]), call.cursor || null, load);
}

/**
 * Araçların ortak yardımcıları: modele giden VERİ metninin güvenli biçimi,
 * proje/görev künyeleri, erişim denetimleri ve ortak şema parçaları.
 */


/**
 * Veritabanından gelen serbest metin (başlık, açıklama, ileti) VERİDİR. Metin
 * kısaltılır, denetim karakterleri atılır ve kanıt atfına benzeyen işaretler
 * (`【R1】`, `[R1]`) nötrlenir: veri, yanıta kaynak atfı sızdıramaz.
 */
export { dataText } from '../toolResultText.js';
import { dataText } from '../toolResultText.js';

export function projectIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    const projectId = canonicalActualId(row.ProjectId);
    if (!projectId) continue;
    index.set(projectId, {
      projectId,
      name: dataText(row.ProjectName, 160),
      code: row.ProjectCode ? dataText(row.ProjectCode, 60) : null,
      source: row.SourceType === 'CORPORATE' ? 'corporate' : 'manual',
      accessLevel: row.AccessLevel === 'FULL' ? 'FULL' : 'PARTIAL',
      readGrant: Boolean(row.HasReadGrant),
      ownScoped: Boolean(row.IsTaskScoped)
    });
  }
  return index;
}

export function projectRef(project, projectId = null) {
  if (!project) return { projectId: projectId || null, name: 'Proje' };
  return { projectId: project.projectId, name: project.name, ...(project.code ? { code: project.code } : {}) };
}

/** Erişim düzeyinin model/kullanıcı dilindeki adı. */
export function accessLevelOf(access) {
  if (!access) return 'NONE';
  if (access.accessLevel === 'FULL') return 'FULL';
  return access.readGrant ? 'READ' : 'PARTIAL';
}

export function accessLabelOf(level) {
  return {
    FULL: 'Tam erişim',
    READ: 'Okuma erişimi (projenin bütün görevleri)',
    PARTIAL: 'Kısmi erişim (yalnızca yetkili görevler)'
  }[level] || 'Erişim yok';
}

export function accessExplanation(access) {
  const level = accessLevelOf(access);
  return {
    level,
    label: accessLabelOf(level),
    reasons: [...new Set((access?.reasons || []).map(accessReasonLabel))],
    completeTaskView: isCompleteTaskView(access),
    dependenciesAndBaselines: level === 'FULL'
  };
}

/** Görev listesi öğesi (boş alanlar yazılmaz: model için kısa). */
export function taskItem(fact, { projects, assignees = null, today, withProject = true }) {
  const item = {
    taskId: fact.id,
    title: dataText(fact.title, 160),
    ...(withProject ? { project: projectRef(projects.get(fact.projectId), fact.projectId) } : {}),
    status: fact.status,
    statusLabel: statusLabelOf(fact.status),
    priority: fact.priority,
    priorityLabel: priorityLabel(fact.priority),
    milestone: fact.milestone,
    overdue: isOverdue(fact, today)
  };
  if (fact.keyword) item.keyword = dataText(fact.keyword, 80);
  if (fact.targetFinish) item.targetFinish = fact.targetFinish;
  if (fact.plannedStart) item.plannedStart = fact.plannedStart;
  if (fact.plannedFinish) item.plannedFinish = fact.plannedFinish;
  if (fact.actualStart) item.actualStart = fact.actualStart;
  if (fact.actualFinish) item.actualFinish = fact.actualFinish;
  if (fact.progress != null) item.progressPercent = fact.progress;
  if (fact.createdAt) item.createdAt = fact.createdAt;
  if (fact.updatedAt) item.updatedAt = fact.updatedAt;
  if (isOverdue(fact, today)) item.overdueDays = overdueDays(fact, today);
  if (assignees) Object.assign(item, assigneeView(fact, assignees));
  // Kanonik erişim düzeyi (FULL/READ/PARTIAL): kanıt yazıcısı bunu yerelleştirir.
  item.access = fact.accessLevel === 'FULL' ? 'FULL' : (projects?.get(fact.projectId)?.readGrant ? 'READ' : 'PARTIAL');
  return item;
}

export function notFound() {
  return new ToolError(TOOL_ERROR_CODES.NOT_FOUND);
}

export function fullAccessRequired() {
  return new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE);
}

/**
 * Proje görünür değilse var olmayan projeyle aynı sonuç. Kapsam, yüklendiği
 * anda parmak izi alınmış değişmez bir görüntüdür: sistem yöneticisinin kapsamı
 * da bütün etkin projeleri içerir, burada genişletilmez (son yetki denetimi
 * aynı kapsamı yeniden kurabilmelidir).
 */
export async function requireVisibleProject(scope, projectId, call) {
  const access = projectAccess(scope, projectId);
  if (!access || (scope.isAdmin && !(await visibleProjectName(call, scope, projectId)))) throw notFound();
  return access;
}

/** Bağımlılık ve baz plan yalnızca FULL projede (anlık görüntüyle aynı). */
export async function requireFullProject(scope, projectId, call) {
  const access = await requireVisibleProject(scope, projectId, call);
  if (access.accessLevel !== 'FULL') throw fullAccessRequired();
  return access;
}

/** Aranan proje kümesinin kapsam künyesi (sonuçtan değil, ARANAN kümeden). */
export function searchedScope(scope, projectId = null) {
  if (projectId) {
    const access = projectAccess(scope, projectId);
    return describeTaskScope(access ? [access] : []);
  }
  if (scope.isAdmin) return describeTaskScope([]);
  return describeTaskScope([...scope.projects.values()]);
}

export function participantScope(note) {
  return { kind: SCOPE_KINDS.PARTICIPANT, completeProjectView: false, note };
}

export function currentUserScope(note) {
  return { kind: SCOPE_KINDS.CURRENT_USER, completeProjectView: false, note };
}

export function referenceScope(note) {
  return { kind: SCOPE_KINDS.REFERENCE, completeProjectView: true, note };
}

export function isPartialScope(scopeDescriptor) {
  return scopeDescriptor?.kind === SCOPE_KINDS.SUBSET;
}

/* ── Ortak şema parçaları ─────────────────────────────────── */

export const ID_PROPERTY = (description) => ({ type: 'string', format: 'uuid', description });
export const DATE_PROPERTY = (description) => ({ type: 'string', format: 'date', description });
const limitDefaults = new WeakMap();
export const effectivePageSize = (property, args) => args.limit ?? limitDefaults.get(property) ?? null;
export const LIMIT_PROPERTY = (maximum, fallback) => {
  const property = {
    type: 'integer',
    minimum: 1,
    maximum,
    description: `Döndürülecek en fazla öğe (1–${maximum}, varsayılan ${fallback}).`
  };
  limitDefaults.set(property, fallback);
  return property;
};
export const CURSOR_PROPERTY = {
  type: 'string',
  maxLength: 400,
  pattern: '^[A-Za-z0-9_-]+$',
  description: 'Önceki sonucun nextCursor değeri (sonraki sayfa için). Süzgeçler aynı kalmalıdır.'
};
export const PERSON_SICIL_PROPERTY = {
  type: 'integer',
  minimum: 1,
  maximum: 2147483647,
  description: 'Kişi süzgeci: rota_person_search ile bulunan Sicil. Kimlik doğrulaması değildir; yalnızca süzgeçtir.'
};

/**
 * Seçicinin kullanıcıya gösterilen adı: kanıt olgusu kimlikle değil adla
 * nitelenir. Yalnızca görünür proje/görev adı okunur; görünmüyorsa `null`.
 */
export async function visibleProjectName(call, scope, projectId) {
  if (!projectId) return null;
  const result = await call.sql((executor) => readProjectSearch(executor, scope, { text: '', limit: 1, projectId }));
  return result.rows[0] ? dataText(result.rows[0].ProjectName, 160) : null;
}

/** Görünür görevin adı ve güncel projesi; görünmüyorsa `null`. */
export async function visibleTaskReference(call, scope, taskId) {
  if (!taskId) return null;
  const result = await call.sql((executor) => readTaskFacts(executor, scope, { taskIds: [taskId], maxRows: 1 }));
  const fact = result.facts[0];
  return fact ? { title: dataText(fact.title, 160), projectId: fact.projectId } : null;
}
