import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { ASSISTANT_STREAM_PHASES } from '../../../domain/ai/assistantContract.js';
import {
  analyzeGroundedAnswer,
  analyzeUngroundedAnswer,
  GROUNDING_FAILED_FINISH_REASON,
  groundingFailureText,
  groundingRepairInstruction,
  withScopeDisclosure
} from '../../../domain/ai/evidenceContract.js';
import { recordGroundedAnswer, recordGroundedTurn } from '../aiTelemetry.js';
import { createEvidenceLedger } from '../tools/evidenceLedger.js';
import { createToolExecutor } from '../tools/toolExecutor.js';
import { getRotaTool, toolCatalogForModel } from '../tools/toolRegistry.js';
import { parseEvidenceResponse } from '../../../domain/ai/evidenceVerification.js';
import { invalidArguments, isTurnFatal, TOOL_ERROR_CODES } from '../tools/toolErrors.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';
import { createToolScope } from '../tools/toolScope.js';
import { bindRequestEntities, declarationHints, parseRequestDeclaration, requestEvidence, requestEvidenceReady, requestRepairHint, requestSelections, requestSummary, requestWindow,
  droppedNameHint, droppedNames, metricIdHints, namedScope, nameProbes, requestSchema, unmatchedEntities } from '../tools/requestDeclaration.js';
import { createCallIds, prepareExecutionSet, rejectionFor, textPlanCall, typedPlanningTool, unpackTypedPlan } from '../tools/executionSet.js';
import { completeRequest, derivedReads, readKey, requestBoundCall, requestTextFields } from '../tools/requestPopulation.js';
import { parseTurnLanguage, parseTurnRequest, parseTurnRoute, TURN_ROUTES } from '../../../domain/ai/evidenceIntent.js';
import { CLARIFICATION_LIMITS, clarificationReference } from '../../../domain/ai/clarification.js';
import { renderClarification } from '../../../domain/ai/evidenceNarrative.js';
import { createAiDeadline } from '../aiDeadline.js';

/**
 * Rota verisine dayanan yanıtın SINIRLI döngüsü.
 *
 * 1. Model veri okumadan önce niyetini türlü bir bildirimle verir: Rota
 *    sorusunda istek (`request`: işlem, ölçüler, varlıklar, koşullar). Sunucu
 *    kullanıcı cümlesini yorumlamaz; bildirimin yapısını ve güven kaynağını
 *    doğrular. Geçerli istek olmadan hiçbir araç çalışmaz (bildirim düzeltmesi
 *    sınırlıdır) ve istek veri okunduktan sonra değişmez.
 * 2. Model araç çağrısı ya da yanıt üretir (araç turu en fazla `maxToolRounds`;
 *    sonrasında araçlar kapatılır ve model eldeki kanıtla yanıtlar). Araçlar
 *    sunucuda, yetkiyle ve sınırlarla çalışır; başarılı sonuçlar kanıt olur (R1, R2 …).
 * 3. Son seçimin tur, kayıt, alan ve türlü değeri ile bildirilen isteğe uyumu
 *    (ölçü kapsamı, nüfus, varlık, liste/sıralama bütünlüğü) sunucuda
 *    belirlenimci doğrulanır. İkinci bir dil modeli yargıç olarak kullanılmaz.
 *    Her araç turundan sonra sunucu, bildirilen isteğin kayıt defterindeki
 *    ölçü yollarından türettiği seçimi aynı doğrulamadan geçirir; geçerse
 *    güncel yetki yeniden doğrulanır ve modele ayrıca seçim turu yaptırılmaz.
 * 4. Doğrulanamayan yanıt BİR kez düzeltilir; yine doğrulanamazsa kullanıcı
 *    sabit güvenli iletiyi görür (uydurma kanıtlı yanıt hiçbir zaman gösterilmez).
 * 5. Standart kipte kurtarılabilir model hatası (doğrulanamayan yapı, uzunluk
 *    sınırı, boş yanıt) Derin düşünme kuruluysa aynı kanıt defteriyle ona BİR
 *    kez devredilir; doğrulama aynıdır, kullanıcı tek yanıt görür. Devir
 *    öncesinde eksik kanıt mevcut araç/düzeltme bütçesiyle tamamlanır; yalnızca
 *    yanıt biçimi sorunu araçsız devredilebilir.
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

/** Kanıt varken düzeltme turunda yeni araç çağrısını gerektirebilen istek hataları. */
const EVIDENCE_GAP_CODES = new Set(['METRIC_MISSING', 'ENTITY_MISSING', 'ENTITY_UNRESOLVED', 'POPULATION_MISMATCH', 'RANK_MISMATCH', 'LIST_INCOMPLETE', 'LIST_ROWS_REQUIRED']);

/** Bildirilen isteği bu turun kanıtlarıyla doğrular; istek yoksa kanıtlı yanıt kabul edilmez. */
function analyzeRequested(text, { evidenceIds, evidencePayloads, locale, request, entries, selection, today }) {
  if (!request) return { ok: false, citedIds: [], issues: [{ code: 'REQUEST_DECLARATION_REQUIRED' }] };
  const bound = { ...request, entities: bindRequestEntities(request, entries, selection) };
  return analyzeGroundedAnswer(text, { evidenceIds, evidencePayloads, locale, request: bound, evidence: requestEvidence(request, entries, today) });
}

