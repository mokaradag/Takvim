import 'server-only';
import { ASSISTANT_STREAM_PHASES } from '../../../domain/ai/assistantContract.js';
import {
  analyzeDirectAnswer,
  analyzeGroundedAnswer,
  analyzeUngroundedAnswer,
  GROUNDING_FAILED_FINISH_REASON,
  groundingFailureText,
  replyLocale,
  groundingRepairInstruction,
  requiresRotaEvidence,
  withScopeDisclosure
} from '../../../domain/ai/evidenceContract.js';
import { recordGroundedAnswer } from '../aiTelemetry.js';
import { createEvidenceLedger } from '../tools/evidenceLedger.js';
import { createToolExecutor } from '../tools/toolExecutor.js';
import { getRotaTool } from '../tools/toolRegistry.js';
import { parseEvidenceResponse } from '../../../domain/ai/evidenceVerification.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';

/**
 * Rota verisine dayanan yanıtın SINIRLI döngüsü.
 *
 * 1. Model yanıtı ya da araç çağrısı üretir (araç turu en fazla
 *    `maxToolRounds`; sonrasında araçlar kapatılır ve model eldeki kanıtla
 *    yanıtlar).
 * 2. Araçlar sunucuda, yetkiyle ve sınırlarla çalışır; başarılı sonuçlar
 *    kanıt olur (R1, R2 …).
 * 3. Son iddiaların tur, kayıt, alan ve türlü değeri sunucuda doğrulanır.
 *    İkinci bir dil modeli yargıç olarak kullanılmaz.
 * 4. Doğrulanamayan yanıt BİR kez düzeltilir; yine doğrulanamazsa kullanıcı
 *    sabit güvenli iletiyi görür (uydurma kanıtlı yanıt hiçbir zaman gösterilmez).
 *
 * Yapılandırılmış son karar doğrulanmadan hiçbir model metni gösterilmez.
 */

function roundLimitNote() {
  return 'SUNUCU DOĞRULAMASI: Araç çağrı sınırına ulaşıldı. Yeni araç çağırma; yalnızca eldeki kanıtlarla yanıtla ve eksik kalan kısmı açıkça belirt.';
}

function appendServerInstruction(transcript, instruction) {
  const systemIndex = transcript.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) {
    transcript.unshift({ role: 'system', content: instruction });
    return;
  }
  const current = transcript[systemIndex];
  transcript[systemIndex] = { ...current, content: `${current.content}\n\n${instruction}` };
}

function safeToolCallsForTranscript(toolCalls, toolMessages) {
  return toolCalls.map((call, index) => {
    let rejected = true;
    try {
      rejected = JSON.parse(String(toolMessages[index]?.content || '{}')).ok === false;
    } catch {
      rejected = true;
    }
    return rejected ? { ...call, arguments: '{}' } : call;
  });
}

const TOOL_FOLLOW_UPS = Object.freeze({
  rota_task_search: ['rota_task_detail', 'rota_task_analytics', 'rota_project_search'],
  rota_project_search: ['rota_project_detail', 'rota_task_search', 'rota_task_detail', 'rota_task_analytics', 'rota_wbs_inspect', 'rota_calendar_inspect', 'rota_baseline_compare', 'rota_dependency_inspect', 'rota_data_quality'],
  rota_person_search: ['rota_workload_summary', 'rota_task_search', 'rota_task_analytics'],
  rota_task_detail: ['rota_task_search', 'rota_task_analytics', 'rota_dependency_inspect', 'rota_recurrence_inspect', 'rota_activity_search'],
  rota_portfolio_summary: ['rota_project_search', 'rota_project_detail', 'rota_task_analytics', 'rota_wbs_inspect'],
  rota_workload_summary: ['rota_person_search', 'rota_task_search', 'rota_task_analytics'],
  rota_baseline_compare: ['rota_project_search', 'rota_project_detail'],
  rota_dependency_inspect: ['rota_project_search', 'rota_task_detail'],
  rota_recurrence_inspect: ['rota_task_search', 'rota_task_detail'],
  rota_calendar_inspect: ['rota_project_search'],
  rota_activity_search: ['rota_task_search', 'rota_task_detail'],
  rota_schedule_requests: ['rota_task_detail'], rota_assignment_requests: ['rota_task_detail'],
  rota_outlook_status: ['rota_task_search', 'rota_task_detail'], rota_data_quality: ['rota_task_search']
});

export function toolsForInitialCalls(calls, catalog) {
  const registered = new Set(catalog.map((tool) => tool.name));
  const names = new Set();
  for (const call of calls) {
    if (!registered.has(call.name)) continue;
    names.add(call.name);
    for (const name of TOOL_FOLLOW_UPS[call.name] || []) if (registered.has(name)) names.add(name);
  }
  return names;
}

/** Sistem ve güncel isteği korur; önce eski geçmişi, sonra tam araç kümelerini atar. */
function boundTranscript(transcript) {
  while (transcript.length > 96) {
    const currentUserIndex = transcript.findLastIndex((message) => message.role === 'user');
    const historyIndex = transcript.findIndex((message, index) => index < currentUserIndex && message.role !== 'system');
    if (historyIndex >= 0) { transcript.splice(historyIndex, 1); continue; }
    const exchangeIndex = transcript.findIndex((message) => message.role === 'assistant' && message.toolCalls?.length);
    if (exchangeIndex < 0) break;
    let end = exchangeIndex + 1;
    while (transcript[end]?.role === 'tool') end += 1;
    transcript.splice(exchangeIndex, end - exchangeIndex);
  }
}

