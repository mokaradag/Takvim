import 'server-only';
import { TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { parseToolArguments } from './toolArguments.js';
import { getRotaTool } from './toolRegistry.js';
import { addDays, foldText, normalizeTaskFilters } from './rota/taskFacts.js';
import { businessDate } from '../../../domain/calendar/businessDate.js';

/**
 * Bir turun KAPSAM SINIRI (containment).
 *
 * İlk başarılı araç turu, model henüz hiçbir araç sonucu görmeden seçildiği
 * için güvenilir niyettir. Sonraki turlarda araç sonucu metni kapsamı
 * genişletemez:
 *
 *  - Aynı aracın sonraki çağrısı ilk normalize nüfusun içinde kalır
 *    (daraltma, sayfalama serbesttir).
 *  - Başka aracın ilk çağrısı yalnızca sunucunun döndürdüğü ve belirsiz
 *    OLMAYAN kimliklere (görev, proje, WBS, baz plan, kişi) bağlanabilir;
 *    belirsiz aramanın adayları kullanıcıya sorulmadan kimlik olamaz.
 *  - Serbest arama metni yalnızca kullanıcının bu turdaki iletisinde geçiyorsa
 *    ya da veri okunmadan önce bildirildiyse kullanılabilir.
 *  - Varsayılanı en dar olmayan nüfus bağımsız değişkenleri (hareket ve takvim
 *    tarih penceresi) başka aracın ilk çağrısında varsayılan pencerede ya da
 *    veri okunmadan önce bildirilen pencerede kalır.
 */

const IDENTITIES = Object.freeze({ taskId: 'tasks', templateTaskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', sicil: 'people', personSicil: 'people' });
const TASK_POPULATION_TOOLS = new Set(['rota_task_search', 'rota_task_analytics']);
/** Kimliksiz geniş nüfustan aynı görünür görev nüfusuna geçişler. */
const BROAD_FOLLOW_UPS = Object.freeze({
  rota_data_quality: ['rota_task_search', 'rota_task_analytics'],
  rota_portfolio_summary: ['rota_task_analytics']
});
/** Kök değeri bu olduğunda alan en geniş nüfustur; daha dar her değer içerilir. */
const WIDEST = Object.freeze({ scope: 'visible', includeEmpty: true, tab: 'all', source: 'all', assignee: 'any' });
const WINDOW_TOOLS = new Set(['rota_activity_search', 'rota_calendar_inspect']);

function populationArguments(name, args, today) {
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

function contains(root, args) {
  if ((root.text ?? null) !== (args.text ?? null)) return false;
  for (const [key, value] of Object.entries(root)) {
    if (['cursor', 'limit', 'textFields', 'sort'].includes(key)) continue;
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

/** Sonuçtaki kimlikler; belirsiz aramanın adayları ayrı tutulur. */
function resultIdentities(name, data) {
  const resolved = [];
  const candidates = [];
  if (!data || typeof data !== 'object') return { resolved, candidates };
  const rest = { ...data };
  if (name === 'rota_project_search' && Array.isArray(data.matches)) {
    delete rest.matches;
    const exact = data.matches.filter((match) => match.exactMatch === true);
    const unique = !data.ambiguous && (data.matches.length === 1 || exact.length === 1);
    for (const match of data.matches) (unique && (data.matches.length === 1 || match.exactMatch === true) ? resolved : candidates).push(match);
  } else if (name === 'rota_person_search' && Array.isArray(data.people)) {
    delete rest.people;
    (data.ambiguous === true ? candidates : resolved).push(...data.people);
  } else if (name === 'rota_task_search' && Array.isArray(data.tasks) && data.titleResolution) {
    // Metinle ad çözümünde yalnızca sunucunun kanıtladığı tek görev kimlik olur.
    delete rest.tasks;
    delete rest.resolvedTask;
    candidates.push(...data.tasks);
    if (data.titleResolution === 'unique' && data.resolvedTask) resolved.push({ taskId: data.resolvedTask.taskId });
  } else if (data.ambiguous === true) {
    candidates.push(data);
    return { resolved, candidates };
  }
  resolved.push(rest);
  // Toplu sonuç grupları sunucuya ait kimliklerdir (ör. proje ya da kişi bazında dağılım).
  if (name === 'rota_task_analytics' && Array.isArray(data.groups)) {
    if (data.groupBy === 'project') resolved.push(...data.groups.filter((group) => group.key !== 'other').map((group) => ({ projectId: group.key })));
    if (data.groupBy === 'assignee') {
      resolved.push(...data.groups.map((group) => /^sicil:(\d+)$/.exec(String(group.key))?.[1]).filter(Boolean).map((sicil) => ({ personSicil: Number(sicil) })));
    }
  }
  return { resolved, candidates };
}

export function createToolScope({ today = businessDate(new Date()), userText = '', allowedTextFields = null } = {}) {
  const ids = { tasks: new Set(), projects: new Set(), wbs: new Set(), baselines: new Set(), people: new Set() };
  const roots = new Map();
  let established = false;
  let broadProjects = false;
  let projectScope = false;
  const broadRoots = new Set();
  const textFields = new Set();
  const trustedTexts = new Set();
  const trustedWindows = [];
  const userNeedle = foldText(userText);

  function capture(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(capture); return; }
    for (const [key, item] of Object.entries(value)) {
      if (IDENTITIES[key] && (typeof item === 'string' || typeof item === 'number')) ids[IDENTITIES[key]].add(String(item));
      else if (item && typeof item === 'object') capture(item);
    }
  }

  function textTrusted(text) {
    const needle = foldText(text).trim();
    return Boolean(needle) && (trustedTexts.has(needle) || userNeedle.includes(needle));
  }

  return Object.freeze({
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
          if (typeof args.text === 'string') trustedTexts.add(foldText(args.text).trim());
          if (WINDOW_TOOLS.has(call.name)) trustedWindows.push({ dateFrom: normalized.dateFrom, dateTo: normalized.dateTo });
          if (call.name === 'rota_portfolio_summary') broadProjects = true;
          if (args.projectId || ['rota_project_search', 'rota_portfolio_summary'].includes(call.name)) projectScope = true;
          if (!args.projectId && !args.taskId && !args.personSicil && !args.wbsId) broadRoots.add(call.name);
        }
        // Belirsiz aramanın adayları kimlik olarak yakalanmaz; kullanıcıya sorulur.
        const { resolved } = resultIdentities(call.name, body.data);
        capture(args);
        resolved.forEach(capture);
        // Proje kırılımlı geniş analiz, projeye inmeyi kullanıcının sorusunun parçası yapar.
        if (call.name === 'rota_task_analytics' && body.data?.groupBy === 'project' && !args.projectId) projectScope = true;
      }
      established = true;
    },
    validate(name, args) {
      const fail = () => { throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE); };
      // Serbest metin alanları yalnızca kullanıcının açtığı kümeden seçilebilir (ilk turda da).
      if (allowedTextFields && (args.textFields || []).some((field) => !allowedTextFields.includes(field))) {
        throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, { details: ['$.textFields:not-authorized'] });
      }
      if (!established) return;
      if ((args.textFields || []).some((field) => !textFields.has(field))) fail();
      const normalized = populationArguments(name, args, today);
      const sameRoot = roots.get(name);
      const relatedTaskRoots = TASK_POPULATION_TOOLS.has(name)
        ? [...TASK_POPULATION_TOOLS].flatMap((tool) => roots.get(tool) || []) : [];
      const taskPopulation = relatedTaskRoots.length > 0;
      if (!sameRoot && args.projectId && !projectScope) fail();
      if (sameRoot || taskPopulation) {
        const matches = (sameRoot || relatedTaskRoots).some((root) => contains(root, normalized));
        if (!matches) fail();
      }
      for (const [key, population] of Object.entries({ taskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', personSicil: 'people' })) {
        if (args[key] != null && !ids[population].has(String(args[key]))) fail();
      }
      if (!sameRoot && !taskPopulation && args.text != null && !textTrusted(args.text)) fail();
      if (!sameRoot && WINDOW_TOOLS.has(name) && !windowTrusted(name, normalized, trustedWindows, today)) fail();
      const ownWorkflow = roots.has('rota_notifications') && ['rota_schedule_requests', 'rota_assignment_requests'].includes(name);
      const broadFollowUp = Object.entries(BROAD_FOLLOW_UPS).some(([tool, next]) => broadRoots.has(tool) && next.includes(name));
      const trustedSearch = args.text != null && textTrusted(args.text);
      if (!sameRoot && !taskPopulation && !args.taskId && !args.projectId && !args.personSicil && !ownWorkflow && !broadFollowUp && !trustedSearch
        && !(broadProjects && name === 'rota_portfolio_summary')) fail();
    }
  });
}
