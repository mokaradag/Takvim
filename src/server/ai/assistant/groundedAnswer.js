import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
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
import { CLARIFICATION_LIMITS, clarificationReference } from '../../../domain/ai/clarification.js';
import { renderClarification } from '../../../domain/ai/evidenceNarrative.js';
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
 * 5. Standart kipte kurtarılabilir model hatası (doğrulanamayan yapı, uzunluk
 *    sınırı, boş yanıt) Derin düşünme kuruluysa aynı kanıt defteriyle ona BİR
 *    kez devredilir; doğrulama aynıdır, kullanıcı tek yanıt görür.
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
  rota_task_search: ['rota_task_detail', 'rota_task_analytics', 'rota_project_search', 'rota_outlook_status'],
  rota_project_search: ['rota_project_detail', 'rota_task_search', 'rota_task_detail', 'rota_task_analytics', 'rota_wbs_inspect', 'rota_calendar_inspect', 'rota_baseline_compare', 'rota_dependency_inspect', 'rota_data_quality', ...PROJECT_SCOPED_FOLLOW_UPS],
  rota_person_search: ['rota_workload_summary', 'rota_task_search', 'rota_task_analytics'],
  rota_task_detail: ['rota_task_search', 'rota_task_analytics', 'rota_dependency_inspect', 'rota_recurrence_inspect', 'rota_activity_search', 'rota_outlook_status'],
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

/** Açıklanabilir kanıt: sunucunun tuttuğu aday kümesi (kısmi tek aday ya da belirsiz en az iki aday). */
function clarifiableEvidence(item) {
  let payload;
  try { payload = JSON.parse(item.payload); } catch { return null; }
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  const resolution = data.titleResolution || data.resolution || (data.ambiguous === true ? 'ambiguous' : null);
  if (!['ambiguous', 'partial'].includes(resolution)) return null;
  const pool = Array.isArray(data.candidates) ? data.candidates : (data.matches || data.people || data.tasks || []);
  const candidates = pool.filter((candidate) => candidate && typeof candidate === 'object')
    .slice(0, CLARIFICATION_LIMITS.maxCandidates);
  const references = candidates.map((candidate, ordinal) => clarificationReference({ ordinal,
    projectId: candidate.projectId, taskId: candidate.projectId ? null : candidate.taskId, personSicil: candidate.projectId || candidate.taskId ? null : candidate.sicil }));
  if (references.some((reference) => !reference)) return null;
  const minimum = resolution === 'partial' ? 1 : 2;
  if (candidates.length < minimum) return null;
  return { id: item.id, candidates, references, confirmation: resolution === 'partial', truncated: data.candidatesTruncated === true || pool.length > candidates.length };
}

/**
 * Açıklama SUNUCUYA AİTTİR: model yalnızca açıklama istediğini (ve gerekirse
 * hangi kanıtın) bildirir; adayların tamamı, sırası ve kalıcı kimlikleri
 * sunucunun kanıt kaydından gelir. Model aday atamaz ya da seçemez.
 */
function analyzeClarification(response, { evidenceIds, evidencePayloads, locale }) {
  const invalid = { ok: false, issues: [{ code: 'CLARIFICATION_CANDIDATES_REQUIRED' }] };
  const keys = Object.keys(response).filter((key) => key !== 'kind');
  if (keys.some((key) => !['evidence', 'claims'].includes(key)) || keys.length > 1) return invalid;
  const clarifiable = evidencePayloads.map(clarifiableEvidence).filter(Boolean);
  let target = null;
  if (typeof response.evidence === 'string') {
    target = clarifiable.find((item) => item.id === response.evidence) || null;
  } else if (Array.isArray(response.claims)) {
    // Eski biçim: iddialar gerçek olmalı ve tek bir açıklanabilir kanıtın adaylarına ait olmalıdır.
    if (!response.claims.length || !response.claims.every((claim) => claim && typeof claim.field === 'string'
      && ['data.matches.', 'data.people.', 'data.tasks.', 'data.candidates.'].some((prefix) => claim.field.startsWith(prefix)))) return invalid;
    const verdict = analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', claims: response.claims }), { evidenceIds, evidencePayloads, locale });
    if (!verdict.ok) return verdict;
    if (verdict.citedIds.length !== 1) return invalid;
    target = clarifiable.find((item) => item.id === verdict.citedIds[0]) || null;
  } else if (clarifiable.length === 1) {
    target = clarifiable[0];
  }
  if (!target || !evidenceIds.includes(target.id)) return invalid;
  return {
    ok: true,
    issues: [],
    citedIds: [target.id],
    kind: 'clarification',
    clarification: { evidenceId: target.id, references: target.references },
    normalized: renderClarification({ evidenceId: target.id, candidates: target.candidates, truncated: target.truncated, confirmation: target.confirmation, locale })
  };
}

