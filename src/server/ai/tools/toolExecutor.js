import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { recordAiToolCall } from '../aiTelemetry.js';
import { parseToolArguments } from './toolArguments.js';
import { isTurnFatal, TOOL_ERROR_CODES, ToolError, toToolError } from './toolErrors.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { getRotaTool } from './toolRegistry.js';

/**
 * Araç çağrılarının SINIRLI yürütücüsü.
 *
 * Model yalnızca kayıtlı bir aracı ve şemaya uyan bağımsız değişkenleri
 * seçebilir. Yürütücü, bir model yanıtındaki çağrıları (en fazla
 * `maxCallsPerRound`) sınırlı eşzamanlılıkla, her biri kendi süre sınırıyla
 * çalıştırır; tur boyunca toplam çağrı, toplam sonuç boyutu ve araç evresinin
 * duvar saati sınırlıdır. Sınırı aşan çağrı yürütülmez, güvenli hata alır.
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

/** En büyük listeyi yarılayarak sonucu boyut sınırına indirir; olmuyorsa `null`. */
function shrinkToFit(envelope, maxBytes) {
  let current = envelope;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const text = JSON.stringify(current);
    if (byteLength(text) <= maxBytes) return text;
    const data = current.data;
    let largest = null;
    for (const [key, value] of Object.entries(data || {})) {
      if (Array.isArray(value) && value.length > 1 && (!largest || value.length > data[largest].length)) largest = key;
    }
    if (!largest) return null;
    current = {
      ...current,
      truncated: true,
      complete: false,
      nextCursor: null,
      returnedCount: current.returnedCount === data[largest].length
        ? Math.ceil(data[largest].length / 2)
        : current.returnedCount,
      data: {
        ...data,
        [largest]: data[largest].slice(0, Math.ceil(data[largest].length / 2)),
        sizeNote: 'Sonuç boyut sınırı nedeniyle kısaltıldı; daha dar bir süzgeçle yeniden sorgulayın.'
      }
    };
  }
  return null;
}

export function createToolExecutor({
  context,
  ledger,
  signal,
  limits = TOOL_LIMITS,
  resolveTool = getRotaTool,
  onProgress = null,
  clock = Date.now
}) {
  const state = { calls: 0, resultBytes: 0, startedAt: null, attempted: 0, failures: 0 };

  function phaseRemainingMs() {
    if (state.startedAt == null) return limits.maxToolPhaseMs;
    return Math.max(0, limits.maxToolPhaseMs - (clock() - state.startedAt));
  }

  /**
   * Tek çağrı: doğrulama → yürütme. Sonuç `{ outcome }` ya da aynı model
   * yanıtındaki özdeş çağrı için `{ sameAs }`dir.
   */
  async function execute(call, tool, pending, index) {
    if (call.oversize) throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$:tooLarge'] });
    const args = parseToolArguments(tool.parameters, call.arguments);
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
        sql: (work) => context.sql(deadline.signal, work)
      });
      const outcome = await raceWithAbort(() => tool.handler(args, scoped), deadline.signal);
      return { outcome, cacheKey };
    } catch (error) {
      const failure = deadline.failure();
      if (failure?.code === AI_ERROR_CODES.AI_CANCELLED) throw failure;
      if (failure) throw new ToolError(TOOL_ERROR_CODES.TIMEOUT);
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  function envelopeFor(tool, outcome, generatedAt) {
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
      data: outcome.data
    };
  }

  /** Bir model yanıtındaki araç çağrılarını yürütür; çağrı sırasıyla araç iletileri döner. */
  async function runRound(toolCalls = []) {
    if (state.startedAt == null) state.startedAt = clock();
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
        const envelope = envelopeFor(plan.tool, result.outcome, result.generatedAt);
        const text = shrinkToFit(envelope, limits.maxResultBytes - 64);
        if (!text) {
          code = TOOL_ERROR_CODES.RESULT_TOO_LARGE;
          content = JSON.stringify(errorEnvelope(name, new ToolError(code)));
        } else if (state.resultBytes + byteLength(text) > limits.maxTotalResultBytes) {
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
            highlights: result.outcome.evidence?.highlights || []
          });
          content = JSON.stringify({ ...shrunk, evidenceId: id });
          if (id) ledger.attachPayload(id, content);
        }
      }
      if (repeated && state.resultBytes + byteLength(content) > limits.maxTotalResultBytes) {
        code = TOOL_ERROR_CODES.LIMIT_EXCEEDED;
        content = JSON.stringify(errorEnvelope(name, new ToolError(code)));
      }
      if (code) state.failures += 1;
      contents[index] = content;
      state.resultBytes += byteLength(content);
      if (!repeated && !plan.rejected) {
        recordAiToolCall({ tool: name, code, durationMs: result.durationMs, resultBytes: byteLength(content) });
      }
      return { role: 'tool', toolCallId: plan.call.id, content };
    });
  }

  return Object.freeze({
    runRound,
    stats() {
      return { calls: state.calls, attempted: state.attempted, failures: state.failures, resultBytes: state.resultBytes };
    }
  });
}
