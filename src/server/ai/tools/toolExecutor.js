import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { recordAiToolCall } from '../aiTelemetry.js';
import { parseToolArguments } from './toolArguments.js';
import { isTurnFatal, TOOL_ERROR_CODES, ToolError, toToolError } from './toolErrors.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { getRotaTool } from './toolRegistry.js';
import { fitToolResult } from './toolResultPolicy.js';
import { claimableContract } from '../../../domain/ai/claimableEvidence.js';
import { trackResultText } from './toolResultText.js';

/**
 * Araç çağrılarının SINIRLI yürütücüsü.
 *
 * Model yalnızca kayıtlı bir aracı ve şemaya uyan bağımsız değişkenleri
 * seçebilir. Yürütücü, bir model yanıtındaki çağrıları (en fazla
 * `maxCallsPerRound`) sınırlı eşzamanlılıkla, her biri kendi süre sınırıyla
 * çalıştırır; tur boyunca toplam çağrı, toplam sonuç boyutu ve araç evresinin
 * toplam yürütme süresi sınırlıdır. Sınırı aşan çağrı yürütülmez, güvenli hata alır.
 *
 * Her çağrı TAM BİR araç iletisi üretir (sağlayıcı her çağrı kimliği için bir
 * sonuç bekler). Başarılı sonuç kanıt defterine çağrı sırasıyla (R1, R2 …)
 * kaydedilir; aynı model yanıtında aynı araç ve aynı bağımsız değişkenlerle
 * yinelenen çağrı yeniden SQL çalıştırmaz, önceki sonucu (aynı kanıtı) alır.
 *
 * Oturumun iptali ve kimlik hataları araç sonucu değildir: tur sonlandırılır.
 */

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function errorEnvelope(tool, error) {
  return {
    ok: false,
    tool,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details?.length ? { details: error.details } : {})
    }
  };
}

