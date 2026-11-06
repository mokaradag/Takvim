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
const NO_PROJECT_KEY = '-';

function packIds(ids) {
  return Buffer.from(ids.map((id) => id.replace(/-/g, '')).join(''), 'hex').toString('base64url');
}

/** Paketlenmiş kimliklerin kanonik ikili gösterimi; bozuk değer `null`. */
function unpackIds(packed) {
  if (typeof packed !== 'string' || !/^[A-Za-z0-9_-]*$/.test(packed)) return null;
  const bytes = Buffer.from(packed, 'base64url');
  return bytes.length % 16 === 0 && bytes.toString('base64url') === packed ? bytes : null;
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

/**
 * v1 nüfusunu doğrular ve çözer: kanonik proje anahtarı, geçerli paket, görev
 * sayısı sınırı ve yinelenmeyen görev zorunludur; aksi `null`.
 */
function decodePackedPopulation(value, countOnly) {
  if (!value || typeof value !== 'object' || value.v !== POPULATION_VERSION || value.complete !== true
    || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)) return null;
  const references = [];
  const seen = new Set();
  let count = 0;
  for (const [key, packed] of Object.entries(value.tasks)) {
    const projectId = key === NO_PROJECT_KEY ? null : canonicalActualId(key);
    // Kodlayıcı yalnızca kanonik proje anahtarı yazar; farklı yazım bozuk kayıttır.
    if (key !== NO_PROJECT_KEY && projectId !== key) return null;
    const bytes = unpackIds(packed);
    if (!bytes) return null;
    count += bytes.length / 16;
    if (count > TOOL_LIMITS.maxAnalyzedTasks) return null;
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const hex = bytes.subarray(offset, offset + 16).toString('hex');
      if (seen.has(hex)) return null;
      seen.add(hex);
      if (!countOnly) {
        const taskId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        references.push({ taskId, projectId });
      }
    }
  }
  return countOnly ? count : references;
}

/**
 * Sıkıştırılmış tam nüfus (v2): aynı v1 nüfusunun deflate + base64url biçimi.
 * Yalnızca v1 biçimi sınırlı kayda sığmadığında yazılır. Okumada girdi
 * uzunluğu, açılmış bayt sayısı ve görev sayısı ayrı ayrı sınırlıdır; kesik,
 * artık bayt taşıyan, iç içe sürümlü ya da sayısı tutmayan akış reddedilir.
 */
const COMPRESSED_POPULATION_VERSION = 2;
const MAX_COMPRESSED_POPULATION_CHARS = 32000;
/** Görev başına en kötü durumda bir proje anahtarı ve paketlenmiş kimlik (~64 karakter) ile sarmalayıcı. */
const MAX_INFLATED_POPULATION_BYTES = TOOL_LIMITS.maxAnalyzedTasks * 72 + 64;
const COMPRESSED_POPULATION_KEYS = 'complete,count,deflated,v';

/** v2 taşıyıcısının biçimini ve sınırlarını denetleyip iç JSON'u açar; herhangi bir ihlalde `null`. */
function inflatePopulation(value, budget = null) {
  if (Object.keys(value).sort().join(',') !== COMPRESSED_POPULATION_KEYS || value.complete !== true
    || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > TOOL_LIMITS.maxAnalyzedTasks
    || typeof value.deflated !== 'string' || !value.deflated.length || value.deflated.length > MAX_COMPRESSED_POPULATION_CHARS
    || !/^[A-Za-z0-9_-]+$/.test(value.deflated)) return null;
  const bytes = Buffer.from(value.deflated, 'base64url');
  if (bytes.toString('base64url') !== value.deflated) return null;
  const maxOutputLength = Math.min(MAX_INFLATED_POPULATION_BYTES, budget?.remainingBytes ?? MAX_INFLATED_POPULATION_BYTES);
  if (maxOutputLength <= 0) return null;
  let charged = false;
  try {
    const { buffer, engine } = inflateRawSync(bytes, { maxOutputLength, info: true });
    if (budget) budget.remainingBytes -= buffer.length;
    charged = true;
    // Akış sonundan sonra kalan bayt kanonik olmayan kayıttır.
    if (engine.bytesWritten !== bytes.length) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    // Başarısız açılım da çalışma bütçesini tüketir; sonraki kayıt aynı bütçeyi tekrar kullanamaz.
    if (budget && !charged) budget.remainingBytes = Math.max(0, budget.remainingBytes - maxOutputLength);
    return null;
  }
}

