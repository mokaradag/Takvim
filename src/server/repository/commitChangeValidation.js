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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function issue(code, path, message, details = null) {
  return { code, path, message, details };
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function canonicalUuid(value) {
  if (value == null || value === '') return value;
  const normalized = text(value);
  return UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
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
  if (!UUID_PATTERN.test(normalized)) {
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
      ['dataDate', project.dataDate, 'Proje veri tarihi gereklidir.'],
      ['color', project.color, 'Proje rengi gereklidir.']
    ];
    for (const [field, value, message] of required) {
      if (!text(value)) return issue('PROJECT_CREATE_FIELD_REQUIRED', `projectUpserts[${index}].${field}`, message, { field });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(project.dataDate))) {
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

  for (const collection of COLLECTIONS) {
    if (changes[collection] !== undefined && !Array.isArray(changes[collection])) {
      return issue('CHANGE_COLLECTION_NOT_ARRAY', collection, `${collection} dizi olmalıdır.`);
    }
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
