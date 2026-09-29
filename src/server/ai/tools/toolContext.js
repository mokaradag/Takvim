import 'server-only';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { loadAuthorizationContext } from '../../authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../db/pool.js';
import { ServerPersistenceError } from '../../errors.js';
import { boundedExecutor } from '../../observability/boundedExecution.js';
import { raceWithAbort } from '../aiDeadline.js';
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
  const state = { sqlMs: 0, queries: 0, authorization: null, authorizationLoads: 0 };
  const today = businessDate(now);

  async function withSql(signal, work) {
    if (state.sqlMs >= limits.maxCumulativeSqlMs) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
    const pool = await raceWithAbort(() => getPool(), signal);
    return gate.run(sicil, signal, async (track) => {
      const admittedAt = clock();
      state.queries += 1;
      try {
        return await work(boundedExecutor(pool, signal, { track }));
      } finally {
        state.sqlMs += Math.max(0, clock() - admittedAt);
      }
    });
  }

  async function loadScope(signal) {
    const auth = await withSql(signal, (executor) => loadAuthorization(executor));
    state.authorizationLoads += 1;
    // Yükleyici kimliği yine oturumdan çözer; turun Sicil'iyle aynı olmalıdır.
    if (Number(auth?.sicil) !== Number(sicil)) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Oturum kimliği tur sırasında değişti.');
    }
    return Object.freeze({ auth, scope: buildRotaScope(auth) });
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
    stats() {
      return { sqlMs: state.sqlMs, queries: state.queries, authorizationLoads: state.authorizationLoads };
    }
  });
}
