function issue(code, path, message) {
  return { code, path, message };
}

export function findNestedCommitCollectionIssue(changes = {}) {
  for (let index = 0; index < (changes.projectUpserts || []).length; index += 1) {
    const tags = changes.projectUpserts[index]?.tags;
    if (tags !== undefined && !Array.isArray(tags)) {
      return issue(
        'PROJECT_TAGS_NOT_ARRAY',
        `projectUpserts[${index}].tags`,
        'Proje etiketleri dizi olmalıdır.'
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
    const assigneeIds = changes.taskUpserts[index]?.assigneeIds;
    if (assigneeIds !== undefined && !Array.isArray(assigneeIds)) {
      return issue(
        'TASK_ASSIGNEES_NOT_ARRAY',
        `taskUpserts[${index}].assigneeIds`,
        'Görev sorumluları dizi olmalıdır.'
      );
    }
  }

  return null;
}
