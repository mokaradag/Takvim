import { canonicalActualIdOrValue, isActualId } from '../../domain/identity/actualId.js';

const COLLECTIONS = Object.freeze([
  'projectUpserts',
  'projectDeletes',
  'wbsUpserts',
  'wbsDeletes',
  'taskUpserts',
  'taskDeletes'
]);
const UPSERTS = Object.freeze([
  ['projectUpserts', 'projectDeletes', 'project'],
  ['wbsUpserts', 'wbsDeletes', 'wbs'],
  ['taskUpserts', 'taskDeletes', 'task']
]);
const PROJECT_COLORS = new Set(['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);
const DEPENDENCY_TYPES = new Set(['FS', 'SS', 'FF', 'SF']);

/**
 * Tek bir değişiklik kümesinin KOLEKSİYON başına en fazla girdi sayısı.
 *
 * Değişiklik kümesinin BÜYÜKLÜĞÜ hiçbir yerde sınırlanmıyordu: `commitChanges`
 * bütün küme için TEK bir SERIALIZABLE işlem açar ve doğrulama katmanları
 * koleksiyonları girdi başına birer SQL gidiş-dönüşüyle dolaşır (görev başına
 * yaklaşık on beş sorgu). Sınırsız bir istek, aralık kilitlerini tutarken
 * yüzbinlerce sıralı sorguya dönüşüyor; `MERGEN_ROTA_DB_REQUEST_TIMEOUT_MS`
 * SORGU başına uygulandığı için hiç devreye girmiyor ve tek bir istek bütün
 * kurulumun yazmalarını (yazma başladıktan sonra okumalarını da) durduruyordu.
 *
 * Sınır, arayüzün GERÇEKTEN ürettiği en büyük partiden türetilir: yineleme
 * serisi üretimi (`MAX_RECURRENCE_OCCURRENCES = 400`) tek `task/add-many`
 * eylemiyle gelir. Kat, meşru toplu işlemlere yer bırakır.
 */
export const MAX_COMMIT_COLLECTION_ENTRIES = 1000;

/** Tek bir değişiklik kümesindeki TOPLAM girdi sayısı sınırı. */
export const MAX_COMMIT_TOTAL_ENTRIES = 2000;

/**
 * GÖREV BAŞINA en fazla bağımlılık sayısı.
 *
 * Yukarıdaki iki sınır yalnızca ÜST DÜZEY dizileri bağlar. Tek bir `taskUpserts`
 * girdisi sınırsız bir `deps` dizisi taşıyabiliyordu; işlem hattı her bağımlılığı
 * SERIALIZABLE işlemin İÇİNDE öncül aramasına ve ayrı bir eklemeye açtığı için,
 * kimliği doğrulanmış tek bir yazar 8 MiB gövdeye sığan binlerce bağımlılıkla
 * aynı sorgu fırtınasını ve kilit tükenmesini yeniden üretebiliyordu — üst düzey
 * sınırın engellemeyi amaçladığı yolun ta kendisi.
 */
export const MAX_COMMIT_TASK_DEPENDENCIES = 500;

/** Değişiklik kümesindeki TOPLAM iç içe bağımlılık sayısı sınırı. */
export const MAX_COMMIT_TOTAL_DEPENDENCIES = 5000;

/**
 * GÖREV BAŞINA en fazla sorumlu sayısı.
 *
 * `deps` ile BİREBİR aynı açık: `assigneeIds` sınırsızdı ve `ensurePeople`
 * normalleştirilmiş her sicil için SERIALIZABLE işlemin İÇİNDE ayrı bir dizin
 * sorgusu çalıştırır. Tek bir geçerli görev, 8 MiB gövde sınırına sığacak
 * biçimde yüz binlerce geçerli sicil taşıyabiliyor; kimliği doğrulanmış bir
 * yazar böylece üst düzey kardinalite savunmasını atlayarak aynı sorgu
 * fırtınasını ve kilit tükenmesini üretebiliyordu.
 *
 * Sınır, en büyük meşru atamanın çok üstünde tutulur: arayüz bir göreve tek
 * seferde bir ekip atar, yüzlerce kişi değil.
 */
export const MAX_COMMIT_TASK_ASSIGNEES = 200;

/** Değişiklik kümesindeki TOPLAM iç içe sorumlu sayısı sınırı. */
export const MAX_COMMIT_TOTAL_ASSIGNEES = 5000;

/**
 * PROJE BAŞINA en fazla etiket (ve yeniden adlandırma) sayısı.
 *
 * `deps` ve `assigneeIds` ile aynı amplifikasyon: `reconcileProjectTags`
 * kataloğu önce siler, sonra kanonik etiket başına AYRI bir ekleme sorgusu
 * çalıştırır ve yeniden adlandırmalar görev/şablon yayılımını tetikler — hepsi
 * SERIALIZABLE commit işleminin içinde. Sınırsız bir katalog, 8 MiB gövdeye
 * sığan on binlerce kısa etiketle kilitleri tutan sıralı bir sorgu fırtınası
 * üretiyor ve üst düzey kardinalite savunmasını atlıyordu.
 *
 * Sınır meşru kullanımın çok üstündedir: bir proje onlarca etiket taşır.
 */
export const MAX_COMMIT_PROJECT_TAGS = 500;

/** Değişiklik kümesindeki TOPLAM iç içe etiket girdisi sınırı. */
export const MAX_COMMIT_TOTAL_TAGS = 5000;

function issue(code, path, message, details = null) {
  return { code, path, message, details };
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function canonicalUuid(value) {
  return canonicalActualIdOrValue(value == null || value === '' ? value : text(value));
}

function mapCollection(value, mapper) {
  if (value === undefined) return value;
  return Array.isArray(value) ? value.map(mapper) : value;
}

function canonicalDelete(value) {
  return typeof value === 'string'
    ? canonicalUuid(value)
    : { ...value, id: canonicalUuid(value?.id) };
}

export function canonicalizeCommitChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return changes;
  return {
    ...changes,
    projectUpserts: mapCollection(changes.projectUpserts, (project) => ({
      ...project,
      id: canonicalUuid(project?.id),
      calendarId: canonicalUuid(project?.calendarId)
    })),
    projectDeletes: mapCollection(changes.projectDeletes, canonicalDelete),
    wbsUpserts: mapCollection(changes.wbsUpserts, (node) => ({
      ...node,
      id: canonicalUuid(node?.id),
      projectId: canonicalUuid(node?.projectId),
      parentId: canonicalUuid(node?.parentId)
    })),
    wbsDeletes: mapCollection(changes.wbsDeletes, canonicalDelete),
    taskUpserts: mapCollection(changes.taskUpserts, (task) => ({
      ...task,
      id: canonicalUuid(task?.id),
      projectId: canonicalUuid(task?.projectId),
      wbsId: canonicalUuid(task?.wbsId),
      calendarId: canonicalUuid(task?.calendarId),
      // Seri şablonu kimliği de kanonikleştirilir: yalnızca harf büyüklüğü
      // farkı yüzünden şablon bulunamadı hatası alınmamalıdır.
      recurrenceParentId: canonicalUuid(task?.recurrenceParentId),
      deps: Array.isArray(task?.deps) ? task.deps.map((dependency) => ({
        ...dependency,
        id: canonicalUuid(dependency?.id),
        predecessorId: canonicalUuid(dependency?.predecessorId)
      })) : task?.deps
    })),
    taskDeletes: mapCollection(changes.taskDeletes, canonicalDelete)
  };
}

function entryId(value) {
  return canonicalUuid(text(typeof value === 'string' ? value : value?.id));
}

function validateEntries(changes, collection) {
  const values = changes[collection] || [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (collection.endsWith('Deletes')) {
      if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))) {
        return issue('CHANGE_ENTRY_INVALID', `${collection}[${index}]`, 'Silme kayıtları kimlik metni veya kimlik/sürüm nesnesi olmalıdır.');
      }
    } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return issue('CHANGE_ENTRY_INVALID', `${collection}[${index}]`, 'Güncelleme kayıtları nesne olmalıdır.');
    }
    if (!entryId(value)) {
      return issue('CHANGE_ID_REQUIRED', `${collection}[${index}].id`, 'Her değişiklik kaydı için kimlik gereklidir.');
    }
  }
  return null;
}