/** Kalıcı nüfus → `{ taskId, projectId }` dizisi; nüfus eksik ya da bozuksa `null`. */
export function decodeAuthorizationPopulation(value, { countOnly = false, budget = null } = {}) {
  if (value?.v !== COMPRESSED_POPULATION_VERSION) return decodePackedPopulation(value, countOnly);
  // Sıkıştırılmış kayıt sayım için de bütünüyle açılır ve doğrulanır; iç kayıt yalnızca v1 olabilir.
  const inner = inflatePopulation(value, budget);
  const decoded = decodePackedPopulation(inner, countOnly);
  if (decoded == null || (countOnly ? decoded : decoded.length) !== value.count) return null;
  return decoded;
}

/**
 * v1 nüfusunun kayıpsız sıkıştırılmış biçimi. Geçersiz ya da açılmış sınırı
 * aşan nüfus doğrulanamaz işaretine döner (kısmi nüfus asla tam sayılmaz).
 */
export function compressAuthorizationPopulation(population) {
  const count = decodePackedPopulation(population, true);
  const text = JSON.stringify(population);
  if (count == null || Buffer.byteLength(text) > MAX_INFLATED_POPULATION_BYTES) return unverifiableAuthorizationPopulation();
  return { v: COMPRESSED_POPULATION_VERSION, complete: true, count, deflated: deflateRawSync(text).toString('base64url') };
}

/**
 * Güncel proje erişiminin sırası: kısmi < görev kapsamlı kısmi (WBS kataloğu)
 * < okuma < tam. Kayıtlı yanıtın açıkladığı düzey bu sıralamayla karşılaştırılır.
 */
export const PROJECT_ACCESS_RANK = Object.freeze({ PARTIAL: 1, CATALOG: 2, READ: 3, FULL: 4 });

/** Güncel proje satırının (`readProjectSearch`) erişim sırası. */
export function currentProjectRank(row) {
  if (row.AccessLevel === 'FULL') return PROJECT_ACCESS_RANK.FULL;
  if (row.HasReadGrant) return PROJECT_ACCESS_RANK.READ;
  return row.IsTaskScoped ? PROJECT_ACCESS_RANK.CATALOG : PROJECT_ACCESS_RANK.PARTIAL;
}

const disclosedRank = (level) => (['PARTIAL', 'READ', 'FULL'].includes(level) ? PROJECT_ACCESS_RANK[level] : null);

/**
 * Proje sonucunun açıkladığı erişim düzeyleri: her kayıtlı proje en az
 * görünür olmalıdır; düzeyi gösterilen proje güncel olarak o düzeyden düşük
 * olamaz. Bozuk satır `null` döner (kapalı ret).
 */
function disclosedProjectLevels(projectIds, rows, levelOf) {
  const levels = new Map(projectIds.map((id) => [id, PROJECT_ACCESS_RANK.PARTIAL]));
  for (const row of rows) {
    const id = row != null && typeof row === 'object' ? canonicalActualId(row.projectId) : null;
    const rank = id ? disclosedRank(levelOf(row)) : null;
    if (!rank || !levels.has(id)) return null;
    levels.set(id, Math.max(levels.get(id), rank));
  }
  return levels;
}

/**
 * Kayıtlı görev kapsamının açıkladığı düzey. Farklı projelerin düzeyleri tek
 * tek kaydedilmediğinde yalnızca tek düzeyli nüfus doğrulanır; güvenli
 * biçimde kanıtlanamayan eski veya bozuk kapsam yeniden açıklanmaz.
 */
function savedTaskScopeRank(scope, auth) {
  const levels = scope?.projects;
  if (!levels || !['full', 'read', 'partial'].every(key => Number.isSafeInteger(levels[key]) && levels[key] >= 0)) return null;
  const complete = levels.partial === 0;
  if (levels.full + levels.read + levels.partial === 0) {
    // Sistem yöneticisinin filtresiz kapsamı proje sayısı tutmaz; tam yetkisi güncel olmalıdır.
    return auth?.isSystemAdmin === true && complete && scope.completeProjectView === true
      && scope.kind === 'complete-projects' ? PROJECT_ACCESS_RANK.FULL : null;
  }
  if (scope.completeProjectView !== complete || scope.kind !== (complete ? 'complete-projects' : 'authorized-task-subset')) return null;
  if (Object.values(levels).filter(count => count > 0).length > 1) return null;
  return levels.full > 0 ? PROJECT_ACCESS_RANK.FULL
    : levels.read > 0 ? PROJECT_ACCESS_RANK.READ : PROJECT_ACCESS_RANK.PARTIAL;
}

