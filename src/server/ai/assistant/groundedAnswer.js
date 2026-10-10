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
import { getRotaTool } from '../tools/toolRegistry.js';
import { parseEvidenceResponse } from '../../../domain/ai/evidenceVerification.js';
import { isTurnFatal, TOOL_ERROR_CODES } from '../tools/toolErrors.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';
import { createToolScope } from '../tools/toolScope.js';
import { bindRequestEntities, declarationHints, parseRequestDeclaration, requestEvidence, requestEvidenceReady, requestRepairHint, requestSelections, requestSummary, requestWindow, textPlanCall, typedPlanningTool, unpackTypedPlan } from '../tools/requestDeclaration.js';
import { parseTurnLanguage, parseTurnRequest, parseTurnRoute, parseTurnWindow, TURN_ROUTES } from '../../../domain/ai/evidenceIntent.js';
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

function analyze(text, { evidenceIds, evidencePayloads, toolsAttempted, toolFailureCodes, route, locale, request, entries, selection, today }) {
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

/** Veri okunmadan önceki bildirim turları (yalnız bildirim ya da reddedilen araç çağrısı) için sınır. */
const DECLARATION_ROUNDS = 2;

/** Bildirim hatası ayrıntıları yalnızca şema yoludur; modelin yazdığı metin yönergeye taşınmaz. */
const problemPaths = (details = []) => details.map((detail) => String(detail).replace(/[^\w.$[\]:-]/g, '').slice(0, 80)).filter(Boolean).slice(0, 8);

function declarationRepair(details = [], serverHints = []) {
  const problems = problemPaths(details);
  const hints = [...serverHints.slice(0, 6), ...declarationHints(problems)];
  return [
    'SUNUCU DOĞRULAMASI: Araç çağrıları çalıştırılmadı. Rota verisi okunmadan önce geçerli bir istek bildirimi gerekir.',
    ...(problems.length ? [`Bildirim sorunları: ${problems.join(', ')}`] : []),
    ...(hints.length ? [`Beklenen biçim: ${hints.join('; ')}`] : []),
    'Yalnızca bildirilen sorunları düzelt; sorunsuz araç, ölçü, süzgeç ve çağrı bağımsız değişkenlerini değiştirme.',
    'rota_plan çağır: intent rota, language tr|en, request içinde operation/metrics/population/layout, calls içinde {name,arguments} araç planı (araçları aynı yanıtta doğrudan da çağırabilirsin). Normal asistan metni gerekmez; geçerli plan sunucuda doğrulanıp yürütülür.',
    'entities[].text ve filters.text kullanıcının iletisinde geçen metin olmalıdır; entities[].id yalnızca kullanıcının yazdığı ya da sunucunun bağladığı kimliktir.'
  ].join('\n');
}

/**
 * Reddedilen plan modelin kendi çağrısı olarak yalnızca çalışan dökümde kalır:
 * model planını baştan yazmak yerine düzeltebilir. Araç sonucu yalnızca
 * sunucunun sorun yollarını ve kayıt defteri ipuçlarını taşır.
 */
function recordRejectedPlan(turn, calls, details, hints = []) {
  const shown = calls.filter((call) => /^[A-Za-z0-9_.:-]{1,160}$/.test(String(call.id || ''))).slice(0, TOOL_LIMITS.maxCallsPerRound + 1);
  if (!shown.length) return;
  const planned = shown.some((call) => call.name === 'rota_plan');
  const error = (call) => ({ code: TOOL_ERROR_CODES.INVALID_ARGUMENTS, ...(planned && call.name !== 'rota_plan' ? { details: ['$.plan:invalid'] }
    : { details: problemPaths(details), ...(hints.length ? { hints: hints.slice(0, 6) } : {}) }) });
  turn.transcript.push({ role: 'assistant', content: '', toolCalls: shown.map(({ id, name, arguments: args, oversize }) => ({ id, name, arguments: oversize ? '{}' : String(args || '{}') })) },
    ...shown.map((call) => ({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: false, tool: call.name, error: error(call) }) })));
}

/**
 * Veri okunmadan önceki bildirimi uygular: dil, türlü istek ve dönem.
 * Geçersiz Rota isteği önceki kabulü değiştirmez; `{ ok: false, details }` döner.
 */