function validateIdentitySets(changes, upsertCollection, deleteCollection, entityName) {
  const upsertIds = new Set();
  for (let index = 0; index < (changes[upsertCollection] || []).length; index += 1) {
    const id = entryId(changes[upsertCollection][index]);
    if (upsertIds.has(id)) {
      return issue('DUPLICATE_UPSERT', `${upsertCollection}[${index}].id`, `Aynı ${entityName} kimliği bir değişiklik kümesinde birden fazla kez güncellenemez.`, { id });
    }
    upsertIds.add(id);
  }

  const deleteIds = new Set();
  for (let index = 0; index < (changes[deleteCollection] || []).length; index += 1) {
    const id = entryId(changes[deleteCollection][index]);
    if (deleteIds.has(id)) {
      return issue('DUPLICATE_DELETE', `${deleteCollection}[${index}].id`, `Aynı ${entityName} kimliği bir değişiklik kümesinde birden fazla kez silinemez.`, { id });
    }
    if (upsertIds.has(id)) {
      return issue('UPSERT_DELETE_CONFLICT', `${deleteCollection}[${index}].id`, `Aynı ${entityName} tek değişiklik kümesinde hem güncellenip hem silinemez.`, { id });
    }
    deleteIds.add(id);
  }
  return null;
}

function validateUuid(value, path, label, { required = false, entity = false } = {}) {
  const normalized = text(value);
  if (!normalized) {
    return required
      ? issue(entity ? 'CHANGE_ID_REQUIRED' : 'CHANGE_REFERENCE_REQUIRED', path, `${label} gereklidir.`)
      : null;
  }
  if (!isActualId(normalized)) {
    return issue(entity ? 'CHANGE_ID_INVALID' : 'CHANGE_REFERENCE_INVALID', path, `${label} geçerli UUID olmalıdır.`);
  }
  return null;
}

