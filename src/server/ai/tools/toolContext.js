import 'server-only';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { loadAuthorizationContext } from '../../authorization/loadAuthorizationContext.js';
import { getSqlPool, sql, withSqlTransaction } from '../../db/pool.js';
import { ServerPersistenceError } from '../../errors.js';
import { boundedExecutor } from '../../observability/boundedExecution.js';
import { createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { buildRotaScope } from './rota/rotaScope.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { toolSqlGate } from './toolSqlGate.js';
import { authorizationFingerprint, currentProjectRank, decodeAuthorizationPopulation, evidenceTaskReferences, PROJECT_ACCESS_RANK, savedEvidenceRequirements, scopedEvidenceAuthorization } from './evidenceAuthorization.js';
import { readProjectSearch, readVisibleTasks, readWbsVisibility } from './rota/rotaToolStore.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';

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
        return await work(boundedExecutor(pool, cumulativeDeadline.signal, { track }), track, cumulativeDeadline.signal);
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

  async function loadScope(signal, authorizationOnly = false, run = withSql) {
    let auth;
    try {
      auth = await run(signal, (executor) => loadAuthorization(executor, { includeScopeIdentities: true, maxScopeRows: limits.maxAuthorizationRows }), { authorizationOnly });
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

  /** İletinin sınırlı kanıt nüfusu ve güncel alan gereksinimleri son denetimde birlikte çözülür. */
  function preparedEvidence(saved) {
    if (saved.unverifiable || !state.current || !saved.authorizationEpoch) return null;
    let decoded;
    try {
      const payload = saved.parsedPayload || JSON.parse(saved.payload || '{}');
      const references = saved.authorizationPopulation ? decodeAuthorizationPopulation(saved.authorizationPopulation)
        : saved.taskReferences ?? evidenceTaskReferences(payload);
      if (!Array.isArray(references) || references.some(row => !canonicalActualId(row?.taskId) || !canonicalActualId(row?.projectId))) return null;
      const population = new Map(references.map(row => [row.taskId, row.projectId]));
      if (population.size !== references.length || evidenceTaskReferences(payload).some(row =>
        !population.has(row.taskId) || row.projectId != null && row.projectId !== population.get(row.taskId))) return null;
      const proof = saved.scopedAuthorization;
      if (proof && (!Array.isArray(proof.projectIds) || proof.projectIds.some(id => canonicalActualId(id) !== id)
        || new Set(proof.projectIds).size !== proof.projectIds.length)) return null;
      decoded = { entry: { ...saved, parsedPayload: payload, taskReferences: references }, references, payload };
    } catch { return null; }
    const exact = isEvidenceAuthorized(decoded.entry);
    const historical = Object.hasOwn(saved, 'savedPopulation');
    const fieldSensitive = ['rota_task_detail', 'rota_wbs_inspect'].includes(saved.tool);
    const requirements = historical || !exact || fieldSensitive ? savedEvidenceRequirements(decoded.entry, state.current.auth, { exact }) : null;
    // Eski kayıt alan gereksinimlerini dönem eşleşmesiyle atlayamaz; canlı kanıt kendi güncel araç kapısını korur.
    if ((historical || !exact || fieldSensitive) && !requirements) {
      const unchangedLegacy = exact && !['rota_task_analytics', 'rota_workload_summary', 'rota_task_search', 'rota_task_detail',
        'rota_project_search', 'rota_portfolio_summary', 'rota_project_detail', 'rota_wbs_inspect',
        'rota_recurrence_inspect', 'rota_data_quality', 'rota_baseline_compare', 'rota_dependency_inspect'].includes(saved.tool);
      if (!unchangedLegacy) return null;
    }
    return { ...decoded, requirements };
  }

  /** Kaydın alan gereksinimleri bu görev için güncel kimlik tabanı istiyor mu? */
  const needsIdentity = (requirements, taskId) => Boolean(requirements && (requirements.identities || requirements.identityTaskIds?.has(taskId)));
  /**
   * Güncel görünür görev eşlemesinde proje kökenini ve gerekiyorsa kimlik tabanını
   * denetler; eksik görev/proje kapalı reddedilir. Yeni sorgu çalıştırmaz.
   *
   * @param {Map} current - Aynı denetimde okunan görünür görevler.
   * @param {object} reference - Kayıtlı görev ve proje kimliği.
   * @param {boolean} identity - Kimlik tabanının zorunlu olup olmadığı.
   * @returns {boolean} Kayıt güncel görünürlük gereksinimini sağlıyorsa true.
   */
  const taskStillValid = (current, { taskId, projectId }, identity) => {
    const row = current.get(taskId);
    return Boolean(projectId && row && row.projectId === projectId && (!identity || row.identityBase));
  };

  /**
   * Aynı yetki görüntüsündeki kanıtlar ortak, sınırlı proje/görev/düğüm okumalarını
   * paylaşır. Her kanıt kendi alan gereksinimine göre değerlendirilir; birinin
   * daha yüksek kimlik veya proje gereksinimi diğerini düşürmez.
   */
  async function revalidateEvidence(entries, signal, run = withSql) {
    const prepared = new Map();
    const projectIds = new Set();
    const taskIds = new Set();
    const nodesByProject = new Map();
    for (const saved of entries) {
      signal.throwIfAborted();
      const item = preparedEvidence(saved);
      if (!item) continue;
      const { entry, references, requirements, payload } = item;
      item.projectIds = [...new Set([...(entry.scopedAuthorization?.projectIds || []), ...(requirements?.projectIds || []),
        ...(Object.hasOwn(saved, 'savedPopulation') ? references.map(row => row.projectId) : []), payload.entity?.type === 'project' ? canonicalActualId(payload.entity.id) : null].filter(Boolean))];
      item.nodes = [...(requirements?.wbsAncestorNodes || [])].map(node => ({ ...node, projectId: requirements.wbsProjectId }));
      const filters = payload.data?.filters;
      if (['rota_task_search', 'rota_task_analytics'].includes(saved.tool) && (filters?.wbsId != null || filters?.wbs != null)) {
        const id = canonicalActualId(filters.wbsId);
        const projectId = canonicalActualId(filters.projectId);
        if (!id || !projectId || references.some(row => row.projectId !== projectId)) continue;
        item.nodes.push({ id, projectId });
      }
      for (const id of item.projectIds) projectIds.add(id);
      for (const row of references) taskIds.add(row.taskId);
      for (const node of item.nodes) {
        if (!nodesByProject.has(node.projectId)) nodesByProject.set(node.projectId, new Set());
        nodesByProject.get(node.projectId).add(node.id);
      }
      prepared.set(saved, item);
    }
    const projects = new Map();
    const tasks = new Map();
    const nodes = new Map();
    const projectList = [...projectIds];
    const taskList = [...taskIds];
    for (let start = 0; start < projectList.length; start += limits.maxAnalyzedTasks) {
      const chunk = projectList.slice(start, start + limits.maxAnalyzedTasks);
      const result = await run(signal, executor => readProjectSearch(executor, state.current.scope,
        { projectIds: chunk, text: '', limit: chunk.length }), { authorizationOnly: true });
      for (const row of result.rows) projects.set(canonicalActualId(row.ProjectId), currentProjectRank(row));
    }
    for (let start = 0; start < taskList.length; start += limits.maxAnalyzedTasks) {
      const chunk = taskList.slice(start, start + limits.maxAnalyzedTasks);
      const result = await run(signal, executor => readVisibleTasks(executor, state.current.scope, chunk), { authorizationOnly: true });
      for (const [id, row] of result) tasks.set(id, row);
    }
    for (const [projectId, ids] of nodesByProject) {
      const list = [...ids];
      const observed = new Map();
      for (let start = 0; start < list.length; start += limits.maxAnalyzedTasks) {
        const result = await run(signal, executor => readWbsVisibility(executor, state.current.scope,
          { projectId, wbsIds: list.slice(start, start + limits.maxAnalyzedTasks) }), { authorizationOnly: true });
        for (const row of result) observed.set(canonicalActualId(row.WbsId), row);
      }
      nodes.set(projectId, observed);
    }
    const authorized = new Set();
    for (const [saved, item] of prepared) {
      const { references, requirements } = item;
      const validProjects = item.projectIds.every(id => projects.has(id) && projects.get(id) >= (requirements?.fullProjects
        ? PROJECT_ACCESS_RANK.FULL : requirements?.projectLevels?.get(id) ?? PROJECT_ACCESS_RANK.PARTIAL));
      const validTasks = references.every(row => taskStillValid(tasks, row, needsIdentity(requirements, row.taskId)));
      // Ata ilişkisi tarihsel olgudur; açıklanan her düğümün kendi projesinde güncel görünürlüğü zorunludur.
      const validNodes = item.nodes.every(node => nodes.get(node.projectId)?.has(node.id));
      if (validProjects && validTasks && validNodes) authorized.add(saved.id);
    }
    return authorized;
  }

  /**
   * Son açıklama sınırı tek SERIALIZABLE okuma işlemidir. Yetki, etkin proje,
   * görev→proje/kimlik ve WBS gözlemleri commit'e kadar korunur; sonraki bir
   * değişiklik bu okumanın ardından sıralanır. Ağ teslimiyle atomiklik iddiası
   * yoktur. Önceki denetimlerin gözlemleri bu işleme taşınmaz.
   */
  async function recheckEvidenceTasks(entries, signal) {
    return withSql(signal, async (_executor, track, transactionSignal) => {
      // Gövde salt okumadır ve her denemede yetkiyi baştan okur: kilitlenme kurbanı işlem yalnız bir kez,
      // yeni işlemde ve aynı SQL kapısı/süre sınırı içinde yinelenir. Diğer hatalar yinelenmez.
      const pending = withSqlTransaction(async transaction => {
        const run = (activeSignal, work) => {
          activeSignal.throwIfAborted();
          state.queries += 1;
          return work(boundedExecutor(transaction, activeSignal, { track }));
        };
        await loadScope(transactionSignal, true, run);
        // Önceki iletinin dönemi bu işlemin yetki kaynağı değildir.
        const epoch = state.epoch;
        const authorized = await revalidateEvidence(entries, transactionSignal, run);
        await loadScope(transactionSignal, true, run);
        if (state.epoch !== epoch) throw new ToolError(TOOL_ERROR_CODES.TIMEOUT);
        transactionSignal.throwIfAborted();
        return new Set(entries.filter(entry => authorized.has(entry.id)));
      }, { isolationLevel: sql.ISOLATION_LEVEL.SERIALIZABLE, deadlockRetries: 1 });
      track(pending);
      return raceWithAbort(() => pending, transactionSignal);
    }, { authorizationOnly: true });
  }

  return Object.freeze({
    sicil,
    now,
    today,
    limits,
    /** Yeni araç kümesi: yetki bağlamı yeniden okunacaktır. */
    beginRound() {
      state.round = (state.round || 0) + 1;
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
      const existing = snapshots.get(key);
      if (existing && existing.epoch === state.epoch && (cursor || existing.round === state.round)) return existing.pending;
      if (cursor) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.cursor:stale'] });
      const pending = Promise.resolve().then(load);
      const snapshot = { pending, round: state.round, epoch: state.epoch };
      snapshots.set(key, snapshot);
      try { return await pending; }
      catch (error) { if (snapshots.get(key) === snapshot) snapshots.delete(key); throw error; }
    },
    authorizationEpoch() { return state.epoch; },
    evidenceAuthorization(args, envelope, projectIds) { return scopedEvidenceAuthorization(state.current.auth, state.current.scope, args, envelope, projectIds); },
    /**
     * Yüklenmiş tur kapsamında kanıtın projeleri için açıklanan erişim düzeyini
     * kayda hazırlar; güncel yetki denetiminin yerine geçmez ve SQL çalıştırmaz.
     *
     * @param {Array<object>} references - Doğrulanmış proje kimliği taşıyan görevler.
     * @returns {Array<object>} Her proje için tek kimlik ve erişim düzeyi.
     */
    evidenceProjectLevels(references) {
      return [...new Set(references.map(row => row.projectId))].map(projectId => {
        const access = state.current.scope.projects.get(projectId);
        return { projectId, level: state.current.scope.isAdmin || access?.accessLevel === 'FULL' ? 'FULL' : access?.readGrant ? 'READ' : 'PARTIAL' };
      });
    },
    isEvidenceAuthorized,
    revalidateEvidence,
    recheckEvidenceTasks,
    revalidateAuthorization(signal) { return loadScope(signal, true); },
    timeoutCode(signal) { return waiting.has(signal) ? TOOL_ERROR_CODES.BUSY : TOOL_ERROR_CODES.TIMEOUT; },
    stats() {
      return { sqlMs: state.sqlMs, queries: state.queries, authorizationLoads: state.authorizationLoads };
    }
  });
}
