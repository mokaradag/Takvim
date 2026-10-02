import 'server-only';
import { createHash } from 'node:crypto';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { loadAuthorizationContext } from '../../authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../db/pool.js';
import { ServerPersistenceError } from '../../errors.js';
import { boundedExecutor } from '../../observability/boundedExecution.js';
import { createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { buildRotaScope } from './rota/rotaScope.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { toolSqlGate } from './toolSqlGate.js';

/**
 * Bir Rota AI turunun araç bağlamı.
 *
 * Kimlik YALNIZCA güvenilir oturumdan gelen Sicil'dir; model kimlik, yetki ya
 * da kapsam veremez. "Bugün" tur başında Türkiye iş günü olarak sabitlenir:
 * aynı turdaki bütün araçlar aynı günü kullanır.
 *
 * Yetki bağlamı her MODEL TURUNDA (araç çağrısı kümesinde) Rota'nın kanonik
 * yükleyicisiyle yeniden okunur; aynı kümedeki çağrılar bir kez yüklenen
 * bağlamı paylaşır. Böylece bir yetki değişikliği en geç sonraki araç
 * kümesinde yürürlüğe girer.
 *
 * Her SQL işi araç kapısından (Sicil başına tek etkin sorgu), çağrının süre
 * sınırıyla ve iptal edilebilir olarak geçer; kapının yeri sürücüdeki sorgu
 * gerçekten bitene kadar tutulur. Tur boyunca SQL'de geçen toplam süre
 * sınırlıdır; sınır dolunca yeni sorgu başlatılmaz.
 */
export function createToolTurnContext({
  sicil,
  now = new Date(),
  limits = TOOL_LIMITS,
  clock = Date.now,
  getPool = getSqlPool,
  loadAuthorization = loadAuthorizationContext,
  gate = toolSqlGate
}) {
  const state = { sqlMs: 0, queries: 0, authorization: null, authorizationLoads: 0, epoch: null };
  const waiting = new WeakSet();
  const snapshots = new Map();
  const today = businessDate(now);

  async function withSql(signal, work) {
    if (state.sqlMs >= limits.maxCumulativeSqlMs) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
    const pool = await raceWithAbort(() => getPool(), signal);
    let admitted = false;
    waiting.add(signal);
    try { return await gate.run(sicil, signal, async (track) => {
      admitted = true;
      waiting.delete(signal);
      if (state.sqlMs >= limits.maxCumulativeSqlMs) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
      const admittedAt = clock();
      const remainingMs = Math.max(1, limits.maxCumulativeSqlMs - state.sqlMs);
      const cumulativeDeadline = createAiDeadline({ timeoutMs: remainingMs, parentSignal: signal, now: clock });
      state.queries += 1;
      try {
        return await work(boundedExecutor(pool, cumulativeDeadline.signal, { track }));
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (cumulativeDeadline.failure()) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
        throw error;
      } finally {
        cumulativeDeadline.dispose();
        state.sqlMs += Math.max(0, clock() - admittedAt);
      }
    }); } catch (error) {
      if (!admitted && signal.reason?.code === 'AI_TIMEOUT') throw new ToolError(TOOL_ERROR_CODES.BUSY);
      throw error;
    } finally { waiting.delete(signal); }
  }

  async function loadScope(signal) {
    const auth = await withSql(signal, (executor) => loadAuthorization(executor, { includeScopeIdentities: true }));
    state.authorizationLoads += 1;
    // Yükleyici kimliği yine oturumdan çözer; turun Sicil'iyle aynı olmalıdır.
    if (Number(auth?.sicil) !== Number(sicil)) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Oturum kimliği tur sırasında değişti.');
    }
    const scope = buildRotaScope(auth);
    const previousEpoch = state.epoch;
    state.epoch = createHash('sha256').update(JSON.stringify({
      sicil: scope.sicil, admin: scope.isAdmin, executive: scope.isExecutive,
      projects: [...scope.projects].sort(([a], [b]) => a.localeCompare(b)),
      tasks: scope.scopedTaskIds.split(',').sort(), people: [...(auth.scopeIdentities || [])].sort((a, b) => a - b), assignment: scope.canAssignAllCorporate
    })).digest('hex');
    if (previousEpoch && previousEpoch !== state.epoch) snapshots.clear();
    return Object.freeze({ auth, scope });
  }

  return Object.freeze({
    sicil,
    now,
    today,
    limits,
    /** Yeni araç kümesi: yetki bağlamı yeniden okunacaktır. */
    beginRound() {
      state.authorization = null;
    },
    /** Bu kümenin yetki kapsamı (küme içinde bir kez yüklenir). */
    authorization(signal) {
      if (!state.authorization) {
        const pending = loadScope(signal);
        state.authorization = pending;
        pending.catch(() => {
          if (state.authorization === pending) state.authorization = null;
        });
      }
      return state.authorization;
    },
    /** Sınırlı yürütücüyle tek SQL işi (kapı + süre sınırı + iptal). */
    sql: withSql,
    async snapshot(key, cursor, load) {
      if (snapshots.has(key)) return snapshots.get(key);
      if (cursor) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.cursor:stale'] });
      const result = await load();
      snapshots.set(key, result);
      return result;
    },
    authorizationEpoch() { return state.epoch; },
    timeoutCode(signal) { return waiting.has(signal) ? TOOL_ERROR_CODES.BUSY : TOOL_ERROR_CODES.TIMEOUT; },
    stats() {
      return { sqlMs: state.sqlMs, queries: state.queries, authorizationLoads: state.authorizationLoads };
    }
  });
}
