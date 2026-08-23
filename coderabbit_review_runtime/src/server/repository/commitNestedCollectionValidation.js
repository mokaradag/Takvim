const SQL_INT_MAX = 2147483647;

const VERSIONED_PROJECT_FIELDS = Object.freeze([
  'name',
  'code',
  'leadId',
  'dataDate',
  'color',
  'calendarId'
]);

const VERSIONED_WBS_FIELDS = Object.freeze([
  'projectId',
  'parentId',
  'code',
  'name',
  'sortOrder'
]);

const VERSIONED_TASK_FIELDS = Object.freeze([
  'projectId',
  'wbsId',
  'calendarId',
  'description',
  'keyword',
  'status',
  'priority',
  'plannedStart',
  'plannedFinish',
  'plannedDurationDays',
  'targetFinish',
  'actualStart',
  'actualFinish',
  'remainingDurationDays',
  'progress',
  'plannedHours',
  'actualHours',
  'budget',
  'spent',
  'sortOrder'
]);

function issue(code, path, message) {
  return { code, path, message };
}

function hasPersistenceVersion(value) {
  return value != null && String(value).trim() !== '';
}

function hasOwn(value, field) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function firstMissingField(value, fields) {
  return fields.find((field) => !hasOwn(value, field)) || null;
}

function versionedFieldIssue(value, fields, basePath, entityLabel, code) {
  const field = firstMissingField(value, fields);
  return field
    ? issue(code, `${basePath}.${field}`, `Güncellenen ${entityLabel} için ${field} alanı gönderilmelidir.`)
    : null;
}

function validSicil(value) {
  const normalized = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(normalized)) return false;
  const sicil = Number(normalized);
  return Number.isSafeInteger(sicil) && sicil > 0 && sicil <= SQL_INT_MAX;
}

