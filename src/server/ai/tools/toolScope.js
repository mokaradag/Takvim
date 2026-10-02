import 'server-only';
import { TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { parseToolArguments } from './toolArguments.js';
import { getRotaTool } from './toolRegistry.js';

const IDENTITIES = Object.freeze({ taskId: 'tasks', templateTaskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', sicil: 'people', personSicil: 'people' });

function contains(root, args) {
  if ((root.text ?? null) !== (args.text ?? null)) return false;
  for (const [key, value] of Object.entries(root)) {
    if (['cursor', 'limit', 'textFields', 'sort'].includes(key)) continue;
    const next = args[key];
    if (key === 'dateFrom' || key === 'targetFrom') { if (!next || next < value) return false; }
    else if (key === 'dateTo' || key === 'targetTo') { if (!next || next > value) return false; }
    else if (Array.isArray(value)) { if (!Array.isArray(next) || !next.length || next.some((item) => !value.includes(item))) return false; }
    else if (JSON.stringify(next) !== JSON.stringify(value) && value !== 'any' && value !== 'all') return false;
  }
  return true;
}

export function createToolScope() {
  const ids = { tasks: new Set(), projects: new Set(), wbs: new Set(), baselines: new Set(), people: new Set() };
  const roots = new Map();
  let established = false;
  let broadProjects = false;
  let projectScope = false;
  let ambiguous = false;
  const textFields = new Set();

  function capture(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(capture); return; }
    for (const [key, item] of Object.entries(value)) {
      if (IDENTITIES[key] && (typeof item === 'string' || typeof item === 'number')) ids[IDENTITIES[key]].add(String(item));
      else if (item && typeof item === 'object') capture(item);
    }
  }

  return Object.freeze({
    establish(calls, messages) {
      const successful = messages.map((message, index) => ({ body: JSON.parse(message.content || '{}'), call: calls[index] }))
        .filter((item) => item.body.ok === true);
      if (!successful.length) return;
      if (established) {
        successful.forEach(({ body }) => capture(body.data));
        return;
      }
      for (const { body, call } of successful) {
        let args;
        try { args = parseToolArguments(getRotaTool(call.name).parameters, call.arguments || '{}'); } catch { continue; }
        roots.set(call.name, [...(roots.get(call.name) || []), args]);
        for (const field of args.textFields || []) textFields.add(field);
        if (call.name === 'rota_portfolio_summary') broadProjects = true;
        if (args.projectId || ['rota_project_search', 'rota_portfolio_summary'].includes(call.name)) projectScope = true;
        if (body.data?.ambiguous === true) ambiguous = true;
        capture(args);
        capture(body.data);
      }
      established = true;
    },
    validate(name, args) {
      if (!established) return;
      const fail = () => { throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE); };
      if ((args.textFields || []).some((field) => !textFields.has(field))) fail();
      const sameRoot = roots.get(name);
      if (ambiguous && !sameRoot) fail();
      if (!sameRoot && args.projectId && !projectScope) fail();
      if (sameRoot) {
        const matches = sameRoot.some((root) => contains(root, args));
        if (!matches) fail();
      }
      for (const [key, population] of Object.entries({ taskId: 'tasks', projectId: 'projects', wbsId: 'wbs', baselineId: 'baselines', personSicil: 'people' })) {
        if (args[key] != null && !ids[population].has(String(args[key]))) fail();
      }
      if (!sameRoot && args.text != null) fail();
      const ownWorkflow = roots.has('rota_notifications') && ['rota_schedule_requests', 'rota_assignment_requests'].includes(name);
      if (!sameRoot && !args.taskId && !args.projectId && !args.personSicil && !ownWorkflow && !(broadProjects && name === 'rota_portfolio_summary')) fail();
    }
  });
}
