import { normalizeRecurrenceRule } from '../../scheduling/recurrence/index.js';

const TASK_STATUSES = new Set(['planned', 'in-progress', 'done']);
const TASK_PRIORITIES = new Set(['low', 'medium', 'high', 'critical', 'normal']);
const DEPENDENCY_LAG_UNITS = new Set(['day', 'week', 'month']);
const SQL_INT_MIN = -2147483648;
const SQL_INT_MAX = 2147483647;
const DECIMAL_10_2_MAX = 99999999.99;
const DECIMAL_12_2_MAX = 9999999999.99;
const DECIMAL_19_4_MAX = 999999999999999.9999;
const DECIMAL_TEXT_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function issue(code, path, message, details = null) {
  return { code, path, message, details };
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function hasOwn(value, field) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
}

function isValidIsoDate(value) {
  const normalized = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const [year, month, day] = normalized.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function numericValue(value) {
  if (value == null || value === '') {
    return { present: false, valid: true, value: null };
  }
  if (typeof value === 'number') {
    return { present: true, valid: Number.isFinite(value), value };
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized || !DECIMAL_TEXT_PATTERN.test(normalized)) {
      return { present: true, valid: false, value: null };
    }
    const parsed = Number(normalized);
    return { present: true, valid: Number.isFinite(parsed), value: parsed };
  }
  return { present: true, valid: false, value: null };
}

function validateNumber(value, path, label, {
  min = -Infinity,
  max = Infinity,
  integer = false,
  invalidCode = 'TASK_NUMBER_INVALID',
  rangeCode = 'TASK_NUMBER_OUT_OF_RANGE'
} = {}) {
  const numeric = numericValue(value);
  if (!numeric.present) return null;
  if (!numeric.valid || (integer && !Number.isInteger(numeric.value))) {
    return issue(invalidCode, path, `${label} geçerli bir sayı olmalıdır.`);
  }
  if (numeric.value < min || numeric.value > max) {
    return issue(rangeCode, path, `${label} izin verilen aralıkta olmalıdır.`);
  }
  return null;
}

function validateOptionalString(value, path, label, { allowNull = true } = {}) {
  if (value === undefined || (allowNull && value === null)) return null;
  if (typeof value !== 'string') {
    return issue('TASK_TEXT_INVALID', path, `${label} metin olmalıdır.`);
  }
  return null;
}

function validateProjectDates(changes) {
  for (let index = 0; index < (changes.projectUpserts || []).length; index += 1) {
    const value = changes.projectUpserts[index]?.dataDate;
    if (value != null && value !== '' && typeof value !== 'string') {
      return issue(
        'PROJECT_DATA_DATE_INVALID',
        `projectUpserts[${index}].dataDate`,
        'Proje veri tarihi geçerli bir YYYY-MM-DD tarihi olmalıdır.'
      );
    }
    if (text(value) && !isValidIsoDate(value)) {
      return issue(
        'PROJECT_DATA_DATE_INVALID',
        `projectUpserts[${index}].dataDate`,
        'Proje veri tarihi geçerli bir YYYY-MM-DD tarihi olmalıdır.'
      );
    }
  }
  return null;
}