function acceptDeclaration(turn, declaration, route) {
  const language = parseTurnLanguage(declaration);
  if (language) turn.locale = language;
  if (route !== TURN_ROUTES.ROTA) return { ok: true };
  let request;
  try {
    request = parseRequestDeclaration(parseTurnRequest(declaration), {
      textTrusted: turn.containment.textTrusted,
      identityTrusted: turn.containment.identityTrusted,
      today: turn.context.today
    });
  } catch (error) {
    if (error?.code !== TOOL_ERROR_CODES.INVALID_ARGUMENTS) throw error;
    return { ok: false, details: error.details || [], hints: error.hints || [] };
  }
  turn.request = request;
  turn.containment.declare(parseTurnWindow(declaration) || requestWindow(request));
  instruct(turn, `SUNUCU: Veri okunmadan bildirilen istek kabul edildi: ${requestSummary(request)}. Son yanıtta bu isteğin her ölçüsünü taşıyan olguları seç; istek veri okunduktan sonra değiştirilemez.`);
  return { ok: true };
}

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
    // Yanıt dili modelin bildirimidir; bildirilene kadar varsayılan Türkçedir.
    locale: 'tr',
    request: null,
    declarationsLeft: DECLARATION_ROUNDS,
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
    model: turn.session.model,
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
  const before = ledger.ids();
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
    if (before.some((id) => !ledger.has(id))) turn.revoked = true;
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
    guardDisclosure: async (signal) => !(await revalidate(turn, signal)) && !turn.revoked
  };
}