function validateUuidReferences(changes) {
  for (const collection of COLLECTIONS) {
    for (let index = 0; index < (changes[collection] || []).length; index += 1) {
      const value = changes[collection][index];
      const idIssue = validateUuid(entryId(value), `${collection}[${index}].id`, 'Değişiklik kimliği', { required: true, entity: true });
      if (idIssue) return idIssue;
    }
  }

  for (let index = 0; index < (changes.projectUpserts || []).length; index += 1) {
    const project = changes.projectUpserts[index];
    const calendarIssue = validateUuid(project.calendarId, `projectUpserts[${index}].calendarId`, 'Proje takvim kimliği', { required: true });
    if (calendarIssue) return calendarIssue;
  }

  for (let index = 0; index < (changes.wbsUpserts || []).length; index += 1) {
    const node = changes.wbsUpserts[index];
    const projectIssue = validateUuid(node.projectId, `wbsUpserts[${index}].projectId`, 'WBS proje kimliği', { required: true });
    if (projectIssue) return projectIssue;
    const parentIssue = validateUuid(node.parentId, `wbsUpserts[${index}].parentId`, 'Üst WBS kimliği');
    if (parentIssue) return parentIssue;
  }

  for (let taskIndex = 0; taskIndex < (changes.taskUpserts || []).length; taskIndex += 1) {
    const task = changes.taskUpserts[taskIndex];
    const projectIssue = validateUuid(task.projectId, `taskUpserts[${taskIndex}].projectId`, 'Görev proje kimliği', { required: true });
    if (projectIssue) return projectIssue;
    const wbsIssue = validateUuid(task.wbsId, `taskUpserts[${taskIndex}].wbsId`, 'Görev WBS kimliği');
    if (wbsIssue) return wbsIssue;
    const calendarIssue = validateUuid(task.calendarId, `taskUpserts[${taskIndex}].calendarId`, 'Görev takvim kimliği');
    if (calendarIssue) return calendarIssue;
    if (!Array.isArray(task.deps)) continue;
    for (let dependencyIndex = 0; dependencyIndex < task.deps.length; dependencyIndex += 1) {
      const dependencyIssue = validateUuid(
        task.deps[dependencyIndex]?.predecessorId,
        `taskUpserts[${taskIndex}].deps[${dependencyIndex}].predecessorId`,
        'Öncül görev kimliği',
        { required: true }
      );
      if (dependencyIssue) return dependencyIssue;
    }
  }
  return null;
}