function validateTaskScalars(changes) {
  const dateFields = [
    ['plannedStart', 'Planlanan başlangıç'],
    ['plannedFinish', 'Planlanan bitiş'],
    ['targetFinish', 'Hedef bitiş'],
    ['actualStart', 'Gerçek başlangıç'],
    ['actualFinish', 'Gerçek bitiş']
  ];
  const numericFields = [
    ['plannedDurationDays', 'Planlanan süre', 0, DECIMAL_10_2_MAX],
    ['remainingDurationDays', 'Kalan süre', 0, DECIMAL_10_2_MAX],
    ['plannedHours', 'Planlanan iş gücü', -DECIMAL_12_2_MAX, DECIMAL_12_2_MAX],
    ['actualHours', 'Gerçekleşen iş gücü', -DECIMAL_12_2_MAX, DECIMAL_12_2_MAX],
    ['budget', 'Bütçe', -DECIMAL_19_4_MAX, DECIMAL_19_4_MAX],
    ['spent', 'Harcama', -DECIMAL_19_4_MAX, DECIMAL_19_4_MAX]
  ];

  for (let index = 0; index < (changes.taskUpserts || []).length; index += 1) {
    const task = changes.taskUpserts[index];
    const basePath = `taskUpserts[${index}]`;

    if (task?.task != null && typeof task.task !== 'string') {
      return issue('TASK_TITLE_INVALID', `${basePath}.task`, 'Görev başlığı metin olmalıdır.');
    }
    if (task?.title != null && typeof task.title !== 'string') {
      return issue('TASK_TITLE_INVALID', `${basePath}.title`, 'Görev başlığı metin olmalıdır.');
    }
    const title = text(task?.task || task?.title);
    if (!title) return issue('TASK_TITLE_REQUIRED', `${basePath}.task`, 'Görev başlığı gereklidir.');
    if (title.length > 1000) {
      return issue('TASK_TITLE_TOO_LONG', `${basePath}.task`, 'Görev başlığı en fazla 1000 karakter olabilir.');
    }

    const descriptionIssue = validateOptionalString(task?.description, `${basePath}.description`, 'Görev açıklaması');
    if (descriptionIssue) return descriptionIssue;
    const keywordIssue = validateOptionalString(task?.keyword, `${basePath}.keyword`, 'Görev anahtar sözcüğü');
    if (keywordIssue) return keywordIssue;
    if (task.keyword != null && task.keyword.length > 255) {
      return issue('TASK_KEYWORD_TOO_LONG', `${basePath}.keyword`, 'Görev anahtar sözcüğü en fazla 255 karakter olabilir.');
    }

    // Tekrar kuralı RFC 5545 altkümesidir: ayrıştırılamayan bir metin kalıcı
    // kayda düşerse arayüz seriyi hiç açamaz ve kural sessizce yok sayılırdı.
    const recurrenceIssue = validateOptionalString(task?.recurrence, `${basePath}.recurrence`, 'Görev tekrar kuralı');
    if (recurrenceIssue) return recurrenceIssue;
    if (text(task.recurrence)) {
      if (text(task.recurrence).length > 400) {
        return issue('TASK_RECURRENCE_TOO_LONG', `${basePath}.recurrence`, 'Görev tekrar kuralı en fazla 400 karakter olabilir.');
      }
      if (!normalizeRecurrenceRule(task.recurrence)) {
        return issue('TASK_RECURRENCE_INVALID', `${basePath}.recurrence`, 'Görev tekrar kuralı geçerli bir RFC 5545 RRULE olmalıdır.');
      }
      if (text(task.recurrenceParentId)) {
        return issue(
          'TASK_RECURRENCE_CONFLICT',
          `${basePath}.recurrence`,
          'Bir yineleme kendi tekrar kuralını taşıyamaz; kural yalnızca seri şablonunda bulunur.'
        );
      }
    }

    if (task.status !== undefined && typeof task.status !== 'string') {
      return issue('TASK_STATUS_INVALID', `${basePath}.status`, 'Görev durumu desteklenen değerlerden biri olmalıdır.');
    }
    const status = text(task.status || 'planned');
    if (!TASK_STATUSES.has(status)) {
      return issue('TASK_STATUS_INVALID', `${basePath}.status`, 'Görev durumu desteklenen değerlerden biri olmalıdır.');
    }
    if (task.priority !== undefined && typeof task.priority !== 'string') {
      return issue('TASK_PRIORITY_INVALID', `${basePath}.priority`, 'Görev önceliği desteklenen değerlerden biri olmalıdır.');
    }
    const priority = text(task.priority || 'normal');
    if (!TASK_PRIORITIES.has(priority)) {
      return issue('TASK_PRIORITY_INVALID', `${basePath}.priority`, 'Görev önceliği desteklenen değerlerden biri olmalıdır.');
    }

    const hasIsMilestone = hasOwn(task, 'isMilestone');
    const hasMilestone = hasOwn(task, 'milestone');
    if (hasIsMilestone && typeof task.isMilestone !== 'boolean') {
      return issue('TASK_MILESTONE_FLAG_INVALID', `${basePath}.isMilestone`, 'Kilometre taşı göstergesi doğru/yanlış değeri olmalıdır.');
    }
    if (hasMilestone && typeof task.milestone !== 'boolean') {
      return issue('TASK_MILESTONE_FLAG_INVALID', `${basePath}.milestone`, 'Kilometre taşı göstergesi doğru/yanlış değeri olmalıdır.');
    }
    if (hasIsMilestone && hasMilestone && task.isMilestone !== task.milestone) {
      return issue('TASK_MILESTONE_FLAG_CONFLICT', `${basePath}.milestone`, 'Kilometre taşı göstergeleri birbiriyle çelişemez.');
    }
    const isMilestone = hasIsMilestone ? task.isMilestone : (hasMilestone ? task.milestone : false);

    for (const [field, label] of dateFields) {
      const dateTypeIssue = validateOptionalString(task[field], `${basePath}.${field}`, label);
      if (dateTypeIssue) return dateTypeIssue;
      if (text(task[field]) && !isValidIsoDate(task[field])) {
        return issue('TASK_DATE_INVALID', `${basePath}.${field}`, `${label} geçerli bir YYYY-MM-DD tarihi olmalıdır.`, { field });
      }
    }
    const plannedStart = text(task.plannedStart);
    const plannedFinish = text(task.plannedFinish);
    const actualStart = text(task.actualStart);
    const actualFinish = text(task.actualFinish);
    if (plannedStart && plannedFinish && plannedFinish < plannedStart) {
      return issue('TASK_PLANNED_RANGE_INVALID', `${basePath}.plannedFinish`, 'Planlanan bitiş başlangıçtan önce olamaz.');
    }
    if (actualFinish && !actualStart) {
      return issue('TASK_ACTUAL_START_REQUIRED', `${basePath}.actualStart`, 'Gerçek bitiş için gerçek başlangıç gereklidir.');
    }
    if (actualStart && actualFinish && actualFinish < actualStart) {
      return issue('TASK_ACTUAL_RANGE_INVALID', `${basePath}.actualFinish`, 'Gerçek bitiş başlangıçtan önce olamaz.');
    }

    for (const [field, label, min, max] of numericFields) {
      const numberIssue = validateNumber(task[field], `${basePath}.${field}`, label, { min, max });
      if (numberIssue) return numberIssue;
    }
    const progressIssue = validateNumber(task.progress, `${basePath}.progress`, 'Görev ilerlemesi', {
      min: 0,
      max: 100,
      rangeCode: 'TASK_PROGRESS_INVALID'
    });
    if (progressIssue) return progressIssue;
    const sortIssue = validateNumber(task.sortOrder, `${basePath}.sortOrder`, 'Görev sırası', {
      min: SQL_INT_MIN,
      max: SQL_INT_MAX,
      integer: true,
      invalidCode: 'TASK_SORT_ORDER_INVALID',
      rangeCode: 'TASK_SORT_ORDER_INVALID'
    });
    if (sortIssue) return sortIssue;

    const duration = numericValue(task.plannedDurationDays);
    if (isMilestone && duration.present && duration.valid && duration.value !== 0) {
      return issue('TASK_MILESTONE_DURATION_INVALID', `${basePath}.plannedDurationDays`, 'Kilometre taşı süresi sıfır olmalıdır.');
    }
  }
  return null;
}