function analyze(text, { evidenceIds, evidencePayloads, toolsAttempted, toolsRequested = false, toolFailureCodes, route, locale, request, entries, selection, today }) {
  const response = parseEvidenceResponse(text);
  const notFoundOnly = evidenceIds.length === 0 && toolFailureCodes.size > 0 && [...toolFailureCodes].every((code) => code === TOOL_ERROR_CODES.NOT_FOUND);
  if (toolsAttempted && notFoundOnly && (response?.kind === 'not_found' || response?.kind === 'unavailable' || analyzeUngroundedAnswer(text, { allowNotFound: true }).ok)) {
    return { ok: true, normalized: locale === 'en' ? 'The record was not found or is not accessible.' : 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.', kind: 'not_found', citedIds: [], issues: [] };
  }
  if (evidenceIds.length) {
    if (response?.kind === 'clarification' && response && typeof response === 'object' && !Array.isArray(response)) {
      return analyzeClarification(response, { evidenceIds, evidencePayloads, locale });
    }
    return { kind: 'grounded', ...analyzeRequested(text, { evidenceIds, evidencePayloads, locale, request, entries, selection, today }) };
  }
  // Yalnızca yürütülen okumaların erişim hatası arka uç kullanılamıyor yanıtı olabilir.
  if (toolsAttempted && toolFailureCodes.size > 0 && [...toolFailureCodes].every((code) =>
    [TOOL_ERROR_CODES.DATABASE_UNAVAILABLE, TOOL_ERROR_CODES.TIMEOUT, TOOL_ERROR_CODES.BUSY, TOOL_ERROR_CODES.INTERNAL].includes(code))
    && response?.kind === 'unavailable' && Object.keys(response).length === 1) {
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

/** Veri okunmadan önceki bildirim turları (yalnız bildirim ya da reddedilen araç çağrısı) için sınır. */
const DECLARATION_ROUNDS = 2;

/** Bildirim hatası ayrıntıları yalnızca şema yoludur; modelin yazdığı metin yönergeye taşınmaz. */
const schemaNames = (schema) => Object.entries(schema.properties || {}).flatMap(([name, child]) => [name, ...schemaNames(child)])
  .concat(schema.items ? schemaNames(schema.items) : []);
const structuralNames = new Set(['plan', 'calls', 'request', 'intent', 'language', 'name', 'arguments', 'metric', 'entity', 'field',
  ...schemaNames(requestSchema()), ...toolCatalogForModel().flatMap((tool) => [tool.name, ...schemaNames(tool.parameters)])]);
const problemPaths = (details = []) => details.map((detail) => {
  const match = /^(\$[^:]*):([A-Za-z][A-Za-z-]*)$/.exec(String(detail));
  if (!match) return '$:invalid';
  const path = match[1].split('.').slice(1)
    .map((part) => /^([A-Za-z]\w*)(\[\d+\])?$/.exec(part))
    .map((part) => part && structuralNames.has(part[1]) ? `${part[1]}${part[2] || ''}` : 'field').join('.');
  return `${path ? `$.${path}` : '$'}:${match[2]}`;
}).slice(0, 8);

function declarationRepair(details = [], serverHints = []) {
  const problems = problemPaths(details);
  const hints = [...serverHints.slice(0, 6), ...declarationHints(problems)];
  return [
    'SUNUCU DOĞRULAMASI: Araç çağrıları çalıştırılmadı. Rota verisi okunmadan önce geçerli bir istek bildirimi gerekir.',
    ...(problems.length ? [`Bildirim sorunları: ${problems.join(', ')}`] : []),
    ...(hints.length ? [`Beklenen biçim: ${hints.join('; ')}`] : []),
    'Yalnızca bildirilen sorunları düzelt; sorunsuz araç, ölçü, süzgeç ve çağrı bağımsız değişkenlerini değiştirme. Sorunlu ölçüyü SİLME: ipucundaki taşıyıcı araçlardan birini population.tool yap. Sorun yolları request alanına göredir ($.entities = request.entities).',
    'Yanıtın yeniden rota_plan çağrısı olmalıdır: intent rota, language tr|en, request içinde operation/metrics/population/layout (ve gerekiyorsa entities/filters); calls isteğe bağlıdır (sunucu okumaları istekten kurar). rota_plan olmadan tek başına doğrudan araç çağrısı çalışmaz. Normal asistan metni gerekmez; geçerli plan sunucuda doğrulanıp yürütülür.',
    'entities[].text ve filters.text kullanıcının iletisinde geçen metin olmalıdır; entities[].id yalnızca kullanıcının yazdığı ya da sunucunun bağladığı kimliktir.'
  ].join('\n');
}

const jsonArguments = (value) => {
  try { return JSON.stringify(JSON.parse(String(value ?? '{}'))); } catch { return '{}'; }
};

/**
 * Reddedilen plan modelin kendi çağrısı olarak yalnızca çalışan dökümde kalır:
 * model planını baştan yazmak yerine düzeltebilir. Araç sonucu yalnızca
 * sunucunun sorun yollarını ve kayıt defteri ipuçlarını taşır. Kimlikleri
 * sunucu verir; sağlayıcının kimlikleri dökümde çakışamaz.
 */
function recordRejectedPlan(turn, calls, details, hints = [], problems = null, executionCalls = calls) {
  const shown = calls.slice(0, TOOL_LIMITS.maxCallsPerRound + 1).map((call) => {
    // Kendi sorunu olan çağrının bağımsız değişkenleri sonraki modele taşınmaz; geçerli çağrılar düzeltilebilsin diye kalır.
    const own = problems?.find((problem) => problem.index >= 0 && executionCalls[problem.index] === call)?.error || null;
    return { ...call, own, id: turn.callId() };
  });
  if (!shown.length) return;
  const planned = shown.some((call) => call.name === 'rota_plan');
  const error = (call) => {
    if (call.own) return { code: call.own.code, details: problemPaths(call.own.details || []) };
    return { code: TOOL_ERROR_CODES.INVALID_ARGUMENTS, ...(planned && call.name !== 'rota_plan' ? { details: ['$.plan:invalid'] }
      : { details: problemPaths(details), ...(hints.length ? { hints: hints.slice(0, 6) } : {}) }) };
  };
  turn.transcript.push({ role: 'assistant', content: '', toolCalls: shown.map(({ id, name, arguments: args, oversize, own }) => ({ id, name: String(name || 'unknown').slice(0, 64),
    arguments: oversize || own ? '{}' : jsonArguments(args) })) },
    ...shown.map((call) => ({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: false, tool: String(call.name || 'unknown').slice(0, 64), error: error(call) }) })));
}

/**
 * Veri okunduktan sonraki araç turunun yürütme kümesi geçersizse HİÇBİR çağrı
 * çalışmaz: her çağrı kendi sorununu ya da geçersiz kardeşi nedeniyle
 * yürütülmediğini görür. Reddedilen tur araç turu bütçesinden düşer.
 */
function recordRejectedRound(turn, calls, problems) {
  const shown = calls.slice(0, TOOL_LIMITS.maxCallsPerRound + 1).map((call, index) => ({ ...call, index, own: problems.some((problem) => problem.index === index), id: turn.callId() }));
  turn.transcript.push({ role: 'assistant', content: '', toolCalls: shown.map(({ id, name, arguments: args, oversize, own }) => ({ id, name: String(name || 'unknown').slice(0, 64),
    arguments: oversize || own ? '{}' : jsonArguments(args) })) },
    ...shown.map((call) => {
      const error = rejectionFor(problems, call.index);
      return { role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: false, tool: String(call.name || 'unknown').slice(0, 64),
        error: { code: error.code, message: error.message, ...(error.details?.length ? { details: problemPaths(error.details) } : {}) } }) };
    }));
}

