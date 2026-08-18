function trimString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function trimRequiredEnum(value) {
  const normalized = trimString(value);
  return typeof normalized === 'string' && !normalized ? null : normalized;
}

function emptyStringToNull(value) {
  return value === '' ? null : value;
}

function mapArray(value, mapper) {
  return Array.isArray(value) ? value.map(mapper) : value;
}

function hasOwn(value, field) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function canonicalMilestoneFields(task) {
  const hasMilestone = hasOwn(task, 'milestone');
  const hasIsMilestone = hasOwn(task, 'isMilestone');
  if (!hasMilestone && !hasIsMilestone) return {};
  if (hasMilestone && hasIsMilestone) {
    return { milestone: task.milestone, isMilestone: task.isMilestone };
  }

  const value = hasMilestone ? task.milestone : task.isMilestone;
  return { milestone: value, isMilestone: value };
}

export function canonicalizeCommitScalars(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return changes;

  return {
    ...changes,
    projectUpserts: mapArray(changes.projectUpserts, (project) => ({
      ...project,
      name: trimString(project?.name),
      code: trimString(project?.code),
      source: trimString(project?.source),
      sourceType: trimString(project?.sourceType),
      leadId: trimString(project?.leadId),
      dataDate: trimString(project?.dataDate),
      color: trimString(project?.color),
      // Etiket düz metin (eski istemci) ya da `{ name, color, icon }` olabilir;
      // her iki biçimde de yalnızca metin alanları kırpılır.
      tags: mapArray(project?.tags, (tag) => (typeof tag === 'string' || tag == null
        ? trimString(tag)
        : { ...tag, name: trimString(tag.name), color: trimString(tag.color), icon: trimString(tag.icon) }))
    })),
    wbsUpserts: mapArray(changes.wbsUpserts, (node) => ({
      ...node,
      code: trimString(node?.code),
      name: trimString(node?.name)
    })),
    taskUpserts: mapArray(changes.taskUpserts, (task) => ({
      ...task,
      ...canonicalMilestoneFields(task),
      task: trimString(task?.task),
      title: trimString(task?.title),
      keyword: trimString(task?.keyword),
      status: trimRequiredEnum(task?.status),
      priority: trimRequiredEnum(task?.priority),
      recurrenceOccurrenceDate: trimString(task?.recurrenceOccurrenceDate),
      plannedStart: trimString(task?.plannedStart),
      plannedFinish: trimString(task?.plannedFinish),
      plannedDurationDays: emptyStringToNull(task?.plannedDurationDays),
      targetFinish: trimString(task?.targetFinish),
      actualStart: trimString(task?.actualStart),
      actualFinish: trimString(task?.actualFinish),
      remainingDurationDays: emptyStringToNull(task?.remainingDurationDays),
      progress: emptyStringToNull(task?.progress),
      plannedHours: emptyStringToNull(task?.plannedHours),
      actualHours: emptyStringToNull(task?.actualHours),
      budget: emptyStringToNull(task?.budget),
      spent: emptyStringToNull(task?.spent),
      sortOrder: emptyStringToNull(task?.sortOrder),
      assigneeIds: mapArray(task?.assigneeIds, trimString),
      deps: mapArray(task?.deps, (dependency) => ({
        ...dependency,
        type: trimString(dependency?.type),
        lagDays: emptyStringToNull(dependency?.lagDays),
        lagValue: emptyStringToNull(dependency?.lagValue),
        lagUnit: trimString(dependency?.lagUnit)
      }))
    }))
  };
}