function analyze(text, { evidenceIds, evidencePayloads, toolsAttempted, toolFailureCodes, route, locale, userText }) {
  const response = parseEvidenceResponse(text);
  const notFoundOnly = evidenceIds.length === 0 && toolFailureCodes.size > 0 && [...toolFailureCodes].every((code) => code === TOOL_ERROR_CODES.NOT_FOUND);
  if (toolsAttempted && notFoundOnly && (response?.kind === 'not_found' || response?.kind === 'unavailable' || analyzeUngroundedAnswer(text, { allowNotFound: true }).ok)) {
    return { ok: true, normalized: locale === 'en' ? 'The record was not found or is not accessible.' : 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.', kind: 'not_found', citedIds: [], issues: [] };
  }
  if (evidenceIds.length) {
    if (response?.kind === 'clarification' && response && typeof response === 'object' && !Array.isArray(response)) {
      return analyzeClarification(response, { evidenceIds, evidencePayloads, locale });
    }
    return { kind: 'grounded', ...analyzeGroundedAnswer(text, { evidenceIds, evidencePayloads, locale, userText }) };
  }
  if (toolsAttempted && response?.kind === 'unavailable' && Object.keys(response).length === 1) {
    return { ok: true, normalized: locale === 'en' ? 'Rota data is currently unavailable. Please try again later.' : 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', kind: 'unavailable', citedIds: [], issues: [] };
  }
  if (!toolsAttempted && [TURN_ROUTES.GENERAL, TURN_ROUTES.UNDECIDED].includes(route) && response?.kind === 'general' && typeof response.text === 'string' && Object.keys(response).length === 2) {
    return { ok: true, normalized: locale === 'en' ? 'Select General chat for a general explanation. Rota data answers require current evidence.' : 'Genel açıklama için Genel sohbet seçeneğini seçin. Rota verisi yanıtları güncel kanıt gerektirir.', kind: 'general_redirect', citedIds: [], issues: [] };
  }
  return { normalized: text, kind: 'direct', ok: false, citedIds: [], issues: [{ code: route === TURN_ROUTES.ROTA ? 'ROTA_EVIDENCE_REQUIRED' : 'ANSWER_INTENT_REQUIRED' }] };
}

function selectionInstruction(clarification) {
  const selected = clarification.selected ? clarificationReference(clarification.selected) : null;
  if (!selected) {
    return 'SUNUCU SEÇİMİ: Kullanıcının yanıtı önceki açıklamadaki adaylardan birini numarasıyla seçmiyor. Aday kimliklerini kullanma; gerekiyorsa kullanıcının yazdığı adla yeniden ara ya da yeniden sor.';
  }
  const [key, value] = Object.entries(selected).find(([name]) => name !== 'ordinal');
  return `SUNUCU SEÇİMİ: Kullanıcı önceki açıklamadaki ${selected.ordinal + 1}. adayı seçti; sunucu bu seçimi ${key}=${value} kimliğine bağladı. Önceki soruyu bu kimlikle yanıtla; başka adayı kullanma.`;
}

/**
 * Derin düşünmeye devri ENGELLEYEN araç sonuçları: kayıt yok ya da yetki yok,
 * kapsam dışı, desteklenmeyen istek, SQL/uygulama hatası. Bu durumda daha
 * güçlü model yanıtı değiştiremez.
 */
const ESCALATION_BLOCKING_TOOL_CODES = new Set([
  TOOL_ERROR_CODES.NOT_FOUND,
  TOOL_ERROR_CODES.UNSUPPORTED_SCOPE,
  TOOL_ERROR_CODES.UNSUPPORTED,
  TOOL_ERROR_CODES.TIMEOUT,
  TOOL_ERROR_CODES.BUSY,
  TOOL_ERROR_CODES.DATABASE_UNAVAILABLE,
  TOOL_ERROR_CODES.INTERNAL
]);

/** Boş yanıt aynı oturumda en fazla bir kez, yalnızca bu kadar süre kaldıysa yeniden istenir. */
export const EMPTY_COMPLETION_RETRY_MIN_MS = 15000;

const EVIDENCE_READY_NOTE = 'SUNUCU: Bu turun kanıtları hazır. Yeni araç çağırma; yalnızca eldeki kanıtlarla son yanıtı üret.';

function isEmptyCompletion(error) {
  return error?.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID && error?.details?.reason === 'EMPTY_COMPLETION';
}

/** Turun durumu: kanıt defteri, kapsam, araç izinleri ve döküm. Devirde aynı durum sürer. */
function startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, onStatus }) {
  const status = (phase, extra = {}) => onStatus?.({ phase, ...extra });
  const userMessages = messages.filter((message) => message.role === 'user');
  const currentUser = userMessages.at(-1);
  // Kullanıcının bu turdaki iletisi (açıklama yanıtında önceki sorusu da) arama metni için güvenilir niyettir.
  const userText = [clarification?.selected ? clarification.question : null, currentUser?.content].filter(Boolean).join('\n');
  const turn = {
    catalog,
    context,
    limits,
    status,
    session: null,
    ledger: createEvidenceLedger(),
    permittedTools: null,
    route: TURN_ROUTES.UNDECIDED,
    locale: replyLocale(clarification?.question ? `${clarification.question} ${currentUser?.content || ''}` : currentUser?.content),
    userText,
    containment: createToolScope({ today: context.today, userText, allowedTextFields, clarification }),
    // Çalışan döküm ve Derin düşünmeye devredilecek temiz döküm (düzeltme notları olmadan).
    transcript: [...messages],
    baseline: [...messages],
    toolRounds: 0,
    modelRounds: 0,
    toolsAttempted: false,
    toolFailureCodes: new Set(),
    repaired: false,
    repairsLeft: limits.maxRepairRounds,
    emptyRetried: false,
    escalated: false,
    models: []
  };
  turn.executor = createToolExecutor({
    resolveTool: (name) => !turn.permittedTools || turn.permittedTools.has(name) ? getRotaTool(name) : null,
    context,
    ledger: turn.ledger,
    validateCall: turn.containment.validate,
    signal: () => turn.session?.signal ?? null,
    limits,
    onProgress: ({ topic }) => status(ASSISTANT_STREAM_PHASES.TOOLS, { topic })
  });
  if (clarification) instruct(turn, selectionInstruction(clarification));
  if (!allowedTextFields.length) {
    instruct(turn, 'Bu turda kullanıcı kayıtlı serbest metni (açıklama, talep/karar iletisi, değişiklik metni) açmadı: textFields kullanma; bu metinler gerekiyorsa kullanıcıya iletisinde "Notlar ve iletiler" anahtarını açmasını önerebilirsin.');
  }
  return turn;
}