/** Proje künyesinin açıkladığı alanların canlı araçtaki en düşük erişimi; belirlenemezse tam erişim. */
function projectDetailRank(data, projectId) {
  const project = data?.project;
  const rank = disclosedRank(data?.access?.level);
  if (!project || typeof project !== 'object' || canonicalActualId(project.projectId) !== projectId || !rank) return PROJECT_ACCESS_RANK.FULL;
  const over = Array.isArray(project.countsOverLimit) ? project.countsOverLimit : [];
  // Bağımlılık/baz plan sayısı yalnızca tam erişimde, WBS sayısı tam/okuma/görev kapsamlı erişimde üretilir.
  if (project.dependencyCount != null || project.baselineCount != null || over.includes('dependencyCount') || over.includes('baselineCount')) return PROJECT_ACCESS_RANK.FULL;
  if (project.wbsNodeCount != null || over.includes('wbsNodeCount')) return Math.max(rank, PROJECT_ACCESS_RANK.CATALOG);
  return rank;
}

/**
 * Kimliğe bağlı görev sınıfları canlı sorguda yalnızca kimlik tabanıyla
 * üretilir (`assignmentState`): sorumlusuz/çözülemeyen sorumlu kovaları,
 * kişisi kayıttan kanıtlanamayan kova ve kesilmiş grup listesi her katkı
 * görevinin güncel kimlik tabanını ister. Biçimi bozuk grup `null` döner.
 */
function assigneeGroupsNeedIdentity(groups, permitted) {
  if (!Array.isArray(groups)) return null;
  let needed = false;
  for (const group of groups) {
    if (!group || typeof group !== 'object' || typeof group.key !== 'string') return null;
    const sicil = /^sicil:(\d+)$/.exec(group.key)?.[1];
    if (sicil != null) needed ||= !(Number.isSafeInteger(Number(sicil)) && permitted.has(Number(sicil)));
    else needed ||= group.key !== 'undisclosed';
  }
  return needed;
}

function validQualityChecks(data) {
  return Array.isArray(data.checks)
    && data.checks.every(row => row && typeof row.id === 'string' && Number.isSafeInteger(row.count) && row.count >= 0 && row.count <= data.openTaskCount)
    && new Set(data.checks.map(row => row.id)).size === data.checks.length
    && ['assignee', 'unresolvedAssignee'].every(id => data.checks.some(row => row.id === id));
}

const EMPTY_RESULT_DATA = Object.freeze({
  rota_project_search: (data) => Array.isArray(data.matches) && data.matches.length === 0,
  rota_task_search: (data) => Array.isArray(data.tasks) && data.tasks.length === 0,
  rota_workload_summary: (data) => Array.isArray(data.people) && data.people.length === 0 && data.openTaskCount === 0
    && data.unassignedOpenTasks === 0 && data.unrepresentedOpenTasks === 0,
  rota_task_analytics: (data) => data.totals?.total === 0 && (data.groups == null || (Array.isArray(data.groups) && data.groups.length === 0)),
  rota_recurrence_inspect: (data) => Array.isArray(data.series) && data.series.length === 0 && data.visibleEntryCount === 0,
  rota_data_quality: (data) => data.openTaskCount === 0 && data.cleanOpenTaskCount === 0
    && validQualityChecks(data) && data.checks.every(row => Array.isArray(row.examples) && row.examples.length === 0)
    && data.completedWithoutActualFinish?.count === 0
});

/**
 * Katkı kaydı olmayan boş sonuç yalnızca özgün yetki dönemiyle açılır.
 * Boş eşleşme listesi aranan korumalı nüfusu tek başına kanıtlamaz.
 */
