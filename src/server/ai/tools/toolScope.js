import 'server-only';
import { TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { parseToolArguments } from './toolArguments.js';
import { getRotaTool } from './toolRegistry.js';
import { addDays, foldText, normalizeTaskFilters } from './rota/taskFacts.js';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { clarificationReferences } from '../../../domain/ai/clarification.js';

const IDENTITY_ARGUMENTS = Object.freeze({ taskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', personSicil: 'people' });
const TASK_POPULATION_TOOLS = new Set(['rota_task_search', 'rota_task_analytics']);
/** Kimliksiz geniş nüfustan aynı görünür görev nüfusuna geçişler. */
const BROAD_FOLLOW_UPS = Object.freeze({
  rota_data_quality: ['rota_task_search', 'rota_task_analytics'],
  rota_portfolio_summary: ['rota_task_analytics']
});
/**
 * Takip çağrısına açık, sunucunun döndürdüğü görev satırı kimlikleri. Toplu
 * grup anahtarları ve aday listeleri kimlik değildir.
 */
const FOLLOW_UP_TASK_PATHS = Object.freeze({
  rota_task_search: ['tasks.*.taskId'],
  rota_dependency_inspect: ['task.taskId', 'predecessors.*.taskId', 'successors.*.taskId'],
  rota_recurrence_inspect: ['series.templateTaskId', 'series.next.*.taskId', 'series.lastCompleted.taskId',
    'series.*.templateTaskId', 'series.*.next.*.taskId', 'series.*.lastCompleted.taskId'],
  rota_activity_search: ['items.*.task.taskId'],
  rota_schedule_requests: ['items.*.task.taskId'],
  rota_assignment_requests: ['items.*.task.taskId'],
  rota_outlook_status: ['task.taskId', 'items.*.task.taskId'],
  rota_notifications: ['scheduleRequests.latest.*.taskId', 'assignmentCoordination.latest.*.taskId', 'taskEvents.latest.*.taskId']
});

export function followUpTaskPaths(name) {
  return FOLLOW_UP_TASK_PATHS[name] || [];
}

function valuesAt(value, parts) {
  if (!parts.length) return [value];
  if (value == null || typeof value !== 'object') return [];
  const [head, ...rest] = parts;
  if (head === '*') return Array.isArray(value) ? value.flatMap((item) => valuesAt(item, rest)) : [];
  return Array.isArray(value) ? [] : valuesAt(value[head], rest);
}

/** Kimliksiz kök, aracın erişebildiği en geniş nüfus mu? Kaynağa göre daraltılmış portföy değildir. */
function broadRoot(name, normalized) {
  if (normalized.projectId || normalized.taskId || normalized.personSicil || normalized.wbsId) return false;
  return name !== 'rota_portfolio_summary' || normalized.source === 'all';
}
/** Kök değeri bu olduğunda alan en geniş nüfustur; daha dar her değer içerilir. */
const WIDEST = Object.freeze({ scope: 'visible', includeEmpty: true, tab: 'all', source: 'all', assignee: 'any' });
const WINDOW_TOOLS = new Set(['rota_activity_search', 'rota_calendar_inspect']);
/** Nüfusu değiştirmeyen gösterim bağımsız değişkenleri. */
const PRESENTATION_KEYS = new Set(['cursor', 'limit', 'textFields', 'sort', 'depth']);

/** Kapsam metni karşılaştırması: harf, aksan, noktasız ı ve noktalama duyarsız. */
export function containmentText(value) {
  return foldText(value).replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function populationArguments(name, args, today) {
  if (TASK_POPULATION_TOOLS.has(name)) return normalizeTaskFilters(args);
  if (name === 'rota_activity_search') {
    const period = args.period || (args.dateFrom ? 'custom' : 'today');
    const dateFrom = period === 'custom' ? args.dateFrom : period === 'yesterday' ? addDays(today, -1) : period === 'last_7_days' ? addDays(today, -6) : today;
    const dateTo = period === 'custom' ? args.dateTo || args.dateFrom : period === 'yesterday' ? dateFrom : today;
    return { ...args, period: 'custom', dateFrom, dateTo, scope: args.scope || 'visible' };
  }
  if (name === 'rota_calendar_inspect') {
    const dateFrom = args.dateFrom || today;
    return { ...args, dateFrom, dateTo: args.dateTo || addDays(dateFrom, 29) };
  }
  if (['rota_schedule_requests', 'rota_assignment_requests'].includes(name)) return { ...args, tab: args.tab || 'all' };
  if (name === 'rota_portfolio_summary') return { ...args, source: args.source || 'all', includeEmpty: args.includeEmpty !== false };
  return args;
}

function sameText(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return containmentText(left) === containmentText(right);
}

function contains(root, args, { textTrusted }) {
  if (!sameText(root.text ?? null, args.text ?? null)) {
    if (args.text == null || !textTrusted(args.text)) return false;
    if (root.text && !(` ${containmentText(args.text)} `).includes(` ${containmentText(root.text)} `)) return false;
  }
  for (const [key, value] of Object.entries(root)) {
    if (PRESENTATION_KEYS.has(key) || key === 'text') continue;
    if (value == null || (Array.isArray(value) && !value.length) || (key === 'createdByMe' && value === false)) continue;
    const next = args[key];
    if (key === 'dateFrom' || key === 'targetFrom') { if (!next || next < value) return false; }
    else if (key === 'dateTo' || key === 'targetTo') { if (!next || next > value) return false; }
    else if (Array.isArray(value)) { if (!Array.isArray(next) || !next.length || next.some((item) => !value.includes(item))) return false; }
    else if (Object.hasOwn(WIDEST, key) && value === WIDEST[key]) continue;
    else if (JSON.stringify(next) !== JSON.stringify(value) && value !== 'any' && value !== 'all') return false;
  }
  return true;
}

/** Varsayılan pencere ([bugün] ya da 30 gün) ya da güvenilir bir pencere içinde mi? */
function windowTrusted(name, normalized, windows, today) {
  const defaults = name === 'rota_activity_search' ? [{ dateFrom: today, dateTo: today }] : [{ dateFrom: today, dateTo: addDays(today, 29) }];
  return [...defaults, ...windows].some((window) => normalized.dateFrom >= window.dateFrom && normalized.dateTo <= window.dateTo);
}

/** Sonuçtaki kimlikler; kısmi ve belirsiz aramanın adayları ayrı tutulur. */
function resultIdentities(name, data) {
  if (!data || typeof data !== 'object') return [];
  if (name === 'rota_project_search') return data.resolution === 'unique' && data.resolvedProject
    ? [{ population: 'projects', id: data.resolvedProject.projectId }] : [];
  if (name === 'rota_person_search') return data.resolution === 'unique' && data.resolvedPerson
    ? [{ population: 'people', id: data.resolvedPerson.sicil }] : [];
  if (name === 'rota_task_search' && data.titleResolution) return data.titleResolution === 'unique' && data.resolvedTask
    ? [{ population: 'tasks', id: data.resolvedTask.taskId }] : [];
  const identities = followUpTaskPaths(name).flatMap((path) => valuesAt(data, path.split('.')))
    .map((id) => ({ population: 'tasks', id }));
  // Portföyün döndürdüğü projeler sunucunun yetkiyle ürettiği satırlardır; takip çağrısı kapsamı genişletmez.
  if (name === 'rota_portfolio_summary') identities.push(...(data.projects || []).map((row) => ({ population: 'projects', id: row.projectId })));
  if (name === 'rota_wbs_inspect') identities.push(...(data.nodes || []).map((row) => ({ population: 'wbs', id: row.wbsId })));
  if (name === 'rota_baseline_compare') identities.push(...(data.availableBaselines || []).map((row) => ({ population: 'baselines', id: row.baselineId })));
  return identities.filter((row) => typeof row.id === 'string' || typeof row.id === 'number');
}

function referenceIdentity(reference) {
  if (reference.projectId) return ['projects', reference.projectId];
  if (reference.taskId) return ['tasks', reference.taskId];
  return ['people', String(reference.personSicil)];
}

/**
 * @param {object} options
 * @param {string} [options.userText] Kullanıcının bu turdaki iletisi (ve açıklama yanıtında önceki sorusu).
 * @param {{ candidates: object[], selected: object|null }|null} [options.clarification]
 *   Önceki turun açıklama adayları ve sunucunun kullanıcının seçimine bağladığı aday.
 */
export function createToolScope({ today = businessDate(new Date()), userText = '', allowedTextFields = null, clarification = null } = {}) {
  const ids = { tasks: new Set(), projects: new Set(), wbs: new Set(), baselines: new Set(), people: new Set() };
  const roots = new Map();
  let established = false;
  let broadProjects = false;
  let projectScope = false;
  const broadRoots = new Set();
  const textFields = new Set();
  const trustedTexts = new Set();
  const trustedWindows = [];
  const userNeedle = containmentText(userText);
  // Önceki açıklamanın adayları: yalnızca bağlanan seçim kimliktir.
  const reserved = new Set(clarificationReferences(clarification?.candidates).map((reference) => referenceIdentity(reference).join(':')));
  const bound = clarification?.selected ? clarificationReferences([clarification.selected])[0] || null : null;
  if (bound) {
    const [population, id] = referenceIdentity(bound);
    ids[population].add(id);
    if (population === 'projects') projectScope = true;
  }

  function textTrusted(text) {
    const needle = containmentText(text);
    return Boolean(needle) && (trustedTexts.has(needle) || (` ${userNeedle} `).includes(` ${needle} `));
  }

  function identityTrusted(population, id) {
    if (bound && referenceIdentity(bound).join(':') === `${population}:${id}`) return true;
    if (population === 'people') {
      const text = containmentText(userText);
      return text === String(id) || new RegExp(`(?:^| )sicil(?:i|li)? ${id}(?: |$)|(?:^| )${id} sicil(?:i|li)?(?: |$)`).test(text);
    }
    const tokens = String(userText).toLowerCase().match(/(?<![a-z0-9])[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![a-z0-9])/g) || [];
    return tokens.includes(String(id).toLowerCase());
  }

  return Object.freeze({
    textTrusted,
    identityTrusted,
    /** Önceki açıklamada kullanıcının numarasıyla seçtiği ve sunucunun bağladığı aday. */
    boundSelection() {
      return bound ? { ...bound } : null;
    },
    /**
     * Veri okunmadan önce bildirilen nüfus (ör. dönem). Yalnızca ilk araç
     * turundan önce kabul edilir.
     */
    declare(filters) {
      if (established || !filters || typeof filters !== 'object') return;
      for (const name of WINDOW_TOOLS) {
        try {
          const args = parseToolArguments(getRotaTool(name).parameters, JSON.stringify(Object.fromEntries(
            ['period', 'dateFrom', 'dateTo'].filter((key) => filters[key] != null).map((key) => [key, filters[key]]))));
          if (!Object.keys(args).length) continue;
          const window = populationArguments(name, args, today);
          if (window.dateFrom && window.dateTo) trustedWindows.push({ dateFrom: window.dateFrom, dateTo: window.dateTo });
        } catch { /* Geçersiz bildirim yok sayılır. */ }
      }
    },
    establish(calls, messages) {
      const successful = messages.map((message, index) => {
        try { return { body: JSON.parse(message.content || '{}'), call: calls[index] }; } catch { return { body: {}, call: calls[index] }; }
      }).filter((item) => item.body.ok === true);
      if (!successful.length) return;
      const initialRound = !established;
      for (const { body, call } of successful) {
        let args;
        try { args = parseToolArguments(getRotaTool(call.name).parameters, call.arguments || '{}'); } catch { continue; }
        const normalized = populationArguments(call.name, args, today);
        roots.set(call.name, [...(roots.get(call.name) || []), normalized]);
        if (initialRound) {
          for (const field of args.textFields || []) textFields.add(field);
          if (typeof args.text === 'string' && textTrusted(args.text)) trustedTexts.add(containmentText(args.text));
          if (WINDOW_TOOLS.has(call.name)) trustedWindows.push({ dateFrom: normalized.dateFrom, dateTo: normalized.dateTo });
          if (call.name === 'rota_portfolio_summary') broadProjects = true;
          if (args.projectId || ['rota_project_search', 'rota_portfolio_summary'].includes(call.name)) projectScope = true;
          if (broadRoot(call.name, normalized)) broadRoots.add(call.name);
        }
        // Belirsiz ya da kısmi aramanın adayları kimlik olarak yakalanmaz; kullanıcıya sorulur.
        for (const [key, population] of Object.entries(IDENTITY_ARGUMENTS)) {
          if (args[key] != null) ids[population].add(String(args[key]));
        }
        for (const { population, id } of resultIdentities(call.name, body.data)) ids[population].add(String(id));
      }
      established = true;
    },
    validate(name, args) {
      const fail = () => { throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE); };
      // Serbest metin alanları yalnızca kullanıcının açtığı kümeden seçilebilir (ilk turda da).
      if (allowedTextFields && (args.textFields || []).some((field) => !allowedTextFields.includes(field))) {
        throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, { details: ['$.textFields:not-authorized'] });
      }
      // Önceki açıklamanın seçilmemiş adayı, bu turda sunucunun kanıtlamadığı bir kimliktir.
      for (const [key, population] of Object.entries(IDENTITY_ARGUMENTS)) {
        if (args[key] != null && reserved.has(`${population}:${args[key]}`) && !ids[population].has(String(args[key]))) fail();
      }
      if (!established) {
        // İlk turda da arama metni kullanıcının bu turdaki iletisinden gelmelidir.
        if (args.text != null && !textTrusted(args.text)) fail();
        for (const [key, population] of Object.entries(IDENTITY_ARGUMENTS)) {
          if (args[key] != null && !identityTrusted(population, args[key])) fail();
        }
        return;
      }
      if ((args.textFields || []).some((field) => !textFields.has(field))) fail();
      const normalized = populationArguments(name, args, today);
      const sameRoot = roots.get(name);
      const relatedTaskRoots = TASK_POPULATION_TOOLS.has(name)
        ? [...TASK_POPULATION_TOOLS].flatMap((tool) => roots.get(tool) || []) : [];
      const taskPopulation = relatedTaskRoots.length > 0;
      if (!sameRoot && args.projectId && !projectScope && !ids.projects.has(String(args.projectId))
        && !identityTrusted('projects', args.projectId)) fail();
      if (sameRoot || taskPopulation) {
        const matches = (sameRoot || relatedTaskRoots).some((root) => contains(root, normalized, { textTrusted }));
        if (!matches) fail();
      }
      for (const [key, population] of Object.entries(IDENTITY_ARGUMENTS)) {
        if (args[key] != null && !ids[population].has(String(args[key])) && !identityTrusted(population, args[key])) fail();
      }
      if (!sameRoot && !taskPopulation && args.text != null && !textTrusted(args.text)) fail();
      if (!sameRoot && WINDOW_TOOLS.has(name) && !windowTrusted(name, normalized, trustedWindows, today)) fail();
      const broadFollowUp = Object.entries(BROAD_FOLLOW_UPS).some(([tool, next]) => broadRoots.has(tool) && next.includes(name));
      const trustedSearch = args.text != null && textTrusted(args.text);
      if (!sameRoot && !taskPopulation && !args.taskId && !args.projectId && !args.personSicil && !broadFollowUp && !trustedSearch
        && !(broadProjects && name === 'rota_portfolio_summary')) fail();
    }
  });
}