/** Sunucu notu; düzeltme notları yalnızca çalışan dökümde kalır. */
function instruct(turn, instruction, { repair = false } = {}) {
  appendServerInstruction(turn.transcript, instruction);
  if (!repair) appendServerInstruction(turn.baseline, instruction);
}

function record(turn, ...messages) {
  turn.transcript.push(...messages);
  turn.baseline.push(...messages);
}

/**
 * Derin düşünme bu turu değiştirebilir mi? Veri yokluğu, yetki, kapsam ya da
 * altyapı hatası kanıtsız bir turu bitirdiyse hayır.
 */
function escalationPermitted(turn) {
  if (turn.escalated) return false;
  if (turn.ledger.ids().length) return true;
  return ![...turn.toolFailureCodes].some((code) => ESCALATION_BLOCKING_TOOL_CODES.has(code));
}

function stats(turn) {
  return { modelRounds: turn.modelRounds, toolRounds: turn.toolRounds, ...turn.executor.stats(), ...turn.context.stats() };
}

/** Doğrulanamayan turun sabit güvenli yanıtı. */
async function failTurn(turn, onText) {
  const failureText = groundingFailureText(turn.locale);
  await onText(failureText);
  recordGroundedAnswer({ outcome: 'failed', rounds: turn.modelRounds, evidence: 0, repaired: turn.repaired });
  return {
    text: failureText,
    finishReason: GROUNDING_FAILED_FINISH_REASON,
    outcome: 'failed',
    evidence: [],
    evidenceRows: [],
    streamedLive: false,
    repaired: turn.repaired,
    disclosed: false,
    models: [...turn.models],
    stats: stats(turn)
  };
}