function provenEmptyResult(entry, payload, exact) {
  const data = payload.data;
  if (!exact || entry.taskReferences.length !== 0 || !EMPTY_RESULT_DATA[entry.tool] || !data || typeof data !== 'object'
    || payload.complete !== true || payload.truncated === true || payload.totalCount !== 0 || payload.returnedCount !== 0
    || payload.entity != null) return false;
  const filters = data.filters;
  if (!filters || typeof filters !== 'object') return false;
  return EMPTY_RESULT_DATA[entry.tool](data);
}

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
    const assignees = item?.assignees;
    if (!taskId || !Array.isArray(assignees) || !['visible', 'unresolved', 'unassigned', 'undisclosed'].includes(item.assignment)
      || assignees.some(person => !person || typeof person.name !== 'string' || !person.name.trim()
        || (person.identityHidden === true ? Object.hasOwn(person, 'sicil')
          : Object.hasOwn(person, 'identityHidden') || !Number.isSafeInteger(person.sicil) || person.sicil <= 0 || person.sicil > 2147483647))
      || item.assignment === 'unassigned' && assignees.length !== 0
      || ['visible', 'unresolved'].includes(item.assignment) && !assignees.some(person => person.identityHidden !== true)
      || item.assignment === 'undisclosed' && assignees.some(person => person.identityHidden !== true)) return null;
    // Sorumlusuz bilgisi ve güncel olarak açık olmayan kişi yalnızca kimlik tabanıyla açılır.
    const disclosed = item.assignment === 'unassigned'
      || assignees.some((person) => person?.identityHidden !== true && !permitted.has(Number(person?.sicil)));
    const ownOnly = assignees.some((person) => person?.identityHidden === true)
      || (item.createdBy != null && Number(item.createdBy.sicil) !== self);
    if (disclosed || (ownOnly && !own.has(taskId))) required.add(taskId);
  }
  return required;
}

/** Tam nüfustaki özgün kimlik tabanları ve kısmi açıklanan kişiler; eksik köken `null`, eski biçim `undefined`. */
function savedIdentityPopulation(payload, population, permitted, personHidden = false) {
  if (!Object.hasOwn(payload, 'authorizationIdentityPopulation')) return undefined;
  const carrier = payload.authorizationIdentityPopulation;
  const inner = carrier?.v === COMPRESSED_POPULATION_VERSION ? inflatePopulation(carrier) : carrier;
  const identityReferences = decodePackedPopulation(inner, false);
  if (carrier?.v === COMPRESSED_POPULATION_VERSION && identityReferences?.length !== carrier.count) return null;
  if (!identityReferences || identityReferences.some(row => population.get(row.taskId) !== row.projectId)) return null;
  const identityTaskIds = new Set(identityReferences.map(row => row.taskId));
  const partial = inner?.partial;
  if (!Array.isArray(partial) || partial.some(row => !population.has(row?.taskId) || identityTaskIds.has(row.taskId)
    || !Array.isArray(row.sicils) || row.sicils.some(sicil => !Number.isSafeInteger(sicil) || sicil <= 0 || sicil > 2147483647)
    || new Set(row.sicils).size !== row.sicils.length)
    || new Set(partial.map(row => row.taskId)).size !== partial.length
    || identityTaskIds.size + partial.length !== population.size) return null;
  for (const row of partial) if (personHidden || row.sicils.some(sicil => !permitted.has(sicil))) identityTaskIds.add(row.taskId);
  return identityTaskIds;
}

/**
 * Eski dönemi yeniden üretmeyiz. Yalnızca görev araçlarının tam nüfusu ve
 * kayıtlı alanları, güncel kayıt/kimlik görünürlüğüyle bağımsız doğrulanabilir.
 * Diğer araçların ek yetki kuralları mevcut dönem denetiminde kalır.
 */