/** Yetki önce yenilenir; tek anlamlı aday aynı doğrulayıcıdan geçer. */
async function serverSelection(turn) {
  if (!turn.request || !turn.ledger.ids().length) return null;
  const before = turn.ledger.ids();
  if (await revalidate(turn)) return unavailableVerdict(turn.locale);
  if (before.some((id) => !turn.ledger.has(id))) return unavailableVerdict(turn.locale);
  const startedAt = Date.now();
  const input = verdictInput(turn);
  const verified = requestSelections(turn.request, input.entries, input.selection).filter((candidate) => analyze(candidate, input).ok);
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
  // Veri okunmadıysa Derin düşünme kendi bildirimini verebilir.
  if (!turn.toolsAttempted) turn.declarationsLeft = DECLARATION_ROUNDS;
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

/** `resume` aynı defter, kapsam ve tur bütçesiyle muhakeme devrini sürdürür. */
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
  resume = null,
  deferDisclosure = false
}) {
  const turn = resume || startTurn({ messages, catalog, context, limits, allowedTextFields, clarification, onStatus });
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
  const canEscalate = () => escalationAvailable && escalationPermitted(turn);
  // Ucuz kurtarma tükendiğinde Standart tur Derin'e bir kez devredilir; veri okunduysa Derin
  // araç çağıramaz, bu yüzden devir yalnızca bildirilen ölçülerin kanıtı hazırsa yapılır.
  const deepCanHelp = () => canEscalate() && (!ledger.ids().length || Boolean(turn.request && requestEvidenceReady(turn.request, ledger.requestEntries(), turn.context.today)));
  const fallback = (reason) => (deepCanHelp() ? escalation(turn, reason) : failTurn(turn, onText));
  let allowTools = resumed ? ledger.ids().length === 0 : true;
  let lengthExhausted = false;
  for (;;) {
    if (turn.revoked) return finish(turn, unavailableVerdict(turn.locale), onText);
    // Kanıt sağlayıcıya her gönderilişten önce günceldir; arada iş yoksa yeni okuma gerekmez.
    if (turn.ledger.ids().length && turn.revalidatedAt !== turn.work) {
      const before = turn.ledger.ids();
      if (await revalidate(turn) || before.some((id) => !ledger.has(id))) return finish(turn, unavailableVerdict(turn.locale), onText);
    }
    const canCallTools = allowTools && turn.toolRounds < limits.maxToolRounds;
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
        tools: !turn.request ? [typedPlanningTool(catalog), ...catalog] : turn.permittedTools ? catalog.filter((tool) => turn.permittedTools.has(tool.name)) : catalog,
        toolChoice: canCallTools ? 'auto' : 'none',
        onEvent: async (event) => {
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
    const reported = session.model;
    if (reported) turn.models.push(reported);
    // Yerel çağrı yerine metin olarak dönen plan aynı plan doğrulamasından geçer.
    const textPlan = !turn.toolsAttempted && !result.toolCalls.length ? textPlanCall(result.text) : null;
    if (textPlan) result = { ...result, text: '', toolCalls: [textPlan] };
    const modelCalls = result.toolCalls;
    if (!turn.toolsAttempted && result.toolCalls.some((call) => call.name === 'rota_plan')) {
      try { result = unpackTypedPlan(result, catalog); }
      catch (error) {
        if (turn.declarationsLeft <= 0) return fallback('REQUEST_DECLARATION');
        turn.declarationsLeft -= 1;
        turn.trace.declarations += 1;
        turn.trace.pending = 'declaration';
        recordRejectedPlan(turn, modelCalls, error.details);
        instruct(turn, declarationRepair(error.details), { repair: true });
        continue;
      }
    }

    if (result.finishReason === 'length') {
      if (turn.repairsLeft > 0) {
        turn.repairsLeft -= 1;
        turn.repaired = true;
        turn.trace.repairs += 1;
        turn.trace.pending = 'repair';
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
    // Bildirim yalnızca veri okunmadan önce kabul edilir; sonrasında istek değişmez.
    const declared = !turn.toolsAttempted && declaredRoute ? acceptDeclaration(turn, declaration, declaredRoute) : null;
    if (declared) turn.trace.declarations += 1;
    if (declared && !result.toolCalls.length && turn.declarationsLeft > 0) {
      turn.declarationsLeft -= 1;
      turn.route = declaredRoute;
      if (declared.ok) instruct(turn, `Bu turun veri okunmadan belirlenen yönlendirmesi: ${turn.route}. Şimdi bu niyete göre yanıtla; Rota olguları yalnızca araç kanıtıyla sunulur.`);
      else {
        turn.trace.pending = 'declaration';
        instruct(turn, declarationRepair(declared.details, declared.hints), { repair: true });
      }
      continue;
    }
    // Araç turu her durumda geçerli bir istek ister: genel yönlendirme bildiren yanıtın araç çağrısı da çalışmaz.
    if (result.toolCalls.length && canCallTools && ((declared && !declared.ok) || !turn.request)) {
      // Geçerli istek bildirimi olmadan araç çalışmaz: veri okunmadan önce bildirim düzeltilir.
      if (turn.declarationsLeft > 0) {
        turn.declarationsLeft -= 1;
        turn.route = TURN_ROUTES.ROTA;
        turn.trace.pending = 'declaration';
        recordRejectedPlan(turn, modelCalls, declared?.details || ['$.request:required'], declared?.hints);
        instruct(turn, declarationRepair(declared?.details || ['$.request:required'], declared?.hints), { repair: true });
        continue;
      }
      return fallback('REQUEST_DECLARATION');
    }
    if (result.toolCalls.length && canCallTools) {
      turn.toolsAttempted = true;
      turn.route = TURN_ROUTES.ROTA;
      turn.toolFailureCodes.clear();
      turn.toolRounds += 1;
      const toolMessages = await executor.runRound(result.toolCalls);
      turn.work += 1;
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
      // Bildirilen istek kanıttaki olguları belirliyorsa ayrı bir model seçim turu gerekmez.
      const settled = await serverSelection(turn);
      if (settled) return finish(turn, settled, onText, 'server');
      if (turn.request.reasoning === 'synthesis' && requestEvidenceReady(turn.request, ledger.requestEntries(), turn.context.today) && canEscalate()) return escalation(turn, 'SYNTHESIS_REQUIRED');
      continue;
    }

    const authorizationUnavailable = await revalidate(turn);
    const text = String(result.text || '').trim();
    status(ASSISTANT_STREAM_PHASES.VERIFYING);
    const verifyStartedAt = Date.now();
    const verdict = authorizationUnavailable || turn.revoked ? unavailableVerdict(turn.locale) : analyze(text, verdictInput(turn));
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
