const PROJECT_COLOR_KEYS = new Set(['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);

function normalizedName(value) {
  return String(value || '').trim();
}

function comparableName(value) {
  return normalizedName(value).toLocaleLowerCase('tr-TR');
}

function normalizedProjectCode(value) {
  return normalizedName(value).toUpperCase();
}

export function normalizeProjectTags(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map(normalizedName)
    .filter(Boolean)
    .filter((value) => {
      const key = comparableName(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.localeCompare(b, 'tr'));
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function resolveCalendarId(input = {}, calendars = []) {
  const requested = String(input.calendarId || '').trim();
  return requested || calendars[0]?.id || '';
}

function validationError(issues) {
  const first = issues[0];
  return {
    ok: false,
    error: {
      kind: 'domain',
      code: first.code,
      field: first.field,
      message: first.message,
      issues
    }
  };
}

export function validateProjectCreationInput(input = {}, { projects = [], people = [], calendars = [] } = {}) {
  const issues = [];
  const name = normalizedName(input.name || input.ProjeAdi);
  const code = normalizedProjectCode(input.code || input.ProjeKodu);
  const calendarId = resolveCalendarId(input, calendars);

  if (!name) {
    issues.push({ code: 'PROJECT_NAME_REQUIRED', field: 'name', message: 'Proje adı boş bırakılamaz.' });
  } else if (projects.some((project) => comparableName(project.name) === comparableName(name))) {
    issues.push({ code: 'PROJECT_NAME_DUPLICATE', field: 'name', message: 'Bu adda bir proje zaten bulunuyor.' });
  }

  if (code && projects.some((project) => normalizedProjectCode(project.code || project.ProjeKodu) === code)) {
    issues.push({ code: 'PROJECT_CODE_DUPLICATE', field: 'code', message: 'Bu proje kodu zaten kullanılıyor.' });
  }

  if (!input.leadId) {
    issues.push({ code: 'PROJECT_LEAD_REQUIRED', field: 'leadId', message: 'Proje sorumlusu seçilmelidir.' });
  } else if (!people.some((person) => person.id === input.leadId)) {
    issues.push({ code: 'PROJECT_LEAD_NOT_FOUND', field: 'leadId', message: 'Seçilen proje sorumlusu bulunamadı.' });
  }

  if (!calendarId || !calendars.some((calendar) => calendar.id === calendarId)) {
    issues.push({ code: 'PROJECT_CALENDAR_NOT_FOUND', field: 'calendarId', message: 'Kurumsal çalışma takvimi bulunamadı.' });
  }

  if (!input.dataDate) {
    issues.push({ code: 'PROJECT_DATA_DATE_REQUIRED', field: 'dataDate', message: 'Veri tarihi seçilmelidir.' });
  } else if (!isValidIsoDate(input.dataDate)) {
    issues.push({ code: 'PROJECT_DATA_DATE_INVALID', field: 'dataDate', message: 'Veri tarihi geçerli bir tarih olmalıdır.' });
  }

  if (!PROJECT_COLOR_KEYS.has(input.color)) {
    issues.push({ code: 'PROJECT_COLOR_INVALID', field: 'color', message: 'Geçerli bir proje rengi seçilmelidir.' });
  }

  return issues;
}

function nextRootCode(wbs = []) {
  const max = wbs
    .filter((node) => node.parentId == null)
    .reduce((current, node) => {
      const numeric = Number.parseInt(String(node.code || '').split('.').at(0), 10);
      return Number.isFinite(numeric) ? Math.max(current, numeric) : current;
    }, 0);
  return String(max + 1);
}

export function prepareProjectCreation(input, context = {}, ids = {}) {
  const projects = context.projects || [];
  const people = context.people || [];
  const calendars = context.calendars || [];
  const wbs = context.wbs || [];
  const calendarId = resolveCalendarId(input, calendars);
  const normalizedInput = {
    ...input,
    name: normalizedName(input.name || input.ProjeAdi),
    code: normalizedProjectCode(input.code || input.ProjeKodu),
    calendarId
  };
  const issues = validateProjectCreationInput(normalizedInput, { projects, people, calendars });

  if (issues.length) return validationError(issues);

  const lead = people.find((person) => person.id === normalizedInput.leadId) || null;
  const project = {
    id: ids.projectId,
    code: normalizedInput.code,
    name: normalizedInput.name,
    source: normalizedInput.source || 'manual',
    color: normalizedInput.color,
    leadId: normalizedInput.leadId,
    lead: lead?.name || '',
    calendarId,
    dataDate: normalizedInput.dataDate,
    tags: normalizeProjectTags(normalizedInput.tags)
  };
  const rootWbs = {
    id: ids.rootWbsId,
    projectId: project.id,
    parentId: null,
    code: nextRootCode(wbs),
    name: project.name,
    sortOrder: 1
  };

  return {
    ok: true,
    project,
    rootWbs,
    changes: {
      projectUpserts: [project],
      wbsUpserts: [rootWbs]
    }
  };
}

export function prepareProjectUpdate(projectId, input, context = {}) {
  const projects = context.projects || [];
  const people = context.people || [];
  const calendars = context.calendars || [];
  const existing = projects.find((project) => project.id === projectId) || null;

  if (!existing) {
    return validationError([{ code: 'PROJECT_NOT_FOUND', field: 'projectId', message: 'Güncellenecek proje bulunamadı.' }]);
  }

  const calendarId = existing.calendarId || resolveCalendarId(input, calendars);
  const normalizedInput = {
    ...input,
    name: normalizedName(input.name === undefined ? existing.name : input.name),
    code: normalizedProjectCode(input.code === undefined ? existing.code : input.code),
    source: input.source === undefined ? existing.source : input.source,
    leadId: input.leadId === undefined ? existing.leadId : input.leadId,
    dataDate: input.dataDate === undefined ? existing.dataDate : input.dataDate,
    color: input.color === undefined ? existing.color : input.color,
    calendarId
  };
  const issues = validateProjectCreationInput(normalizedInput, {
    projects: projects.filter((project) => project.id !== projectId),
    people,
    calendars
  }).filter((issue) => {
    if (input.dataDate === undefined && !existing.dataDate && issue.code === 'PROJECT_DATA_DATE_REQUIRED') return false;
    if (input.leadId === undefined && !existing.leadId && issue.code === 'PROJECT_LEAD_REQUIRED') return false;
    return true;
  });

  if (issues.length) return validationError(issues);

  const lead = people.find((person) => person.id === normalizedInput.leadId) || null;
  return {
    ok: true,
    project: {
      ...existing,
      code: normalizedInput.code,
      name: normalizedInput.name,
      source: normalizedInput.source || existing.source || 'manual',
      color: normalizedInput.color,
      leadId: normalizedInput.leadId,
      lead: lead?.name || (input.leadId === undefined ? existing.lead || '' : ''),
      calendarId,
      dataDate: normalizedInput.dataDate,
      tags: normalizeProjectTags(normalizedInput.tags === undefined ? existing.tags : normalizedInput.tags)
    }
  };
}

export function prepareProjectUpdateChanges(projectId, input, context = {}) {
  const prepared = prepareProjectUpdate(projectId, input, context);
  if (!prepared.ok) return prepared;

  const projects = context.projects || [];
  const tasks = context.tasks || [];
  const wbs = context.wbs || [];
  const existing = projects.find((project) => project.id === projectId);
  const canonicalTags = new Map(
    (prepared.project.tags || []).map((tag) => [comparableName(tag), tag])
  );

  const taskUpserts = tasks
    .filter((task) => task.projectId === projectId)
    .map((task) => {
      const nameChanged = task.proje !== prepared.project.name;
      const codeChanged = (task.projectCode || '') !== (prepared.project.code || '');
      const colorChanged = task.color !== prepared.project.color;
      const canonicalKeyword = canonicalTags.get(comparableName(task.keyword));
      const keywordChanged = Boolean(canonicalKeyword) && task.keyword !== canonicalKeyword;

      if (!nameChanged && !codeChanged && !colorChanged && !keywordChanged) return null;

      const nextTask = {
        ...task,
        proje: prepared.project.name,
        projectCode: prepared.project.code || '',
        color: prepared.project.color
      };
      if (keywordChanged) nextTask.keyword = canonicalKeyword;
      return nextTask;
    })
    .filter(Boolean);

  const rootWbs = wbs.find((node) => node.projectId === projectId && node.parentId == null) || null;
  const projectNameChanged = existing.name !== prepared.project.name;
  const rootTracksProjectName = rootWbs?.name === existing.name;
  const wbsUpserts = projectNameChanged && rootTracksProjectName
    ? [{ ...rootWbs, name: prepared.project.name }]
    : [];

  return {
    ...prepared,
    changes: {
      projectUpserts: [prepared.project],
      taskUpserts,
      wbsUpserts
    }
  };
}
