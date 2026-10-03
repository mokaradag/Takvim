import 'server-only';
import { TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { parseToolArguments } from './toolArguments.js';
import { getRotaTool } from './toolRegistry.js';
import { addDays, foldText, normalizeTaskFilters } from './rota/taskFacts.js';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { clarificationReferences } from '../../../domain/ai/clarification.js';

/**
 * Bir turun KAPSAM SINIRI (containment).
 *
 * İlk başarılı araç turu, model henüz hiçbir araç sonucu görmeden seçildiği
 * için güvenilir niyettir; yine de serbest arama metni ilk turda da yalnızca
 * kullanıcının iletisinde geçen metin olabilir. Sonraki turlarda araç sonucu
 * metni kapsamı genişletemez:
 *
 *  - Aynı aracın sonraki çağrısı ilk normalize nüfusun içinde kalır
 *    (daraltma, sayfalama serbesttir).
 *  - Başka aracın ilk çağrısı yalnızca sunucunun KANITLADIĞI kimliklere
 *    (görev, proje, WBS, baz plan, kişi) bağlanabilir: tek kesin ad
 *    eşleşmesi kimliktir; kısmi ya da belirsiz aramanın adayları kullanıcıya
 *    sorulmadan kimlik olamaz.
 *  - Önceki turdaki açıklamanın adayları, sunucunun kullanıcının numaralı
 *    seçimine bağladığı aday dışında bu turda kimlik olarak kullanılamaz.
 *  - Varsayılanı en dar olmayan nüfus bağımsız değişkenleri (hareket ve takvim
 *    tarih penceresi) başka aracın ilk çağrısında varsayılan pencerede ya da
 *    veri okunmadan önce bildirilen pencerede kalır.
 *
 * Karşılaştırmalar normalize değerlerle yapılır (kimlikler kanonik, metin
 * harf/aksan duyarsız, varsayılanlar açık değerleriyle eşit).
 */

const IDENTITIES = Object.freeze({ taskId: 'tasks', templateTaskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', sicil: 'people', personSicil: 'people' });
const IDENTITY_ARGUMENTS = Object.freeze({ taskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', personSicil: 'people' });
const TASK_POPULATION_TOOLS = new Set(['rota_task_search', 'rota_task_analytics']);
/** Kimliksiz geniş nüfustan aynı görünür görev nüfusuna geçişler. */
const BROAD_FOLLOW_UPS = Object.freeze({
  rota_data_quality: ['rota_task_search', 'rota_task_analytics'],
  rota_portfolio_summary: ['rota_task_analytics']
});
/** Kök değeri bu olduğunda alan en geniş nüfustur; daha dar her değer içerilir. */
const WIDEST = Object.freeze({ scope: 'visible', includeEmpty: true, tab: 'all', source: 'all', assignee: 'any' });
const WINDOW_TOOLS = new Set(['rota_activity_search', 'rota_calendar_inspect']);
/** Nüfusu değiştirmeyen gösterim bağımsız değişkenleri. */
const PRESENTATION_KEYS = new Set(['cursor', 'limit', 'textFields', 'sort', 'depth']);

/** Kapsam metni karşılaştırması: harf, aksan, noktasız ı ve noktalama duyarsız. */
export function containmentText(value) {
  return foldText(value).replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

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

function sameText(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return containmentText(left) === containmentText(right);
}

function contains(root, args, { textTrusted }) {
  if (!sameText(root.text ?? null, args.text ?? null) && !(args.text != null && textTrusted(args.text))) return false;
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
  const resolved = [];
  const candidates = [];
  if (!data || typeof data !== 'object') return { resolved, candidates };
  const rest = { ...data };
  if (name === 'rota_project_search' && Array.isArray(data.matches)) {
    for (const key of ['matches', 'candidates', 'resolvedProject']) delete rest[key];
    candidates.push(...data.matches, ...(Array.isArray(data.candidates) ? data.candidates : []));
    // Yalnızca tek kesin ad/kod eşleşmesi kimliktir; tek kısmi sonuç değildir.
    const exact = data.resolvedProject ? [data.resolvedProject] : data.matches.filter((match) => match.exactMatch === true);
    if (data.ambiguous !== true && exact.length === 1 && exact[0]?.projectId) resolved.push({ projectId: exact[0].projectId });
  } else if (name === 'rota_person_search' && Array.isArray(data.people)) {
    for (const key of ['people', 'candidates', 'resolvedPerson']) delete rest[key];
    candidates.push(...data.people, ...(Array.isArray(data.candidates) ? data.candidates : []));
    // Kimlik Sicil'dir: yalnızca sunucunun kesin Sicil/ad eşleşmesi olarak çözdüğü kişi.
    if (data.resolution === 'unique' && Number.isSafeInteger(data.resolvedPerson?.sicil)) resolved.push({ personSicil: data.resolvedPerson.sicil });
  } else if (name === 'rota_task_search' && Array.isArray(data.tasks) && data.titleResolution) {
    for (const key of ['tasks', 'candidates', 'resolvedTask']) delete rest[key];
    candidates.push(...data.tasks, ...(Array.isArray(data.candidates) ? data.candidates : []));
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

  function capture(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(capture); return; }
    for (const [key, item] of Object.entries(value)) {
      if (IDENTITIES[key] && (typeof item === 'string' || typeof item === 'number')) ids[IDENTITIES[key]].add(String(item));
      else if (item && typeof item === 'object') capture(item);
    }
  }

  function textTrusted(text) {
    const needle = containmentText(text);
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
          if (typeof args.text === 'string' && textTrusted(args.text)) trustedTexts.add(containmentText(args.text));
          if (WINDOW_TOOLS.has(call.name)) trustedWindows.push({ dateFrom: normalized.dateFrom, dateTo: normalized.dateTo });
          if (call.name === 'rota_portfolio_summary') broadProjects = true;
          if (args.projectId || ['rota_project_search', 'rota_portfolio_summary'].includes(call.name)) projectScope = true;
          if (!args.projectId && !args.taskId && !args.personSicil && !args.wbsId) broadRoots.add(call.name);
        }
        // Belirsiz ya da kısmi aramanın adayları kimlik olarak yakalanmaz; kullanıcıya sorulur.
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
      // Önceki açıklamanın seçilmemiş adayı, bu turda sunucunun kanıtlamadığı bir kimliktir.
      for (const [key, population] of Object.entries(IDENTITY_ARGUMENTS)) {
        if (args[key] != null && reserved.has(`${population}:${args[key]}`) && !ids[population].has(String(args[key]))) fail();
      }
      if (!established) {
        // İlk turda da arama metni kullanıcının bu turdaki iletisinden gelmelidir.
        if (args.text != null && !textTrusted(args.text)) fail();
        return;
      }
      if ((args.textFields || []).some((field) => !textFields.has(field))) fail();
      const normalized = populationArguments(name, args, today);
      const sameRoot = roots.get(name);
      const relatedTaskRoots = TASK_POPULATION_TOOLS.has(name)
        ? [...TASK_POPULATION_TOOLS].flatMap((tool) => roots.get(tool) || []) : [];
      const taskPopulation = relatedTaskRoots.length > 0;
      if (!sameRoot && args.projectId && !projectScope) fail();
      if (sameRoot || taskPopulation) {
        const matches = (sameRoot || relatedTaskRoots).some((root) => contains(root, normalized, { textTrusted }));
        if (!matches) fail();
      }
      for (const [key, population] of Object.entries(IDENTITY_ARGUMENTS)) {
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
