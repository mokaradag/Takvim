import 'server-only';
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
import { authorizationFingerprint, evidenceTaskReferences, scopedEvidenceAuthorization } from './evidenceAuthorization.js';
import { readTaskFacts } from './rota/rotaToolStore.js';

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
/** Kanıt yeniden doğrulamasında okunabilecek en fazla görev kimliği parçası. */
const MAX_REVALIDATION_CHUNKS = 8;

export function createToolTurnContext({
  sicil,
  now = new Date(),
  limits = TOOL_LIMITS,
  clock = Date.now,
  getPool = getSqlPool,
  loadAuthorization = loadAuthorizationContext,
  gate = toolSqlGate
}) {
  const state = { sqlMs: 0, queries: 0, authorization: null, authorizationLoads: 0, epoch: null, current: null };
  const waiting = new WeakSet();
  const snapshots = new Map();
  const today = businessDate(now);

  async function withSql(signal, work, { authorizationOnly = false } = {}) {
    if (!authorizationOnly && state.sqlMs >= limits.maxCumulativeSqlMs) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
    const pool = await raceWithAbort(() => getPool(), signal);
    let admitted = false;
    waiting.add(signal);
    try { return await gate.run(sicil, signal, async (track) => {
      admitted = true;
      waiting.delete(signal);
      if (!authorizationOnly && state.sqlMs >= limits.maxCumulativeSqlMs) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
      const admittedAt = clock();
      const remainingMs = authorizationOnly ? limits.callTimeoutMs : Math.max(1, limits.maxCumulativeSqlMs - state.sqlMs);
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
        if (!authorizationOnly) state.sqlMs += Math.max(0, clock() - admittedAt);
      }
    }); } catch (error) {
      if (!admitted && signal.reason?.code === 'AI_TIMEOUT') throw new ToolError(TOOL_ERROR_CODES.BUSY);
      throw error;
    } finally { waiting.delete(signal); }
  }

  async function loadScope(signal, authorizationOnly = false) {
    let auth;
    try {
      auth = await withSql(signal, (executor) => loadAuthorization(executor, { includeScopeIdentities: true, maxScopeRows: limits.maxAuthorizationRows }), { authorizationOnly });
    } catch (error) {
      if (error?.code === 'AI_SCOPE_LIMIT_EXCEEDED') throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
      throw error;
    }
    state.authorizationLoads += 1;
    // Yükleyici kimliği yine oturumdan çözer; turun Sicil'iyle aynı olmalıdır.
    if (Number(auth?.sicil) !== Number(sicil)) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Oturum kimliği tur sırasında değişti.');
    }
    const scope = buildRotaScope(auth);
    const previousEpoch = state.epoch;
    state.epoch = authorizationFingerprint(auth, scope);
    state.current = Object.freeze({ auth, scope });
    if (previousEpoch && previousEpoch !== state.epoch) snapshots.clear();
    return state.current;
  }

  function isEvidenceAuthorized(entry) {
    if (!entry.authorizationEpoch || !state.current) return false;
    const proof = entry.scopedAuthorization;
    return proof?.version === 1
      ? proof.epoch === authorizationFingerprint(state.current.auth, state.current.scope, proof)
      : entry.authorizationEpoch === state.epoch;
  }

  async function revalidateEvidence(entries, signal) {
    const eligible = entries.filter(isEvidenceAuthorized);
    const references = new Map(eligible.map((entry) => [entry.id, entry.taskReferences || evidenceTaskReferences(JSON.parse(entry.payload || '{}'))]));
    const taskIds = [...new Set([...references.values()].flat().map((row) => row.taskId))];
    // Görev kimlikleri analiz sınırı büyüklüğünde parçalarla okunur: uzun bir
    // konuşma ya da büyük bir toplam tek sorguyu aşmaz; parça sayısı sınırlıdır.
    const chunkSize = limits.maxAnalyzedTasks;
    if (taskIds.length > chunkSize * MAX_REVALIDATION_CHUNKS) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
    const current = new Map();
    for (let start = 0; start < taskIds.length; start += chunkSize) {
      const chunk = taskIds.slice(start, start + chunkSize);
      const result = await withSql(signal, (executor) => readTaskFacts(executor, state.current.scope, { taskIds: chunk, maxRows: chunk.length }), { authorizationOnly: true });
      if (result.truncated) throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE);
      for (const fact of result.facts) current.set(fact.id, fact.projectId);
    }
    return new Set(eligible.filter((entry) => references.get(entry.id).every(({ taskId, projectId }) =>
      current.has(taskId) && (!projectId || current.get(taskId) === projectId))).map((entry) => entry.id));
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
    evidenceAuthorization(args, envelope) { return scopedEvidenceAuthorization(state.current.auth, state.current.scope, args, envelope); },
    isEvidenceAuthorized,
    revalidateEvidence,
    revalidateAuthorization(signal) { return loadScope(signal, true); },
    timeoutCode(signal) { return waiting.has(signal) ? TOOL_ERROR_CODES.BUSY : TOOL_ERROR_CODES.TIMEOUT; },
    stats() {
      return { sqlMs: state.sqlMs, queries: state.queries, authorizationLoads: state.authorizationLoads };
    }
  });
}
