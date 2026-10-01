import 'server-only';
import { ASSISTANT_STREAM_PHASES } from '../../../domain/ai/assistantContract.js';
import {
  analyzeDirectAnswer,
  analyzeGroundedAnswer,
  analyzeUngroundedAnswer,
  containsCitationMarker,
  GROUNDING_FAILED_FINISH_REASON,
  groundingFailureText,
  replyLocale,
  groundingRepairInstruction,
  normalizeCitations,
  requiresRotaEvidence,
  withScopeDisclosure
} from '../../../domain/ai/evidenceContract.js';
import { recordGroundedAnswer } from '../aiTelemetry.js';
import { createEvidenceLedger } from '../tools/evidenceLedger.js';
import { createToolExecutor } from '../tools/toolExecutor.js';
import { getRotaTool } from '../tools/toolRegistry.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';

/**
 * Rota verisine dayanan yanıtın SINIRLI döngüsü.
 *
 * 1. Model yanıtı ya da araç çağrısı üretir (araç turu en fazla
 *    `maxToolRounds`; sonrasında araçlar kapatılır ve model eldeki kanıtla
 *    yanıtlar).
 * 2. Araçlar sunucuda, yetkiyle ve sınırlarla çalışır; başarılı sonuçlar
 *    kanıt olur (R1, R2 …).
 * 3. Son yanıt BELİRLENİMCİ olarak doğrulanır: atıflar bu turun kanıtlarına
 *    işaret etmeli, kanıta dayanan bloklar atıflı olmalı; kanıt yokken atıf
 *    kullanılamaz. İkinci bir dil modeli yargıç olarak kullanılmaz.
 * 4. Doğrulanamayan yanıt BİR kez düzeltilir; yine doğrulanamazsa kullanıcı
 *    sabit güvenli iletiyi görür (uydurma kanıtlı yanıt hiçbir zaman gösterilmez).
 *
 * Akış dürüsttür: kanıta dayanan yanıt doğrulanmadan gösterilmez ve tek
 * parça gönderilir (sahte karakter akışı yoktur). Araç kullanmayan genel
 * yanıt, ilk satırlar araç çağrısı ya da atıf işareti taşımadığı anlaşıldıktan
 * sonra gerçek zamanlı akar; sonradan araç çağrısı ya da düzeltme gerekirse
 * tarayıcıya `revise` gönderilir ve gösterilen taslak kaldırılır.
 */

/** Genel yanıtın canlı akışa açılması için gereken en küçük taslak. */
export const LIVE_RELEASE_CHARS = 160;
const LIVE_RELEASE_LINES = 2;

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

/** This plan reads trusted user messages only, never tool-result text. */
export function toolIntentAllowlist(text, catalog, priorUserMessages = []) {
  const source = String(text || '');
  const context = source.length < 80 ? `${priorUserMessages.slice(-1).join(' ')} ${source}` : source;
  if (/(?:her şeyi|tüm alanları|everything|all domains)/iu.test(source)) return new Set(catalog.map((tool) => tool.name));
  const names = new Set();
  const add = (...tools) => tools.forEach((tool) => names.add(tool));
  if (/(?:görev|task|termin|deadline|ilerleme|progress|gecik|overdue)/iu.test(context)) add('rota_task_search', 'rota_task_detail', 'rota_task_analytics', 'rota_project_search');
  if (/(?:proje|project)/iu.test(context)) add('rota_project_search', 'rota_project_detail', 'rota_task_search', 'rota_task_detail', 'rota_task_analytics');
  if (/(?:portföy|portfolio|hangi projede|en çok|most overdue)/iu.test(context)) add('rota_portfolio_summary', 'rota_project_search', 'rota_project_detail', 'rota_task_analytics');
  if (/(?:iş yük|workload|personel|person|kişi|people|çalışan|employee)/iu.test(context)) add('rota_workload_summary', 'rota_person_search', 'rota_task_search', 'rota_task_analytics');
  if (/(?:sorumlu|assignee|owner|kim|who)/iu.test(context)) add('rota_person_search', 'rota_task_search', 'rota_task_detail', 'rota_workload_summary');
  if (/(?:wbs|iş dağılım)/iu.test(context)) add('rota_wbs_inspect', 'rota_project_search', 'rota_task_search');
  if (/(?:hareket|activity|kim ne yaptı|who did what)/iu.test(context)) add('rota_activity_search', 'rota_task_search');
  if (/(?:tarih değişikli|schedule request)/iu.test(context)) add('rota_schedule_requests', 'rota_task_detail');
  if (/(?:atama|assignment)/iu.test(context)) add('rota_assignment_requests', 'rota_task_detail');
  if (/(?:bildirim|notification)/iu.test(context)) add('rota_notifications');
  if (/(?:baz plan|baseline)/iu.test(context)) add('rota_baseline_compare', 'rota_project_search', 'rota_project_detail');
  if (/(?:bağımlılık|dependenc)/iu.test(context)) add('rota_dependency_inspect', 'rota_project_search', 'rota_task_detail');
  if (/(?:tekrar|recurren)/iu.test(context)) add('rota_recurrence_inspect', 'rota_task_search', 'rota_task_detail');
  if (/(?:takvim|calendar|çalışma günü|working day)/iu.test(context)) add('rota_calendar_inspect', 'rota_project_search');
  if (/outlook/iu.test(context)) add('rota_outlook_status', 'rota_task_search');
  if (/(?:veri kalite|data quality)/iu.test(context)) add('rota_data_quality', 'rota_project_search');
  return names;
}

