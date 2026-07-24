const SQL_INT_MAX = 2147483647;

function issue(code, path, message) {
  return { code, path, message };
}

function hasPersistenceVersion(value) {
  return value != null && String(value).trim() !== '';
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
    const tags = project?.tags;
    if (tags !== undefined && !Array.isArray(tags)) {
      return issue(
        'PROJECT_TAGS_NOT_ARRAY',
        `projectUpserts[${index}].tags`,
        'Proje etiketleri dizi olmalıdır.'
      );
    }
    if (hasPersistenceVersion(project?.version) && tags === undefined) {
      return issue(
        'PROJECT_TAGS_REQUIRED_FOR_UPDATE',
        `projectUpserts[${index}].tags`,
        'Güncellenen proje için etiketlerin tümü gönderilmelidir.'
      );
    }
    for (let tagIndex = 0; tagIndex < (tags || []).length; tagIndex += 1) {
      if (typeof tags[tagIndex] !== 'string' || !tags[tagIndex].trim()) {
        return issue(
          'PROJECT_TAG_INVALID',
          `projectUpserts[${index}].tags[${tagIndex}]`,
          'Proje etiketi boş olmayan bir metin olmalıdır.'
        );
      }
    }
  }

  for (let index = 0; index < (changes.taskUpserts || []).length; index += 1) {
    const task = changes.taskUpserts[index];
    const assigneeIds = task?.assigneeIds;
    if (assigneeIds !== undefined && !Array.isArray(assigneeIds)) {
      return issue(
        'TASK_ASSIGNEES_NOT_ARRAY',
        `taskUpserts[${index}].assigneeIds`,
        'Görev sorumluları dizi olmalıdır.'
      );
    }
    if (hasPersistenceVersion(task?.version) && assigneeIds === undefined) {
      return issue(
        'TASK_ASSIGNEES_REQUIRED_FOR_UPDATE',
        `taskUpserts[${index}].assigneeIds`,
        'Güncellenen görev için sorumluların tümü gönderilmelidir.'
      );
    }
    for (let assigneeIndex = 0; assigneeIndex < (assigneeIds || []).length; assigneeIndex += 1) {
      if (!validSicil(assigneeIds[assigneeIndex])) {
        return issue(
          'TASK_ASSIGNEE_INVALID',
          `taskUpserts[${index}].assigneeIds[${assigneeIndex}]`,
          'Görev sorumlusu Sicil değeri pozitif ve geçerli bir SQL Server int olmalıdır.'
        );
      }
    }

    const dependencies = task?.deps;
    if (dependencies !== undefined && !Array.isArray(dependencies)) {
      return issue(
        'TASK_DEPENDENCIES_NOT_ARRAY',
        `taskUpserts[${index}].deps`,
        'Görev bağımlılıkları dizi olmalıdır.'
      );
    }
    if (hasPersistenceVersion(task?.version) && dependencies === undefined) {
      return issue(
        'TASK_DEPENDENCIES_REQUIRED_FOR_UPDATE',
        `taskUpserts[${index}].deps`,
        'Güncellenen görev için bağımlılıkların tümü gönderilmelidir.'
      );
    }
  }

  return null;
}
