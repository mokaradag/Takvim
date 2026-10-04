import 'server-only';
import { createHash } from 'node:crypto';
import { canonicalActualId } from '../../../domain/identity/actualId.js';

/**
 * Yüklenen yetki bağlamı başına bir kez hesaplanan kanonik parçalar: yönetim
 * kapsamındaki kimlik kümesi (en fazla yetki satırı sınırı kadar) ve bütün
 * nüfusun parmak izi her kanıt doğrulamasında yeniden sıralanmaz; olay
 * döngüsünde yinelenen O(N log N) iş yapılmaz.
 */
const canonicalParts = new WeakMap();

function partsOf(auth, scope) {
  let entry = canonicalParts.get(auth);
  if (!entry || entry.scope !== scope) {
    entry = {
      scope,
      people: createHash('sha256').update(JSON.stringify([...(auth.scopeIdentities || [])].sort((a, b) => a - b))).digest('hex'),
      full: null
    };
    canonicalParts.set(auth, entry);
  }
  return entry;
}

function digest(auth, scope, { projects, tasks, rights }) {
  return createHash('sha256').update(JSON.stringify({
    sicil: scope.sicil, admin: scope.isAdmin, executive: scope.isExecutive,
    projects: [...scope.projects].filter(([id]) => !projects || projects.has(id)).sort(([a], [b]) => a.localeCompare(b)),
    tasks: projects || tasks ? [...new Set(rights.map((row) => row.taskId))].sort() : scope.scopedTaskIds.split(',').sort(),
    taskRights: rights.map(({ projectId, taskId, reason }) => [projectId, taskId, reason]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    people: partsOf(auth, scope).people, assignment: scope.canAssignAllCorporate
  })).digest('hex');
}

/** A population-wide result keeps the full epoch; entity-focused results bind only their population. */
export function authorizationFingerprint(auth, scope, { projectIds = null, taskIds = null } = {}) {
  const projects = projectIds ? new Set(projectIds) : null;
  const tasks = taskIds ? new Set(taskIds) : null;
  if (!projects && !tasks) {
    const parts = partsOf(auth, scope);
    parts.full ??= digest(auth, scope, { projects: null, tasks: null, rights: auth.scopeTaskRights || [] });
    return parts.full;
  }
  const rights = (auth.scopeTaskRights || []).filter((row) => (!projects || projects.has(row.projectId)) && (!tasks || tasks.has(row.taskId)));
  return digest(auth, scope, { projects, tasks, rights });
}

/**
 * Kanıtın yetki nüfusunun kalıcı ve SINIRLI gösterimi: görev kimlikleri proje
 * başına 16 baytlık ikili değerlerin base64url birleşimi olarak saklanır
 * (görev başına ~21 karakter). Çözülemeyen ya da biçimi bozuk değer `null`
 * döner ve kanıt doğrulanamaz sayılır.
 */
const POPULATION_VERSION = 1;
const NO_PROJECT_KEY = '-';

function packIds(ids) {
  return Buffer.from(ids.map((id) => id.replace(/-/g, '')).join(''), 'hex').toString('base64url');
}

function unpackIds(packed) {
  if (typeof packed !== 'string' || !/^[A-Za-z0-9_-]*$/.test(packed)) return null;
  const bytes = Buffer.from(packed, 'base64url');
  if (bytes.length % 16 !== 0 || bytes.toString('base64url') !== packed) return null;
  const ids = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const hex = bytes.subarray(offset, offset + 16).toString('hex');
    ids.push(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  }
  return ids;
}

export function encodeAuthorizationPopulation(references = []) {
  const byProject = new Map();
  for (const { taskId, projectId } of references) {
    const id = canonicalActualId(taskId);
    if (!id) continue;
    const key = canonicalActualId(projectId) || NO_PROJECT_KEY;
    if (!byProject.has(key)) byProject.set(key, new Set());
    byProject.get(key).add(id);
  }
  return {
    v: POPULATION_VERSION,
    complete: true,
    tasks: Object.fromEntries([...byProject].sort(([a], [b]) => a.localeCompare(b)).map(([key, ids]) => [key, packIds([...ids].sort())]))
  };
}

/** Kalıcı nüfus → `{ taskId, projectId }` dizisi; nüfus eksik ya da bozuksa `null`. */
export function decodeAuthorizationPopulation(value) {
  if (!value || typeof value !== 'object' || value.v !== POPULATION_VERSION || value.complete !== true
    || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) return null;
  const references = [];
  for (const [key, packed] of Object.entries(value.tasks)) {
    const projectId = key === NO_PROJECT_KEY ? null : canonicalActualId(key);
    if (key !== NO_PROJECT_KEY && !projectId) return null;
    const ids = unpackIds(packed);
    if (!ids) return null;
    for (const taskId of ids) references.push({ taskId, projectId });
  }
  return references;
}

/**
 * Sonucu yalnızca yükte listelenen kayıtlara dayanan araçlar: nüfus işareti
 * taşımayan eski kalıcı kanıtları yükteki başvurularla doğrulanabilir. Diğer
 * araçların eski kanıtı sayılan nüfusu taşımadığından doğrulanamaz.
 */
export const PAYLOAD_POPULATION_TOOLS = Object.freeze(new Set(['rota_task_detail', 'rota_project_search', 'rota_person_search', 'rota_calendar_inspect']));

/** Nüfusu sınırlı kayda sığmayan kanıtın işareti: yeniden açılışta doğrulanamaz. */
export function unverifiableAuthorizationPopulation() {
  return { v: POPULATION_VERSION, complete: false };
}

export function evidenceTaskReferences(envelope) {
  const tasks = new Map();
  const visit = (value, inheritedProject = null) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, inheritedProject)); return; }
    const projectId = canonicalActualId(value.projectId || value.project?.projectId) || inheritedProject;
    for (const [key, item] of Object.entries(value)) {
      if (['taskId', 'seriesTaskId', 'templateTaskId'].includes(key)) {
        const id = canonicalActualId(item);
        if (id) tasks.set(id, projectId || tasks.get(id) || null);
      } else if (item && typeof item === 'object') visit(item, projectId);
    }
  };
  visit(envelope?.data);
  return [...tasks].map(([taskId, projectId]) => ({ taskId, projectId }));
}

export function scopedEvidenceAuthorization(auth, scope, args, envelope, projectPopulation = []) {
  const taskIds = envelope.tool === 'rota_task_detail' ? evidenceTaskReferences(envelope).map((row) => row.taskId) : null;
  const projectId = args.projectId || (taskIds ? envelope.data?.task?.project?.projectId : null);
  const projectIds = projectId ? [projectId] : [...new Set(projectPopulation.map(canonicalActualId).filter(Boolean))];
  if (!projectIds.length) return null;
  const population = { projectIds, taskIds };
  return { version: 1, ...population, epoch: authorizationFingerprint(auth, scope, population) };
}