function analyze(text, { evidenceIds, evidencePayloads, toolsAttempted, evidenceRequired, locale }) {
  const normalized = text;
  if (evidenceIds.length) return {
    normalized,
    kind: 'grounded',
    ...analyzeGroundedAnswer(normalized, { evidenceIds, evidencePayloads, locale })
  };
  const response = parseEvidenceResponse(text);
  if (toolsAttempted && response?.kind === 'unavailable' && Object.keys(response).length === 1) {
    const safe = groundingFailureText(locale);
    return { normalized: safe, kind: 'ungrounded', ...analyzeUngroundedAnswer(safe) };
  }
  if (toolsAttempted) return { normalized, kind: 'ungrounded', ...analyzeUngroundedAnswer(normalized, { evidenceRequired }) };
  if (response?.kind === 'general' && typeof response.text === 'string' && Object.keys(response).length === 2) {
    return { normalized: response.text, kind: 'direct', ...analyzeDirectAnswer(response.text, { evidenceRequired }) };
  }
  return { normalized, kind: 'direct', ok: false, citedIds: [], issues: [{ code: 'ANSWER_INTENT_REQUIRED' }] };
}

export async function runGroundedTurn(session, {
  messages,
  catalog,
  context,
  limits = TOOL_LIMITS,
  priorGrounded = false,
  onStatus = null,
  onText
}) {
  const ledger = createEvidenceLedger();
  const status = (phase, extra = {}) => onStatus?.({ phase, ...extra });
  let permittedTools = null;
  const executor = createToolExecutor({
    resolveTool: (name) => !permittedTools || permittedTools.has(name) ? getRotaTool(name) : null,
    context,
    ledger,
    signal: session.signal,
    limits,
    onProgress: ({ topic }) => status(ASSISTANT_STREAM_PHASES.TOOLS, { topic })
  });
  const transcript = [...messages];
  const userMessages = messages.filter((message) => message.role === 'user');
  const currentUser = userMessages.at(-1);
  const evidenceRequired = requiresRotaEvidence(currentUser?.content, {
    priorGrounded
  });
  const locale = replyLocale(currentUser?.content);
  let toolRounds = 0;
  let modelRounds = 0;
  let toolsAttempted = false;
  let repairsLeft = limits.maxRepairRounds;
  let repaired = false;
  let allowTools = true;
  for (;;) {
    const canCallTools = allowTools && toolRounds < limits.maxToolRounds;
    modelRounds += 1;
    boundTranscript(transcript);
    const result = await session.round({
      messages: transcript,
      tools: permittedTools ? catalog.filter((tool) => permittedTools.has(tool.name)) : catalog,
      toolChoice: canCallTools ? 'auto' : 'none',
      onEvent: async (event) => {
        if (event.type === 'thinking') status(ASSISTANT_STREAM_PHASES.THINKING);
        else if (event.type === 'generating') status(ASSISTANT_STREAM_PHASES.GENERATING);
      }
    });

    if (result.toolCalls.length && canCallTools) {
      toolsAttempted = true;
      toolRounds += 1;
      if (!permittedTools) {
        const selected = toolsForInitialCalls(result.toolCalls.slice(0, limits.maxCallsPerRound), catalog);
        if (selected.size) permittedTools = selected;
      }
      const toolMessages = await executor.runRound(result.toolCalls);
      transcript.push({ role: 'assistant', content: result.text || '', toolCalls: safeToolCallsForTranscript(result.toolCalls, toolMessages) });
      transcript.push(...toolMessages);
      if (toolRounds >= limits.maxToolRounds) appendServerInstruction(transcript, roundLimitNote());
      continue;
    }

    const text = String(result.text || '').trim();
    status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verdict = analyze(text, {
      evidenceIds: ledger.ids(),
      evidencePayloads: ledger.payloads(),
      toolsAttempted,
      evidenceRequired,
      locale
    });
    if (verdict.ok) {
      const cited = ledger.summaries(verdict.citedIds);
      const disclosure = verdict.kind === 'grounded' ? withScopeDisclosure(verdict.normalized, cited, locale) : { text: verdict.normalized, disclosed: false };
      const finalText = verdict.kind === 'grounded' ? disclosure.text : verdict.normalized;
      await onText(finalText);
      const outcome = verdict.kind === 'grounded' ? 'grounded' : verdict.kind === 'ungrounded' ? 'failed' : 'direct';
      recordGroundedAnswer({ outcome, rounds: modelRounds, evidence: cited.length, repaired, disclosed: disclosure.disclosed });
      return {
        text: finalText,
        finishReason: outcome === 'failed' ? GROUNDING_FAILED_FINISH_REASON : result.finishReason || 'stop',
        outcome,
        evidence: cited,
        evidenceRows: ledger.persistable(verdict.citedIds),
        streamedLive: false,
        repaired,
        disclosed: disclosure.disclosed,
        stats: { modelRounds, toolRounds, ...executor.stats(), ...context.stats() }
      };
    }

    if (repairsLeft > 0) {
      repairsLeft -= 1;
      repaired = true;
      appendServerInstruction(transcript, groundingRepairInstruction(verdict.issues));
      // Kanıt varken düzeltme yalnızca yeniden yazımdır; kanıt yoksa model
      // gereken aracı çağırabilir (araç turu sınırı sürer).
      allowTools = ledger.size() === 0;
      continue;
    }

    const failureText = groundingFailureText(locale);
    await onText(failureText);
    recordGroundedAnswer({ outcome: 'failed', rounds: modelRounds, evidence: 0, repaired });
    return {
      text: failureText,
      finishReason: GROUNDING_FAILED_FINISH_REASON,
      outcome: 'failed',
      evidence: [],
      evidenceRows: [],
      streamedLive: false,
      repaired,
      disclosed: false,
      stats: { modelRounds, toolRounds, ...executor.stats(), ...context.stats() }
    };
  }
}