/**
 * Veri okunmadan önceki bildirimi uygular: dil, türlü istek ve dönem.
 * Geçersiz Rota isteği önceki kabulü değiştirmez; `{ ok: false, details }` döner.
 * Kabul edilen bildirim planın çağrılarıyla tamamlanana kadar yürütülmez.
 */
function acceptDeclaration(turn, declaration, route) {
  const language = parseTurnLanguage(declaration);
  if (route !== TURN_ROUTES.ROTA) {
    return { ok: true, request: null, language };
  }
  let request;
  const raw = parseTurnRequest(declaration);
  try {
    request = parseRequestDeclaration(raw, {
      textTrusted: turn.containment.textTrusted,
      identityTrusted: turn.containment.identityTrusted,
      today: turn.context.today
    });
  } catch (error) {
    if (error?.code !== TOOL_ERROR_CODES.INVALID_ARGUMENTS) throw error;
    return { ok: false, details: error.details || [], hints: [...(error.hints || []), ...metricIdHints(error.details || [], raw)] };
  }
  return { ok: true, request, language };
}

/**
 * Veri okunmadan önceki plan: bildirilen istek ve yürütme kümesinin TAMAMI
 * birlikte doğrulanır; istek planın nüfus çağrılarıyla tamamlanır ve aracın
 * ifade edemeyeceği istek reddedilir. Herhangi bir sorun varsa hiçbir SQL çalışmaz.
 */
function preparePlan(turn, calls, declared) {
  if (declared && !declared.ok) return { ok: false, details: declared.details, hints: declared.hints || [] };
  const provisional = declared?.request || turn.declared;
  if (!provisional) return { ok: false, details: ['$.request:required'], hints: [] };
  const set = prepareExecutionSet(calls, { catalog: turn.catalog, validateCall: turn.containment.validate, limits: turn.limits,
    attempted: turn.executor.stats().attempted, callId: turn.callId, today: turn.context.today });
  if (!set.ok) {
    return { ok: false, details: set.problems.flatMap((problem) => problem.error.details?.length ? problem.error.details : [`$.calls:${problem.error.code}`]),
      hints: [], problems: set.problems };
  }
  const completion = completeRequest(provisional, set.calls.map(({ name, args }) => ({ name, args })),
    { today: turn.context.today, allowedTextFields: turn.allowedTextFields });
  if (completion.problems.length) return { ok: false, details: completion.problems, hints: completion.hints };
  // Düzeltme kullanıcının adlandırdığı bir kaydı düşüremez (zayıf model reddi soruyu daraltarak "onarır").
  const dropped = droppedNames(turn.namedScope, completion.request);
  if (dropped.length) return { ok: false, details: ['$.entities:dropped'], hints: [droppedNameHint(dropped)] };
  const checked = prepareExecutionSet(calls, { catalog: turn.catalog, validateCall: requestCallValidator(turn, completion.request), limits: turn.limits,
    attempted: turn.executor.stats().attempted, callId: turn.callId, today: turn.context.today });
  if (!checked.ok) return { ok: false, details: checked.problems.flatMap((problem) => problem.error.details || []), hints: [], problems: checked.problems };
  return { ok: true, request: completion.request, calls: checked.calls };
}

/** Modelin bulduğu kimlik yeni bir okuma yükümlülüğü açmaz; istek bağlı çağrı sunucunun biçimiyle yürür. */
function requestCallValidator(turn, request, reads = null) {
  const bound = bindRequestEntities(request, turn.ledger.requestEntries(), turn.containment.boundSelection());
  return (name, args) => {
    turn.containment.validate(name, args);
    const call = requestBoundCall(request, name, args, { today: turn.context.today, bound, reads });
    if (!call) throw invalidArguments(['$.request:unrelated']);
    return call;
  };
}

/** Önceki kabul notu dökümlerden çıkarılır: yalnızca güncel kabul edilen istek modele bildirilir. */
function clearAcceptedNote(turn) {
  if (!turn.acceptedNote) return;
  for (const transcript of [turn.transcript, turn.baseline]) {
    transcript.forEach((message, index) => {
      if (message.role === 'system' && message.content.includes(turn.acceptedNote)) {
        transcript[index] = { ...message, content: message.content.replace(`\n\n${turn.acceptedNote}`, '') };
      }
    });
  }
  turn.acceptedNote = null;
}