function validateDependencyScalars(changes) {
  for (let taskIndex = 0; taskIndex < (changes.taskUpserts || []).length; taskIndex += 1) {
    const task = changes.taskUpserts[taskIndex];
    if (!Array.isArray(task?.deps)) continue;
    const predecessorIds = new Set();
    for (let dependencyIndex = 0; dependencyIndex < task.deps.length; dependencyIndex += 1) {
      const dependency = task.deps[dependencyIndex];
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) continue;
      const path = `taskUpserts[${taskIndex}].deps[${dependencyIndex}]`;
      const predecessorId = text(dependency.predecessorId);
      if (predecessorId && predecessorId === text(task.id)) {
        return issue('SELF_DEPENDENCY', `${path}.predecessorId`, 'Bir görev kendisine bağımlı olamaz.');
      }
      if (predecessorId && predecessorIds.has(predecessorId)) {
        return issue('DUPLICATE_DEPENDENCY', `${path}.predecessorId`, 'Aynı öncül görev bağımlılığı birden fazla kez eklenemez.');
      }
      if (predecessorId) predecessorIds.add(predecessorId);

      const lagDaysIssue = validateNumber(dependency.lagDays, `${path}.lagDays`, 'Bağımlılık gecikme günü', {
        min: -DECIMAL_10_2_MAX,
        max: DECIMAL_10_2_MAX,
        invalidCode: 'DEPENDENCY_LAG_INVALID',
        rangeCode: 'DEPENDENCY_LAG_INVALID'
      });
      if (lagDaysIssue) return lagDaysIssue;
      const lagValueIssue = validateNumber(dependency.lagValue, `${path}.lagValue`, 'Bağımlılık gecikme değeri', {
        min: -DECIMAL_10_2_MAX,
        max: DECIMAL_10_2_MAX,
        invalidCode: 'DEPENDENCY_LAG_INVALID',
        rangeCode: 'DEPENDENCY_LAG_INVALID'
      });
      if (lagValueIssue) return lagValueIssue;
      if (dependency.lagUnit != null && dependency.lagUnit !== '' && typeof dependency.lagUnit !== 'string') {
        return issue('DEPENDENCY_LAG_UNIT_INVALID', `${path}.lagUnit`, 'Bağımlılık gecikme birimi day, week veya month olmalıdır.');
      }
      if (text(dependency.lagUnit) && !DEPENDENCY_LAG_UNITS.has(text(dependency.lagUnit))) {
        return issue('DEPENDENCY_LAG_UNIT_INVALID', `${path}.lagUnit`, 'Bağımlılık gecikme birimi day, week veya month olmalıdır.');
      }
    }
  }
  return null;
}

export function findCommitScalarIssue(changes = {}) {
  return validateProjectDates(changes)
    || validateTaskScalars(changes)
    || validateDependencyScalars(changes);
}