export function findNestedCommitCollectionIssue(changes = {}) {
  for (let index = 0; index < (changes.projectUpserts || []).length; index += 1) {
    const project = changes.projectUpserts[index];
    const basePath = `projectUpserts[${index}]`;
    const tags = project?.tags;
    if (tags !== undefined && !Array.isArray(tags)) {
      return issue(
        'PROJECT_TAGS_NOT_ARRAY',
        `${basePath}.tags`,
        'Proje etiketleri dizi olmalıdır.'
      );
    }
    if (hasPersistenceVersion(project?.version) && tags === undefined) {
      return issue(
        'PROJECT_TAGS_REQUIRED_FOR_UPDATE',
        `${basePath}.tags`,
        'Güncellenen proje için etiketlerin tümü gönderilmelidir.'
      );
    }
    for (let tagIndex = 0; tagIndex < (tags || []).length; tagIndex += 1) {
      // Etiket ya düz metindir (eski istemciler) ya da `{ name, color, icon }`
      // nesnesidir; her iki durumda da adın dolu olması beklenir.
      const tag = tags[tagIndex];
      const name = typeof tag === 'string' ? tag : (tag && typeof tag === 'object' ? tag.name : null);
      if (typeof name !== 'string' || !name.trim()) {
        return issue(
          'PROJECT_TAG_INVALID',
          `${basePath}.tags[${tagIndex}]`,
          'Proje etiketi boş olmayan bir metin adı taşımalıdır.'
        );
      }
    }

    // Etiket yeniden adlandırmaları katalog yazmasıyla birlikte gelir ve canlı
    // görev satırlarına uygulanır; şekli bu yüzden sınırda doğrulanır.
    const renames = project?.tagRenames;
    if (renames !== undefined && !Array.isArray(renames)) {
      return issue(
        'PROJECT_TAG_RENAMES_NOT_ARRAY',
        `${basePath}.tagRenames`,
        'Etiket yeniden adlandırmaları dizi olmalıdır.'
      );
    }
    for (let renameIndex = 0; renameIndex < (renames || []).length; renameIndex += 1) {
      const entry = renames[renameIndex];
      const from = entry && typeof entry === 'object' ? entry.from : null;
      const to = entry && typeof entry === 'object' ? entry.to : null;
      if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) {
        return issue(
          'PROJECT_TAG_RENAME_INVALID',
          `${basePath}.tagRenames[${renameIndex}]`,
          'Etiket yeniden adlandırması dolu `from` ve `to` adları taşımalıdır.'
        );
      }
    }

    if (hasPersistenceVersion(project?.version)) {
      const fieldIssue = versionedFieldIssue(
        project,
        VERSIONED_PROJECT_FIELDS,
        basePath,
        'proje',
        'PROJECT_UPDATE_FIELD_REQUIRED'
      );
      if (fieldIssue) return fieldIssue;
    }
  }

  for (let index = 0; index < (changes.wbsUpserts || []).length; index += 1) {
    const node = changes.wbsUpserts[index];
    if (!hasPersistenceVersion(node?.version)) continue;
    const fieldIssue = versionedFieldIssue(
      node,
      VERSIONED_WBS_FIELDS,
      `wbsUpserts[${index}]`,
      'WBS kaydı',
      'WBS_UPDATE_FIELD_REQUIRED'
    );
    if (fieldIssue) return fieldIssue;
  }

  for (let index = 0; index < (changes.taskUpserts || []).length; index += 1) {
    const task = changes.taskUpserts[index];
    const basePath = `taskUpserts[${index}]`;
    const assigneeIds = task?.assigneeIds;
    if (assigneeIds !== undefined && !Array.isArray(assigneeIds)) {
      return issue(
        'TASK_ASSIGNEES_NOT_ARRAY',
        `${basePath}.assigneeIds`,
        'Görev sorumluları dizi olmalıdır.'
      );
    }
    if (hasPersistenceVersion(task?.version) && assigneeIds === undefined) {
      return issue(
        'TASK_ASSIGNEES_REQUIRED_FOR_UPDATE',
        `${basePath}.assigneeIds`,
        'Güncellenen görev için sorumluların tümü gönderilmelidir.'
      );
    }
    for (let assigneeIndex = 0; assigneeIndex < (assigneeIds || []).length; assigneeIndex += 1) {
      if (!validSicil(assigneeIds[assigneeIndex])) {
        return issue(
          'TASK_ASSIGNEE_INVALID',
          `${basePath}.assigneeIds[${assigneeIndex}]`,
          'Görev sorumlusu Sicil değeri pozitif ve geçerli bir SQL Server int olmalıdır.'
        );
      }
    }

    const dependencies = task?.deps;
    if (dependencies !== undefined && !Array.isArray(dependencies)) {
      return issue(
        'TASK_DEPENDENCIES_NOT_ARRAY',
        `${basePath}.deps`,
        'Görev bağımlılıkları dizi olmalıdır.'
      );
    }
    if (hasPersistenceVersion(task?.version) && dependencies === undefined) {
      return issue(
        'TASK_DEPENDENCIES_REQUIRED_FOR_UPDATE',
        `${basePath}.deps`,
        'Güncellenen görev için bağımlılıkların tümü gönderilmelidir.'
      );
    }

    if (hasPersistenceVersion(task?.version)) {
      if (!hasOwn(task, 'task') && !hasOwn(task, 'title')) {
        return issue(
          'TASK_UPDATE_FIELD_REQUIRED',
          `${basePath}.task`,
          'Güncellenen görev için task veya title alanı gönderilmelidir.'
        );
      }
      if (!hasOwn(task, 'isMilestone') && !hasOwn(task, 'milestone')) {
        return issue(
          'TASK_UPDATE_FIELD_REQUIRED',
          `${basePath}.isMilestone`,
          'Güncellenen görev için isMilestone veya milestone alanı gönderilmelidir.'
        );
      }
      const fieldIssue = versionedFieldIssue(
        task,
        VERSIONED_TASK_FIELDS,
        basePath,
        'görev',
        'TASK_UPDATE_FIELD_REQUIRED'
      );
      if (fieldIssue) return fieldIssue;
    }
  }

  return null;
}