/** Planla tamamlanan istek bu turun isteğidir; önceki (veri okunmadan değişen) kabul notunun yerini alır. */
function acceptRequest(turn, request, language = null) {
  turn.request = request;
  turn.declared = request;
  if (language) turn.locale = language;
  turn.containment.declare(requestWindow(request));
  turn.namedScope = namedScope(turn.namedScope, request, turn.containment.textTrusted);
  // Veri okunmadan bildirilen nüfusun korumalı metin alanları sunucunun türettiği okumalarda da açıktır.
  turn.containment.declareTextFields(requestTextFields(request));
  const note = `SUNUCU: Veri okunmadan bildirilen istek kabul edildi: ${requestSummary(request)}. Son yanıtta bu isteğin her ölçüsünü taşıyan olguları seç; istek veri okunduktan sonra değiştirilemez.`;
  clearAcceptedNote(turn);
  turn.acceptedNote = note;
  instruct(turn, note);
}

function isEmptyCompletion(error) {
  return error?.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID && error?.details?.reason === 'EMPTY_COMPLETION';
}

/** Turun durumu: kanıt defteri, kapsam, araç izinleri ve döküm. Devirde aynı durum sürer. */
function startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, onStatus, onProgress }) {
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
    // Gerçek üretim ilerlemesi (sağlayıcı olayı, araç sonucu); canlı tutma iletisi ilerleme değildir.
    progress: () => onProgress?.(),
    session: null,
    ledger: createEvidenceLedger(),
    permittedTools: null,
    route: TURN_ROUTES.UNDECIDED,
    // Yanıt dili modelin bildirimidir; bildirilene kadar varsayılan Türkçedir.
    locale: 'tr',
    // Bildirilen (henüz planla tamamlanmamış) istek ve planla tamamlanan istek; ilk kanıttan sonra değişmez.
    declared: null,
    // Turun bildirimlerinde kullanıcının adlandırdığı kayıtlar; düzeltme bunları düşüremez.
    namedScope: [],
    request: null,
    acceptedNote: null,
    allowedTextFields,
    callId: createCallIds(),
    declarationsLeft: DECLARATION_ROUNDS,
    containment: createToolScope({ today: context.today, userText, allowedTextFields, clarification }),
    // Çalışan döküm ve Derin düşünmeye devredilecek temiz döküm (düzeltme notları olmadan).
    transcript: [...messages],
    baseline: [...messages],
    toolRounds: 0,
    modelRounds: 0,
    toolsAttempted: false,
    toolsRequested: false,
    // Bu turda yürütülen okumalar: bildirimden türetilen okuma aynı çağrıyı yinelemez.
    attemptedReads: new Set(),
    toolFailureCodes: new Set(),
    repaired: false,
    repairsLeft: limits.maxRepairRounds,
    emptyRetried: false,
    escalated: false,
    // Model, araç ya da oturum işinin sayacı; yetki yalnızca bu değişince yeniden okunur.
    work: 0,
    revalidatedAt: null,
    models: [],
    // İçeriksiz tur izi: tur amaçları, süreler, belirteç sayıları ve sayaçlar.
    trace: { startedAt: Date.now(), rounds: [], declarations: 0, repairs: 0, revalidationMs: 0, verificationMs: 0, pending: null }
  };
  turn.executor = createToolExecutor({
    resolveTool: (name) => !turn.permittedTools || turn.permittedTools.has(name) ? getRotaTool(name) : null,
    context,
    ledger: turn.ledger,
    validateCall: turn.containment.validate,
    signal: () => turn.session?.signal ?? null,
    limits,
    onProgress: ({ topic }) => {
      onProgress?.();
      status(ASSISTANT_STREAM_PHASES.TOOLS, { topic });
    }
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

const MAX_TRACED_ROUNDS = 16;

/** Model turunun amacı (içeriksiz): bildirim/plan, araç, takip, seçim ya da düzeltme. */
function roundPurpose(turn, canCallTools) {
  if (turn.trace.pending) return turn.trace.pending;
  if (!turn.ledger.ids().length) return turn.request ? 'tools' : 'plan';
  return canCallTools ? 'follow-up' : 'select';
}

function traceRound(turn, { purpose, startedAt, result = null, error = null }) {
  if (turn.trace.rounds.length >= MAX_TRACED_ROUNDS) return;
  const measured = result || error?.roundMeasurements;
  const usage = measured?.usage || {};
  if (!['repair', 'declaration', 'retry'].includes(purpose) && result) {
    purpose = result.toolCalls?.some((call) => call.name === 'rota_plan') ? 'plan'
      : result.toolCalls?.length ? (turn.toolsAttempted ? 'follow-up' : 'tools') : turn.ledger.ids().length ? 'select' : 'plan';
  }
  turn.trace.rounds.push({
    purpose,
    profile: turn.session.profile,
    model: turn.session.reportedModel?.(result?.model) ?? turn.session.model,
    configuredModel: turn.session.model,
    modelMismatch: result?.modelMismatch === true,
    durationMs: measured?.durationMs ?? Date.now() - startedAt,
    firstEventMs: measured?.firstEventMs ?? null,
    budget: turn.session.maxOutputTokens ?? null,
    finishReason: error && !measured ? 'error' : measured?.finishReason,
    toolCalls: result?.toolCalls?.length || 0,
    input: usage.promptTokens ?? null,
    completion: usage.completionTokens ?? null,
    reasoning: usage.reasoningTokens ?? null
  });
}

function traceTurn(turn, outcome, { selectedBy = null, code = null } = {}) {
  if (turn.trace.recorded) return;
  turn.trace.recorded = true;
  recordGroundedTurn({
    outcome, code, selectedBy, escalated: turn.escalated, durationMs: Date.now() - turn.trace.startedAt,
    modelRounds: turn.modelRounds, toolRounds: turn.toolRounds, declarations: turn.trace.declarations, repairs: turn.trace.repairs,
    revalidationMs: turn.trace.revalidationMs, verificationMs: turn.trace.verificationMs, rounds: turn.trace.rounds,
    ...turn.executor.stats(), ...turn.context.stats()
  });
}

function unavailableVerdict(locale) {
  return { ok: true, normalized: locale === 'en' ? 'Rota data is currently unavailable. Please try again later.' : 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', kind: 'unavailable', citedIds: [], issues: [] };
}

/** Doğrulayıcının girdisi: bu turun GEÇERLİ kanıtı, bildirilen istek ve sunucunun bağladığı seçim. */
function verdictInput(turn) {
  return {
    evidenceIds: turn.ledger.ids(),
    evidencePayloads: turn.ledger.payloads(),
    toolsAttempted: turn.toolsAttempted,
    toolsRequested: turn.toolsRequested,
    toolFailureCodes: turn.toolFailureCodes,
    route: turn.route,
    locale: turn.locale,
    request: turn.request,
    entries: turn.ledger.requestEntries(),
    selection: turn.containment.boundSelection(),
    today: turn.context.today
  };
}

/**
 * Çizimden hemen önce güncel yetki ve kanıt yeniden doğrulanır. Yetki ya da
 * kanıt okunamazsa bütün kanıt geçersizdir ve `true` (kullanılamıyor) döner.
 */
async function revalidate(turn, disclosureSignal = turn.session.signal) {
  const { ledger, context, limits } = turn;
  if (!ledger.ids().length || !context.authorizationEpoch) return false;
  const startedAt = Date.now();
  let unavailable = false;
  const validationDeadline = createAiDeadline({ timeoutMs: limits.callTimeoutMs, parentSignal: disclosureSignal });
  try {
    context.beginRound();
    try {
      await (context.revalidateAuthorization || context.authorization)(validationDeadline.signal);
      if (context.revalidateEvidence) ledger.retainAuthorized(await context.revalidateEvidence(ledger.authorizationEntries(), validationDeadline.signal));
    } catch (error) {
      if (isTurnFatal(error) || disclosureSignal?.aborted) throw error;
      unavailable = true;
      ledger.invalidateAuthorization(null);
    }
    ledger.invalidateAuthorization(context.authorizationEpoch(), context.isEvidenceAuthorized);
    // Sonraki model ya da araç işine kadar bu yetki okuması günceldir.
    if (!unavailable) turn.revalidatedAt = turn.work;
  } finally {
    validationDeadline.dispose();
    turn.trace.revalidationMs += Date.now() - startedAt;
  }
  return unavailable;
}

/** Doğrulanmış sonucun gösterimi: kapsam notunu sunucu ekler, yalnızca atfedilen kanıt kaydedilir. */
async function finish(turn, verdict, onText, selectedBy = 'model') {
  const { ledger, locale } = turn;
  const cited = ledger.summaries(verdict.citedIds);
  const disclosure = ['grounded', 'clarification'].includes(verdict.kind) ? withScopeDisclosure(verdict.normalized, cited, locale) : { text: verdict.normalized, disclosed: false };
  const finalText = ['grounded', 'clarification'].includes(verdict.kind) ? disclosure.text : verdict.normalized;
  await onText(finalText);
  const outcome = verdict.kind;
  const completeDisclosure = (deliveredOutcome, code = null) => {
    if (turn.trace.recorded) return;
    if (deliveredOutcome !== 'error') {
      recordGroundedAnswer({ outcome: deliveredOutcome, rounds: turn.modelRounds, evidence: deliveredOutcome === outcome ? cited.length : 0,
        repaired: turn.repaired, disclosed: deliveredOutcome === outcome && disclosure.disclosed });
    }
    traceTurn(turn, deliveredOutcome, { selectedBy: deliveredOutcome === 'grounded' ? selectedBy : null, code: typeof code === 'string' ? code : null });
  };
  if (!turn.deferDisclosure) completeDisclosure(outcome);
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
    stats: stats(turn),
    completeDisclosure,
    guardDisclosure: async (signal) => !(await revalidate(turn, signal)) && !turn.ledger.revoked()
  };
}

/** Yetki önce yenilenir; tek anlamlı aday aynı doğrulayıcıdan geçer. */
async function serverSelection(turn) {
  if (!turn.request || !turn.ledger.ids().length) return null;
  if (await revalidate(turn) || turn.ledger.revoked()) return unavailableVerdict(turn.locale);
  const startedAt = Date.now();
  const input = verdictInput(turn);
  // Kullanıcının yazdığı ad hiçbir görünür kayda uymuyorsa yanıt, varlığı ele vermeyen "bulunamadı"dır.
  if (unmatchedEntities(turn.request, input.entries, input.selection).length) {
    return { ok: true, normalized: turn.locale === 'en' ? 'The record was not found or is not accessible.' : 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.',
      kind: 'not_found', citedIds: [], issues: [] };
  }
  const verified = requestSelections(turn.request, input.entries, input.selection, input.today, (candidate) => analyze(candidate, input).ok);
  turn.trace.verificationMs += Date.now() - startedAt;
  if (verified.length !== 1) return null;
  const [selected] = verified;
  turn.status(ASSISTANT_STREAM_PHASES.VERIFYING);
  const checkedAt = Date.now();
  const verdict = analyze(selected, verdictInput(turn));
  turn.trace.verificationMs += Date.now() - checkedAt;
  return verdict.ok ? verdict : null;
}

/** Doğrulanamayan turun sabit güvenli yanıtı. */
async function failTurn(turn, onText) {
  const failureText = groundingFailureText(turn.locale);
  await onText(failureText);
  const completeDisclosure = (outcome, code = null) => {
    if (turn.trace.recorded) return;
    if (outcome !== 'error') recordGroundedAnswer({ outcome, rounds: turn.modelRounds, evidence: 0, repaired: turn.repaired });
    traceTurn(turn, outcome, { code: typeof code === 'string' ? code : null });
  };
  if (!turn.deferDisclosure) completeDisclosure('failed');
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
    stats: stats(turn),
    completeDisclosure
  };
}

/**
 * Standart kipte muhakeme ihtiyacı ya da ucuz kurtarmadan sonra kalan protokol
 * hatası aynı kanıt ve kapsamla Derin'e BİR kez devredilir.
 */
function escalation(turn, reason, { error = null } = {}) {
  turn.escalated = true;
  turn.transcript = [...turn.baseline];
  turn.trace.pending = null;
  // Kanıt okunmadıysa istek donmamıştır: Derin düşünme kendi planını ve bildirimini verebilir; eski kabul notu
  // (ör. "istek değiştirilemez") Derin'i bağlamaz. Yürütülen okumaların kaydı korunur: aynı okuma yinelenmez.
  if (!turn.ledger.size()) {
    turn.declarationsLeft = DECLARATION_ROUNDS;
    turn.declared = null;
    turn.request = null;
    turn.toolsAttempted = false;
    turn.permittedTools = null;
    clearAcceptedNote(turn);
  }
  if (turn.ledger.ids().length) instruct(turn, EVIDENCE_READY_NOTE);
  return {
    outcome: 'escalate',
    reason,
    resume: turn,
    toolsReused: turn.ledger.ids().length > 0,
    traceError: (error) => traceTurn(turn, 'error', { code: error?.code }),
    models: [...turn.models],
    fallback: (onText) => {
      if (error) { traceTurn(turn, 'error', { code: error.code }); throw error; }
      return failTurn(turn, onText);
    }
  };
}

/**
 * Bildirimden türetilen okumalar, model çağrısıyla aynı ham biçimde: adla bildirilen
 * varlığın çözümü ya da varlıklar bağlıysa nüfus okuması (bkz. requestPopulation.derivedReads).
 */
function derivedCalls(turn, request) {
  if (!request?.population) return [];
  const entries = turn.ledger.requestEntries();
  const selection = turn.containment.boundSelection();
  const bound = bindRequestEntities(request, entries, selection);
  const reads = derivedReads(request, bound, { today: turn.context.today, attempted: turn.attemptedReads });
  // Tam adı hiçbir kayda uymayan varlık için adın ilk sözcüğüyle bir yoklama araması yapılır.
  const probes = reads.length ? [] : nameProbes(request, entries, selection)
    .filter(({ name, args }) => !turn.attemptedReads.has(readKey(name, args, turn.context.today)));
  return [...reads, ...probes].map(({ name, args }) => ({ id: 'derived', name, arguments: JSON.stringify(args), oversize: false }));
}

/** Doğrulanmış yürütme kümesini çalıştırır; model ve sunucu okumaları aynı yoldan geçer. */
async function executeRound(turn, executed) {
  const { executor, containment, catalog, limits } = turn;
  turn.toolsAttempted = true;
  turn.route = TURN_ROUTES.ROTA;
  turn.toolFailureCodes.clear();
  turn.toolRounds += 1;
  for (const call of executed) turn.attemptedReads.add(readKey(call.name, call.args, turn.context.today));
  const toolMessages = await executor.runRound(executed);
  turn.work += 1;
  turn.progress();
  for (const message of toolMessages) {
    const body = toolMessageBody(message);
    if (body?.ok === false && typeof body.error?.code === 'string') turn.toolFailureCodes.add(body.error.code);
  }
  containment.establish(executed, toolMessages);
  if (toolMessages.some((message) => toolMessageBody(message)?.ok === true)) {
    // Her başarılı turun takip araçları eklenir: çok adımlı çözüm (kişi →
    // görev → ayrıntı) mümkündür; bağımsız değişkenler kapsam sınırına bağlı kalır.
    const next = toolsForInitialCalls(executed, catalog, toolMessages);
    // Veri okunmadan bildirilen nüfus aracı da açık kalır; bağımsız değişkenleri yine kapsam sınırına bağlıdır.
    const declared = turn.request?.population?.tool;
    turn.permittedTools = new Set([...(turn.permittedTools || []), ...next, ...(declared && catalog.some((tool) => tool.name === declared) ? [declared] : [])]);
  }
  record(turn, { role: 'assistant', content: '', toolCalls: safeToolCallsForTranscript(executed, toolMessages) }, ...toolMessages);
  if (turn.toolRounds >= limits.maxToolRounds) instruct(turn, roundLimitNote());
}

/** `resume` aynı defter, kapsam ve tur bütçesiyle muhakeme devrini sürdürür. */
export async function runGroundedTurn(session, {
  messages,
  catalog,
  context,
  limits = TOOL_LIMITS,
  allowedTextFields = [],
  clarification = null,
  onStatus = null,
  onProgress = null,
  onText,
  escalation: escalationAvailable = false,
  resume = null,
  deferDisclosure = false
}) {
  const turn = resume || startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, onStatus, onProgress });
  turn.session = session;
  turn.deferDisclosure = deferDisclosure;
  // Yeni oturum (kuyruk beklemesi dâhil) yetkinin yeniden okunmasını gerektirir.
  turn.work += 1;
  try {
    return await continueTurn(turn, { escalationAvailable, onText, resumed: Boolean(resume) });
  } catch (error) {
    if (!resume) traceTurn(turn, 'error', { code: typeof error?.code === 'string' ? error.code : null });
    throw error;
  }
}

