import 'server-only';
import { ASSISTANT_STREAM_PHASES } from '../../../domain/ai/assistantContract.js';
import {
  analyzeDirectAnswer,
  analyzeGroundedAnswer,
  analyzeUngroundedAnswer,
  containsCitationMarker,
  GROUNDING_FAILED_FINISH_REASON,
  GROUNDING_FAILURE_TEXT,
  groundingRepairInstruction,
  normalizeCitations,
  requiresRotaEvidence,
  withScopeDisclosure
} from '../../../domain/ai/evidenceContract.js';
import { recordGroundedAnswer } from '../aiTelemetry.js';
import { createEvidenceLedger } from '../tools/evidenceLedger.js';
import { createToolExecutor } from '../tools/toolExecutor.js';
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

function analyze(text, { evidenceIds, evidencePayloads, toolsAttempted, evidenceRequired }) {
  const normalized = normalizeCitations(text);
  if (evidenceIds.length) return {
    normalized,
    kind: 'grounded',
    ...analyzeGroundedAnswer(normalized, { evidenceIds, evidencePayloads })
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
  const executor = createToolExecutor({
    context,
    ledger,
    signal: session.signal,
    limits,
    onProgress: ({ topic }) => status(ASSISTANT_STREAM_PHASES.TOOLS, { topic })
  });
  const transcript = [...messages];
  const currentUser = [...messages].reverse().find((message) => message.role === 'user');
  const evidenceRequired = requiresRotaEvidence(currentUser?.content);
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
    const result = await session.round({
      messages: transcript,
      tools: catalog,
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
      transcript.push({ role: 'assistant', content: result.text || '', toolCalls: result.toolCalls });
      transcript.push(...await executor.runRound(result.toolCalls));
      if (toolRounds >= limits.maxToolRounds) transcript.push({ role: 'system', content: roundLimitNote() });
      continue;
    }

    const text = String(result.text || '').trim();
    if (!streamed) status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verdict = analyze(text, {
      evidenceIds: ledger.ids(),
      evidencePayloads: ledger.payloads(),
      toolsAttempted,
      evidenceRequired
    });
    if (verdict.ok) {
      const cited = ledger.summaries(verdict.citedIds);
      const disclosure = verdict.kind === 'grounded' ? withScopeDisclosure(verdict.normalized, cited) : { text, disclosed: false };
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
      transcript.push({ role: 'assistant', content: text || '…' });
      transcript.push({ role: 'system', content: groundingRepairInstruction(verdict.issues) });
      // Kanıt varken düzeltme yalnızca yeniden yazımdır; kanıt yoksa model
      // gereken aracı çağırabilir (araç turu sınırı sürer).
      allowTools = ledger.size() === 0;
      continue;
    }

    await onText(GROUNDING_FAILURE_TEXT);
    recordGroundedAnswer({ outcome: 'failed', rounds: modelRounds, evidence: 0, repaired });
    return {
      text: GROUNDING_FAILURE_TEXT,
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
