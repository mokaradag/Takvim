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
import { recordGroundedAnswer, recordGroundedTurn, recordPlannerDecision, recordPlannerRejection } from '../aiTelemetry.js';
import { createEvidenceLedger } from '../tools/evidenceLedger.js';
import { createToolExecutor } from '../tools/toolExecutor.js';
import { getRotaTool, TASK_RESULT_SCOPE_TOOLS, toolCatalogForModel } from '../tools/toolRegistry.js';
import { parseEvidenceResponse } from '../../../domain/ai/evidenceVerification.js';
import { invalidArguments, isTurnFatal, TOOL_ERROR_CODES, ToolError } from '../tools/toolErrors.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';
import { containmentText, createToolScope, rowIdentityPath } from '../tools/toolScope.js';
import { bindRequestEntities, declarationHints, parseRequestDeclaration, requestEvidence, requestEvidenceReady, requestRepairHint, requestSelections, requestSummary, requestWindow,
  dependentEntity, droppedNameHint, droppedNames, instantiateDependent, metricIdHints, namedScope, nameProbes, requestSchema, unmatchedEntities } from '../tools/requestDeclaration.js';
import { parseToolArguments } from '../tools/toolArguments.js';
import { createCallIds, planShapeHints, prepareExecutionSet, rejectionFor, typedPlanningTool, unpackTypedPlan } from '../tools/executionSet.js';
import { completeRequest, derivedReads, readKey, requestBoundCall, requestTextFields, declaredFacets, requestDimensions, requestScopeForTool } from '../tools/requestPopulation.js';
import { parseTurnLanguage, parseTurnRequest, parseTurnRoute, TURN_ROUTES } from '../../../domain/ai/evidenceIntent.js';
import { CLARIFICATION_LIMITS, clarificationReference } from '../../../domain/ai/clarification.js';
import { renderClarification } from '../../../domain/ai/evidenceNarrative.js';
import { createAiDeadline } from '../aiDeadline.js';
import { concreteCollections, rankedRowIndexes, taskResultScope } from '../../../domain/ai/requestContract.js';
import { EVIDENCE_TEXT_FIELDS, METRICS, metricEntityType, metricPaths, rowCollections } from '../../../domain/ai/claimableEvidence.js';
import { PLANNER_INTENTS, PLANNER_LIMITS, renderDependentLimit, renderPartUnavailable, renderPlannerAbstention, renderPlannerClarification, renderTextFieldsRequired } from '../../../domain/ai/plannerOutcome.js';
import { plannerCandidateNote } from './groundedPrompt.js';

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

/**
 * Sunucu notu dökümün SONUNA ayrı sistem iletisi olarak eklenir: sistem yönergesi ve araç şemaları tur boyunca ve
 * turlar arasında bayt bayt aynı kalır (sağlayıcı önek önbelleği; düzeltme turu öneki yeniden işletmez).
 */
function appendServerInstruction(transcript, instruction) {
  transcript.push({ role: 'system', content: instruction });
}