export function createToolExecutor({
  context,
  ledger,
  signal,
  limits = TOOL_LIMITS,
  resolveTool = getRotaTool,
  onProgress = null,
  validateCall = null,
  clock = Date.now
}) {
  const state = { calls: 0, resultBytes: 0, toolMs: 0, roundStartedAt: null, attempted: 0, failures: 0 };

  function phaseRemainingMs() {
    const running = state.roundStartedAt == null ? 0 : clock() - state.roundStartedAt;
    return Math.max(0, limits.maxToolPhaseMs - state.toolMs - running);
  }

  function fitWithinResultBudget(content, name) {
    const remaining = Math.max(0, limits.maxTotalResultBytes - state.resultBytes);
    if (byteLength(content) <= remaining) return { content, limited: false };
    const limited = JSON.stringify(errorEnvelope(name, new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED)));
    if (byteLength(limited) <= remaining) return { content: limited, limited: true };
    const compact = JSON.stringify({ ok: false, error: { code: TOOL_ERROR_CODES.LIMIT_EXCEEDED } });
    return { content: byteLength(compact) <= remaining ? compact : '', limited: true };
  }

  /**
   * Tek çağrı: doğrulama → yürütme. Sonuç `{ outcome }` ya da aynı model
   * yanıtındaki özdeş çağrı için `{ sameAs }`dir.
   */
  async function execute(call, tool, pending, index) {
    if (call.oversize) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$:tooLarge'] });
    const args = parseToolArguments(tool.parameters, call.arguments);
    validateCall?.(tool.name, args);
    const cacheKey = `${tool.name}\u0000${JSON.stringify(args)}`;
    // Çağrılar sırayla alınır: özdeş çağrının sahibi her zaman daha küçük sıradadır.
    if (pending.has(cacheKey)) return { sameAs: pending.get(cacheKey) };
    pending.set(cacheKey, index);
    const remaining = Math.min(tool.timeoutMs, phaseRemainingMs());
    if (remaining < 250) throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED);
    const deadline = createAiDeadline({ timeoutMs: remaining, parentSignal: signal, now: clock });
    try {
      const scoped = Object.freeze({
        sicil: context.sicil,
        today: context.today,
        now: context.now,
        signal: deadline.signal,
        authorization: () => context.authorization(deadline.signal),
        sql: (work) => context.sql(deadline.signal, work),
        snapshot: (key, cursor, load) => context.snapshot(key, cursor, load)
      });
      await context.authorization?.(deadline.signal);
      const outcome = await raceWithAbort(() => trackResultText(() => tool.handler(args, scoped)), deadline.signal);
      return { outcome, cacheKey, args };
    } catch (error) {
      const failure = deadline.failure();
      if (failure?.code === AI_ERROR_CODES.AI_CANCELLED) throw failure;
      if (error?.code === TOOL_ERROR_CODES.BUSY) throw error;
      if (failure) throw new ToolError(context.timeoutCode?.(deadline.signal) || TOOL_ERROR_CODES.TIMEOUT);
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  function envelopeFor(tool, outcome, generatedAt, args) {
    return {
      ok: true,
      evidenceId: null,
      tool: tool.name,
      generatedAt,
      today: context.today,
      scope: outcome.scope,
      complete: Boolean(outcome.complete),
      truncated: Boolean(outcome.truncated),
      returnedCount: outcome.returnedCount ?? null,
      totalCount: outcome.totalCount ?? null,
      nextCursor: outcome.nextCursor ?? null,
      subject: outcome.evidence?.entity?.name || outcome.evidence?.label || 'Rota',
      claimable: claimableContract(tool.name, args.textFields || []),
      data: outcome.data
    };
  }

  /** Bir model yanıtındaki araç çağrılarını yürütür; çağrı sırasıyla araç iletileri döner. */
  async function executeRound(toolCalls = []) {
    context.beginRound();
    const plans = toolCalls.map((call, index) => {
      if (index >= limits.maxCallsPerRound || phaseRemainingMs() <= 0) {
        return { call, tool: null, rejected: new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED) };
      }
      state.attempted += 1;
      if (state.attempted > limits.maxTotalCalls) {
        return { call, tool: null, rejected: new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED) };
      }
      const tool = resolveTool(call.name);
      if (!tool) return { call, tool: null, rejected: new ToolError(TOOL_ERROR_CODES.UNKNOWN_TOOL) };
      state.calls += 1;
      return { call, tool, rejected: null };
    });

    const results = new Array(plans.length);
    const pending = new Map();
    let next = 0;
    const worker = async () => {
      while (next < plans.length) {
        const index = next;
        next += 1;
        const plan = plans[index];
        if (plan.rejected) {
          results[index] = { error: plan.rejected, durationMs: 0 };
          continue;
        }
        onProgress?.({ topic: plan.tool.topic });
        const startedAt = clock();
        try {
          results[index] = { ...(await execute(plan.call, plan.tool, pending, index)), durationMs: clock() - startedAt, generatedAt: new Date().toISOString() };
        } catch (error) {
          if (isTurnFatal(error)) throw error;
          results[index] = { error: toToolError(error), durationMs: clock() - startedAt };
        }
      }
    };
    const workers = Array.from({ length: Math.min(limits.roundConcurrency, plans.length) }, () => worker());
    const settled = await Promise.allSettled(workers);
    const fatal = settled.find((item) => item.status === 'rejected');
    if (fatal) throw fatal.reason;

    if (context.authorizationEpoch?.()) ledger.invalidateAuthorization(context.authorizationEpoch());

    // Kanıt kimlikleri tamamlanma sırasıyla değil ÇAĞRI sırasıyla verilir.
    const contents = new Array(plans.length);
    return plans.map((plan, index) => {
      const result = results[index];
      const name = plan.tool?.name || String(plan.call.name || 'unknown').slice(0, 64);
      const repeated = result.sameAs != null;
      let content;
      let code = null;
      if (result.sameAs != null) {
        content = contents[result.sameAs];
      } else if (result.error) {
        code = result.error.code;
        content = JSON.stringify(errorEnvelope(name, result.error));
      } else {
        const envelope = envelopeFor(plan.tool, result.outcome, result.generatedAt, result.args);
        const text = fitToolResult(envelope, limits.maxResultBytes - 64, ledger.factPrefix(), plan.tool.resultPolicy);
        if (!text) {
          code = TOOL_ERROR_CODES.RESULT_TOO_LARGE;
          content = JSON.stringify(errorEnvelope(name, new ToolError(code)));
        } else if (fitWithinResultBudget(JSON.stringify({ ...JSON.parse(text), evidenceId: `R${ledger.size() + 1}` }), name).limited) {
          code = TOOL_ERROR_CODES.LIMIT_EXCEEDED;
          content = JSON.stringify(errorEnvelope(name, new ToolError(code)));
        } else {
          const shrunk = JSON.parse(text);
          const id = ledger.register({
            tool: plan.tool.name,
            kind: plan.tool.evidenceKind,
            label: result.outcome.evidence?.label,
            entity: result.outcome.evidence?.entity ?? null,
            generatedAt: shrunk.generatedAt,
            complete: shrunk.complete,
            truncated: shrunk.truncated,
            partial: shrunk.scope?.kind === 'authorized-task-subset',
            counts: { returned: shrunk.returnedCount, total: shrunk.totalCount },
            highlights: shrunk.truncated ? [] : (result.outcome.evidence?.highlights || []),
            authorizationEpoch: context.authorizationEpoch?.() ?? null
          });
          content = JSON.stringify({ ...shrunk, evidenceId: id });
          if (id) ledger.attachPayload(id, content);
        }
      }
      const budgeted = fitWithinResultBudget(content, name);
      if (budgeted.limited) code = TOOL_ERROR_CODES.LIMIT_EXCEEDED;
      content = budgeted.content;
      if (code) state.failures += 1;
      contents[index] = content;
      state.resultBytes += byteLength(content);
      if (!repeated && !plan.rejected) {
        recordAiToolCall({ tool: name, code, durationMs: result.durationMs, resultBytes: byteLength(content) });
      }
      return { role: 'tool', toolCallId: plan.call.id, content };
    });
  }

  async function runRound(toolCalls = []) {
    state.roundStartedAt = clock();
    try {
      return await executeRound(toolCalls);
    } finally {
      state.toolMs += Math.max(0, clock() - state.roundStartedAt);
      state.roundStartedAt = null;
    }
  }

  return Object.freeze({
    runRound,
    stats() {
      return { calls: state.calls, attempted: state.attempted, failures: state.failures, resultBytes: state.resultBytes };
    }
  });
}