/** Keep system/current request and complete tool exchanges; drop oldest history first. */
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
  const normalized = normalizeCitations(text);
  if (evidenceIds.length) return {
    normalized,
    kind: 'grounded',
    ...analyzeGroundedAnswer(normalized, { evidenceIds, evidencePayloads, locale })
  };
  if (toolsAttempted) return { normalized, kind: 'ungrounded', ...analyzeUngroundedAnswer(normalized, { evidenceRequired }) };
  return { normalized, kind: 'direct', ...analyzeDirectAnswer(normalized, { evidenceRequired }) };
}

export async function runGroundedTurn(session, {
  messages,
  catalog,
  context,
  limits = TOOL_LIMITS,
  onStatus = null,
  onText,
  onRevise = null
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
    priorUserMessages: userMessages.slice(0, -1).map((message) => message.content)
  });
  const priorUsers = userMessages.slice(0, -1).map((message) => message.content);
  const locale = replyLocale(currentUser?.content);
  const intentTools = toolIntentAllowlist(currentUser?.content, catalog, priorUsers);
  let toolRounds = 0;
  let modelRounds = 0;
  let toolsAttempted = false;
  let repairsLeft = limits.maxRepairRounds;
  let repaired = false;
  let allowTools = true;
  let liveAllowed = !evidenceRequired;
  let streamed = false;

  const revise = () => {
    if (!streamed) return;
    streamed = false;
    onRevise?.();
  };

  for (;;) {
    const canCallTools = allowTools && toolRounds < limits.maxToolRounds;
    const live = { buffer: '', released: false, sawToolCall: false };
    modelRounds += 1;
    boundTranscript(transcript);
    const result = await session.round({
      messages: transcript,
      tools: permittedTools ? catalog.filter((tool) => permittedTools.has(tool.name)) : catalog,
      toolChoice: canCallTools ? 'auto' : 'none',
      onEvent: async (event) => {
        if (event.type === 'thinking') status(ASSISTANT_STREAM_PHASES.THINKING);
        else if (event.type === 'generating') status(ASSISTANT_STREAM_PHASES.GENERATING);
        else if (event.type === 'tool_call_started' && canCallTools) {
          live.sawToolCall = true;
          // Canlı gösterilen ön söz bir araç çağrısının girişiydi; kaldırılır.
          if (live.released) revise();
          liveAllowed = false;
        } else if (event.type === 'text') {
          if (!liveAllowed || live.sawToolCall) return;
          if (live.released) {
            await onText(event.text);
            return;
          }
          live.buffer += event.text;
          const lines = (live.buffer.match(/\n/g) || []).length;
          if (!containsCitationMarker(live.buffer) && (live.buffer.length >= LIVE_RELEASE_CHARS || lines >= LIVE_RELEASE_LINES)) {
            live.released = true;
            streamed = true;
            await onText(live.buffer);
          }
        }
      }
    });

    if (result.toolCalls.length && canCallTools) {
      revise();
      liveAllowed = false;
      toolsAttempted = true;
      toolRounds += 1;
      const toolMessages = await executor.runRound(result.toolCalls);
      transcript.push({ role: 'assistant', content: result.text || '', toolCalls: safeToolCallsForTranscript(result.toolCalls, toolMessages) });
      transcript.push(...toolMessages);
      if (ledger.size() > 0) permittedTools = intentTools;
      if (toolRounds >= limits.maxToolRounds) appendServerInstruction(transcript, roundLimitNote());
      continue;
    }

    const text = String(result.text || '').trim();
    if (!streamed) status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verdict = analyze(text, {
      evidenceIds: ledger.ids(),
      evidencePayloads: ledger.payloads(),
      toolsAttempted,
      evidenceRequired,
      locale
    });
    if (verdict.ok) {
      const cited = ledger.summaries(verdict.citedIds);
      const disclosure = verdict.kind === 'grounded' ? withScopeDisclosure(verdict.normalized, cited, locale) : { text, disclosed: false };
      const finalText = verdict.kind === 'grounded' ? disclosure.text : text;
      if (!streamed) await onText(finalText);
      const outcome = verdict.kind === 'grounded' ? 'grounded' : 'direct';
      recordGroundedAnswer({ outcome, rounds: modelRounds, evidence: cited.length, repaired, disclosed: disclosure.disclosed });
      return {
        text: finalText,
        finishReason: result.finishReason || 'stop',
        outcome,
        evidence: cited,
        evidenceRows: ledger.persistable(verdict.citedIds),
        streamedLive: streamed,
        repaired,
        disclosed: disclosure.disclosed,
        stats: { modelRounds, toolRounds, ...executor.stats(), ...context.stats() }
      };
    }

    revise();
    liveAllowed = false;
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
