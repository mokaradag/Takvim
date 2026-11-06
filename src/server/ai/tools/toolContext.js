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
import { authorizationFingerprint, currentProjectRank, decodeAuthorizationPopulation, evidenceTaskReferences, PROJECT_ACCESS_RANK, savedEvidenceRequirements, scopedEvidenceAuthorization } from './evidenceAuthorization.js';
import { readProjectSearch, readVisibleTasks, readWbs } from './rota/rotaToolStore.js';
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
  const wbsByProject = new Map();
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
    // Yeni yetki yüklemesi, önceki WBS ata ağacı görüntüsünü geçersiz kılar.
    wbsByProject.clear();
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

  /**
   * Kayıtlı kanıtın doğrulanacak nüfusu ve güncel gereksinimi. Birebir dönem
   * eşleşmesi ek gereksinim istemez; aksi halde yalnızca kayıttan kanıtlanabilen
   * eşdeğer erişim aranır. Doğrulanamayan kayıt `null` döner.
   */
  function preparedEvidence(saved) {
    if (saved.unverifiable || !state.current || !saved.authorizationEpoch) return null;
    const references = saved.authorizationPopulation ? decodeAuthorizationPopulation(saved.authorizationPopulation)
      : saved.taskReferences ?? evidenceTaskReferences(JSON.parse(saved.payload || '{}'));
    if (!Array.isArray(references)) return null;
    const entry = { ...saved, taskReferences: references };
    const exact = isEvidenceAuthorized(entry);
    const requirements = exact ? null : savedEvidenceRequirements(entry, state.current.auth);
    if (!exact && !requirements) return null;
    return { entry, references, requirements };
  }

  /** Görev başına beklenen güncel proje ve kimlik tabanı gereksinimi. */
  const needsIdentity = (requirements, taskId) => Boolean(requirements && (requirements.identities || requirements.identityTaskIds?.has(taskId)));
  /** Görev hâlâ görünür, kayıtlı projesinde ve (gerekiyorsa) kimlik tabanlı mı? */
  const taskStillValid = (current, { taskId, projectId }, identity) => {
    const row = current.get(taskId);
    return Boolean(row) && (!projectId || row.projectId === projectId) && (!identity || row.identityBase);
  };
  /** WBS ata yolunun bütün düğümleri hâlâ güncel kapsamda görünür olmalıdır. */
  const wbsNodes = (result) => ({
    truncated: result.truncated,
    byId: new Map(result.nodes.map(row => [canonicalActualId(row.WbsId), row]))
  });
  const wbsStillValid = (nodes, requirements) => !nodes.truncated && requirements.wbsAncestorNodes.every(({ id, parentId }) => {
    const row = nodes.byId.get(id);
    return row && (row.ParentWbsId == null ? null : canonicalActualId(row.ParentWbsId)) === parentId;
  });

  /**
   * Kayıtlı kanıtları güncel yetkiyle doğrular: her proje güncel erişim
   * düzeyiyle, her katkı görevi sınırlı toplu okumayla denetlenir. Doğrulanan
   * kanıt kimlikleri döner.
   */
  async function revalidateEvidence(entries, signal) {
    // Nüfusu kalıcı kayda sığmayan kanıt güncel yetkiyle doğrulanamaz.
    const authorized = new Set();
    for (const saved of entries) {
      if (signal.aborted) throw signal.reason;
      const prepared = preparedEvidence(saved);
      if (!prepared) continue;
      const { entry, references, requirements } = prepared;
      const payload = JSON.parse(entry.payload || '{}');
      const projectIds = [...new Set([...(entry.scopedAuthorization?.projectIds || []), ...(requirements?.projectIds || []),
        payload.entity?.type === 'project' ? payload.entity.id : null].filter(Boolean))];
      // Kayıtlı erişim düzeyi bilinen proje, güncel düzeyi ondan düşük değilse açılır; düzeyi bilinmeyen proje tam erişim ister.
      const required = (row) => (requirements?.fullProjects ? PROJECT_ACCESS_RANK.FULL
        : requirements?.projectLevels ? requirements.projectLevels.get(canonicalActualId(row.ProjectId)) ?? PROJECT_ACCESS_RANK.FULL : 0);
      let valid = true;
      for (let start = 0; start < projectIds.length; start += limits.maxAnalyzedTasks) {
        const projectChunk = projectIds.slice(start, start + limits.maxAnalyzedTasks);
        const projects = await withSql(signal, (executor) => readProjectSearch(executor, state.current.scope,
          { projectIds: projectChunk, text: '', limit: projectChunk.length }), { authorizationOnly: true });
        if (projects.rows.length !== projectChunk.length || projects.rows.some(row => currentProjectRank(row) < required(row))) { valid = false; break; }
      }
      if (!valid) continue;
      for (let start = 0; start < references.length; start += limits.maxAnalyzedTasks) {
        const chunk = references.slice(start, start + limits.maxAnalyzedTasks);
        const current = await withSql(signal, (executor) => readVisibleTasks(executor, state.current.scope, chunk.map((row) => row.taskId)), { authorizationOnly: true });
        if (!chunk.every((reference) => taskStillValid(current, reference, needsIdentity(requirements, reference.taskId)))) { valid = false; break; }
      }
      if (valid && requirements?.wbsAncestorNodes) {
        // Yönetim kapsamındaki WBS ata düğümleri yalnızca güncel ağaçta görünürlerse yeniden açılır.
        let nodes = wbsByProject.get(requirements.wbsProjectId);
        if (!nodes) {
          const result = await withSql(signal, (executor) => readWbs(executor, state.current.scope, {
            projectId: requirements.wbsProjectId, today, maxRows: limits.maxAnalyzedTasks
          }), { authorizationOnly: true });
          nodes = wbsNodes(result);
          wbsByProject.set(requirements.wbsProjectId, nodes);
        }
        valid = wbsStillValid(nodes, requirements);
      }
      if (valid) authorized.add(entry.id);
    }
    return authorized;
  }

  /**
   * Açıklamadan hemen önceki son görev denetimi. Yetki dönemi görev→proje
   * ilişkisini kapsamaz: aynı dönemde gizli projeye taşınan görev ancak bu
   * okumayla yakalanır. Bütün kanıtların görevleri tekilleştirilip sınırlı
   * parçalarla bir kez okunur (görev başına sorgu yoktur); tutarsız ya da
   * doğrulanamayan kanıt düşer. Okuma hatası çağırana iletilir (kapalı ret).
   */
  async function recheckEvidenceTasks(entries, signal) {
    const expected = new Map();
    const wbsChecks = new Map();
    const failed = new Set();
    for (const saved of entries) {
      if (signal.aborted) throw signal.reason;
      const prepared = preparedEvidence(saved);
      if (!prepared) { failed.add(saved); continue; }
      for (const reference of prepared.references) {
        const identity = needsIdentity(prepared.requirements, reference.taskId);
        const known = expected.get(reference.taskId);
        const obligation = { entry: saved, projectId: reference.projectId, identity };
        if (!known) expected.set(reference.taskId, { taskId: reference.taskId, obligations: [obligation] });
        else known.obligations.push(obligation);
      }
      if (prepared.requirements?.wbsAncestorNodes) {
        const projectId = prepared.requirements.wbsProjectId;
        if (!wbsChecks.has(projectId)) wbsChecks.set(projectId, []);
        wbsChecks.get(projectId).push({ entry: saved, requirements: prepared.requirements });
      }
    }
    const tasks = [...expected.values()];
    for (let start = 0; start < tasks.length; start += limits.maxAnalyzedTasks) {
      const chunk = tasks.slice(start, start + limits.maxAnalyzedTasks);
      const current = await withSql(signal, (executor) => readVisibleTasks(executor, state.current.scope, chunk.map((row) => row.taskId)), { authorizationOnly: true });
      for (const task of chunk) {
        for (const obligation of task.obligations) {
          if (!taskStillValid(current, { taskId: task.taskId, projectId: obligation.projectId }, obligation.identity)) failed.add(obligation.entry);
        }
      }
    }
    // Görev aynı projede başka WBS düğümüne taşınmışsa yetki dönemi değişmeyebilir.
    // Son ata denetimi ilk doğrulamadaki önbelleği kullanmaz; proje başına tek sorgudur.
    for (const [projectId, checks] of wbsChecks) {
      if (checks.every(({ entry }) => failed.has(entry))) continue;
      const result = await withSql(signal, (executor) => readWbs(executor, state.current.scope, {
        projectId, today, maxRows: limits.maxAnalyzedTasks
      }), { authorizationOnly: true });
      const current = wbsNodes(result);
      for (const { entry, requirements } of checks) if (!wbsStillValid(current, requirements)) failed.add(entry);
    }
    return new Set(entries.filter((entry) => !failed.has(entry)));
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
