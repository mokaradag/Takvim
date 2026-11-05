import 'server-only';
import { createHash } from 'node:crypto';
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
const NO_PROJECT_KEY = '-';

function packIds(ids) {
  return Buffer.from(ids.map((id) => id.replace(/-/g, '')).join(''), 'hex').toString('base64url');
}

function unpackIds(packed, countOnly = false) {
  if (typeof packed !== 'string' || !/^[A-Za-z0-9_-]*$/.test(packed)) return null;
  const bytes = Buffer.from(packed, 'base64url');
  if (bytes.length % 16 !== 0 || bytes.toString('base64url') !== packed) return null;
  if (countOnly) return bytes.length / 16;
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
export function decodeAuthorizationPopulation(value, { countOnly = false } = {}) {
  if (!value || typeof value !== 'object' || value.v !== POPULATION_VERSION || value.complete !== true
    || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) return null;
  const references = [];
  let count = 0;
  for (const [key, packed] of Object.entries(value.tasks)) {
    const projectId = key === NO_PROJECT_KEY ? null : canonicalActualId(key);
    if (key !== NO_PROJECT_KEY && !projectId) return null;
    const ids = unpackIds(packed, countOnly);
    if (ids == null) return null;
    count += countOnly ? ids : ids.length;
    if (count > TOOL_LIMITS.maxAnalyzedTasks) return null;
    if (!countOnly) for (const taskId of ids) references.push({ taskId, projectId });
  }
  return countOnly ? count : references;
}

const PROJECT_ACCESS_RANK = Object.freeze({ PARTIAL: 1, READ: 2, FULL: 3 });

/**
 * Kayıtlı görev satırlarında açıklanan kimlikler. Güncel öz/yönetim hakkıyla
 * açıklanamayan kimlik, görevin güncel kimlik tabanını ister; yalnızca kendi
 * sorumluluğuyla açılan alanlar (gizli eş sorumlu adı, oluşturan) güncel
 * sorumlulukla da açılabilir. Biçimi bozuk satır `null` döner (kapalı ret).
 */
function savedIdentityTasks(items, auth, permitted) {
  if (!Array.isArray(items)) return null;
  const self = Number(auth.sicil);
  const own = new Set((auth.scopeTaskRights || []).filter((row) => row.reason === 'ASSIGNEE').map((row) => row.taskId));
  const required = new Set();
  for (const item of items) {
    const taskId = canonicalActualId(item?.taskId);
    const assignees = item?.assignees ?? [];
    if (!taskId || !Array.isArray(assignees)) return null;
    // Sorumlusuz bilgisi ve güncel olarak açık olmayan kişi yalnızca kimlik tabanıyla açılır.
    const disclosed = item.assignment === 'unassigned'
      || assignees.some((person) => person?.identityHidden !== true && !permitted.has(Number(person?.sicil)));
    const ownOnly = assignees.some((person) => person?.identityHidden === true)
      || (item.createdBy != null && Number(item.createdBy.sicil) !== self);
    if (disclosed || (ownOnly && !own.has(taskId))) required.add(taskId);
  }
  return required;
}

/**
 * Eski dönemi yeniden üretmeyiz. Yalnızca görev araçlarının tam nüfusu ve
 * kayıtlı alanları, güncel kayıt/kimlik görünürlüğüyle bağımsız doğrulanabilir.
 * Diğer araçların ek yetki kuralları mevcut dönem denetiminde kalır.
 */
export function savedEvidenceRequirements(entry, auth) {
  if (!entry.savedPopulation || !/^[a-f0-9]{64}$/.test(entry.authorizationEpoch || '')
    || !['rota_task_analytics', 'rota_workload_summary', 'rota_task_search', 'rota_task_detail',
      'rota_project_detail', 'rota_project_search', 'rota_portfolio_summary', 'rota_wbs_inspect',
      'rota_baseline_compare', 'rota_dependency_inspect', 'rota_recurrence_inspect', 'rota_data_quality'].includes(entry.tool)) return null;
  const proof = entry.scopedAuthorization;
  if (proof != null && (proof.version !== 1 || !/^[a-f0-9]{64}$/.test(proof.epoch || '')
    || !Array.isArray(proof.projectIds) || proof.projectIds.some(id => !canonicalActualId(id))
    || proof.taskIds != null && (!Array.isArray(proof.taskIds) || proof.taskIds.some(id => !canonicalActualId(id))))) return null;
  const payload = JSON.parse(entry.payload || '{}');
  if (payload.tool !== entry.tool || !Array.isArray(entry.taskReferences)
    || entry.taskReferences.some(({ taskId, projectId }) => !canonicalActualId(taskId) || !canonicalActualId(projectId))) return null;
  const projectIds = [...new Set([...(proof?.projectIds || []), ...entry.taskReferences.map(row => row.projectId),
    payload.entity?.type === 'project' ? canonicalActualId(payload.entity.id) : null].filter(Boolean))];
  const data = payload.data;
  const isProjectRow = (row) => row != null && typeof row === 'object' && Boolean(canonicalActualId(row.projectId));
  if (['rota_project_search', 'rota_portfolio_summary'].includes(entry.tool) && !proof) {
    // Görev nüfusu boş projeleri içermez; eski proje toplamı bütün proje kimliklerini de taşımalıdır.
    const projects = entry.tool === 'rota_project_search' ? data?.matches : data?.projects;
    if (payload.complete !== true || payload.truncated === true || !Array.isArray(projects)
      || projects.length !== payload.totalCount || !projects.every(isProjectRow)) return null;
    projectIds.push(...projects.map(row => canonicalActualId(row.projectId)).filter(id => !projectIds.includes(id)));
  }
  if (!projectIds.length) return null;
  if (entry.tool === 'rota_project_search') {
    // Canlı arama kısmi projeleri de döndürür: her eşleşme kayıtlı erişim düzeyinden düşük olmayan güncel erişim ister.
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    if (!matches.every((row) => isProjectRow(row) && PROJECT_ACCESS_RANK[row.access?.level])) return null;
    const projectLevels = new Map(matches.map((row) => [canonicalActualId(row.projectId), PROJECT_ACCESS_RANK[row.access.level]]));
    projectIds.push(...[...projectLevels.keys()].filter((id) => !projectIds.includes(id)));
    return { projectIds, projectLevels, identities: true };
  }
  if (!['rota_task_analytics', 'rota_workload_summary', 'rota_task_search', 'rota_task_detail'].includes(entry.tool)) {
    return { projectIds, fullProjects: true, identities: true };
  }
  // Ekip süzgecinin güncel yönetim düzeyi ve üyeleri kayıttan yeniden kurulamaz; yalnızca birebir dönem eşleşmesi açar.
  // Boyut nedeniyle verisi çıkarılmış kanıt süzgeçlerini (ekip kapsamı dahil) taşımadığından eşdeğer erişim kanıtlanamaz.
  if (!data || data.filters?.assignee === 'team') return null;
  if (entry.tool === 'rota_task_analytics' && (!data.totals || !data.filters)) return null;
  if (entry.tool === 'rota_workload_summary' && (!Array.isArray(data.people) || !Number.isSafeInteger(data.openTaskCount))) return null;
  if (entry.tool === 'rota_task_search' && !Array.isArray(data.tasks)) return null;
  if (entry.tool === 'rota_task_detail' && !data.task) return null;
  const permitted = new Set([Number(auth.sicil), ...(auth.scopeIdentities || [])]);
  // Kişi süzgecinin nüfusu kişinin kimliğine dayanır; kimlik güncel olarak açık değilse her görev kimlik tabanı ister.
  const personSicil = data.filters?.personSicil;
  const personHidden = personSicil != null && !permitted.has(Number(personSicil));
  if (entry.tool === 'rota_task_analytics' && data.groupBy !== 'assignee') return { projectIds, identities: personHidden };
  if (entry.tool === 'rota_task_search' || entry.tool === 'rota_task_detail') {
    const identityTaskIds = savedIdentityTasks(entry.tool === 'rota_task_search' ? data.tasks : [data.task], auth, permitted);
    if (!identityTaskIds) return null;
    return { projectIds, identities: personHidden || data.filters?.assignee === 'unassigned', identityTaskIds,
      fullProjects: entry.tool === 'rota_task_detail' && Boolean(data.task.dependencies) };
  }
  // Kişi toplamı da korunur: kesilmiş kişi/grup önizlemesi bütün kimlikleri kanıtlamaz.
  const people = entry.tool === 'rota_workload_summary' ? data.people?.map(row => row?.sicil)
    : data.groups?.map(row => /^sicil:(\d+)$/.exec(row?.key)?.[1]).filter(Boolean);
  const identities = personHidden || !(payload.complete === true && payload.truncated !== true && Array.isArray(people)
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