function validateProjectCreates(changes) {
  for (let index = 0; index < (changes.projectUpserts || []).length; index += 1) {
    const project = changes.projectUpserts[index];
    if (text(project.version)) continue;
    if (text(project.source || project.sourceType || 'manual').toLowerCase() !== 'manual') {
      return issue('CORPORATE_PROJECT_CREATE_FORBIDDEN', `projectUpserts[${index}].source`, 'Kurumsal projeler istemci değişiklik kümesiyle oluşturulamaz.');
    }
    const required = [
      ['name', project.name, 'Proje adı gereklidir.'],
      ['leadId', project.leadId, 'Proje sorumlusu gereklidir.'],
      ['calendarId', project.calendarId, 'Etkin çalışma takvimi gereklidir.'],
      ['color', project.color, 'Proje rengi gereklidir.']
    ];
    for (const [field, value, message] of required) {
      if (!text(value)) return issue('PROJECT_CREATE_FIELD_REQUIRED', `projectUpserts[${index}].${field}`, message, { field });
    }
    // Veri tarihi (ilerleme kesim tarihi) isteğe bağlıdır: proje planlama kesimi
    // tanımlanmadan da açılabilir. Verildiğinde biçimi doğrulanır.
    if (text(project.dataDate) && !/^\d{4}-\d{2}-\d{2}$/.test(text(project.dataDate))) {
      return issue('PROJECT_DATA_DATE_INVALID', `projectUpserts[${index}].dataDate`, 'Proje veri tarihi YYYY-MM-DD biçiminde olmalıdır.');
    }
    if (!PROJECT_COLORS.has(text(project.color))) {
      return issue('PROJECT_COLOR_INVALID', `projectUpserts[${index}].color`, 'Geçerli bir proje rengi seçilmelidir.');
    }
  }
  return null;
}

function validateTaskDependencies(changes) {
  for (let taskIndex = 0; taskIndex < (changes.taskUpserts || []).length; taskIndex += 1) {
    const task = changes.taskUpserts[taskIndex];
    if (task.deps !== undefined && !Array.isArray(task.deps)) {
      return issue('TASK_DEPENDENCIES_NOT_ARRAY', `taskUpserts[${taskIndex}].deps`, 'Görev bağımlılıkları dizi olmalıdır.');
    }
    for (let dependencyIndex = 0; dependencyIndex < (task.deps || []).length; dependencyIndex += 1) {
      const dependency = task.deps[dependencyIndex];
      const path = `taskUpserts[${taskIndex}].deps[${dependencyIndex}]`;
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
        return issue('TASK_DEPENDENCY_INVALID', path, 'Görev bağımlılığı nesne olmalıdır.');
      }
      if (!text(dependency.predecessorId)) {
        return issue('DEPENDENCY_PREDECESSOR_REQUIRED', `${path}.predecessorId`, 'Bağımlılık için öncül görev kimliği gereklidir.');
      }
      if (!DEPENDENCY_TYPES.has(text(dependency.type))) {
        return issue('DEPENDENCY_TYPE_INVALID', `${path}.type`, 'Bağımlılık türü FS, SS, FF veya SF olmalıdır.');
      }
    }
  }
  return null;
}

