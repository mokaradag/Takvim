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

/** Paketlenmiş kimlikleri kanonik UUID dizisine (ya da `countOnly` ile sayıya) çevirir; bozuk değer `null`. */
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

/**
 * v1 nüfusunu doğrular ve çözer: kanonik proje anahtarı, geçerli paket, görev
 * sayısı sınırı ve (tam çözümde) yinelenmeyen görev zorunludur; aksi `null`.
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
    const ids = unpackIds(packed, countOnly);
    if (ids == null) return null;
    count += countOnly ? ids : ids.length;
    if (count > TOOL_LIMITS.maxAnalyzedTasks) return null;
    if (countOnly) continue;
    for (const taskId of ids) {
      // Aynı görevin iki kez (ya da iki projede) görünmesi tutarsız nüfustur.
      if (seen.has(taskId)) return null;
      seen.add(taskId);
      references.push({ taskId, projectId });
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
function inflatePopulation(value) {
  if (Object.keys(value).sort().join(',') !== COMPRESSED_POPULATION_KEYS || value.complete !== true
    || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > TOOL_LIMITS.maxAnalyzedTasks
    || typeof value.deflated !== 'string' || !value.deflated.length || value.deflated.length > MAX_COMPRESSED_POPULATION_CHARS
    || !/^[A-Za-z0-9_-]+$/.test(value.deflated)) return null;
  const bytes = Buffer.from(value.deflated, 'base64url');
  if (bytes.toString('base64url') !== value.deflated) return null;
  try {
    const { buffer, engine } = inflateRawSync(bytes, { maxOutputLength: MAX_INFLATED_POPULATION_BYTES, info: true });
    // Akış sonundan sonra kalan bayt kanonik olmayan kayıttır.
    if (engine.bytesWritten !== bytes.length) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch { return null; }
}

/** Kalıcı nüfus → `{ taskId, projectId }` dizisi; nüfus eksik ya da bozuksa `null`. */
export function decodeAuthorizationPopulation(value, { countOnly = false } = {}) {
  if (value?.v !== COMPRESSED_POPULATION_VERSION) return decodePackedPopulation(value, countOnly);
  // Sıkıştırılmış kayıt sayım için de bütünüyle açılır ve doğrulanır; iç kayıt yalnızca v1 olabilir.
  const inner = inflatePopulation(value);
  const decoded = decodePackedPopulation(inner, false);
  if (!decoded || decoded.length !== value.count) return null;
  return countOnly ? decoded.length : decoded;
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

const EMPTY_RESULT_DATA = Object.freeze({
  rota_project_search: (data) => Array.isArray(data.matches) && data.matches.length === 0,
  rota_task_search: (data) => Array.isArray(data.tasks) && data.tasks.length === 0,
  rota_task_analytics: (data) => data.totals?.total === 0 && (data.groups == null || (Array.isArray(data.groups) && data.groups.length === 0))
});

/**
 * Kanıtlanmış boş ve kapsamsız sonuç: tam, kesilmemiş, sıfır sayılı, boş
 * nüfuslu ve proje/kişi/ekip/WBS seçicisi taşımayan kayıt. Doğrulanacak katkı
 * kaydı yoktur; eksik ya da bozuk nüfus bu duruma hiçbir zaman girmez.
 */
function provenEmptyResult(entry, payload, proof) {
  const data = payload.data;
  if (proof || entry.taskReferences.length !== 0 || !EMPTY_RESULT_DATA[entry.tool] || !data || typeof data !== 'object'
    || payload.complete !== true || payload.truncated === true || payload.totalCount !== 0 || payload.returnedCount !== 0
    || payload.entity != null) return false;
  const filters = data.filters;
  if (!filters || typeof filters !== 'object') return false;
  if (entry.tool !== 'rota_project_search' && (filters.projectId != null || filters.wbsId != null || filters.personSicil != null
    || filters.teamLevel != null || !['any', 'me'].includes(filters.assignee))) return false;
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
  const projectList = entry.tool === 'rota_project_search' ? data?.matches : entry.tool === 'rota_portfolio_summary' ? data?.projects : null;
  if (projectList !== null) {
    // Görev nüfusu boş projeleri içermez; proje sonucu bütün eşleşen projelerin nüfusunu taşımalıdır.
    if (!proof) {
      if (payload.complete !== true || payload.truncated === true || !Array.isArray(projectList)
        || projectList.length !== payload.totalCount || !projectList.every(isProjectRow)) return null;
      projectIds.push(...projectList.map(row => canonicalActualId(row.projectId)).filter(id => !projectIds.includes(id)));
    } else if (!Number.isSafeInteger(payload.totalCount) || proof.projectIds.length !== payload.totalCount) return null;
  }
  if (!projectIds.length) return provenEmptyResult(entry, payload, proof) ? { projectIds: [], identities: false } : null;
  if (projectList !== null) {
    // Canlı arama/portföy kısmi projeleri de döndürür: gösterilmeyen proje yalnızca görünürlük, düzeyi
    // gösterilen proje (eşleşme, aday ya da portföy satırı) o düzeyden düşük olmayan güncel erişim ister.
    // Verisi çıkarılmış kayıt gösterilen düzeyleri taşımaz: önceki gibi tam erişim istenir.
    if (!Array.isArray(projectList)) return { projectIds, fullProjects: true, identities: true };
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
  // Sorumlusuz süzgeci canlı sorguda her görev için kimlik tabanı ister (gruplamadan bağımsız).
  const unassignedFilter = data.filters?.assignee === 'unassigned';
  if (entry.tool === 'rota_task_search' || entry.tool === 'rota_task_detail') {
    const identityTaskIds = savedIdentityTasks(entry.tool === 'rota_task_search' ? data.tasks : [data.task], auth, permitted);
    if (!identityTaskIds) return null;
    return { projectIds, identities: personHidden || unassignedFilter, identityTaskIds,
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
    || !Number.isSafeInteger(data.unassignedOpenTasks) || data.unassignedOpenTasks < 0) return null;
  const peopleHidden = data.people.some((row) => !permitted.has(Number(row.sicil)));
  return { projectIds, identities: personHidden || truncated || peopleHidden || data.unassignedOpenTasks > 0 };
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