/** Tur başındaki not kullanıcının güncel sorusundan hemen önce durur; soru son ileti kalır. */
function noteBeforeQuestion(transcript, content) {
  transcript.splice(Math.max(0, transcript.findLastIndex((message) => message.role === 'user')), 0, { role: 'system', content });
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

/** Karar öncesi turların araç seçimi: yalnızca türlü plan aracı (adlı işlev seçimi). */
const PLAN_TOOL_CHOICE = Object.freeze({ name: 'rota_plan' });

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
const structuralNames = new Set(['plan', 'calls', 'request', 'additionalRequests', 'clarify', 'abstain', 'reason', 'topics', 'from', 'intent', 'language', 'name', 'arguments', 'metric', 'entity', 'field',
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
  const hints = [...new Set([...serverHints.slice(0, 6), ...planShapeHints(problems), ...declarationHints(problems)])];
  return [
    'SUNUCU DOĞRULAMASI: Araç çağrıları çalıştırılmadı. Rota verisi okunmadan önce geçerli bir istek bildirimi gerekir.',
    ...(problems.length ? [`Bildirim sorunları: ${problems.join(', ')}`] : []),
    ...(hints.length ? [`Beklenen biçim: ${hints.join('; ')}`] : []),
    'Yalnızca bildirilen sorunları düzelt; sorunsuz araç, ölçü, süzgeç ve çağrı bağımsız değişkenlerini değiştirme. Sorunlu ölçüyü SİLME: ölçü aynı soruya aitse ipucundaki taşıyıcı araçlardan birini population.tool yap; başka bir aracın yanıtladığı ayrı bir soruysa onu additionalRequests içinde o aracın ek bölümüne taşı. Sorun yolları request alanına göredir ($.entities = request.entities; ek bölümlerde $.additionalRequests[n]).',
    'Yanıtın yeniden rota_plan çağrısı olmalıdır: Rota verisi gerekiyorsa intent rota, language tr|en, request (ileti ayrı okuma gerektiren başka sorular da soruyorsa ayrıca additionalRequests) içinde operation/metrics/population/layout (ve gerekiyorsa entities/filters); calls isteğe bağlıdır (sunucu okumaları istekten kurar). Soru gerçekten belirsizse intent clarify (clarify.reason), yapılamayan ya da güvensiz istekte intent abstain (abstain.reason). rota_plan olmadan tek başına doğrudan araç çağrısı ya da düz metin yanıt geçerli değildir; normal asistan metni gerekmez.',
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
  // Düzeltme ipuçları modelin gördüğü araç sonucunda da yer alır (sunucu ipuçları, plan ve istek şeması).
  const paths = problemPaths(details);
  const guidance = [...new Set([...hints, ...planShapeHints(paths), ...declarationHints(paths)])];
  const error = (call) => {
    if (call.own) return { code: call.own.code, details: problemPaths(call.own.details || []) };
    return { code: TOOL_ERROR_CODES.INVALID_ARGUMENTS, ...(planned && call.name !== 'rota_plan' ? { details: ['$.plan:invalid'] }
      : { details: paths, ...(guidance.length ? { hints: guidance.slice(0, 6) } : {}) }) };
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
      identityTrusted: turn.containment.identityTrusted, referent: turn.containment.referent,
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
function preparePlan(turn, calls, declared, parts = []) {
  if (declared && !declared.ok) return { ok: false, details: declared.details, hints: declared.hints || [] };
  const provisional = declared?.request || turn.declared;
  if (!provisional) return { ok: false, details: ['$.request:required'], hints: [] };
  const set = prepareExecutionSet(calls, { catalog: turn.catalog, validateCall: turn.containment.validate, limits: turn.limits,
    attempted: turn.executor.stats().attempted, callId: turn.callId, today: turn.context.today });
  if (!set.ok) {
    return { ok: false, details: set.problems.flatMap((problem) => problem.error.details?.length ? problem.error.details : [`$.calls:${problem.error.code}`]),
      hints: [], problems: set.problems };
  }
  // Çok bölümlü planın okumaları yalnızca sunucunun bölümlerden kurduğu okumalardır; ilk bölüm kendi bildirimiyle tamamdır.
  const completion = completeRequest(provisional, parts.length ? [] : set.calls.map(({ name, args }) => ({ name, args })),
    { today: turn.context.today, allowedTextFields: turn.allowedTextFields });
  if (completion.problems.length) return { ok: false, details: completion.problems, hints: completion.hints };
  if (completion.request.previousResult && (!turn.previousResult || parts.length || completion.request.entities.length
    || !TASK_RESULT_SCOPE_TOOLS.includes(completion.request.population.tool))
    || parts.some(part => part.request.previousResult)) {
    return { ok: false, details: ['$.previousResult:unavailable'], hints: ['previousResult yalnızca sunucunun hemen önceki görev kümesi varsa, tek bölümlü kimliksiz görev arama/analiz isteğinde kullanılabilir.'] };
  }
  // Düzeltme kullanıcının adlandırdığı bir kaydı düşüremez (zayıf model reddi soruyu daraltarak "onarır").
  const dropped = droppedNames(turn.namedScope, completion.request);
  if (dropped.length) return { ok: false, details: ['$.entities:dropped'], hints: [droppedNameHint(dropped)] };
  const validateCall = requestCallValidator(turn, completion.request);
  const checked = prepareExecutionSet(calls, { catalog: turn.catalog, validateCall, limits: turn.limits,
    attempted: turn.executor.stats().attempted, callId: turn.callId, today: turn.context.today });
  if (!checked.ok) {
    const details = checked.problems.flatMap((problem) => problem.error.details || []);
    // İsteğe bağlanamayan okuma ayrı bir soruya aitse çağrı olarak değil ek bölüm olarak bildirilir.
    const hints = details.some((detail) => String(detail).endsWith('.request:unrelated')) ? [UNRELATED_CALL_HINT] : [];
    return { ok: false, details, hints, problems: checked.problems };
  }
  return { ok: true, request: completion.request, calls: checked.calls };
}

const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const repairDimensions = (semantic) => {
  const { tool, collection: _collection, ...dimensions } = semantic.population || {};
  const defaults = tool ? requestDimensions({ population: { tool }, filters: {} }, tool) : {};
  return stable(Object.fromEntries(Object.entries(dimensions).filter(([key, value]) => value != null && stable(value) !== stable(defaults[key]))));
};

const repairCalls = (turn, calls) => calls.filter((call) => call.name !== 'rota_plan').flatMap((call) => {
  const definition = getRotaTool(call.name);
  if (!definition) return [];
  let raw;
  try { raw = call.args || JSON.parse(call.arguments); } catch { return []; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || call.oversize) return [];
  const args = {};
  // Hatalı bir bağımsız değişken, geçerli kardeş koşulları silmez; bunlar yürütülecek çağrı değildir.
  for (const [key, schema] of Object.entries(definition.parameters.properties)) {
    if (!Object.hasOwn(raw, key)) continue;
    try {
      const valid = parseToolArguments({ type: 'object', additionalProperties: false, properties: { [key]: schema } }, JSON.stringify({ [key]: raw[key] }));
      turn.containment.validate(call.name, valid);
      Object.assign(args, valid);
    } catch (error) { if (!(error instanceof ToolError)) throw error; }
  }
  return [{ name: call.name, args }];
});

/** Düzeltme eşitliği sunucunun tamamladığı anlamdır; boş seçenekler ve varsayılanlar anlam değildir. */
function repairSemantic(turn, raw, index, calls = []) {
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null
      && !(Array.isArray(item) && !item.length) && !(typeof item === 'object' && !Object.keys(item).length)).map(([key, item]) => [key, clean(item)]));
  };
  const parsed = parseRequestDeclaration(clean(raw), { textTrusted: turn.containment.textTrusted, identityTrusted: turn.containment.identityTrusted, referent: turn.containment.referent,
    today: turn.context.today, priorParts: index });
  const completion = completeRequest(parsed, calls, { today: turn.context.today, allowedTextFields: turn.allowedTextFields });
  const request = completion.request;
  const tool = request.population?.tool;
  const semantic = { ...request, metrics: [...request.metrics].sort(), entities: request.entities.map(({ query: _query, ...entity }) => entity),
    filters: tool ? declaredFacets(tool, request.filters, turn.context.today) : request.filters,
    population: tool ? { tool, collection: request.population.collection ?? null, ...requestDimensions(request, tool) } : null,
    rank: request.rank ? { ...request.rank, limit: request.rank.limit ?? 1 } : null };
  return { semantic, problems: completion.problems };
}

/** Yalnızca reddedilen istek yolları serbesttir; diğer anlamlar tek kanonik izdüşümde kalır. */
function repairAllowance(details, raw) {
  const paths = new Set();
  for (const detail of details) {
    const [path, reason] = String(detail).split(':');
    if (!path.startsWith('$.')) continue;
    if (path.startsWith('$.calls')) {
      const key = /^\$\.calls\[\d+\]\.[^.]+\.([^.[]+)/.exec(path)?.[1];
      if (Object.hasOwn(requestSchema().properties.filters.properties, key) && raw.filters?.[key] == null) paths.add(`filters.${key}`);
      if (['sort', 'groupBy', 'depth', 'textFields'].includes(key) && raw.population?.[key] == null) paths.add(`population.${key}`);
      const entity = { taskId: 'task', projectId: 'project', personSicil: 'person', wbsId: 'wbs', baselineId: 'baseline' }[key];
      if (entity && !(Array.isArray(raw.entities) ? raw.entities : []).some(item => item?.type === entity)) paths.add(`callEntity:${entity}`);
      continue;
    }
    const relative = path.replace(/^\$\.(?:additionalRequests\[\d+\]\.|request\.)?/, '');
    if (typeof raw.filters?.text === 'string' && (reason === 'population' && relative.startsWith('metrics') || relative === 'filters.text' && reason === 'unsupported')) {
      const type = metricEntityType(raw.metrics?.[0]);
      if (['task', 'project', 'person', 'wbs', 'baseline'].includes(type)) paths.add(`textSelector:${type}`);
      paths.add('population.collection');
    }
    if (['fields', 'bindings'].includes(relative) && reason === 'unique') { paths.add(`${relative}Unique`); continue; }
    if (relative === 'metrics' && reason === 'unique') { paths.add('metricsUnique'); continue; }
    if (relative === 'metrics' && reason === 'maxItems') continue;
    if (relative === 'bindings' && reason === 'unknown' && Array.isArray(raw.bindings)) {
      raw.bindings.forEach((binding, index) => {
        if (!raw.metrics?.includes?.(binding?.metric) || !raw.entities?.[binding?.entity]) paths.add(`bindings[${index}]`);
      });
      continue;
    }
    if (relative === 'metrics' || /^metrics\[\d+\]$/.test(relative)) {
      if (reason === 'population') {
        paths.add('population.tool'); paths.add('population.collection');
        (Array.isArray(raw.fields) ? raw.fields : []).forEach((_, i) => { paths.add(`fields[${i}].tool`); paths.add(`fields[${i}].path`); });
      } else {
        paths.add(relative);
        if (!(Array.isArray(raw.metrics) ? raw.metrics : []).some(metric => Object.hasOwn(METRICS, metric))) {
          paths.add('population.tool'); paths.add('population.collection');
        }
      }
    } else if (/^filters\.(period|deadline)$/.test(relative) && reason === 'conflict') {
      for (const key of ['period', 'dateFrom', 'dateTo', ...(relative === 'filters.deadline' ? ['deadline'] : [])]) paths.add(`filters.${key}`);
    } else if (relative === 'rank' && reason === 'operation') paths.add('rank');
    else if (Object.hasOwn(requestSchema().properties, relative.split(/[.[]/)[0])) paths.add(relative);
  }
  // Geçersiz birleşim, önceki görev kümesine bağı silme izni değildir.
  if (raw.previousResult === true) paths.delete('previousResult');
  return paths;
}

/** Yerel yol maskesi yürütme izni değildir; sonuç her zaman tam plan doğrulamasından geçer. */
function repairOmit(value, paths, prefix = '') {
  if (paths.has(prefix)) return undefined;
  if (Array.isArray(value)) return value.map((item, index) => repairOmit(item, paths, `${prefix}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairOmit(item, paths, prefix ? `${prefix}.${key}` : key)])
    .filter(([, item]) => item != null && !(Array.isArray(item) && !item.length) && !(typeof item === 'object' && !Object.keys(item).length)));
}

/** Geçerli kardeşler birebir eşlenir; bozuk yuvalar kaldırılabilir, yeni yuva açılamaz. */
function repairItemsMatch(pin, sections, key, indexes, bindEntities = true) {
  if (!Array.isArray(pin.raw[key] || [])) return pin.paths.has(key);
  if (!indexes.every(index => Array.isArray(sections[index][key] || []))) return false;
  const candidates = indexes.flatMap(index => (sections[index][key] || []).map(item => ({ item, raw: sections[index] })));
  // Bölme tam ölçü kümesini korur; satır hatası ölçü silme izni değildir.
  if (key === 'metrics') return stable(candidates.map(({ item }) => item).sort())
    === stable((pin.paths.has('metricsUnique') ? [...new Set(pin.raw.metrics)] : [...pin.raw.metrics]).sort());
  const paths = new Set([...pin.paths].filter(path => path !== key));
  const normalized = (item, raw, prefix) => {
    const masked = repairOmit(item, paths, prefix);
    return bindEntities && masked && key === 'bindings' && Object.hasOwn(masked, 'entity') ? { ...masked, entity: raw.entities?.[masked.entity] } : masked;
  };
  const seen = new Set();
  const choices = [];
  const optional = [];
  let omitted = 0;
  for (const [slot, item] of (pin.raw[key] || []).entries()) {
    if (pin.paths.has(`${key}Unique`) && seen.has(stable(item))) continue;
    seen.add(stable(item));
    const prefix = `${key}[${slot}]`;
    const expected = normalized(item, pin.raw, prefix);
    if (expected === undefined) { omitted += 1; continue; }
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
    const matches = candidates.flatMap((candidate, at) => stable(normalized(candidate.item, candidate.raw, prefix)) === stable(expected) ? [at] : []);
    (key === 'fields' && pin.paths.has(`${prefix}.path`) ? optional : choices).push(matches);
  }
  // Kısmi maske geçerli kardeşin tek eşleşmesini tüketemez.
  const owners = new Map();
  const assign = (slot, visited) => choices[slot].some(at => {
    if (visited.has(at)) return false;
    visited.add(at);
    if (owners.has(at) && !assign(owners.get(at), visited)) return false;
    owners.set(at, slot);
    return true;
  });
  if (!choices.every((_, slot) => assign(slot, new Set()))) return false;
  for (const matches of optional) {
    choices.push(matches);
    assign(choices.length - 1, new Set());
  }
  return candidates.length - owners.size <= omitted;
}

function repairProjection(turn, raw, index, calls, sections, paths, references = null, preserved = raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return stable({ invalid: typeof raw });
  // Ham model biçimi eşitlikten önce güvenilir sayılmaz; bozuk türler hiçbir zaman diziye zorlanmaz.
  for (const key of ['metrics', 'entities', 'fields', 'bindings']) {
    if (raw[key] != null && !Array.isArray(raw[key]) && !paths.has(key)) return stable({ invalid: key, value: raw[key] });
  }
  const known = Object.fromEntries(Object.entries(raw).filter(([key]) => Object.hasOwn(requestSchema().properties, key)));
  const masked = repairOmit(known, paths);
  const transfer = [...paths].find(path => path.startsWith('textSelector:'))?.split(':')[1];
  const selector = transfer && (masked.entities || []).find(entity => entity?.type === transfer && entity.text);
  const textScope = transfer ? known.filters?.text || selector?.text || null : null;
  if (transfer) {
    masked.filters = { ...masked.filters }; delete masked.filters.text;
    masked.entities = (masked.entities || []).filter(entity => entity !== selector);
  }
  const affected = index => [...paths].some(path => path.startsWith(`entities[${index}]`));
  const placeholders = (masked.entities || []).flatMap((entity, index) => entity && affected(index)
    ? [{ index, entity: { ...entity, id: entity.id ?? null, text: entity.text ?? null } }] : []);
  // Sorunlu yapraklar ayrıştırmayı engellemez; alan/bağlama niyeti ayrıca, aynı maskeyle korunur.
  const metrics = [...new Set((masked.metrics || []).filter(metric => Object.hasOwn(METRICS, metric)))].slice(0, requestSchema().properties.metrics.maxItems);
  const surrogateIndexes = new Set();
  const entities = (masked.entities || []).flatMap((entity, index) => {
    if (!entity) return [];
    if (!affected(index)) return [entity];
    const resolver = { task: 'rota_task_search', project: 'rota_project_search', person: 'rota_person_search' }[entity.type];
    const call = calls.find(call => call.name === resolver && typeof call.args.text === 'string' && turn.containment.textTrusted(call.args.text));
    return call ? [{ type: entity.type, text: call.args.text, repairSurrogate: true }] : [];
  }).map(({ repairSurrogate, ...entity }, index) => {
    if (repairSurrogate) surrogateIndexes.add(index);
    return entity;
  });
  const probe = { ...masked, entities, operation: masked.operation || 'value', metrics: metrics.length ? metrics : ['tasks.total'], fields: [], bindings: [] };
  if (!probe.population?.tool) probe.population = raw.population;
  let semantic;
  try {
    semantic = repairSemantic(turn, probe, index, calls).semantic;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    // Daha erken şema hatası kalan anlamı serbest bırakamaz.
    semantic = { ...masked, layout: masked.layout || 'auto', reasoning: masked.reasoning || 'deterministic' };
  }
  semantic = { ...semantic, entities: (semantic.entities || []).filter((_, index) => !surrogateIndexes.has(index)) };
  for (const { index, entity } of placeholders) semantic = { ...semantic, entities: [...(semantic.entities || []).slice(0, index), entity, ...(semantic.entities || []).slice(index)] };
  semantic = { ...semantic, metrics: masked.metrics ? [...new Set(masked.metrics.filter(item => item != null))].sort() : null,
    fields: masked.fields || [], bindings: masked.bindings || [] };
  if (paths.has('population.tool')) {
    semantic.population = { dimensions: repairDimensions(semantic) };
  }
  semantic.entities = (semantic.entities || []).filter(entity => !paths.has(`callEntity:${entity?.type}`));
  // Bağımlılık, onarılmakta olan kaynağın ham anlamına değil aynı kaynak bölümüne bağlanır.
  semantic.entities = semantic.entities.map(entity => entity?.from == null ? entity
    : { ...entity, from: references ? references.get(entity.from) ?? 'unmatched' : entity.from });
  const projectionPaths = new Set([...paths].filter(path => !path.startsWith('metrics[')));
  const itemRepairs = {};
  for (const key of ['fields', 'bindings']) {
    if (paths.has(key) || ![...paths].some(path => path.startsWith(`${key}[`) || path === `${key}Unique`)) continue;
    // Eski yuva maskesi kısalmış dizinin başka geçerli öğesine uygulanmaz.
    projectionPaths.add(key);
    itemRepairs[key] = raw === preserved || repairItemsMatch({ raw: preserved, paths }, [raw], key, [0], false);
  }
  const projection = repairOmit(semantic, projectionPaths);
  // Geçersiz ölçü tek bir yuvadır; onarım fazladan ölçü ekleyemez.
  return stable({ semantic: projection, ...(Object.keys(itemRepairs).length ? { itemRepairs } : {}), ...(transfer ? { textScope: typeof textScope === 'string' ? containmentText(textScope) : textScope } : {}), metricCount: paths.has('metrics') ? null : paths.has('metricsUnique') ? new Set(raw.metrics).size : raw.metrics?.length ?? null });
}

function pinRepair(turn, plan, details, calls = [], executionCalls = [], matched = false) {
  if (plan.intent !== PLANNER_INTENTS.ROTA) return;
  if (details.some(detail => String(detail).endsWith(':dropped'))) return;
  // Bozuk taşıyıcı kabul edilmez; yalnızca düzeltme sırasında aynı soru yuvası korunur.
  const extra = Array.isArray(plan.additionalRequests) ? plan.additionalRequests
    : plan.additionalRequests && typeof plan.additionalRequests === 'object'
      && Object.keys(plan.additionalRequests).some(key => Object.hasOwn(requestSchema().properties, key)) ? [plan.additionalRequests] : [];
  const sections = [plan.request, ...extra];
  const ownProblems = index => details.filter(detail => index ? String(detail).startsWith(`$.additionalRequests[${index - 1}]`)
    : !String(detail).startsWith('$.additionalRequests'));
  const canSplit = (raw, index, own) => Array.isArray(raw?.metrics) && raw.metrics.every(metric => Object.hasOwn(METRICS, metric))
    && own.some(detail => /\.metrics(?:\[\d+\])?:(?:population|maxItems)$/.test(String(detail)))
    && !sections.some(part => Array.isArray(part?.entities) && part.entities.some(entity => entity?.from === index));
  const snapshot = turn.repairPins.get('snapshot');
  const unrelated = [...new Set(details.flatMap(detail => {
    const match = /^\$\.calls\[(\d+)\].*\.request:unrelated$/.exec(String(detail));
    return match ? [Number(match[1])] : [];
  }))].map(index => executionCalls[index]).filter(Boolean);
  const additions = [...new Map([...(snapshot?.additions || []), ...repairCalls(turn, unrelated)]
    .map(call => [readKey(call.name, { ...call.args, limit: 1 }, turn.context.today), call])).values()];
  if (snapshot) snapshot.additions = additions;
  // Eşleşmiş bölme artık aynı anlamın yeni yuvalarıdır; sonraki ret yalnızca kendi yolunu açar.
  if (snapshot && !(matched && snapshot.pins.some(pin => pin.split))) {
    const used = new Set();
    const references = new Map();
    for (const pin of snapshot.pins) {
      const index = sections.findIndex((raw, index) => !used.has(index)
        && repairProjection(turn, raw, index, index ? [] : snapshot.calls, sections, pin.paths, references, pin.raw) === pin.projection);
      if (index < 0) continue;
      used.add(index);
      references.set(index, pin.index);
      if (!pin.split && canSplit(sections[index], index, ownProblems(index))) {
        // Önceki onarımın koruduğu geçerli anlam artık yeni bölmenin sabit kaynağıdır.
        pin.raw = sections[index];
        snapshot.sections[pin.index] = pin.raw;
        pin.paths = repairAllowance(ownProblems(index), pin.raw);
        pin.split = true;
      } else for (const path of repairAllowance(ownProblems(index), sections[index])) pin.paths.add(path);
      pin.projection = repairProjection(turn, pin.raw, pin.index, pin.index ? [] : snapshot.calls, snapshot.sections, pin.paths);
    }
    return;
  }
  const pins = sections.map((section, index) => {
    const raw = section && typeof section === 'object' && !Array.isArray(section) ? section : {};
    const own = ownProblems(index);
    const paths = repairAllowance(own, raw || {});
    if (!section || typeof section !== 'object' || Array.isArray(section)) for (const key of Object.keys(requestSchema().properties)) paths.add(key);
    if (!raw?.population && !calls.some(call => Array.isArray(raw?.metrics) && raw.metrics.every(metric => metricPaths(call.name, metric).length))) {
      paths.add('population.tool'); paths.add('population.collection');
    }
    const split = canSplit(raw, index, own);
    return { raw, index, paths, split, projection: repairProjection(turn, raw, index, index ? [] : calls, sections, paths) };
  });
  const next = { count: sections.length, sections, pins, calls, additions };
  if (snapshot) Object.assign(snapshot, next);
  else turn.repairPins.set('snapshot', next);
}

function repairMatches(turn, plan, calls = []) {
  const snapshot = turn.repairPins.get('snapshot');
  if (!snapshot) return true;
  if (plan.intent !== PLANNER_INTENTS.ROTA) return false;
  const sections = [plan.request, ...(plan.additionalRequests || [])];
  if (sections.length < snapshot.count || sections.length > PLANNER_LIMITS.maxRequests
    || !snapshot.pins.some(pin => pin.split) && sections.length > snapshot.count + snapshot.additions.length) return false;
  const used = new Set();
  const references = new Map();
  for (const pin of snapshot.pins) {
    if (pin.split) {
      // Her bölüm yalnızca kendi aracının taşıdığı kapsamı alır; toplam kapsam kaybolamaz.
      const paths = new Set([...pin.paths].filter(path => !/^(?:filters|entities)(?:[.\[]|$)/.test(path)));
      for (const path of ['metrics', 'fields', 'bindings', 'population.tool', 'population.collection']) paths.add(path);
      const projected = (raw) => raw.metrics.length === pin.raw.metrics.length ? pin.raw : requestScopeForTool({ ...pin.raw, metrics: raw.metrics,
        fields: (Array.isArray(pin.raw.fields) ? pin.raw.fields : []).filter(field => raw.metrics.includes(field?.metric)) }, raw.population?.tool);
      const matches = (raw, index, candidateCalls) => repairProjection(turn, raw, index, candidateCalls, sections, paths, references)
        === repairProjection(turn, projected(raw), pin.index, pin.index ? [] : snapshot.calls, snapshot.sections, paths);
      const available = sections.flatMap((raw, index) => !used.has(index) && Array.isArray(raw?.metrics)
        && raw.metrics.length && raw.metrics.every(metric => pin.raw.metrics.includes(metric))
        && (raw.metrics.length === pin.raw.metrics.length || !raw.metrics.some(metric => metricPaths(pin.raw.population?.tool, metric).length)
          || raw.population?.tool === pin.raw.population?.tool)
        && matches(raw, index, index ? [] : snapshot.calls)
        && (index || matches(raw, index, calls)) ? [index] : []);
      const scopeCovered = indexes => Object.keys(pin.raw.filters || {}).every(key => indexes.some(index => Object.hasOwn(projected(sections[index]).filters, key)))
        && Array.isArray(pin.raw.entities || []) && (pin.raw.entities || []).every(entity => indexes.some(index => projected(sections[index]).entities.some(item => stable(item) === stable(entity))));
      let selected = null;
      for (let mask = 1; mask < (1 << available.length); mask += 1) {
        const indexes = available.filter((_, bit) => mask & (1 << bit));
        if (['metrics', 'fields', 'bindings'].every(key => repairItemsMatch(pin, sections, key, indexes)) && scopeCovered(indexes)) { selected = indexes; break; }
      }
      if (!selected) return false;
      for (const index of selected) { used.add(index); references.set(index, pin.index); }
      continue;
    }
    const index = sections.findIndex((raw, index) => !used.has(index)
      && repairProjection(turn, raw, index, index ? [] : snapshot.calls, sections, pin.paths, references, pin.raw) === pin.projection
      && (index || repairProjection(turn, raw, index, calls, sections, pin.paths, references, pin.raw) === pin.projection));
    if (index < 0) return false;
    used.add(index);
    references.set(index, pin.index);
  }
  // Ek soru yalnızca sunucunun ilgisiz saydığı çağrının nüfusuna bağlanabilir.
  const added = sections.map((raw, index) => ({ raw, index })).filter(({ index }) => !used.has(index));
  return added.every(({ raw, index }) => {
    try {
      const request = repairSemantic(turn, raw, index).semantic;
      const callIndex = snapshot.additions.findIndex((call, position) => !used.has(`call:${position}`)
        && requestBoundCall(request, call.name, call.args, { today: turn.context.today }));
      if (callIndex < 0) return false;
      used.add(`call:${callIndex}`);
      return true;
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return false;
    }
  });
}

/** Ölçünün gerektirdiği metin ile kazara eklenen nüfus seçeneği ayrıdır. */
function planNeedsText(turn, plan) {
  return [plan?.request, ...(Array.isArray(plan?.additionalRequests) ? plan.additionalRequests : [])].filter(Boolean).some((raw) => Array.isArray(raw.metrics)
    && raw.metrics.some((metric) => turn.catalog.some((tool) => metricPaths(tool.name, metric).some((path) => {
      const field = path.split('.').findLast((part) => part !== '*');
      return EVIDENCE_TEXT_FIELDS.includes(field) && !turn.allowedTextFields.includes(field);
    }))));
}

const TEXT_FIELDS_REQUIRED = /(?:^\$|\.)population\.textFields:not-authorized$/;
const PROSE_PLAN_HINT = 'plan:required: düz metin yanıt kullanıcıya gösterilmez ve karar sayılmaz; yanıtın yalnızca rota_plan çağrısıdır. Rota verisiyle yanıtlanabiliyorsa intent rota ve request (adı geçen kaydı sunucu arar); yapılamayan ya da güvensiz istekte intent abstain (abstain.reason); yalnızca soru adı verilmemiş bir kayda işaret ediyor ya da birden çok anlama geliyorsa intent clarify (açıklama sorusunu sunucu yazar)';
const UNRELATED_CALL_HINT = 'request:unrelated: çağrı isteğin okuması değil; ileti ayrı okuma gerektiren başka bir soru da soruyorsa onu additionalRequests içinde ek bölüm olarak bildir (calls verme), değilse çağrıyı kaldır';

/**
 * Çok bölümlü planın ilk bölüm dışındaki bölümleri: her biri tek bölümlü istekle AYNI doğrulamadan
 * (şema, güven, nüfus ve yetenek) geçer. Bağımlı bölüm (`{ type, from }`) yalnızca önceki bağımsız bir
 * list/rank bölümünün takibe açık satır kimliğine bağlanabilir. Bölüm n'nin sorun yolları `$.additionalRequests[n-1]` biçimindedir.
 */
function prepareParts(turn, requests, primary) {
  const parts = [];
  const sources = [primary.ok ? primary.request : null];
  const details = [...(primary.details || [])];
  const hints = [...(primary.hints || [])];
  for (let index = 1; index < requests.length; index += 1) {
    sources.push(null);
    const at = (details) => details.map((detail) => `$.additionalRequests[${index - 1}]${String(detail).replace(/^\$(?:\.request(?!\w))?/, '')}`);
    let request;
    try {
      request = parseRequestDeclaration(requests[index], { textTrusted: turn.containment.textTrusted, identityTrusted: turn.containment.identityTrusted, referent: turn.containment.referent,
        today: turn.context.today, priorParts: index });
    } catch (error) {
      if (error?.code !== TOOL_ERROR_CODES.INVALID_ARGUMENTS) throw error;
      details.push(...at(error.details || []));
      hints.push(...(error.hints || []), ...metricIdHints(error.details || [], requests[index]));
      continue;
    }
    const completion = completeRequest(request, [], { today: turn.context.today, allowedTextFields: turn.allowedTextFields });
    if (completion.problems.length) {
      details.push(...at(completion.problems));
      hints.push(...completion.hints);
      continue;
    }
    const dependent = dependentEntity(completion.request);
    if (dependent) {
      const source = sources[dependent.from];
      // Hatalı kaynağın bağı ertelenir; planın tamamı yine reddedilir ve onarımda yeniden denetlenir.
      if (source && (dependentEntity(source) || source.operation === 'value' || !sourceCollections(source).some((name) => rowIdentityPath(source.population.tool, name, dependent.type)))) {
        details.push(`$.additionalRequests[${index - 1}].entities:from`);
        hints.push('entities[].from: önceki bağımsız bir list ya da rank bölümünün satırlarına bağlanır; satırlar o türden kayıt kimliği taşımalıdır (ör. görev satırları → task)');
        continue;
      }
    }
    sources[index] = completion.request;
    parts.push(Object.freeze({ index, request: completion.request }));
  }
  return primary.ok && !details.length && parts.length === requests.length - 1 ? { ok: true, parts } : { ok: false, details, hints };
}

/** Yalnızca kayıt defterinin açık satır koleksiyonları takip kimliği taşıyabilir. */
function sourceCollections(request) {
  return request?.population?.collection ? [request.population.collection] : rowCollections(request?.population?.tool);
}

/** Kaynak bölümün yetkili nüfus satırları; modelin seçtiği atıflardan bağımsızdır. */
function dependentRows(turn, from, type) {
  const source = turn.answers.find((answer) => answer.index === from);
  if (source?.verdict.kind !== 'grounded') return [];
  const ids = [];
  const selectedRows = [];
  for (const entry of source.entries) {
    if (entry.tool !== source.request.population.tool || !source.verdict.citedIds.includes(entry.id)) continue;
    const evidence = requestEvidence(source.request, [entry], turn.context.today).get(entry.id);
    if (!evidence?.populationMatch || !evidence.dimensionsMatch) continue;
    for (const collection of sourceCollections(source.request)) {
      const identity = rowIdentityPath(entry.tool, collection, type);
      if (!identity) continue;
      for (const concrete of concreteCollections(entry.payload, collection)) {
        const rows = concrete.rows;
        const order = source.request.operation === 'rank'
          ? (rankedRowIndexes(source.request, entry.tool, entry.payload, collection, concrete.collection.replace(/^data\./, '')) || []).slice(0, source.request.rank.limit || 1)
          : rows.map((_, index) => index);
        for (const index of order) {
          const row = rows[index];
          selectedRows.push({ tool: entry.tool, collection, row });
          const id = identity.split('.').reduce((value, key) => value?.[key], row);
          if ((typeof id === 'string' || typeof id === 'number') && !ids.includes(String(id))) ids.push(String(id));
        }
      }
    }
  }
  turn.containment.beginPart(selectedRows);
  return ids;
}

/** Bölüm kanıtı: yalnızca bu bölümün okuması ya da birebir aynı önceki okuma yeniden kullanılır. */
function partEntries(turn) {
  return turn.ledger.requestEntries().filter((entry) => turn.partEvidence.has(entry.id));
}

function beginPart(turn) {
  turn.partEvidence = new Set();
  turn.toolsAttempted = false;
  turn.toolFailureCodes.clear();
  const entries = turn.ledger.requestEntries();
  const bound = bindRequestEntities(turn.request, entries, turn.containment.boundSelection());
  const reads = derivedReads(turn.request, bound, { today: turn.context.today, attempted: new Set() });
  const keys = new Set(reads.map(({ name, args }) => readKey(name, args, turn.context.today)));
  for (const entry of entries) {
    const resolved = bindRequestEntities(turn.request, [entry]);
    if (keys.has(readKey(entry.tool, entry.args, turn.context.today))
      || bound.some((entity, index) => entity.text && entity.bound && resolved[index]?.bound === entity.bound)) turn.partEvidence.add(entry.id);
  }
}

/** Sıradaki bölüm bu turun isteğidir: plan veri okunmadan doğrulanmıştır, istek sessizce değişmez. */
function acceptPart(turn, spec) {
  turn.containment.beginPart();
  turn.partIndex = spec.index;
  turn.repairsLeft = turn.limits.maxRepairRounds;
  acceptRequest(turn, spec.request, null, { part: spec.index, count: turn.partCount });
  beginPart(turn);
}

/**
 * Bölümün doğrulanmış sonucu: tek bölümlü turda ya da açıklama/erişim kaybında `{ verdict }` (tur
 * olağan biçimde biter). Çok bölümlü planda sonuç saklanır ve sıradaki bölüme geçilir (`null`); son
 * bölümden sonra bölümler tek yanıtta, plan sırasıyla birleşir. Bağımlı bölüm önceki bölümün satır
 * kimlikleriyle en çok `maxDependentRows` kez örneklenir.
 */
function settlePart(turn, verdict, selectedBy) {
  if (!turn.parts.length && !turn.answers.length) return { verdict, selectedBy };
  turn.answers.push({ index: turn.partIndex, verdict, selectedBy, request: turn.request, entries: partEntries(turn) });
  while (turn.parts.length) {
    const next = turn.parts.shift();
    const dependent = dependentEntity(next.request);
    if (!dependent) {
      acceptPart(turn, next);
      return null;
    }
    const rows = dependentRows(turn, dependent.from, dependent.type);
    const shown = rows.slice(0, PLANNER_LIMITS.maxDependentRows);
    if (rows.length > shown.length) turn.partNotes.set(next.index, shown.length);
    const instances = shown.flatMap((id) => {
      const completion = completeRequest(instantiateDependent(next.request, id), [], { today: turn.context.today, allowedTextFields: turn.allowedTextFields });
      return completion.problems.length ? [] : [{ index: next.index, request: completion.request }];
    });
    if (!instances.length) {
      turn.answers.push({ index: next.index, request: next.request, entries: [], selectedBy: 'server',
        verdict: { ok: true, kind: 'unavailable', normalized: renderPartUnavailable({ locale: turn.locale }), citedIds: [], issues: [] } });
      continue;
    }
    turn.parts.unshift(...instances.slice(1));
    acceptPart(turn, instances[0]);
    return null;
  }
  turn.answers.sort((a, b) => a.index - b.index);
  const clarifications = turn.answers.filter((answer) => answer.verdict.clarification);
  const unavailableShown = new Set();
  // Kalıcı aday sözleşmesi bölüm kimliği taşımaz; çok bölümlü yanıtta küresel numaralı seçim üretilmez.
  const texts = turn.answers.flatMap((answer, position) => {
    const unavailable = answer.verdict.kind === 'unavailable' && answer.selectedBy === 'server';
    const repeated = unavailable && unavailableShown.has(answer.index);
    if (unavailable) unavailableShown.add(answer.index);
    return [answer.verdict.clarification
      ? (answer === clarifications[0] ? renderPlannerClarification({ reason: 'missing_referent', locale: turn.locale }) : '') : repeated ? '' : answer.verdict.normalized,
    ...(turn.partNotes.has(answer.index) && turn.answers[position + 1]?.index !== answer.index
      ? [renderDependentLimit({ shown: turn.partNotes.get(answer.index), locale: turn.locale })] : [])];
  });
  const kind = turn.answers.every((answer) => answer.verdict.kind === 'grounded') ? 'grounded'
    : clarifications.length ? 'clarification' : turn.answers.some((answer) => answer.verdict.kind === 'unavailable') ? 'unavailable'
      : turn.answers.some((answer) => answer.verdict.kind === 'grounded') ? 'grounded' : 'not_found';
  return {
    verdict: { ok: true, kind,
      normalized: texts.filter(Boolean).join('\n\n'), citedIds: [...new Set(turn.answers.flatMap((answer) => answer.verdict.citedIds))], issues: [] },
    selectedBy: turn.answers.every((answer) => answer.selectedBy === 'server') ? 'server' : 'model'
  };
}

/** Planlama kararının gözlemcisi ve içeriksiz telemetrisi. Karar donmuş bir özettir; turu değiştiremez. */
function emitPlanned(turn, decision) {
  turn.decision = decision.intent;
  const summary = Object.freeze({ ...decision, language: turn.locale, semantic: turn.planning.state, candidates: turn.planning.candidates.length,
    declarations: turn.trace.declarations, latencyMs: Date.now() - turn.trace.startedAt });
  if (!turn.decisionCounted) recordPlannerDecision({ decision: summary.intent, parts: summary.requests?.length || 0, semantic: summary.semantic,
    candidates: summary.candidates, declarations: summary.declarations, latencyMs: summary.latencyMs, semanticReason: turn.planning.reason });
  turn.decisionCounted = true;
  turn.onPlanned?.(summary);
}

/** Açıklama ya da çekimserlik: veri okunmaz; kullanıcı sunucunun sabit metnini görür. */
function plannerChoice(turn, plan, onText) {
  if (plan.language) turn.locale = plan.language;
  const clarify = plan.intent === PLANNER_INTENTS.CLARIFY;
  emitPlanned(turn, clarify ? { intent: plan.intent, reason: plan.clarify.reason, topics: Object.freeze([...(plan.clarify.topics || [])]) }
    : { intent: plan.intent, reason: plan.abstain.reason });
  const normalized = clarify
    ? renderPlannerClarification({ reason: plan.clarify.reason, topics: (plan.clarify.topics || []).map((name) => getRotaTool(name)?.topic), locale: turn.locale })
    : renderPlannerAbstention({ reason: plan.abstain.reason, locale: turn.locale });
  return finish(turn, { ok: true, kind: clarify ? 'clarification' : 'abstained', normalized, citedIds: [], issues: [] }, onText);
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
    const index = transcript.findIndex((message) => message.role === 'system' && message.content === turn.acceptedNote);
    if (index >= 0) transcript.splice(index, 1);
  }
  turn.acceptedNote = null;
}

/** Planla tamamlanan istek bu turun isteğidir; önceki (veri okunmadan değişen) kabul notunun yerini alır. */
function acceptRequest(turn, request, language = null, position = null) {
  turn.request = request;
  turn.declared = request;
  if (language) turn.locale = language;
  turn.containment.declare(requestWindow(request));
  turn.namedScope = namedScope(turn.namedScope, request, turn.containment.textTrusted);
  // Veri okunmadan bildirilen nüfusun korumalı metin alanları sunucunun türettiği okumalarda da açıktır.
  turn.containment.declareTextFields(requestTextFields(request));
  const part = position && position.count > 1 ? `Planın ${position.part + 1}/${position.count}. bölümü; önceki bölümler doğrulandı ya da sırada. ` : '';
  const note = `SUNUCU: ${part}Veri okunmadan bildirilen istek kabul edildi: ${requestSummary(request)}. Son yanıtta bu isteğin her ölçüsünü taşıyan olguları seç; istek veri okunduktan sonra değiştirilemez.`;
  clearAcceptedNote(turn);
  turn.acceptedNote = note;
  instruct(turn, note);
}

/** Planın kabulü: ilk bölüm turun isteğidir; bütün bölümlerin dönemi ve korumalı metin alanları veri okunmadan bildirilir. */
function acceptPlan(turn, request, language, parts) {
  turn.parts = [...parts];
  turn.answers = [];
  turn.partNotes = new Map();
  turn.partIndex = 0;
  turn.partCount = parts.length + 1;
  for (const part of parts) {
    turn.containment.declare(requestWindow(part.request));
    turn.containment.declareTextFields(requestTextFields(part.request));
  }
  acceptRequest(turn, request, language, { part: 0, count: turn.partCount });
  beginPart(turn);
}

function isEmptyCompletion(error) {
  return error?.code === AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID && error?.details?.reason === 'EMPTY_COMPLETION';
}

/** Turun durumu: kanıt defteri, kapsam, araç izinleri ve döküm. Devirde aynı durum sürer. */
function startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, previousResult, onStatus, onProgress, planning, onPlanned }) {
  const status = (phase, extra = {}) => onStatus?.({ phase, ...extra });
  const userMessages = messages.filter((message) => message.role === 'user');
  const currentUser = userMessages.at(-1);
  // Kullanıcının bu turdaki iletisi (açıklama yanıtında önceki sorusu da) arama metni için güvenilir niyettir.
  const userText = [clarification?.selected ? clarification.question : null, currentUser?.content].filter(Boolean).join('\n');
  const advice = planning || { state: 'unavailable', candidates: [], reason: 'UNAVAILABLE' };
  const prior = previousResult && taskResultScope(previousResult.scope) && previousResult.entries?.length ? previousResult : null;
  const turn = {
    catalog,
    // Anlamsal danışmanlık yalnızca planlayıcıya aday sırası notudur; araç kümesi ve sırası kayıt defterinindir.
    planning: Object.freeze({ state: advice.state, candidates: Object.freeze([...advice.candidates]), reason: advice.reason }),
    onPlanned,
    previousResult: prior,
    decision: null,
    decisionCounted: false,
    readStarted: false,
    repairPins: new Map(),
    partEvidence: new Set(),
    // Çok bölümlü plan: sıradaki bölümler, doğrulanmış bölüm sonuçları ve bağımlı bölüm notları.
    parts: [],
    answers: [],
    partNotes: new Map(),
    partIndex: 0,
    partCount: 1,
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
    // Bildirilen ve tamamlanan istek; ilk okuma girişiminden sonra değişmez.
    declared: null,
    // Turun bildirimlerinde kullanıcının adlandırdığı kayıtlar; düzeltme bunları düşüremez.
    namedScope: [],
    request: null,
    acceptedNote: null,
    allowedTextFields,
    callId: createCallIds(),
    declarationsLeft: DECLARATION_ROUNDS,
    containment: createToolScope({ today: context.today, userText, allowedTextFields, clarification, referents: prior?.scope.taskIds || [] }),
    // Çalışan döküm ve Derin düşünmeye devredilecek temiz döküm (düzeltme notları olmadan).
    transcript: [...messages],
    baseline: [...messages],
    toolRounds: 0,
    modelRounds: 0,
    toolsAttempted: false,
    toolsRequested: false,
    // Başarılı/kalıcı sonuçlar yinelenmez; geçici hata mevcut tur/çağrı sınırları içinde yinelenebilir.
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
    resultScope: () => turn.request?.previousResult ? turn.previousResult : null,
    signal: () => turn.session?.signal ?? null,
    limits,
    onProgress: ({ topic }) => {
      onProgress?.();
      status(ASSISTANT_STREAM_PHASES.TOOLS, { topic });
    }
  });
  if (turn.previousResult) {
    const note = { role: 'system', content: `Önceki doğrulanmış Rota sonuç kapsamı: ${JSON.stringify({ type: 'task', count: turn.previousResult.scope.taskIds.length })}. Bu yalnızca göndergedir, güncel kanıt değildir. Kullanıcının sorusu bu kümeye ilişkinse ("bunlar", "bunlardan", "onun") request.previousResult=true ile rota_task_search (görev özellikleri/süzgeç) ya da rota_task_analytics (sayı) bildir; kimlik/önceki süzgeç kopyalama. Soru kümenin TEK bir görevine sıra ile başvuruyorsa ("ilk görev", "2. görev"; tek görevli kümede "o görev") previousResult yazma; entities:[{"type":"task","previous":<1 tabanlı sıra>}] ile o görevin aracını (ör. öncül/ardıl için rota_dependency_inspect, alanları için rota_task_detail) bildir. Yeni veya adı verilmiş kayıt sorusunda (ör. başka bir kişi) kullanma; önceki sorunun koşullarını yeni kayda uygula. Önceki asistan metninden veri çıkarma.` };
    for (const transcript of [turn.transcript, turn.baseline]) noteBeforeQuestion(transcript, note.content);
  }
  const notes = [
    clarification ? selectionInstruction(clarification) : null,
    turn.planning.candidates.length ? plannerCandidateNote(turn.planning.candidates) : null,
    allowedTextFields.length ? null : 'Bu turda kullanıcı kayıtlı serbest metni (açıklama, talep/karar iletisi, değişiklik metni) açmadı: textFields kullanma. Soru bu metinleri gerektiriyorsa yine planla; sunucu veri okumadan kullanıcıdan "Notlar ve iletiler" anahtarını açmasını ister.'
  ].filter(Boolean);
  for (const note of notes) for (const transcript of [turn.transcript, turn.baseline]) noteBeforeQuestion(transcript, note);
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
    model: turn.session.reportedModel?.(measured?.model) ?? turn.session.model,
    configuredModel: turn.session.model,
    modelMismatch: measured?.modelMismatch === true,
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
    evidenceIds: partEntries(turn).map((entry) => entry.id),
    evidencePayloads: turn.ledger.payloads([...turn.partEvidence]),
    toolsAttempted: turn.toolsAttempted,
    toolsRequested: turn.toolsRequested,
    toolFailureCodes: turn.toolFailureCodes,
    route: turn.route,
    locale: turn.locale,
    request: turn.request,
    entries: partEntries(turn),
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

/** Tek anlamlı görev listesinin dönen satırları; model metni ve seçtiği olgular kimlik kaynağı değildir. */
/**
 * Tek görevin araçları: doğrulanmış yanıtın konusu tek görevse "onun …" takibi o göreve başvurur. Yalnızca
 * kanıt öznesi okunan görevin kendisi olan araçlar (tekrar incelemesinin öznesi seri şablonu olabilir).
 */
const SINGLE_TASK_TOOLS = Object.freeze(['rota_task_detail', 'rota_dependency_inspect']);

function completedResultScope(turn, verdict) {
  if (verdict.kind !== 'grounded' || turn.partCount !== 1) return null;
  const tool = turn.request?.population?.tool;
  if (SINGLE_TASK_TOOLS.includes(tool) && turn.request.entities.length === 1 && turn.request.entities[0].type === 'task') {
    // Özne okumanın görev seçicisiyle aynı olmalıdır: kanıtın adlandırdığı başka bir kayıt gönderge olmaz.
    const subjects = new Set(turn.ledger.requestEntries().filter((entry) => verdict.citedIds.includes(entry.id) && entry.tool === tool)
      .map((entry) => (entry.payload?.entity?.type === 'task' && entry.payload.entity.id === entry.args?.taskId ? entry.payload.entity.id : null)));
    return subjects.size === 1 && !subjects.has(null) ? taskResultScope({ type: 'task', taskIds: [...subjects] }) : null;
  }
  if (!['list', 'rank'].includes(turn.request?.operation) || tool !== 'rota_task_search') return null;
  const taskIds = new Set();
  // Satır sırası kullanıcının gördüğü sıradır: atfedilen kanıt sırası, kanıt içinde satır (sıralamada sıralama) sırası.
  const entries = new Map(turn.ledger.requestEntries().map((entry) => [entry.id, entry]));
  for (const entry of verdict.citedIds.map((id) => entries.get(id))) {
    if (!entry || entry.tool !== 'rota_task_search') continue;
    const evidence = requestEvidence(turn.request, [entry], turn.context.today).get(entry.id);
    if (!evidence?.populationMatch || !evidence.dimensionsMatch) return null;
    const rows = entry.payload?.data?.tasks || [];
    const indexes = turn.request.operation === 'rank'
      ? (rankedRowIndexes(turn.request, entry.tool, entry.payload, 'tasks', 'tasks') || [])
      : rows.map((_, index) => index);
    for (const index of indexes) taskIds.add(rows[index]?.taskId);
  }
  return taskResultScope({ type: 'task', taskIds: [...taskIds] });
}

/** Doğrulanmış sonucun gösterimi: kapsam notunu sunucu ekler, yalnızca atfedilen kanıt kaydedilir. */
async function finish(turn, verdict, onText, selectedBy = 'model') {
  const { ledger, locale } = turn;
  const cited = ledger.summaries(verdict.citedIds);
  const disclosure = cited.length > 0 ? withScopeDisclosure(verdict.normalized, cited, locale) : { text: verdict.normalized, disclosed: false };
  const finalText = cited.length > 0 ? disclosure.text : verdict.normalized;
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
    finishReason: outcome === 'general_redirect' ? 'clarification' : outcome === 'abstained' ? 'unsupported'
      : ['not_found', 'clarification', 'unavailable'].includes(outcome) ? outcome : 'stop',
    outcome,
    evidence: cited,
    evidenceRows: ledger.persistable(verdict.citedIds, { clarification: verdict.clarification || null, resultScope: completedResultScope(turn, verdict) }),
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
  if (!turn.request) return null;
  if (turn.ledger.ids().length && (await revalidate(turn) || turn.ledger.revoked())) return unavailableVerdict(turn.locale);
  const local = verdictInput(turn);
  if (turn.partCount > 1 && turn.toolsAttempted && !local.evidenceIds.length) {
    for (const kind of ['not_found', 'unavailable']) {
      const verdict = analyze(JSON.stringify({ kind }), local);
      if (verdict.ok) return verdict;
    }
  }
  if (!local.evidenceIds.length) return null;
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
  if (turn.answers.length && !turn.ledger.revoked()) {
    const verdict = { ok: true, kind: 'unavailable', normalized: renderPartUnavailable({ locale: turn.locale }), citedIds: [], issues: [] };
    // Sağlayıcı kesildiyse sıradaki bölümler de açıkça eksik gösterilir.
    for (const part of turn.parts.splice(0)) turn.answers.push({ index: part.index, request: part.request, entries: [], selectedBy: 'server', verdict });
    const outcome = settlePart(turn, verdict, 'server');
    return finish(turn, outcome.verdict, onText, outcome.selectedBy);
  }
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
  if ((!turn.decision || turn.decision === PLANNER_INTENTS.ROTA) && !turn.readStarted) {
    turn.decision = null;
    turn.repairPins.clear();
    turn.textFieldsRequired = false;
    turn.namedScope = [];
    turn.declarationsLeft = DECLARATION_ROUNDS;
    turn.declared = null;
    turn.request = null;
    turn.toolsAttempted = false;
    turn.permittedTools = null;
    turn.parts = [];
    turn.answers = [];
    turn.partNotes = new Map();
    turn.partIndex = 0;
    turn.partCount = 1;
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
  // Planlama kararı ilk SQL'den önce bir kez bildirilir (gözlemci ve telemetri).
  if (!turn.decision) {
    emitPlanned(turn, { intent: PLANNER_INTENTS.ROTA, requests: Object.freeze([turn.request, ...turn.parts.map((part) => part.request)].filter(Boolean)),
      calls: Object.freeze(executed.map(({ name, args }) => Object.freeze({ name, args }))) });
  }
  turn.readStarted = true;
  turn.toolFailureCodes.clear();
  turn.toolsAttempted = true;
  turn.route = TURN_ROUTES.ROTA;
  const previousIds = new Set(turn.ledger.ids());
  turn.toolRounds += 1;
  const toolMessages = await executor.runRound(executed);
  executed.forEach((call, index) => {
    const code = toolMessageBody(toolMessages[index])?.error?.code;
    if (![TOOL_ERROR_CODES.TIMEOUT, TOOL_ERROR_CODES.BUSY, TOOL_ERROR_CODES.DATABASE_UNAVAILABLE].includes(code)) {
      turn.attemptedReads.add(readKey(call.name, call.args, turn.context.today));
    }
  });
  turn.work += 1;
  turn.progress();
  for (const message of toolMessages) {
    const body = toolMessageBody(message);
    if (body?.ok === false && typeof body.error?.code === 'string') turn.toolFailureCodes.add(body.error.code);
  }
  for (const id of turn.ledger.ids()) if (!previousIds.has(id)) turn.partEvidence.add(id);
  containment.establish(executed, toolMessages);
  if (toolMessages.some((message) => toolMessageBody(message)?.ok === true)) {
    // Her başarılı turun takip araçları eklenir: çok adımlı çözüm (kişi →
    // görev → ayrıntı) mümkündür; bağımsız değişkenler kapsam sınırına bağlı kalır.
    const next = toolsForInitialCalls(executed, catalog, toolMessages);
    // Veri okunmadan bildirilen nüfus aracı da açık kalır; bağımsız değişkenleri yine kapsam sınırına bağlıdır.
    const declared = [turn.request, ...turn.parts.map((part) => part.request)].map((request) => request?.population?.tool)
      .filter((name) => name && catalog.some((tool) => tool.name === name));
    turn.permittedTools = new Set([...(turn.permittedTools || []), ...next, ...declared]);
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
  previousResult = null,
  onStatus = null,
  onProgress = null,
  onText,
  escalation: escalationAvailable = false,
  resume = null,
  deferDisclosure = false,
  planning = null,
  onPlanned = null
}) {
  const turn = resume || startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, previousResult, onStatus, onProgress, planning, onPlanned });
  turn.session = session;
  turn.deferDisclosure = deferDisclosure;
  // Yeni oturum (kuyruk beklemesi dâhil) yetkinin yeniden okunmasını gerektirir.
  turn.work += 1;
  // Oturumun kurulması (kira, kimlik bilgisi) ilerlemedir: üretim gözcüsünün kurulum payı her oturumu, Derin devri dâhil,
  // bir kez karşılar; turda en çok iki oturum vardır ve her biri kendi süre sınırıyla biter.
  turn.progress();
  try {
    return await continueTurn(turn, { escalationAvailable, onText, resumed: Boolean(resume) });
  } catch (error) {
    if (!resume) traceTurn(turn, 'error', { code: typeof error?.code === 'string' ? error.code : null });
    throw error;
  }
}

async function continueTurn(turn, { escalationAvailable, onText, resumed }) {
  const { ledger, executor, containment, status, catalog, limits, session } = turn;
  // İlk okuma girişimi niyeti dondurur; boş kanıt defteri yürütmeyi geri almaz.
  const frozen = () => Boolean(turn.decision && turn.decision !== PLANNER_INTENTS.ROTA) || turn.readStarted;
  const canEscalate = () => escalationAvailable && escalationPermitted(turn);
  const toolsAvailable = () => !['general', 'clarify', 'abstain', 'invalid', 'text_fields'].includes(turn.decision) && turn.toolRounds < limits.maxToolRounds && executor.stats().attempted < limits.maxTotalCalls;
  // Ucuz kurtarma tükendiğinde Standart tur Derin'e bir kez devredilir. Veri okunduysa Derin araç
  // çağıramaz: devir yalnızca kanıt bildirilen isteği belirlenimci olarak karşılayabiliyorsa yapılır.
  // Veri okunmadıysa Derin yeniden planlar; ortak araç turu bütçesi tükendiyse planı yürütemez.
  const evidenceReady = () => Boolean(turn.request && requestEvidenceReady(turn.request, partEntries(turn), turn.context.today, containment.boundSelection()));
  const deepCanHelp = () => canEscalate() && (frozen() ? evidenceReady() : toolsAvailable());
  let missingPreviousResult = null;
  const fallback = async (reason) => {
    if (turn.textFieldsRequired) {
      emitPlanned(turn, { intent: 'text_fields' });
      return finish(turn, { ok: true, kind: 'clarification', normalized: renderTextFieldsRequired({ locale: turn.locale }), citedIds: [], issues: [] }, onText);
    }
    if (missingPreviousResult) return plannerChoice(turn, missingPreviousResult, onText);
    if (deepCanHelp()) return escalation(turn, reason);
    if (turn.partCount > 1 && !ledger.revoked()) {
      const outcome = settlePart(turn, { ok: true, kind: 'unavailable', normalized: renderPartUnavailable({ locale: turn.locale }), citedIds: [], issues: [] }, 'server');
      if (outcome) return finish(turn, outcome.verdict, onText, outcome.selectedBy);
      const done = await readAndSettle();
      return done || continueTurn(turn, { escalationAvailable, onText, resumed: false });
    }
    if (!turn.decision) emitPlanned(turn, { intent: 'invalid' });
    return failTurn(turn, onText);
  };
  let rejectedPlan = null;
  let repairMatched = false;
  const rejectDeclaration = (calls, rawDetails, hints = [], problems = null, executionCalls = calls) => {
    const details = rawDetails || [];
    recordPlannerRejection(details[0]);
    if (rejectedPlan && !details.includes('$.plan:repairScope')) pinRepair(turn, rejectedPlan, details, repairCalls(turn, executionCalls), executionCalls, repairMatched);
    if (calls.length) turn.toolsRequested = true;
    // Kapsam dışı çağrı veri okunmadan reddedilse de Derin düşünme devrini engeller.
    for (const problem of problems || []) if (ESCALATION_BLOCKING_TOOL_CODES.has(problem.error.code)) turn.toolFailureCodes.add(problem.error.code);
    if (planNeedsText(turn, rejectedPlan) || details.length && details.every((detail) => TEXT_FIELDS_REQUIRED.test(String(detail))) && turn.declarationsLeft <= 0) {
      turn.textFieldsRequired = true;
      if (rejectedPlan?.language) turn.locale = rejectedPlan.language;
      return false;
    }
    // Olmayan gönderge onarımla silinmez; yeni tam soru ayrı turda yeniden doğrulanır.
    // Bulunamayan satır göndergesi (kapsam yok ya da sıra dışı, her bölüm derinliğinde) onarımla düşürülmez: sunucu sorar.
    if (!turn.previousResult && details.includes('$.previousResult:unavailable')
      || details.some((detail) => /entities\[\d+\]\.previous:unavailable$/.test(String(detail)))) {
      missingPreviousResult = { intent: PLANNER_INTENTS.CLARIFY, language: rejectedPlan?.language,
        clarify: { reason: 'missing_referent' } };
      return false;
    }
    if (turn.declarationsLeft <= 0) return false;
    turn.declarationsLeft -= 1;
    turn.trace.pending = 'declaration';
    if (calls.length) recordRejectedPlan(turn, calls, details, hints, problems, executionCalls);
    instruct(turn, declarationRepair(details, hints), { repair: true });
    return true;
  };
  /**
   * Bildirilen nüfus henüz okunmadıysa (ör. adla çözülen varlığın okuması) sunucu okumayı bildirimden
   * kurar; istek kanıttaki olguları belirliyorsa ayrı bir model seçim turu gerekmez. Çok bölümlü planda
   * doğrulanan bölümden sonra sıradaki bölüm aynı yoldan okunur.
   */
  const readAndSettle = async () => {
    for (;;) {
      while (!ledger.revoked() && toolsAvailable() && !evidenceReady()) {
        const needed = derivedCalls(turn, turn.request);
        const derived = prepareExecutionSet(needed, { catalog, validateCall: requestCallValidator(turn, turn.request, needed), limits,
          attempted: executor.stats().attempted, callId: turn.callId, today: turn.context.today });
        if (!derived.ok || !derived.calls.length) break;
        // Sonraki bölümün okumaları veri okunmadan doğrulanmış plandan sunucunun kurduğu okumalardır.
        if (turn.partIndex > 0 && turn.permittedTools) for (const call of derived.calls) turn.permittedTools.add(call.name);
        await executeRound(turn, derived.calls);
      }
      const settled = await serverSelection(turn);
      if (ledger.revoked()) return finish(turn, unavailableVerdict(turn.locale), onText);
      if (!settled) {
        if (!toolsAvailable() && turn.partCount > 1 && !evidenceReady()) {
          const outcome = settlePart(turn, { ok: true, kind: 'unavailable', normalized: renderPartUnavailable({ locale: turn.locale }), citedIds: [], issues: [] }, 'server');
          if (outcome) return finish(turn, outcome.verdict, onText, outcome.selectedBy);
          continue;
        }
        return null;
      }
      const outcome = settlePart(turn, settled, 'server');
      if (outcome) return finish(turn, outcome.verdict, onText, outcome.selectedBy);
    }
  };
  let allowTools = resumed ? !frozen() : true;
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
        // Veri okunmadan araç kümesi kayıt defterinin tamamıdır ve sırası sabittir (önek önbelleği soruya göre
        // bozulmaz); anlamsal danışmanlık yalnızca sistem notundaki aday sırasıdır.
        tools: turn.decision === PLANNER_INTENTS.GENERAL ? [] : !frozen() ? [typedPlanningTool(catalog), ...catalog] : turn.permittedTools ? catalog.filter((tool) => turn.permittedTools.has(tool.name)) : catalog,
        // Karar verilmeden (düzeltme turları dâhil) yanıt yalnızca plan çağrısı olabilir: zayıf model düz metne kaçamaz.
        toolChoice: !canCallTools ? 'none' : !frozen() && !turn.decision ? PLAN_TOOL_CHOICE : 'auto',
        onEvent: async (event) => {
          turn.progress();
          if (event.type === 'thinking') status(ASSISTANT_STREAM_PHASES.THINKING);
          else if (event.type === 'generating') status(ASSISTANT_STREAM_PHASES.GENERATING);
        }
      });
    } catch (error) {
      turn.work += 1;
      traceRound(turn, { purpose, startedAt, error });
      if (turn.answers.length && !session.signal?.aborted
        && ([AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, AI_ERROR_CODES.AI_BUSY, AI_ERROR_CODES.AI_RATE_LIMITED].includes(error?.code)
          || error?.code === AI_ERROR_CODES.AI_TIMEOUT && error.details?.reason === 'PROVIDER_STALLED')) {
        if (await revalidate(turn) || ledger.revoked()) return finish(turn, unavailableVerdict(turn.locale), onText);
        return failTurn(turn, onText);
      }
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
      return fallback('LENGTH');
    }
    const modelCalls = result.toolCalls;
    let plan = null;
    rejectedPlan = null;
    repairMatched = false;
    if (!frozen() && result.toolCalls.some((call) => call.name === 'rota_plan')) {
      try {
        plan = unpackTypedPlan(result, { onDecoded: decoded => { rejectedPlan = decoded; } });
        rejectedPlan = plan.plan;
        if (!repairMatches(turn, plan.plan, repairCalls(turn, plan.calls))) throw invalidArguments(['$.plan:repairScope']);
        repairMatched = true;
      }
      catch (error) {
        if (!(error instanceof ToolError)) throw error;
        turn.trace.declarations += 1;
        if (rejectDeclaration(modelCalls, error.details)) continue;
        return fallback('REQUEST_DECLARATION');
      }
    }
    // Açıklama ve çekimserlik sonlandırıcıdır: Rota verisi okunmaz, sunucunun sabit metni gösterilir.
    if (plan && [PLANNER_INTENTS.CLARIFY, PLANNER_INTENTS.ABSTAIN].includes(plan.plan.intent)) {
      turn.trace.declarations += 1;
      return plannerChoice(turn, plan.plan, onText);
    }
    let calls = turn.decision === PLANNER_INTENTS.GENERAL ? [] : plan ? plan.calls : result.toolCalls;

    const declaration = plan ? { kind: 'route', intent: plan.plan.intent, language: plan.plan.language,
      ...(plan.plan.request ? { request: plan.plan.request } : {}) } : null;
    const declaredRoute = parseTurnRoute(declaration);
    // Bildirim yalnızca veri okunmadan önce kabul edilir; sonrasında istek değişmez.
    const declared = !frozen() && declaredRoute ? acceptDeclaration(turn, declaration, declaredRoute) : null;
    if (declared) turn.trace.declarations += 1;
    // İlk planlama kararı yerine gelen düz metin karar değildir (açıklama ya da ret metni de modelin değil
    // sunucunun işidir): araç denenmeden önce mevcut bildirim bütçesiyle türlü karar istenir. Metin dökümde
    // boş bir plan çağrısı olarak reddedilir; metnin kendisi taşınmaz.
    if (!frozen() && !turn.request && !plan) {
      turn.trace.declarations += 1;
      if (rejectDeclaration(modelCalls, ['$.plan:required'], [PROSE_PLAN_HINT])) {
        if (!modelCalls.length) recordRejectedPlan(turn, [{ name: 'rota_plan', arguments: '{}' }], ['$.plan:required'], [PROSE_PLAN_HINT]);
        continue;
      }
      return fallback('REQUEST_DECLARATION');
    }
    // Çok bölümlü plan: bütün bölümler veri okunmadan birlikte doğrulanır; biri geçersizse hiçbiri yürütülmez.
    let parts = [];
    if (plan?.plan.additionalRequests) {
      const primary = preparePlan(turn, [], declared);
      const checked = prepareParts(turn, [plan.plan.request, ...plan.plan.additionalRequests], primary);
      const validation = checked.ok ? preparePlan(turn, [], declared, checked.parts) : checked;
      if (!validation.ok) {
        turn.route = TURN_ROUTES.ROTA;
        if (rejectDeclaration(modelCalls, validation.details, validation.hints)) continue;
        return fallback('REQUEST_DECLARATION');
      }
      parts = checked.parts;
    }
    // Çağrısız istek: okumalar bildirimden kurulabiliyorsa sunucu kurar; kurulamıyorsa plan çağrı ister.
    if (declared?.ok && declared.request && !calls.length && canCallTools) {
      const completed = preparePlan(turn, [], declared);
      // İlk tur yalnızca birincil bölümü okur; diğer bölümler sırayla yürür.
      calls = completed.ok ? derivedCalls(turn, completed.request) : [];
      if (!calls.length && plan && !completed.ok) {
        // Okuma kurulamadıysa önce isteğin kendi sorunları (ör. aracın metin süzgeci yok) bildirilir; yoksa çağrı istenir.
        const reasons = preparePlan(turn, [], declared);
        const details = reasons.ok ? ['$.calls:required'] : reasons.details;
        if (rejectDeclaration(modelCalls, details, reasons.ok ? [] : reasons.hints)) continue;
        return fallback('REQUEST_DECLARATION');
      }
    }
    if (declared && !calls.length && (turn.declarationsLeft > 0 || declared.ok && !declared.request)) {
      turn.route = declaredRoute;
      if (declared.ok) {
        const prepared = declared.request ? preparePlan(turn, [], declared) : { ok: true };
        if (!prepared.ok) {
          if (rejectDeclaration(modelCalls, prepared.details, prepared.hints)) continue;
          return fallback('REQUEST_DECLARATION');
        }
        if (declared.request) acceptPlan(turn, prepared.request, declared.language, parts);
        else {
          turn.declared = null;
          if (declared.language) turn.locale = declared.language;
          emitPlanned(turn, { intent: PLANNER_INTENTS.GENERAL });
          allowTools = false;
        }
        turn.declarationsLeft = Math.max(0, turn.declarationsLeft - 1);
        instruct(turn, `Bu turun veri okunmadan belirlenen yönlendirmesi: ${turn.route}. Şimdi bu niyete göre yanıtla; Rota olguları yalnızca araç kanıtıyla sunulur.`);
      } else {
        // Reddedilen plan, plan doğrulamasındaki retle aynı biçimde modelin kendi çağrısı olarak kalır.
        if (!rejectDeclaration(modelCalls, declared.details, declared.hints)) return fallback('REQUEST_DECLARATION');
      }
      continue;
    }
    if (calls.length && canCallTools) {
      let prepared;
      if (!frozen()) {
        // Plan: istek ve bütün çağrılar (plan içi ve doğrudan) birlikte, SQL'den önce doğrulanır.
        prepared = preparePlan(turn, calls, declared, plan ? parts : turn.parts);
        if (!prepared.ok) {
          turn.route = TURN_ROUTES.ROTA;
          if (rejectDeclaration(modelCalls, prepared.details, prepared.hints, prepared.problems, calls)) continue;
          return fallback('REQUEST_DECLARATION');
        }
        if (plan) acceptPlan(turn, prepared.request, declared?.language, parts);
        else acceptRequest(turn, prepared.request);
      } else {
        prepared = prepareExecutionSet(calls, { catalog, permitted: turn.permittedTools, validateCall: requestCallValidator(turn, turn.request, derivedCalls(turn, turn.request)), limits,
          attempted: executor.stats().attempted, callId: turn.callId, today: turn.context.today });
        if (!prepared.ok) {
          // Geçersiz küme hiç yürütülmez; reddedilen tur araç turu bütçesinden düşer.
          turn.toolsRequested = true;
          turn.toolRounds += 1;
          turn.work += 1;
          recordRejectedRound(turn, calls, prepared.problems);
          if (turn.toolRounds >= limits.maxToolRounds) instruct(turn, roundLimitNote());
          continue;
        }
      }
      await executeRound(turn, prepared.calls);
      const done = await readAndSettle();
      if (done) return done;
      if (turn.request.reasoning === 'synthesis' && evidenceReady() && canEscalate()) return escalation(turn, 'SYNTHESIS_REQUIRED');
      continue;
    }

    const authorizationUnavailable = await revalidate(turn);
    if (authorizationUnavailable || ledger.revoked()) return finish(turn, unavailableVerdict(turn.locale), onText);
    const text = String(result.text || '').trim();
    status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verifyStartedAt = Date.now();
    const verdict = authorizationUnavailable || ledger.revoked() ? unavailableVerdict(turn.locale) : analyze(text, verdictInput(turn));
    turn.trace.verificationMs += Date.now() - verifyStartedAt;
    if (verdict.ok) {
      const outcome = settlePart(turn, verdict, 'model');
      if (outcome) return finish(turn, outcome.verdict, onText, outcome.selectedBy);
      // Sıradaki bölüm: okumaları sunucu kurar, seçimi önce sunucu dener.
      allowTools = true;
      const done = await readAndSettle();
      if (done) return done;
      continue;
    }

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

    return fallback('VERIFICATION_FAILED');
  }
}
