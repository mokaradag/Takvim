import 'server-only';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { accessReasonLabel, describeTaskScope, isCompleteTaskView, projectAccess, SCOPE_KINDS } from './rotaScope.js';
import { readProjectSearch, readTaskFacts } from './rotaToolStore.js';
import {
  assigneeView,
  isOverdue,
  overdueDays,
  priorityLabel,
  statusLabelOf
} from './taskFacts.js';

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
    priorityLabel: priorityLabel(fact.priority)
  };
  if (fact.targetFinish) item.targetFinish = fact.targetFinish;
  if (fact.plannedStart) item.plannedStart = fact.plannedStart;
  if (fact.plannedFinish) item.plannedFinish = fact.plannedFinish;
  if (fact.actualFinish) item.actualFinish = fact.actualFinish;
  if (fact.progress != null) item.progressPercent = fact.progress;
  if (fact.milestone) item.milestone = true;
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
export async function requireVisibleProject(scope, projectId) {
  const access = projectAccess(scope, projectId);
  if (!access) throw notFound();
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
export const LIMIT_PROPERTY = (maximum, fallback) => ({
  type: 'integer',
  minimum: 1,
  maximum,
  description: `Döndürülecek en fazla öğe (1–${maximum}, varsayılan ${fallback}).`
});
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

export async function visibleTaskTitle(call, scope, taskId) {
  if (!taskId) return null;
  const result = await call.sql((executor) => readTaskFacts(executor, scope, { taskIds: [taskId], maxRows: 1 }));
  return result.facts[0] ? dataText(result.facts[0].title, 160) : null;
}
