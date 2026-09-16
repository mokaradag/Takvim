import 'server-only';
import { applicationInstanceId } from './observabilityConfig.js';

const PROCESS_SCOPED_CODES = new Set([
  'MEMORY_PRESSURE',
  'API_ERROR_RATE_HIGH',
  'API_LATENCY_HIGH'
]);

function parseKey(key) {
  const [component, code, ...scope] = String(key ?? '').split(':');
  return { component, code, scope: scope.length ? scope.join(':') : null };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function supersededProcessAlertKeys(activeKeys = [], {
  env = process.env,
  currentPid = process.pid,
  isProcessAlive = processIsAlive
} = {}) {
  if (String(env.MERGEN_ROTA_INSTANCE_ID ?? '').trim()) return [];

  const currentScope = applicationInstanceId({ env, pid: currentPid });
  const superseded = [];
  for (const key of activeKeys) {
    const parsed = parseKey(key);
    if (!PROCESS_SCOPED_CODES.has(parsed.code) || !parsed.scope || parsed.scope === currentScope) continue;

    const match = /-(\d+)$/.exec(parsed.scope);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (applicationInstanceId({ env, pid }) !== parsed.scope) continue;

    let alive = true;
    try {
      alive = isProcessAlive(pid) !== false;
    } catch {
      alive = true;
    }
    if (!alive) superseded.push(key);
  }
  return superseded;
}