/**
 * Standart kipte kurtarılabilir model/protokol hatası: kullanıcıya hiçbir şey
 * gösterilmeden, aynı kanıt defteri ve temiz dökümle Derin düşünmeye devredilir.
 * `fallback` devir gerçekleşemezse Standart sonucunu (güvenli ileti ya da
 * özgün hata) üretir; böylece kullanıcı her durumda tek yanıt alır.
 */
function escalation(turn, reason, { error = null } = {}) {
  turn.escalated = true;
  turn.transcript = [...turn.baseline];
  if (turn.ledger.ids().length) instruct(turn, EVIDENCE_READY_NOTE);
  return {
    outcome: 'escalate',
    reason,
    resume: turn,
    toolsReused: turn.ledger.ids().length > 0,
    models: [...turn.models],
    fallback: (onText) => {
      if (error) throw error;
      return failTurn(turn, onText);
    }
  };
}

/**
 * `escalation: true` yalnızca Standart kipte ve Derin düşünme araç profili
 * kuruluysa verilir. `resume` devredilen turu sürdürür: yeni araç turu yalnızca
 * kanıt yoksa ve tur sınırı izin veriyorsa açılır.
 */
export async function runGroundedTurn(session, {
  messages,
  catalog,
  context,
  limits = TOOL_LIMITS,
  allowedTextFields = [],
  clarification = null,
  onStatus = null,
  onText,
  escalation: escalationAvailable = false,
  resume = null
}) {
  const turn = resume || startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, onStatus });
  turn.session = session;
  const { ledger, executor, containment, status } = turn;
  ({ catalog, context, limits } = turn);
  const canEscalate = () => escalationAvailable && escalationPermitted(turn);
  let allowTools = resume ? ledger.ids().length === 0 : true;
  let lengthExhausted = false;
  for (;;) {
    const canCallTools = allowTools && turn.toolRounds < limits.maxToolRounds;
    turn.modelRounds += 1;
    boundTranscript(turn.transcript);
    let result;
    try {
      result = await session.round({
        messages: turn.transcript,
        tools: turn.permittedTools ? catalog.filter((tool) => turn.permittedTools.has(tool.name)) : catalog,
        toolChoice: canCallTools ? 'auto' : 'none',
        onEvent: async (event) => {
          if (event.type === 'thinking') status(ASSISTANT_STREAM_PHASES.THINKING);
          else if (event.type === 'generating') status(ASSISTANT_STREAM_PHASES.GENERATING);
        }
      });
    } catch (error) {
      if (!isEmptyCompletion(error) || session.signal?.aborted) throw error;
      // Boş yanıt yan etkisizdir: aynı tur, oturumda bir kez ve süre kaldıysa yeniden istenir.
      if (!turn.emptyRetried && (session.remainingMs?.() ?? 0) >= EMPTY_COMPLETION_RETRY_MIN_MS) {
        turn.emptyRetried = true;
        continue;
      }
      if (canEscalate()) return escalation(turn, 'EMPTY_COMPLETION', { error });
      throw error;
    }
    const reported = result.model || session.model;
    if (reported) turn.models.push(reported);

    if (result.finishReason === 'length') {
      if (turn.repairsLeft > 0) {
        turn.repairsLeft -= 1;
        turn.repaired = true;
        allowTools = ledger.ids().length === 0;
        instruct(turn, 'Çıktı sağlayıcı sınırında kesildi. Önceki kesik JSON geçersizdir. En fazla 8 iddiayla daha kısa ve tam bir JSON üret; gerekli ise listeyi daralt.', { repair: true });
        continue;
      }
      lengthExhausted = true;
      result.text = '';
      result.toolCalls = [];
    }
    const declaration = parseEvidenceResponse(result.text);
    const declaredRoute = parseTurnRoute(declaration);
    // Veri okunmadan önce bildirilen dönem güvenilir niyettir (ilk araç turundan önce).
    if (!turn.toolsAttempted && declaredRoute === TURN_ROUTES.ROTA) containment.declare(parseTurnWindow(declaration));
    if (turn.route === TURN_ROUTES.UNDECIDED && declaredRoute && !result.toolCalls.length) {
      turn.route = declaredRoute;
      instruct(turn, `Bu turun veri okunmadan belirlenen yönlendirmesi: ${turn.route}. Şimdi bu niyete göre yanıtla; Rota olguları yalnızca araç kanıtıyla sunulur.`);
      continue;
    }
    if (result.toolCalls.length && canCallTools) {
      turn.toolsAttempted = true;
      turn.route = TURN_ROUTES.ROTA;
      turn.toolFailureCodes.clear();
      turn.toolRounds += 1;
      const toolMessages = await executor.runRound(result.toolCalls);
      for (const message of toolMessages) {
        const body = toolMessageBody(message);
        if (body?.ok === false && typeof body.error?.code === 'string') turn.toolFailureCodes.add(body.error.code);
      }
      containment.establish(result.toolCalls, toolMessages);
      if (toolMessages.some((message) => toolMessageBody(message)?.ok === true)) {
        // Her başarılı turun takip araçları eklenir: çok adımlı çözüm (kişi →
        // görev → ayrıntı) mümkündür; bağımsız değişkenler kapsam sınırına bağlı kalır.
        const boundedCalls = result.toolCalls.slice(0, limits.maxCallsPerRound);
        const next = toolsForInitialCalls(boundedCalls, catalog, toolMessages.slice(0, boundedCalls.length));
        turn.permittedTools = new Set([...(turn.permittedTools || []), ...next]);
      }
      record(turn, { role: 'assistant', content: result.text || '', toolCalls: safeToolCallsForTranscript(result.toolCalls, toolMessages) }, ...toolMessages);
      if (turn.toolRounds >= limits.maxToolRounds) instruct(turn, roundLimitNote());
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
    const { locale } = turn;
    const verdict = authorizationUnavailable ? { ok: true, normalized: locale === 'en' ? 'Rota data is currently unavailable. Please try again later.' : 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', kind: 'unavailable', citedIds: [], issues: [] } : analyze(text, {
      evidenceIds: ledger.ids(),
      evidencePayloads: ledger.payloads(),
      toolsAttempted: turn.toolsAttempted,
      toolFailureCodes: turn.toolFailureCodes,
      route: turn.route,
      locale,
      userText: turn.userText
    });
    if (verdict.ok) {
      const cited = ledger.summaries(verdict.citedIds);
      const disclosure = ['grounded', 'clarification'].includes(verdict.kind) ? withScopeDisclosure(verdict.normalized, cited, locale) : { text: verdict.normalized, disclosed: false };
      const finalText = ['grounded', 'clarification'].includes(verdict.kind) ? disclosure.text : verdict.normalized;
      await onText(finalText);
      const outcome = verdict.kind;
      recordGroundedAnswer({ outcome, rounds: turn.modelRounds, evidence: cited.length, repaired: turn.repaired, disclosed: disclosure.disclosed });
      return {
        text: finalText,
        // Doğrulanmış yanıtın bitişi sunucu kararıdır; sağlayıcının son turdaki nedeni (ör. tool_calls) taşınmaz.
        finishReason: outcome === 'general_redirect' ? 'clarification'
          : ['not_found', 'clarification', 'unavailable'].includes(outcome) ? outcome : 'stop',
        outcome,
        evidence: cited,
        evidenceRows: ledger.persistable(verdict.citedIds, { clarification: verdict.clarification || null }),
        streamedLive: false,
        repaired: turn.repaired,
        disclosed: disclosure.disclosed,
        models: [...turn.models],
        stats: stats(turn)
      };
    }

    if (turn.repairsLeft > 0) {
      turn.repairsLeft -= 1;
      turn.repaired = true;
      instruct(turn, groundingRepairInstruction(verdict.issues), { repair: true });
      // Kanıt varken düzeltme yalnızca yeniden yazımdır; kanıt yoksa model
      // gereken aracı çağırabilir (araç turu sınırı sürer).
      allowTools = ledger.ids().length === 0;
      continue;
    }

    if (canEscalate()) return escalation(turn, lengthExhausted ? 'LENGTH' : 'VERIFICATION_FAILED');
    return failTurn(turn, onText);
  }
}
