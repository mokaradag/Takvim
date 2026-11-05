import 'server-only';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { TOOL_LIMITS } from './toolLimits.js';
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
      people: createHash('sha256').update(JSON.stringify({
        identities: [...new Set(auth.scopeIdentities || [])].sort((a, b) => a - b),
        memberships: [...new Set((auth.scopeMemberships || []).map((row) => JSON.stringify(row)))].sort()
      })).digest('hex'),
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

/** Nüfus geneli sonuç tam dönemi korur; varlık odaklı sonuç yalnızca kendi nüfusunu bağlar. */
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
const MAX_POPULATION_BYTES = 1500000;
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
  if (value?.v === 2 && value.complete === true) {
    if (typeof value.deflated !== 'string' || value.deflated.length > 32000 || !/^[A-Za-z0-9_-]+$/.test(value.deflated)) return null;
    try {
      const bytes = Buffer.from(value.deflated, 'base64url');
      if (bytes.toString('base64url') !== value.deflated) return null;
      const decoded = JSON.parse(inflateRawSync(bytes, { maxOutputLength: MAX_POPULATION_BYTES }).toString('utf8'));
      if (decoded?.v !== POPULATION_VERSION) return null;
      value = decoded;
    } catch { return null; }
  }
  if (!value || typeof value !== 'object' || value.v !== POPULATION_VERSION || value.complete !== true
    || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) return null;
  const references = [];
  for (const [key, packed] of Object.entries(value.tasks)) {
    const projectId = key === NO_PROJECT_KEY ? null : canonicalActualId(key);
    if (key !== NO_PROJECT_KEY && !projectId) return null;
    const ids = unpackIds(packed);
    if (!ids) return null;
    if (references.length + ids.length > TOOL_LIMITS.maxAnalyzedTasks) return null;
    for (const taskId of ids) references.push({ taskId, projectId });
  }
  return references;
}


/** Aynı tam nüfusun kayıpsız biçimi; açılmış boyut ve görev sayısı ayrıca sınırlıdır. */
export function compressAuthorizationPopulation(population) {
  const text = JSON.stringify(population);
  if (Buffer.byteLength(text) > MAX_POPULATION_BYTES) return unverifiableAuthorizationPopulation();
  return { v: 2, complete: true, deflated: deflateRawSync(text).toString('base64url') };
}

/**
 * Eski dönemi yeniden üretmeyiz. Yalnızca görev araçlarının tam nüfusu ve
 * kayıtlı alanları, güncel kayıt/kimlik görünürlüğüyle bağımsız doğrulanabilir.
 * Diğer araçların ek yetki kuralları mevcut dönem denetiminde kalır.
 */
export function savedEvidenceRequirements(entry, auth) {
  if (!entry.savedPopulation || !/^[a-f0-9]{64}$/.test(entry.authorizationEpoch || '')
    || !['rota_task_analytics', 'rota_workload_summary', 'rota_task_search', 'rota_task_detail'].includes(entry.tool)) return null;
  const proof = entry.scopedAuthorization;
  if (proof != null && (proof.version !== 1 || !/^[a-f0-9]{64}$/.test(proof.epoch || '')
    || !Array.isArray(proof.projectIds) || proof.projectIds.some(id => !canonicalActualId(id))
    || proof.taskIds != null && (!Array.isArray(proof.taskIds) || proof.taskIds.some(id => !canonicalActualId(id))))) return null;
  const payload = JSON.parse(entry.payload || '{}');
  if (payload.tool !== entry.tool || !Array.isArray(entry.taskReferences)
    || entry.taskReferences.some(({ taskId, projectId }) => !canonicalActualId(taskId) || !canonicalActualId(projectId))) return null;
  const projectIds = [...new Set([...entry.taskReferences.map(row => row.projectId),
    payload.entity?.type === 'project' ? canonicalActualId(payload.entity.id) : null].filter(Boolean))];
  if (!projectIds.length) return null;
  const data = payload.data;
  if (data?.filters?.assignee === 'team' && !auth.isExecutive) return null;
  if (!data) return payload.dataOmitted === 'size' ? { projectIds, fullProjects: true, identities: true } : null;
  if (entry.tool === 'rota_task_analytics' && (!data.totals || !data.filters)) return null;
  if (entry.tool === 'rota_workload_summary' && (!Array.isArray(data.people) || !Number.isSafeInteger(data.openTaskCount))) return null;
  if (entry.tool === 'rota_task_search' && !Array.isArray(data.tasks)) return null;
  if (entry.tool === 'rota_task_detail' && !data.task) return null;
  if (entry.tool === 'rota_task_analytics' && data.groupBy !== 'assignee') return { projectIds, identities: false };
  if (entry.tool === 'rota_task_search') return { projectIds, identities: true };
  if (entry.tool === 'rota_task_detail') return { projectIds, identities: true, fullProjects: Boolean(data.task?.dependencies) };
  // Kişi toplamı da korunur: kesilmiş kişi/grup önizlemesi bütün kimlikleri kanıtlamaz.
  const people = entry.tool === 'rota_workload_summary' ? data.people?.map(row => row.sicil)
    : data.groups?.map(row => /^sicil:(\d+)$/.exec(row.key)?.[1]).filter(Boolean);
  const permitted = new Set([Number(auth.sicil), ...(auth.scopeIdentities || [])]);
  const identities = !(payload.complete === true && payload.truncated !== true && Array.isArray(people)
    && people.every(sicil => Number.isSafeInteger(Number(sicil)) && permitted.has(Number(sicil))));
  return { projectIds, identities };
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

/**
 * Kanıt yükündeki canlı görev başvuruları. Kök `filters` seçicinin kökenidir,
 * nüfus değildir: görünür seçiciyi araç kendisi kaydeder; silinmiş ya da
 * arşivlenmiş görevin tarihsel seçicisi canlı görev olarak doğrulanmaz.
 */
export function evidenceTaskReferences(envelope) {
  const tasks = new Map();
  const visit = (value, inheritedProject = null, root = false) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, inheritedProject)); return; }
    const projectId = canonicalActualId(value.projectId || value.project?.projectId) || inheritedProject;
    for (const [key, item] of Object.entries(value)) {
      if (root && key === 'filters') continue;
      if (['taskId', 'seriesTaskId', 'templateTaskId'].includes(key)) {
        const id = canonicalActualId(item);
        if (id) tasks.set(id, projectId || tasks.get(id) || null);
      } else if (item && typeof item === 'object') visit(item, projectId);
    }
  };
  visit(envelope?.data, null, true);
  return [...tasks].map(([taskId, projectId]) => ({ taskId, projectId }));
}

export function scopedEvidenceAuthorization(auth, scope, args, envelope, projectPopulation = []) {
  const taskIds = envelope.tool === 'rota_task_detail' ? evidenceTaskReferences(envelope).map((row) => row.taskId) : null;
  // Katılımcı geçmişinde proje seçicisi yetki değildir; görünür seçiciyi araç kaydeder.
  const selector = envelope.scope?.kind === 'participant' ? null : args.projectId;
  const projectId = selector || (taskIds ? envelope.data?.task?.project?.projectId : null);
  const projectIds = projectId ? [projectId] : [...new Set(projectPopulation.map(canonicalActualId).filter(Boolean))];
  if (!projectIds.length) return null;
  const population = { projectIds, taskIds };
  return { version: 1, ...population, epoch: authorizationFingerprint(auth, scope, population) };
}
