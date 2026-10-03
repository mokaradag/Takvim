import 'server-only';
import { ASSISTANT_STREAM_PHASES } from '../../../domain/ai/assistantContract.js';
import {
  analyzeGroundedAnswer,
  analyzeUngroundedAnswer,
  GROUNDING_FAILED_FINISH_REASON,
  groundingFailureText,
  replyLocale,
  groundingRepairInstruction,
  withScopeDisclosure
} from '../../../domain/ai/evidenceContract.js';
import { recordGroundedAnswer } from '../aiTelemetry.js';
import { createEvidenceLedger } from '../tools/evidenceLedger.js';
import { createToolExecutor } from '../tools/toolExecutor.js';
import { getRotaTool } from '../tools/toolRegistry.js';
import { parseEvidenceResponse } from '../../../domain/ai/evidenceVerification.js';
import { isTurnFatal, TOOL_ERROR_CODES } from '../tools/toolErrors.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';
import { createToolScope } from '../tools/toolScope.js';
import { parseTurnRoute, parseTurnWindow, TURN_ROUTES } from '../../../domain/ai/evidenceIntent.js';
import { createAiDeadline } from '../aiDeadline.js';

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

function toolMessageBody(message) {
  try {
    const body = JSON.parse(String(message?.content || '{}'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function safeToolCallsForTranscript(toolCalls, toolMessages) {
  return toolCalls.map((call, index) => {
    const body = toolMessageBody(toolMessages[index]);
    return body?.ok === true ? call : { ...call, arguments: '{}' };
  });
}

/** Proje kimliğiyle daraltılabilen araçlar: ad çözümünden sonra erişilebilir (kapsam sınırı yine uygulanır). */
const PROJECT_SCOPED_FOLLOW_UPS = Object.freeze(['rota_activity_search', 'rota_recurrence_inspect', 'rota_workload_summary', 'rota_schedule_requests', 'rota_assignment_requests']);

const TOOL_FOLLOW_UPS = Object.freeze({
  rota_task_search: ['rota_task_detail', 'rota_task_analytics', 'rota_project_search'],
  rota_project_search: ['rota_project_detail', 'rota_task_search', 'rota_task_detail', 'rota_task_analytics', 'rota_wbs_inspect', 'rota_calendar_inspect', 'rota_baseline_compare', 'rota_dependency_inspect', 'rota_data_quality', ...PROJECT_SCOPED_FOLLOW_UPS],
  rota_person_search: ['rota_workload_summary', 'rota_task_search', 'rota_task_analytics'],
  rota_task_detail: ['rota_task_search', 'rota_task_analytics', 'rota_dependency_inspect', 'rota_recurrence_inspect', 'rota_activity_search'],
  rota_task_analytics: ['rota_task_search', 'rota_task_detail', 'rota_project_search', 'rota_project_detail'],
  rota_project_detail: ['rota_task_search', 'rota_task_detail', 'rota_task_analytics', 'rota_wbs_inspect', 'rota_calendar_inspect', 'rota_baseline_compare', 'rota_dependency_inspect', 'rota_data_quality', ...PROJECT_SCOPED_FOLLOW_UPS],
  rota_wbs_inspect: ['rota_task_search', 'rota_task_analytics', 'rota_project_detail'],
  rota_notifications: ['rota_schedule_requests', 'rota_assignment_requests', 'rota_task_detail'],
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

export function toolsForInitialCalls(calls, catalog, toolMessages = null) {
  const registered = new Set(catalog.map((tool) => tool.name));
  const names = new Set();
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (!registered.has(call.name)) continue;
    if (toolMessages && toolMessageBody(toolMessages[index])?.ok !== true) continue;
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

function analyze(text, { evidenceIds, evidencePayloads, toolsAttempted, toolFailureCodes, route, locale }) {
  const response = parseEvidenceResponse(text);
  const notFoundOnly = evidenceIds.length === 0 && toolFailureCodes.size > 0 && [...toolFailureCodes].every((code) => code === TOOL_ERROR_CODES.NOT_FOUND);
  if (toolsAttempted && notFoundOnly && (response?.kind === 'not_found' || response?.kind === 'unavailable' || analyzeUngroundedAnswer(text, { allowNotFound: true }).ok)) {
    return { ok: true, normalized: locale === 'en' ? 'The record was not found or is not accessible.' : 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.', kind: 'not_found', citedIds: [], issues: [] };
  }
  if (evidenceIds.length) {
    if (response?.kind === 'clarification' && Object.keys(response).length === 2 && Array.isArray(response.claims)) {
      const ambiguousIds = new Set(evidencePayloads.filter((item) => {
        try {
          const data = JSON.parse(item.payload).data;
          return data?.ambiguous === true || data?.titleResolution === 'ambiguous';
        } catch { return false; }
      }).map((item) => item.id));
      if (!response.claims.every((claim) => claim && typeof claim.field === 'string' && ambiguousIds.has(claim.evidenceId)
        && ['data.matches.', 'data.people.', 'data.tasks.'].some((prefix) => claim.field.startsWith(prefix)))) {
        return { ok: false, issues: [{ code: 'CLARIFICATION_CANDIDATES_REQUIRED' }] };
      }
      // Adaylar sunucu kuralıyla korunur: aynı belirsiz sonuçtan en az iki
      // FARKLI aday gerekir ve her aday tek bir numaralı satırdır; kaydedilen
      // sıra (ordinal) kullanıcının gördüğü numarayla aynıdır.
      const candidateOf = (claim) => ({ evidenceId: claim.evidenceId, index: Number(claim.field.split('.')[2]) });
      const candidates = [];
      for (const claim of response.claims) {
        const candidate = candidateOf(claim);
        if (!candidates.some((other) => other.evidenceId === candidate.evidenceId && other.index === candidate.index)) candidates.push(candidate);
      }
      if (candidates.length < 2 || new Set(candidates.map((candidate) => candidate.evidenceId)).size !== 1
        || candidates.some((candidate) => !Number.isInteger(candidate.index) || candidate.index < 0)) {
        return { ok: false, issues: [{ code: 'CLARIFICATION_CANDIDATES_REQUIRED' }] };
      }
      const rows = [];
      const citedIds = [];
      for (const [ordinal, candidate] of candidates.entries()) {
        const claims = response.claims.filter((claim) => {
          const other = candidateOf(claim);
          return other.evidenceId === candidate.evidenceId && other.index === candidate.index;
        });
        const verdict = analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', claims }), { evidenceIds, evidencePayloads, locale });
        if (!verdict.ok) return verdict;
        for (const id of verdict.citedIds) if (!citedIds.includes(id)) citedIds.push(id);
        const parts = verdict.normalized.split('\n').map((line) => line.replace(/^- /, ''));
        rows.push(`${ordinal + 1}. ${parts.join(' ')}`);
      }
      const question = locale === 'en' ? 'Which candidate did you mean?' : 'Hangi adayı kastediyorsunuz?';
      return { ok: true, issues: [], citedIds, kind: 'clarification', candidates, normalized: `${rows.join('\n')}\n\n${question}` };
    }
    return { kind: 'grounded', ...analyzeGroundedAnswer(text, { evidenceIds, evidencePayloads, locale }) };
  }
  if (toolsAttempted && response?.kind === 'unavailable' && Object.keys(response).length === 1) {
    return { ok: true, normalized: locale === 'en' ? 'Rota data is currently unavailable. Please try again later.' : 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', kind: 'unavailable', citedIds: [], issues: [] };
  }
  if (!toolsAttempted && [TURN_ROUTES.GENERAL, TURN_ROUTES.UNDECIDED].includes(route) && response?.kind === 'general' && typeof response.text === 'string' && Object.keys(response).length === 2) {
    return { ok: true, normalized: locale === 'en' ? 'Select General chat for a general explanation. Rota data answers require current evidence.' : 'Genel açıklama için Genel sohbet seçeneğini seçin. Rota verisi yanıtları güncel kanıt gerektirir.', kind: 'general_redirect', citedIds: [], issues: [] };
  }
  return { normalized: text, kind: 'direct', ok: false, citedIds: [], issues: [{ code: route === TURN_ROUTES.ROTA ? 'ROTA_EVIDENCE_REQUIRED' : 'ANSWER_INTENT_REQUIRED' }] };
}

export async function runGroundedTurn(session, {
  messages,
  catalog,
  context,
  limits = TOOL_LIMITS,
  allowedTextFields = [],
  onStatus = null,
  onText
}) {
  const ledger = createEvidenceLedger();
  const status = (phase, extra = {}) => onStatus?.({ phase, ...extra });
  let permittedTools = null;
  let route = TURN_ROUTES.UNDECIDED;
  const userMessages = messages.filter((message) => message.role === 'user');
  const currentUser = userMessages.at(-1);
  const locale = replyLocale(currentUser?.content);
  // Kullanıcının bu turdaki iletisi, sonraki arama metni için güvenilir niyettir.
  const containment = createToolScope({ today: context.today, userText: String(currentUser?.content || ''), allowedTextFields });
  const executor = createToolExecutor({
    resolveTool: (name) => !permittedTools || permittedTools.has(name) ? getRotaTool(name) : null,
    context,
    ledger,
    validateCall: containment.validate,
    signal: session.signal,
    limits,
    onProgress: ({ topic }) => status(ASSISTANT_STREAM_PHASES.TOOLS, { topic })
  });
  const transcript = [...messages];
  if (!allowedTextFields.length) {
    appendServerInstruction(transcript, 'Bu turda kullanıcı kayıtlı serbest metni (açıklama, talep/karar iletisi, değişiklik metni) açmadı: textFields kullanma; bu metinler gerekiyorsa kullanıcıya "Notları ve iletileri dahil et" seçeneğini önerebilirsin.');
  }
  let toolRounds = 0;
  let modelRounds = 0;
  let toolsAttempted = false;
  const toolFailureCodes = new Set();
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

    if (result.finishReason === 'length') {
      if (repairsLeft > 0) {
        repairsLeft -= 1;
        repaired = true;
        allowTools = ledger.ids().length === 0;
        appendServerInstruction(transcript, 'Çıktı sağlayıcı sınırında kesildi. Önceki kesik JSON geçersizdir. En fazla 8 iddiayla daha kısa ve tam bir JSON üret; gerekli ise listeyi daralt.');
        continue;
      }
      result.text = '';
      result.toolCalls = [];
    }
    const declaration = parseEvidenceResponse(result.text);
    const declaredRoute = parseTurnRoute(declaration);
    // Veri okunmadan önce bildirilen dönem güvenilir niyettir (ilk araç turundan önce).
    if (!toolsAttempted && declaredRoute === TURN_ROUTES.ROTA) containment.declare(parseTurnWindow(declaration));
    if (route === TURN_ROUTES.UNDECIDED && declaredRoute && !result.toolCalls.length) {
      route = declaredRoute;
      appendServerInstruction(transcript, `Bu turun veri okunmadan belirlenen yönlendirmesi: ${route}. Şimdi bu niyete göre yanıtla; Rota olguları yalnızca araç kanıtıyla sunulur.`);
      continue;
    }
    if (result.toolCalls.length && canCallTools) {
      toolsAttempted = true;
      route = TURN_ROUTES.ROTA;
      toolFailureCodes.clear();
      toolRounds += 1;
      const toolMessages = await executor.runRound(result.toolCalls);
      for (const message of toolMessages) {
        const body = toolMessageBody(message);
        if (body?.ok === false && typeof body.error?.code === 'string') toolFailureCodes.add(body.error.code);
      }
      containment.establish(result.toolCalls, toolMessages);
      if (toolMessages.some((message) => toolMessageBody(message)?.ok === true)) {
        // Her başarılı turun takip araçları eklenir: çok adımlı çözüm (kişi →
        // görev → ayrıntı) mümkündür; bağımsız değişkenler kapsam sınırına bağlı kalır.
        const boundedCalls = result.toolCalls.slice(0, limits.maxCallsPerRound);
        const next = toolsForInitialCalls(boundedCalls, catalog, toolMessages.slice(0, boundedCalls.length));
        permittedTools = new Set([...(permittedTools || []), ...next]);
      }
      transcript.push({ role: 'assistant', content: result.text || '', toolCalls: safeToolCallsForTranscript(result.toolCalls, toolMessages) });
      transcript.push(...toolMessages);
      if (toolRounds >= limits.maxToolRounds) appendServerInstruction(transcript, roundLimitNote());
      continue;
    }

    let authorizationUnavailable = false;
    if (ledger.ids().length && context.authorizationEpoch) {
      const validationDeadline = createAiDeadline({ timeoutMs: limits.callTimeoutMs, parentSignal: session.signal });
      try {
        context.beginRound();
        try {
          await (context.revalidateAuthorization || context.authorization)(validationDeadline.signal);
          if (context.revalidateEvidence) ledger.retainAuthorized(await context.revalidateEvidence(ledger.authorizationEntries(), validationDeadline.signal));
        } catch (error) {
          if (isTurnFatal(error) || session.signal?.aborted) throw error;
          authorizationUnavailable = true;
          ledger.invalidateAuthorization(null);
        }
        ledger.invalidateAuthorization(context.authorizationEpoch(), context.isEvidenceAuthorized);
      } finally { validationDeadline.dispose(); }
    }
    const text = String(result.text || '').trim();
    status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verdict = authorizationUnavailable ? { ok: true, normalized: locale === 'en' ? 'Rota data is currently unavailable. Please try again later.' : 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', kind: 'unavailable', citedIds: [], issues: [] } : analyze(text, {
      evidenceIds: ledger.ids(),
      evidencePayloads: ledger.payloads(),
      toolsAttempted,
      toolFailureCodes,
      route,
      locale
    });
    if (verdict.ok) {
      const cited = ledger.summaries(verdict.citedIds);
      const disclosure = ['grounded', 'clarification'].includes(verdict.kind) ? withScopeDisclosure(verdict.normalized, cited, locale) : { text: verdict.normalized, disclosed: false };
      const finalText = ['grounded', 'clarification'].includes(verdict.kind) ? disclosure.text : verdict.normalized;
      await onText(finalText);
      const outcome = verdict.kind;
      recordGroundedAnswer({ outcome, rounds: modelRounds, evidence: cited.length, repaired, disclosed: disclosure.disclosed });
      return {
        text: finalText,
        // Doğrulanmış yanıtın bitişi sunucu kararıdır; sağlayıcının son turdaki nedeni (ör. tool_calls) taşınmaz.
        finishReason: outcome === 'general_redirect' ? 'clarification'
          : ['not_found', 'clarification', 'unavailable'].includes(outcome) ? outcome : 'stop',
        outcome,
        evidence: cited,
        evidenceRows: ledger.persistable(verdict.citedIds, { clarification: verdict.kind === 'clarification', candidates: verdict.candidates }),
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
      allowTools = ledger.ids().length === 0;
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