export function savedEvidenceRequirements(entry, auth, { exact = false } = {}) {
  if ((!entry.savedPopulation && !exact) || !/^[a-f0-9]{64}$/.test(entry.authorizationEpoch || '')
    || !['rota_task_analytics', 'rota_workload_summary', 'rota_task_search', 'rota_task_detail',
      'rota_project_detail', 'rota_project_search', 'rota_portfolio_summary', 'rota_wbs_inspect',
      'rota_baseline_compare', 'rota_dependency_inspect', 'rota_recurrence_inspect', 'rota_data_quality'].includes(entry.tool)) return null;
  const proof = entry.scopedAuthorization;
  if (proof != null && (proof.version !== 1 || !/^[a-f0-9]{64}$/.test(proof.epoch || '')
    || !Array.isArray(proof.projectIds) || proof.projectIds.some(id => canonicalActualId(id) !== id)
    || new Set(proof.projectIds).size !== proof.projectIds.length
    || proof.taskIds != null && (!Array.isArray(proof.taskIds) || proof.taskIds.some(id => !canonicalActualId(id))))) return null;
  const payload = entry.parsedPayload || JSON.parse(entry.payload || '{}');
  if (payload.dataOmitted != null && (payload.dataOmitted !== 'size' || payload.data !== null)
    || payload.tool !== entry.tool || !Array.isArray(entry.taskReferences)
    || entry.taskReferences.some(({ taskId, projectId }) => !canonicalActualId(taskId) || !canonicalActualId(projectId))) return null;
  const population = new Map(entry.taskReferences.map(row => [row.taskId, row.projectId]));
  if (population.size !== entry.taskReferences.length || evidenceTaskReferences(payload).some(row =>
    !population.has(row.taskId) || row.projectId != null && population.get(row.taskId) !== row.projectId)) return null;
  const projectIds = [...new Set([...(proof?.projectIds || []), ...entry.taskReferences.map(row => row.projectId),
    payload.entity?.type === 'project' ? canonicalActualId(payload.entity.id) : null].filter(Boolean))];
  const data = payload.data;
  const permitted = new Set([Number(auth.sicil), ...(auth.scopeIdentities || [])]);
  const isProjectRow = (row) => row != null && typeof row === 'object' && Boolean(canonicalActualId(row.projectId));
  const projectTool = ['rota_project_search', 'rota_portfolio_summary'].includes(entry.tool);
  const projectList = entry.tool === 'rota_project_search' ? data?.matches : data?.projects;
  if (projectTool) {
    // Görev nüfusu boş projeleri içermez; proje sonucu bütün eşleşen projelerin nüfusunu taşımalıdır.
    if (!proof) {
      if (payload.complete !== true || payload.truncated === true || !Array.isArray(projectList)
        || projectList.length !== payload.totalCount || !projectList.every(isProjectRow)) return null;
      projectIds.push(...projectList.map(row => canonicalActualId(row.projectId)).filter(id => !projectIds.includes(id)));
    } else if (!Number.isSafeInteger(payload.totalCount) || proof.projectIds.length !== payload.totalCount) return null;
  }
  if (!projectIds.length) return provenEmptyResult(entry, payload, exact) ? { projectIds: [], identities: false } : null;
  if (projectTool) {
    // Canlı arama/portföy kısmi projeleri de döndürür: gösterilmeyen proje yalnızca görünürlük, düzeyi
    // gösterilen proje (eşleşme, aday ya da portföy satırı) o düzeyden düşük olmayan güncel erişim ister.
    // Verisi çıkarılmış kayıt gösterilen düzeyleri taşımaz: önceki gibi tam erişim istenir.
    if (!Array.isArray(projectList)) return data === null && payload.dataOmitted === 'size'
      ? { projectIds, fullProjects: true, identities: true } : null;
    if (payload.returnedCount !== projectList.length || payload.complete === true && payload.truncated !== true
      && projectList.length !== payload.totalCount) return null;
    const listedIds = projectList.map(row => canonicalActualId(row?.projectId));
    if (listedIds.some(id => !id || !projectIds.includes(id)) || new Set(listedIds).size !== listedIds.length) return null;
    const rows = entry.tool === 'rota_project_search' ? [...projectList, ...(Array.isArray(data.candidates) ? data.candidates : [])] : projectList;
    if (data.candidates != null && !Array.isArray(data.candidates)) return null;
    const projectLevels = disclosedProjectLevels(projectIds, rows, (row) => (entry.tool === 'rota_project_search' ? row.access?.level : row.access));
    return projectLevels ? { projectIds, projectLevels, identities: false } : null;
  }
  if (entry.tool === 'rota_project_detail') {
    const projectId = canonicalActualId(payload.entity?.id);
    if (payload.entity?.type !== 'project' || !projectId) return null;
    const projectLevels = new Map(projectIds.map((id) => [id, PROJECT_ACCESS_RANK.FULL]));
    projectLevels.set(projectId, projectDetailRank(data, projectId));
    return { projectIds, projectLevels, identities: false };
  }
  const recordedLevels = payload.authorizationProjectLevels;
  let taskProjectLevels = null;
  if (recordedLevels != null) {
    if (!Array.isArray(recordedLevels) || recordedLevels.some(row => !row || canonicalActualId(row.projectId) !== row.projectId
      || !disclosedRank(row.level)) || new Set(recordedLevels.map(row => row.projectId)).size !== recordedLevels.length) return null;
    taskProjectLevels = new Map(recordedLevels.map(row => [row.projectId, disclosedRank(row.level)]));
    if (projectIds.some(id => !taskProjectLevels.has(id))) {
      if (recordedLevels.length || entry.taskReferences.length) return null;
      taskProjectLevels = null;
    }
  }
  const savedScopeRank = ['rota_recurrence_inspect', 'rota_wbs_inspect', 'rota_data_quality'].includes(entry.tool)
    ? savedTaskScopeRank(payload.scope, auth) : null;
  if (['rota_recurrence_inspect', 'rota_wbs_inspect', 'rota_data_quality'].includes(entry.tool) && savedScopeRank == null && !taskProjectLevels) return null;
  if (entry.tool === 'rota_recurrence_inspect') {
    const listing = Array.isArray(data?.series) && data?.filters && typeof data.filters === 'object';
    const single = data?.series && !Array.isArray(data.series) && typeof data.series === 'object';
    const nonRecurring = data?.recurring === false && canonicalActualId(data.task?.taskId);
    if (!listing && !single && !nonRecurring) return null;
    if (single || nonRecurring) {
      if (payload.entity?.type !== 'task' || !entry.taskReferences.some(row => row.taskId === canonicalActualId(payload.entity.id))) return null;
    }
    return { projectIds, projectLevels: taskProjectLevels || new Map(projectIds.map(id => [id, savedScopeRank])), identities: false };
  }
  if (entry.tool === 'rota_wbs_inspect') {
    const projectId = canonicalActualId(payload.entity?.id);
    if (payload.entity?.type !== 'project' || projectIds.length !== 1 || projectIds[0] !== projectId
      || canonicalActualId(data?.project?.projectId) !== projectId || !Array.isArray(data.nodes)) return null;
    const catalog = data.catalogVisibility === 'full-catalog';
    if (!catalog && data.catalogVisibility !== 'ancestor-chain-of-visible-tasks') return null;
    const wbsAncestorNodes = [];
    if (!catalog) {
      for (const node of data.nodes) {
        const id = canonicalActualId(node?.wbsId);
        const parentId = node?.parentWbsId == null ? null : canonicalActualId(node.parentWbsId);
        if (!id || node.parentWbsId != null && !parentId || wbsAncestorNodes.some(row => row.id === id)) return null;
        wbsAncestorNodes.push({ id, parentId });
      }
    }
    return { projectIds, projectLevels: new Map([[projectId, Math.max(savedScopeRank, catalog ? PROJECT_ACCESS_RANK.CATALOG : PROJECT_ACCESS_RANK.PARTIAL)]]),
      identities: false, ...(!catalog ? { wbsAncestorNodes, wbsProjectId: projectId } : {}) };
  }
  if (entry.tool === 'rota_data_quality') {
    if (!data || !Array.isArray(data.checks) || !data.filters || typeof data.filters !== 'object'
      || !Number.isSafeInteger(payload.totalCount) || payload.totalCount !== entry.taskReferences.length
      || !Number.isSafeInteger(data.openTaskCount) || data.openTaskCount < 0 || data.openTaskCount > payload.totalCount
      || !validQualityChecks(data)
      || data.filters.projectId != null && !projectIds.includes(canonicalActualId(data.filters.projectId))) return null;
    // Sıfır kişi sayıları da sınıflandırmadır; özgün alan kökeni yoksa bütün katkılarda kimlik tabanı aranır.
    const identityTaskIds = savedIdentityPopulation(payload, population, permitted);
    if (identityTaskIds === null) return null;
    return { projectIds, projectLevels: taskProjectLevels || new Map(projectIds.map(id => [id, savedScopeRank])),
      identityTaskIds, identities: !identityTaskIds };
  }
  if (!['rota_task_analytics', 'rota_workload_summary', 'rota_task_search', 'rota_task_detail'].includes(entry.tool)) {
    return { projectIds, fullProjects: true, identities: true };
  }
  // Ekip süzgecinin güncel yönetim düzeyi ve üyeleri kayıttan yeniden kurulamaz; yalnızca birebir dönem eşleşmesi açar.
  // Boyut nedeniyle verisi çıkarılmış kanıt süzgeçlerini (ekip kapsamı dahil) taşımadığından eşdeğer erişim kanıtlanamaz.
  if (!data) return exact && payload.dataOmitted === 'size'
    ? { projectIds, fullProjects: true, identities: true } : null;
  if (data.filters?.assignee === 'team' && !exact) return null;
  if (!entry.taskReferences.length && !exact) return null;
  if (entry.tool === 'rota_task_analytics' && (!data.totals || !data.filters
    || data.totals.total !== entry.taskReferences.length || payload.totalCount !== entry.taskReferences.length)) return null;
  if (entry.tool === 'rota_workload_summary' && (!Array.isArray(data.people) || data.openTaskCount !== entry.taskReferences.length)) return null;
  if (entry.tool === 'rota_task_search' && (!Array.isArray(data.tasks) || payload.totalCount !== entry.taskReferences.length)) return null;
  if (entry.tool === 'rota_task_detail' && !data.task) return null;
  // Kişi süzgecinin nüfusu kişinin kimliğine dayanır; kimlik güncel olarak açık değilse her görev kimlik tabanı ister.
  const personSicil = data.filters?.personSicil;
  const personHidden = personSicil != null && !permitted.has(Number(personSicil));
  // Sorumlusuz süzgeci canlı sorguda her görev için kimlik tabanı ister (gruplamadan bağımsız).
  const unassignedFilter = data.filters?.assignee === 'unassigned';
  if (entry.tool === 'rota_task_search' || entry.tool === 'rota_task_detail') {
    const identityTaskIds = savedIdentityTasks(entry.tool === 'rota_task_search' ? data.tasks : [data.task], auth, permitted);
    if (!identityTaskIds) return null;
    let wbs = {};
    if (entry.tool === 'rota_task_detail' && data.task.wbsPath?.length) {
      const nodes = data.task.wbsNodes;
      if (!Array.isArray(nodes) || nodes.length !== data.task.wbsPath.length
        || nodes.some(node => !canonicalActualId(node?.id) || node.parentId != null && !canonicalActualId(node.parentId))
        || new Set(nodes.map(node => node.id)).size !== nodes.length) return null;
      wbs = { wbsAncestorNodes: nodes, wbsProjectId: canonicalActualId(data.task.project?.projectId) };
      if (!wbs.wbsProjectId) return null;
    }
    return { ...wbs, projectIds, identities: personHidden || unassignedFilter, identityTaskIds,
      fullProjects: entry.tool === 'rota_task_detail' && Boolean(data.task.dependencies) };
  }
  // Kesilmiş kişi/grup önizlemesi bütün kimlikleri kanıtlamaz.
  const truncated = payload.complete !== true || payload.truncated === true;
  if (entry.tool === 'rota_task_analytics') {
    if (data.groupBy !== 'assignee') return { projectIds, identities: personHidden || unassignedFilter };
    const groups = assigneeGroupsNeedIdentity(data.groups, permitted);
    if (groups == null) return null;
    return { projectIds, identities: personHidden || unassignedFilter || truncated || groups };
  }
  // İş yükünün sorumlusuz sayısı, boş kişi listesinde de kimlik tabanına dayanır.
  if (!data.people.every((row) => row && typeof row === 'object' && Number.isSafeInteger(Number(row.sicil)))
    || !Number.isSafeInteger(data.unassignedOpenTasks) || data.unassignedOpenTasks < 0
    || !Number.isSafeInteger(data.unrepresentedOpenTasks) || data.unrepresentedOpenTasks < 0
    || typeof data.populationComplete !== 'boolean') return null;
  const peopleHidden = data.people.some((row) => !permitted.has(Number(row.sicil)));
  // Tam kişi kapsaması, sıfır sorumlusuz görevde de bütün katkı görevlerinin güncel kimlik tabanını ister.
  const identityTaskIds = savedIdentityPopulation(payload, population, permitted, personHidden);
  if (identityTaskIds === null) return null;
  // Kısıtlı özgün görünümde gizli atama varlığı açıklanmaz. Bilinen kimlik tabanları ise her dönemde korunur.
  return { projectIds, identityTaskIds, identities: !identityTaskIds && (personHidden || truncated || peopleHidden || data.populationComplete
    || data.unassignedOpenTasks > 0 || data.unrepresentedOpenTasks > 0) };
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