export function findCommitChangeIssue(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return issue('CHANGE_SET_INVALID', 'changes', 'Değişiklik kümesi nesne olmalıdır.');
  }

  // KARDİNALİTE önce denetlenir: girdi başına doğrulama yapan aşağıdaki
  // döngülerin kendisi de aşırı büyük bir kümede pahalıdır.
  let totalEntries = 0;
  for (const collection of COLLECTIONS) {
    if (changes[collection] !== undefined && !Array.isArray(changes[collection])) {
      return issue('CHANGE_COLLECTION_NOT_ARRAY', collection, `${collection} dizi olmalıdır.`);
    }
    const size = Array.isArray(changes[collection]) ? changes[collection].length : 0;
    if (size > MAX_COMMIT_COLLECTION_ENTRIES) {
      return issue(
        'CHANGE_COLLECTION_TOO_LARGE',
        collection,
        `${collection} tek seferde en fazla ${MAX_COMMIT_COLLECTION_ENTRIES} girdi taşıyabilir.`,
        { size, limit: MAX_COMMIT_COLLECTION_ENTRIES }
      );
    }
    totalEntries += size;
  }
  if (totalEntries > MAX_COMMIT_TOTAL_ENTRIES) {
    return issue(
      'CHANGE_SET_TOO_LARGE',
      'changes',
      `Bir değişiklik kümesi tek seferde en fazla ${MAX_COMMIT_TOTAL_ENTRIES} girdi taşıyabilir.`,
      { size: totalEntries, limit: MAX_COMMIT_TOTAL_ENTRIES }
    );
  }

  // İÇ İÇE kardinalite de üst düzey sınırlarla birlikte, derin doğrulama ve
  // işlem açılmadan ÖNCE bağlanır (bkz. MAX_COMMIT_TASK_DEPENDENCIES).
  const taskUpserts = Array.isArray(changes.taskUpserts) ? changes.taskUpserts : [];
  let totalDependencies = 0;
  let totalAssignees = 0;
  for (let taskIndex = 0; taskIndex < taskUpserts.length; taskIndex += 1) {
    const dependencies = taskUpserts[taskIndex]?.deps;
    if (Array.isArray(dependencies)) {
      if (dependencies.length > MAX_COMMIT_TASK_DEPENDENCIES) {
        return issue(
          'TASK_DEPENDENCIES_TOO_LARGE',
          `taskUpserts[${taskIndex}].deps`,
          `Bir görev tek seferde en fazla ${MAX_COMMIT_TASK_DEPENDENCIES} bağımlılık taşıyabilir.`,
          { size: dependencies.length, limit: MAX_COMMIT_TASK_DEPENDENCIES }
        );
      }
      totalDependencies += dependencies.length;
    }
    // Sorumlular da AYNI bütçeye girer: her sicil işlem içinde bir dizin
    // sorgusu açar (bkz. MAX_COMMIT_TASK_ASSIGNEES).
    const assignees = taskUpserts[taskIndex]?.assigneeIds;
    if (Array.isArray(assignees)) {
      if (assignees.length > MAX_COMMIT_TASK_ASSIGNEES) {
        return issue(
          'TASK_ASSIGNEES_TOO_LARGE',
          `taskUpserts[${taskIndex}].assigneeIds`,
          `Bir görev tek seferde en fazla ${MAX_COMMIT_TASK_ASSIGNEES} sorumlu taşıyabilir.`,
          { size: assignees.length, limit: MAX_COMMIT_TASK_ASSIGNEES }
        );
      }
      totalAssignees += assignees.length;
    }
  }
  if (totalDependencies > MAX_COMMIT_TOTAL_DEPENDENCIES) {
    return issue(
      'CHANGE_SET_DEPENDENCIES_TOO_LARGE',
      'changes',
      `Bir değişiklik kümesi tek seferde en fazla ${MAX_COMMIT_TOTAL_DEPENDENCIES} bağımlılık taşıyabilir.`,
      { size: totalDependencies, limit: MAX_COMMIT_TOTAL_DEPENDENCIES }
    );
  }
  if (totalAssignees > MAX_COMMIT_TOTAL_ASSIGNEES) {
    return issue(
      'CHANGE_SET_ASSIGNEES_TOO_LARGE',
      'changes',
      `Bir değişiklik kümesi tek seferde en fazla ${MAX_COMMIT_TOTAL_ASSIGNEES} sorumlu taşıyabilir.`,
      { size: totalAssignees, limit: MAX_COMMIT_TOTAL_ASSIGNEES }
    );
  }

  // Proje etiket kataloğu da aynı bütçeye girer: her etiket işlem içinde ayrı
  // bir ekleme sorgusu açar (bkz. MAX_COMMIT_PROJECT_TAGS).
  const projectUpserts = Array.isArray(changes.projectUpserts) ? changes.projectUpserts : [];
  let totalTags = 0;
  for (let projectIndex = 0; projectIndex < projectUpserts.length; projectIndex += 1) {
    for (const field of ['tags', 'tagRenames']) {
      const entries = projectUpserts[projectIndex]?.[field];
      if (!Array.isArray(entries)) continue;
      if (entries.length > MAX_COMMIT_PROJECT_TAGS) {
        return issue(
          'PROJECT_TAGS_TOO_LARGE',
          `projectUpserts[${projectIndex}].${field}`,
          `Bir proje tek seferde en fazla ${MAX_COMMIT_PROJECT_TAGS} etiket girdisi taşıyabilir.`,
          { size: entries.length, limit: MAX_COMMIT_PROJECT_TAGS }
        );
      }
      totalTags += entries.length;
    }
  }
  if (totalTags > MAX_COMMIT_TOTAL_TAGS) {
    return issue(
      'CHANGE_SET_TAGS_TOO_LARGE',
      'changes',
      `Bir değişiklik kümesi tek seferde en fazla ${MAX_COMMIT_TOTAL_TAGS} etiket girdisi taşıyabilir.`,
      { size: totalTags, limit: MAX_COMMIT_TOTAL_TAGS }
    );
  }

  for (const collection of COLLECTIONS) {
    const entryIssue = validateEntries(changes, collection);
    if (entryIssue) return entryIssue;
  }

  for (const [upserts, deletes, entityName] of UPSERTS) {
    const identityIssue = validateIdentitySets(changes, upserts, deletes, entityName);
    if (identityIssue) return identityIssue;
  }

  return validateUuidReferences(changes)
    || validateProjectCreates(changes)
    || validateTaskDependencies(changes);
}