async function continueTurn(turn, { escalationAvailable, onText, resumed }) {
  const { ledger, executor, containment, status, catalog, limits, session } = turn;
  // İstek ilk kanıtla donar: veri okunmadan (çağrılar başarısız olsa da) plan ve bildirim yenilenebilir.
  const frozen = () => ledger.size() > 0;
  const canEscalate = () => escalationAvailable && escalationPermitted(turn);
  const toolsAvailable = () => turn.toolRounds < limits.maxToolRounds && executor.stats().attempted < limits.maxTotalCalls;
  // Ucuz kurtarma tükendiğinde Standart tur Derin'e bir kez devredilir. Veri okunduysa Derin araç
  // çağıramaz: devir yalnızca kanıt bildirilen isteği belirlenimci olarak karşılayabiliyorsa yapılır.
  // Veri okunmadıysa Derin yeniden planlar; ortak araç turu bütçesi tükendiyse planı yürütemez.
  const evidenceReady = () => Boolean(turn.request && requestEvidenceReady(turn.request, ledger.requestEntries(), turn.context.today, containment.boundSelection()));
  const deepCanHelp = () => canEscalate() && (frozen() ? evidenceReady() : toolsAvailable());
  const fallback = (reason) => (deepCanHelp() ? escalation(turn, reason) : failTurn(turn, onText));
  const rejectDeclaration = (calls, details, hints = [], problems = null, executionCalls = calls) => {
    if (calls.length) turn.toolsRequested = true;
    // Kapsam dışı çağrı veri okunmadan reddedilse de Derin düşünme devrini engeller.
    for (const problem of problems || []) if (ESCALATION_BLOCKING_TOOL_CODES.has(problem.error.code)) turn.toolFailureCodes.add(problem.error.code);
    if (turn.declarationsLeft <= 0) return false;
    turn.declarationsLeft -= 1;
    turn.trace.pending = 'declaration';
    if (calls.length) recordRejectedPlan(turn, calls, details, hints, problems, executionCalls);
    instruct(turn, declarationRepair(details, hints), { repair: true });
    return true;
  };
  let allowTools = resumed ? !frozen() : true;
  let lengthExhausted = false;
  for (;;) {
    // Geçerliliğini yitiren kanıt dökümdedir: başka bir sağlayıcı turu ya da görünür yanıt olamaz.
    if (ledger.revoked()) return finish(turn, unavailableVerdict(turn.locale), onText);
    // Kanıt sağlayıcıya her gönderilişten önce günceldir; arada iş yoksa yeni okuma gerekmez.
    if (ledger.ids().length && turn.revalidatedAt !== turn.work) {
      if (await revalidate(turn) || ledger.revoked()) return finish(turn, unavailableVerdict(turn.locale), onText);
    }
    const canCallTools = allowTools && toolsAvailable();
    status(ASSISTANT_STREAM_PHASES.GENERATING);
    turn.modelRounds += 1;
    boundTranscript(turn.transcript);
    const purpose = roundPurpose(turn, canCallTools);
    turn.trace.pending = null;
    const startedAt = Date.now();
    let result;
    try {
      result = await session.round({
        messages: turn.transcript,
        // Plan aracı salt okunur araçlarla birlikte sunulur: plan çağrıları kendi içinde ya da yanında taşıyabilir.
        tools: !frozen() ? [typedPlanningTool(catalog), ...catalog] : turn.permittedTools ? catalog.filter((tool) => turn.permittedTools.has(tool.name)) : catalog,
        toolChoice: canCallTools ? 'auto' : 'none',
        onEvent: async (event) => {
          turn.progress();
          if (event.type === 'thinking') status(ASSISTANT_STREAM_PHASES.THINKING);
          else if (event.type === 'generating') status(ASSISTANT_STREAM_PHASES.GENERATING);
        }
      });
    } catch (error) {
      turn.work += 1;
      traceRound(turn, { purpose, startedAt, error });
      if (!isEmptyCompletion(error) || session.signal?.aborted) throw error;
      // Boş yanıt yan etkisizdir: aynı tur, oturumda bir kez ve süre kaldıysa yeniden istenir.
      if (!turn.emptyRetried && (session.remainingMs?.() ?? 0) >= EMPTY_COMPLETION_RETRY_MIN_MS) {
        turn.emptyRetried = true;
        turn.trace.pending = 'retry';
        continue;
      }
      if (deepCanHelp()) return escalation(turn, 'EMPTY_COMPLETION', { error });
      throw error;
    }
    turn.work += 1;
    traceRound(turn, { purpose, startedAt, result });
    const reported = session.reportedModel?.(result.model) ?? session.model;
    if (reported) turn.models.push(reported);
    // Yerel çağrı yerine metin olarak dönen plan aynı plan doğrulamasından geçer.
    const textPlan = !frozen() && !result.toolCalls.length ? textPlanCall(result.text) : null;
    if (textPlan) result = { ...result, text: '', toolCalls: [textPlan] };
    const modelCalls = result.toolCalls;
    let plan = null;
    if (!frozen() && result.toolCalls.some((call) => call.name === 'rota_plan')) {
      try { plan = unpackTypedPlan(result); }
      catch (error) {
        turn.trace.declarations += 1;
        if (rejectDeclaration(modelCalls, error.details)) continue;
        return fallback('REQUEST_DECLARATION');
      }
    }
    let calls = plan ? plan.calls : result.toolCalls;

    if (result.finishReason === 'length') {
      if (turn.repairsLeft > 0) {
        turn.repairsLeft -= 1;
        turn.repaired = true;
        turn.trace.repairs += 1;
        turn.trace.pending = 'repair';
        allowTools = !frozen();
        instruct(turn, 'Çıktı sağlayıcı sınırında kesildi. Önceki kesik JSON geçersizdir. En fazla 8 iddiayla daha kısa ve tam bir JSON üret; gerekli ise listeyi daralt.', { repair: true });
        continue;
      }
      lengthExhausted = true;
      result.text = '';
      calls = [];
    }
    const declaration = plan ? { kind: 'route', ...plan.plan } : parseEvidenceResponse(result.text);
    const declaredRoute = parseTurnRoute(declaration);
    // Bildirim yalnızca veri okunmadan önce kabul edilir; sonrasında istek değişmez.
    const declared = !frozen() && declaredRoute ? acceptDeclaration(turn, declaration, declaredRoute) : null;
    if (declared) turn.trace.declarations += 1;
    // Çağrısız istek: okumalar bildirimden kurulabiliyorsa sunucu kurar; kurulamıyorsa plan çağrı ister.
    if (declared?.ok && declared.request && !calls.length && canCallTools) {
      const completed = preparePlan(turn, [], declared);
      calls = completed.ok ? derivedCalls(turn, completed.request) : [];
      if (!calls.length && plan) {
        // Okuma kurulamadıysa önce isteğin kendi sorunları (ör. aracın metin süzgeci yok) bildirilir; yoksa çağrı istenir.
        const reasons = preparePlan(turn, [], declared);
        const details = reasons.ok ? ['$.calls:required'] : reasons.details;
        if (rejectDeclaration(modelCalls, details, reasons.ok ? [] : reasons.hints)) continue;
        return fallback('REQUEST_DECLARATION');
      }
    }
    if (declared && !calls.length && turn.declarationsLeft > 0) {
      turn.route = declaredRoute;
      if (declared.ok) {
        const prepared = declared.request ? preparePlan(turn, [], declared) : { ok: true };
        if (!prepared.ok) {
          if (rejectDeclaration(modelCalls, prepared.details, prepared.hints)) continue;
          return fallback('REQUEST_DECLARATION');
        }
        if (declared.request) acceptRequest(turn, prepared.request, declared.language);
        else { turn.declared = null; if (declared.language) turn.locale = declared.language; }
        turn.declarationsLeft -= 1;
        instruct(turn, `Bu turun veri okunmadan belirlenen yönlendirmesi: ${turn.route}. Şimdi bu niyete göre yanıtla; Rota olguları yalnızca araç kanıtıyla sunulur.`);
      } else {
        // Reddedilen plan, plan doğrulamasındaki retle aynı biçimde modelin kendi çağrısı olarak kalır.
        rejectDeclaration(modelCalls, declared.details, declared.hints);
      }
      continue;
    }
    if (calls.length && canCallTools) {
      let prepared;
      if (!frozen()) {
        // Plan: istek ve bütün çağrılar (plan içi ve doğrudan) birlikte, SQL'den önce doğrulanır.
        prepared = preparePlan(turn, calls, declared);
        if (!prepared.ok) {
          turn.route = TURN_ROUTES.ROTA;
          if (rejectDeclaration(modelCalls, prepared.details, prepared.hints, prepared.problems, calls)) continue;
          return fallback('REQUEST_DECLARATION');
        }
        acceptRequest(turn, prepared.request, declared?.language);
      } else {
        prepared = prepareExecutionSet(calls, { catalog, permitted: turn.permittedTools, validateCall: requestCallValidator(turn, turn.request, derivedCalls(turn, turn.request)), limits,
          attempted: executor.stats().attempted, callId: turn.callId, today: turn.context.today });
        if (!prepared.ok) {
          // Geçersiz küme hiç yürütülmez; reddedilen tur araç turu bütçesinden düşer.
          turn.toolsRequested = true;
          turn.toolRounds += 1;
          turn.work += 1;
          for (const problem of prepared.problems) turn.toolFailureCodes.add(problem.error.code);
          recordRejectedRound(turn, calls, prepared.problems);
          if (turn.toolRounds >= limits.maxToolRounds) instruct(turn, roundLimitNote());
          continue;
        }
      }
      await executeRound(turn, prepared.calls);
      // Bildirilen nüfus henüz okunmadıysa (ör. adla çözülen varlığın okuması) sunucu okumayı bildirimden kurar.
      while (!ledger.revoked() && toolsAvailable() && !evidenceReady()) {
        const needed = derivedCalls(turn, turn.request);
        const derived = prepareExecutionSet(needed, { catalog, validateCall: requestCallValidator(turn, turn.request, needed), limits,
          attempted: executor.stats().attempted, callId: turn.callId, today: turn.context.today });
        if (!derived.ok || !derived.calls.length) break;
        await executeRound(turn, derived.calls);
      }
      // Bildirilen istek kanıttaki olguları belirliyorsa ayrı bir model seçim turu gerekmez.
      const settled = await serverSelection(turn);
      if (settled) return finish(turn, settled, onText, 'server');
      if (turn.request.reasoning === 'synthesis' && evidenceReady() && canEscalate()) return escalation(turn, 'SYNTHESIS_REQUIRED');
      continue;
    }

    const authorizationUnavailable = await revalidate(turn);
    const text = String(result.text || '').trim();
    status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verifyStartedAt = Date.now();
    const verdict = authorizationUnavailable || ledger.revoked() ? unavailableVerdict(turn.locale) : analyze(text, verdictInput(turn));
    turn.trace.verificationMs += Date.now() - verifyStartedAt;
    if (verdict.ok) return finish(turn, verdict, onText);

    if (turn.repairsLeft > 0) {
      const evidenceGap = verdict.issues.some((issue) => EVIDENCE_GAP_CODES.has(issue?.code));
      // Eksik kanıt önce mevcut araç bütçesiyle tamamlanır.
      turn.repairsLeft -= 1;
      turn.repaired = true;
      turn.trace.repairs += 1;
      turn.trace.pending = 'repair';
      const hint = turn.request && verdict.kind === 'grounded' ? requestRepairHint(turn.request, ledger.requestEntries()) : '';
      instruct(turn, groundingRepairInstruction(verdict.issues, hint), { repair: true });
      // Kanıt varken düzeltme yeniden seçimdir; kanıt yoksa ya da bildirilen
      // ölçü/nüfus eldeki kanıtta yoksa model gereken aracı çağırabilir (araç turu sınırı sürer).
      allowTools = ledger.ids().length === 0 || evidenceGap;
      continue;
    }

    return fallback(lengthExhausted ? 'LENGTH' : 'VERIFICATION_FAILED');
  }
}
