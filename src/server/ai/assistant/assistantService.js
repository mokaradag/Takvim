import 'server-only';
import { randomUUID } from 'node:crypto';
import { AI_CREDENTIAL_SOURCES } from '../../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { AI_CAPABILITIES, AI_PROFILES, resolveModelProfile } from '../../../domain/ai/aiModelRegistry.js';
import {
  ASSISTANT_LIMITS,
  ASSISTANT_MODES,
  assistantModeLabel,
  conversationTitleFrom,
  isAssistantId,
  isAssistantMode,
  normalizeAssistantMessage
} from '../../../domain/ai/assistantContract.js';
import { getSqlPool, withSqlTransaction } from '../../db/pool.js';
import { ServerPersistenceError } from '../../errors.js';
import { getTrustedCurrentSicil } from '../../identity/currentUserProvider.js';
import { boundedExecutor } from '../../observability/boundedExecution.js';
import { readAiConfig, requireAiAvailable } from '../aiConfig.js';
import { assertAiDirectoryMember, loadAiCredentialStatus } from '../aiCredentialService.js';
import { abortableDelay, AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS, createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { AiError, isAiError } from '../aiErrors.js';
import { getAiGateway } from '../aiRuntime.js';
import { recordGroundedEscalation } from '../aiTelemetry.js';
import { createAiSqlGate } from '../aiSqlGate.js';
import { loadAiModelRegistry } from '../modelRegistryLoader.js';
import { createToolTurnContext } from '../tools/toolContext.js';
import { toolCatalogForModel, toolRegistryProblems } from '../tools/toolRegistry.js';
import { abortAssistantGeneration, claimAssistantGeneration } from './assistantGenerations.js';
import { ASSISTANT_CONTEXT_POLICY, buildAssistantContext } from './assistantPrompt.js';
import {
  appendConversationAnswer,
  appendGroundedConversationAnswer,
  deleteConversation,
  evidenceSchemaState,
  isMissingConversationSchema,
  isMissingEvidenceSchema,
  listConversations,
  loadConversation,
  loadConversationEvidence,
  prepareConversationTurn,
  noteConversationSchema,
  noteEvidenceSchema,
  resetConversationSchemaForTests
} from './conversationStore.js';
import { buildGroundedContext } from './groundedPrompt.js';
import { runGroundedTurn } from './groundedAnswer.js';
import { EVIDENCE_TEXT_FIELDS } from '../../../domain/ai/claimableEvidence.js';
import { clarificationReferences, selectedCandidateOrdinal } from '../../../domain/ai/clarification.js';

/**
 * Rota AI sohbet hizmeti — özellik ile `aiGateway` arasındaki sunucu sınırı.
 *
 * Kimlik YALNIZCA güvenilir oturumdan gelir; hiçbir işlev Sicil, profil ya da
 * model adı almaz. Kullanıcıya dönük kip (`standard`, `deep`) burada, sunucuda
 * profile çevrilir; model adı iş kodunda geçmez (profil → model eşlemesi model
 * kaydındadır).
 *
 * Bir turun yaşam döngüsü: kısa SQL işlemi (kullanıcı iletisi) → işlem ve
 * bağlantı bırakılır → `aiGateway.streamChat` (model üretimi; SQL tutulmaz) →
 * kısa SQL işlemi (tamamlanmış yanıt). Konuşma SQL işleri ortak havuzu kendi
 * sınırlı ve Sicil başına adil kapısından, süre sınırıyla kullanır; model
 * üretimi olağan Rota SQL işlerini tüketemez.
 */

const MODE_PROFILES = Object.freeze({
  [ASSISTANT_MODES.STANDARD]: AI_PROFILES.CHAT_GENERAL,
  [ASSISTANT_MODES.DEEP]: AI_PROFILES.CHAT_REASONING
});

/**
 * Rota verisi araçları açıkken (MERGEN_ROTA_AI_TOOLS_ENABLED) kip → araç
 * yetenekli profil. Araçlar açıkken profil kurulmamışsa ya da 0018
 * uygulanmamışsa veri turu sabit unavailable yanıtı alır.
 */
const MODE_TOOL_PROFILES = Object.freeze({
  [ASSISTANT_MODES.STANDARD]: AI_PROFILES.CHAT_TOOLS,
  [ASSISTANT_MODES.DEEP]: AI_PROFILES.CHAT_TOOLS_REASONING
});
/** 0018 gözleminin geçerlilik süresi; eksik şema daha sık yeniden denenir. */
const EVIDENCE_SCHEMA_READY_TTL_MS = 15 * 60 * 1000;
const EVIDENCE_SCHEMA_MISSING_TTL_MS = 60 * 1000;
const PROBE_CONVERSATION_ID = '00000000-0000-0000-0000-000000000000';
/** Bir konuşmada okunacak en fazla kanıt özeti (ileti başına en fazla 16). */
const MAX_CONVERSATION_EVIDENCE = 16 * ASSISTANT_LIMITS.maxConversationMessages;

/** Konuşma SQL işlerinin süre sınırı (havuz, kapı sırası ve sorgu dâhil). */
export const AI_CONVERSATION_SQL_TIMEOUT_MS = 10000;
/** Tamamlanmış yanıtın yazımı için yinelemeler dâhil toplam süre. */
const ANSWER_PERSIST_BUDGET_MS = 2 * AI_CONVERSATION_SQL_TIMEOUT_MS;
/** Tur isteği gövdesinin en büyük boyutu ve okunma süresi. */
export const ASSISTANT_TURN_BODY_BYTES = 64 * 1024;
const TURN_BODY_TIMEOUT_MS = 10000;
const TURN_FIELDS = new Set(['conversationId', 'turnId', 'message', 'mode', 'expectedSequence', 'source', 'includeText']);

/**
 * Konuşma geçmişinin ortak SQL havuzuna giden işleri: en fazla dört iş aynı
 * anda çalışır, sıra sınırlıdır; tek bir Sicil aynı anda iki iş çalıştırır ve
 * dört iş bekletebilir. Dolunca istek beklemeden `AI_BUSY` alır.
 */
const conversationGate = createAiSqlGate({
  name: 'conversation',
  slots: 4,
  queue: 64,
  perUserActive: 2,
  perUserQueued: 4,
  saturation: 'conversation'
});

export function resetAssistantConversationGateForTests() {
  conversationGate.resetForTests();
  resetConversationSchemaForTests();
}

/** Yalnızca testler: konuşma SQL kapısının doluluğu. */
export function assistantConversationGateStatusForTests() {
  return conversationGate.status();
}

/** Kip → profil. Tanınmayan kip hiçbir profile çözülmez. */
export function assistantProfileForMode(mode) {
  return isAssistantMode(mode) ? MODE_PROFILES[mode] : null;
}

/** Kip → Rota verisi araçlarıyla çalışan profil. */
export function assistantToolProfileForMode(mode) {
  return isAssistantMode(mode) ? MODE_TOOL_PROFILES[mode] : null;
}

function unknownSicil() {
  return new ServerPersistenceError('UNAUTHORIZED', 'Yapılandırılmış Sicil kurumsal personel kaynağında bulunamadı.');
}

function conversationNotFound(reason = 'CONVERSATION_NOT_FOUND') {
  return new ServerPersistenceError('NOT_FOUND', 'Konuşma bulunamadı.', { status: 404, details: { reason } });
}

function conflict(reason, message) {
  return new ServerPersistenceError('CONFLICT', message, { details: { reason } });
}

function invalidRequest(reason, message = null) {
  return new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { message, details: { reason } });
}

function directoryTimeout() {
  return new ServerPersistenceError(
    'DATABASE_UNAVAILABLE',
    'Kurumsal personel kaynağı süre sınırında yanıt vermedi. Biraz sonra yeniden deneyin.',
    { details: { reason: 'DIRECTORY_PREFLIGHT_TIMEOUT' } }
  );
}

function conversationTimeout() {
  return new ServerPersistenceError(
    'DATABASE_UNAVAILABLE',
    'Konuşma geçmişine süre sınırında ulaşılamadı. Biraz sonra yeniden deneyin.',
    { details: { reason: 'CONVERSATION_OPERATION_TIMEOUT' } }
  );
}

function conversationSchemaMissing() {
  return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
    message: 'Bilgin konuşma geçmişi için veritabanı güncellemesi (0017) uygulanmamış. Sistem yöneticinize başvurun.',
    details: { reason: 'CONVERSATION_SCHEMA_MISSING' }
  });
}

/** Süre sınırlı bekleme; istemcinin iptali iptal, sürenin dolması `onTimeout()` olarak bildirilir. */
async function withinDeadline(timeoutMs, signal, work, onTimeout) {
  const deadline = createAiDeadline({ timeoutMs, parentSignal: signal });
  try {
    return await raceWithAbort(() => work(deadline.signal), deadline.signal);
  } catch (error) {
    const failure = deadline.failure();
    if (failure?.code === AI_ERROR_CODES.AI_CANCELLED) throw failure;
    if (failure) throw onTimeout();
    throw error;
  } finally {
    deadline.dispose();
  }
}

/** Rehber üyeliği (Phase 1'in sınırlı rehber kapısı); gövde ya da konuşma okunmadan ÖNCE. */
function verifyDirectoryMember(sicil, signal) {
  return withinDeadline(AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS, signal, (scoped) => assertAiDirectoryMember(sicil, { signal: scoped }), directoryTimeout);
}

/**
 * Konuşma SQL işi: havuz kapıya girmeden (yer tutmadan) alınır, iş kapıdan ve
 * süre sınırıyla geçer; yer, sürücüdeki sorgu GERÇEKTEN bitene kadar tutulur.
 */
function withConversationSql(sicil, signal, work, { trackLifecycle = null } = {}) {
  return withinDeadline(AI_CONVERSATION_SQL_TIMEOUT_MS, signal, (scoped) => {
    const lifecycle = (async () => {
      const pool = await getSqlPool();
      try {
        const result = await conversationGate.run(sicil, scoped, (track) => work({ pool, track, signal: scoped }));
        noteConversationSchema(true);
        return result;
      } catch (error) {
        if (isMissingConversationSchema(error)) {
          noteConversationSchema(false);
          throw conversationSchemaMissing();
        }
        throw error;
      }
    })();
    trackLifecycle?.(lifecycle);
    return lifecycle;
  }, conversationTimeout);
}

function directExecutor({ pool, track, signal }) {
  return boundedExecutor(pool, signal, { track });
}

/**
 * Kısa SQL işlemi. Model çağrısı bu işlemin İÇİNDE yapılmaz (ağ geçidi açık
 * işlemde çalışmayı zaten reddeder). Geri alma, sürücüde hâlâ çalışan
 * (iptal edilmeye çalışılan) deyim bitmeden denenmez.
 */
function inTransaction({ track, signal }, work) {
  return withSqlTransaction(async (transaction) => {
    const running = [];
    const executor = boundedExecutor(transaction, signal, {
      track: (query) => {
        running.push(query);
        track(query);
      }
    });
    try {
      return await work(executor);
    } catch (error) {
      await Promise.allSettled(running);
      throw error;
    }
  }, { deadlockRetries: 2 });
}

function routeAvailable(registry, mode) {
  const resolved = resolveModelProfile(registry, assistantProfileForMode(mode));
  return resolved.ok && resolved.route.capabilities.includes(AI_CAPABILITIES.CHAT);
}

function toolRouteAvailable(registry, mode) {
  const resolved = resolveModelProfile(registry, assistantToolProfileForMode(mode));
  return resolved.ok && resolved.route.capabilities.includes(AI_CAPABILITIES.CHAT)
    && resolved.route.capabilities.includes(AI_CAPABILITIES.TOOLS);
}

/**
 * 0018 (kanıt kaydı) uygulanmış mı? Gözlem önbelleğe alınır; bilinmiyorsa ya
 * da süresi geçtiyse konuşma kapısından tek küçük sorguyla (satır okumadan)
 * denetlenir. Kapı doluluğu ya da süre aşımı şemanın yokluğuna kanıt değildir.
 */
async function evidenceSchemaReady(sicil, signal, { force = false } = {}) {
  const state = evidenceSchemaState();
  const age = state.observedAt ? Date.now() - Date.parse(state.observedAt) : Number.POSITIVE_INFINITY;
  if (!force && state.ready === true && age < EVIDENCE_SCHEMA_READY_TTL_MS) return true;
  if (!force && state.ready === false && age < EVIDENCE_SCHEMA_MISSING_TTL_MS) return false;
  const probe = await withConversationSql(sicil, signal, (scope) => loadConversationEvidence(directExecutor(scope), sicil, {
    conversationId: PROBE_CONVERSATION_ID, maxEvidence: 0
  }));
  if (!probe.knownSicil) throw unknownSicil();
  noteEvidenceSchema(probe.ready);
  return probe.ready;
}

/** 0018 kanıt şemasını bağlantı sınaması için güvenilir kullanıcıyla doğrular. */
export async function checkAssistantEvidenceSchema({ signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  return evidenceSchemaReady(sicil, signal, { force: true });
}

/** Rota verisi araçları bu kurulumda ve bu kipte kullanılabilir mi? */
async function groundedTurnAvailable({ config, registry, mode, sicil, signal }) {
  if (!config.toolsEnabled || !toolRouteAvailable(registry, mode) || !toolRouteAvailable(registry, ASSISTANT_MODES.STANDARD) || toolRegistryProblems().length) return false;
  return evidenceSchemaReady(sicil, signal);
}

function isTransientEvidenceProbeFailure(error) {
  return error?.code === AI_ERROR_CODES.AI_BUSY || error?.code === 'DATABASE_UNAVAILABLE';
}

async function loadEvidenceFor(sicil, signal, { conversationId, messageId = null }) {
  const result = await withConversationSql(sicil, signal, (scope) => loadConversationEvidence(directExecutor(scope), sicil, {
    conversationId, messageId, maxEvidence: MAX_CONVERSATION_EVIDENCE
  }));
  if (!result.knownSicil) throw unknownSicil();
  noteEvidenceSchema(result.ready);
  return { ready: result.ready, byMessage: result.byMessage, epochsByMessage: result.epochsByMessage,
    authorizationByMessage: result.authorizationByMessage, clarificationByMessage: result.clarificationByMessage };
}

/* ── Hazırlık durumu ─────────────────────────────────────────── */

const READINESS_LIMITS = Object.freeze({
  maxMessageChars: ASSISTANT_LIMITS.maxMessageChars,
  maxConversationMessages: ASSISTANT_LIMITS.maxConversationMessages
});

/**
 * Rota AI kullanılabilir mi? Kimlik ve rehber üyeliği ÖNCE doğrulanır;
 * yanıt adres, anahtar, model adı ya da yapılandırma değeri taşımaz — yalnızca
 * kullanılabilirlik, nedeni ve kiplerin açık olup olmadığı döner.
 */
export async function loadAssistantReadiness({ signal = null } = {}) {
  const status = await loadAiCredentialStatus({ signal });
  const config = readAiConfig();
  const unavailable = (reason) => ({ available: false, reason, modes: [], limits: READINESS_LIMITS });
  if (!status.enabled) return unavailable(config.issues.length ? AI_ERROR_CODES.AI_CONFIGURATION_ERROR : AI_ERROR_CODES.AI_DISABLED);
  if (!status.available) return unavailable(AI_ERROR_CODES.AI_CONFIGURATION_ERROR);
  if (status.effectiveSource === AI_CREDENTIAL_SOURCES.MISSING) return unavailable(AI_ERROR_CODES.AI_KEY_MISSING);
  if (status.effectiveSource === AI_CREDENTIAL_SOURCES.PERSONAL && status.credential?.readable === false) {
    return unavailable('AI_KEY_UNREADABLE');
  }
  let registry;
  try {
    registry = await raceWithAbort(() => loadAiModelRegistry({ path: config.registryPath }), signal || new AbortController().signal);
  } catch (error) {
    if (signal?.aborted) throw new AiError(AI_ERROR_CODES.AI_CANCELLED);
    return unavailable(AI_ERROR_CODES.AI_CONFIGURATION_ERROR);
  }
  const modes = [ASSISTANT_MODES.STANDARD, ASSISTANT_MODES.DEEP].map((mode) => ({
    id: mode,
    label: assistantModeLabel(mode),
    available: routeAvailable(registry, mode)
  }));
  await checkAssistantConversationSchema({ signal });
  const available = modes.some((mode) => mode.available);
  return {
    available,
    reason: available ? null : 'PROFILE_UNAVAILABLE',
    credentialSource: status.effectiveSource,
    modes,
    limits: READINESS_LIMITS,
    ...(config.toolsEnabled ? { rotaData: await rotaDataReadiness({ config, registry, signal }) } : {})
  };
}

/**
 * Rota verisi araçlarının hazırlığı (yalnızca özellik açıkken bildirilir):
 * kip başına araç yetenekli profil, araç kayıt defteri ve 0018.
 */
async function rotaDataReadiness({ config, registry, signal }) {
  const sicil = await getTrustedCurrentSicil();
  const modes = [ASSISTANT_MODES.STANDARD, ASSISTANT_MODES.DEEP].map((mode) => ({ id: mode, available: toolRouteAvailable(registry, mode) }));
  let reason = null;
  if (toolRegistryProblems().length) reason = 'TOOL_REGISTRY_INVALID';
  else if (!modes.some((mode) => mode.available)) reason = 'PROFILE_UNAVAILABLE';
  else {
    try {
      if (!await groundedTurnAvailable({ config, registry, mode: modes.find((mode) => mode.available).id, sicil, signal })) {
        reason = 'EVIDENCE_SCHEMA_MISSING';
      }
    } catch (error) {
      if (signal?.aborted || error?.code === AI_ERROR_CODES.AI_CANCELLED || error?.code === 'UNAUTHORIZED') throw error;
      if (!isTransientEvidenceProbeFailure(error)) throw error;
      reason = 'EVIDENCE_SCHEMA_UNKNOWN';
    }
  }
  return { enabled: true, available: reason == null, reason, modes };
}

/** İçerik okumadan iki tabloyu doğrular; sağlık görünümüne gözlem bırakır. */
export async function checkAssistantConversationSchema({ signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  // Eksik yapı `withConversationSql` içinde kaydedilir; kapı doluluğu, süre
  // aşımı ya da bağlantı hatası yapının yokluğuna kanıt değildir.
  const schema = await withConversationSql(sicil, signal, (scope) => loadConversation(directExecutor(scope), sicil, {
    conversationId: '00000000-0000-0000-0000-000000000000', maxMessages: 0
  }));
  if (!schema.knownSicil) throw unknownSicil();
  noteConversationSchema(true);
}

/* ── Konuşma listesi, okuma ve silme ─────────────────────────── */

const SCAN_CURSOR_PREFIX = 'scan-v1';

function encodeCursor(conversation) {
  return Buffer.from(`${conversation.updatedAt}|${conversation.id}`, 'utf8').toString('base64url');
}

function encodeScanCursor(conversation = null) {
  const value = conversation
    ? `${SCAN_CURSOR_PREFIX}|${conversation.createdAt}|${conversation.id}`
    : `${SCAN_CURSOR_PREFIX}|start`;
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const invalid = () => invalidRequest('CURSOR_INVALID');
  if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length === 2 && parts[0] === SCAN_CURSOR_PREFIX && parts[1] === 'start') {
    return { kind: 'scan', createdAt: null, id: null };
  }
  if (parts[0] === SCAN_CURSOR_PREFIX) {
    const [prefix, createdAt, id, extra] = parts;
    if (prefix !== SCAN_CURSOR_PREFIX || extra !== undefined || !isAssistantId(id) || !isCanonicalCursorInstant(createdAt)) throw invalid();
    return { kind: 'scan', createdAt, id: id.toLowerCase() };
  }
  const [updatedAt, id, extra] = parts;
  if (extra !== undefined || !isAssistantId(id) || !isCanonicalCursorInstant(updatedAt)) throw invalid();
  return { kind: 'recent', updatedAt, id: id.toLowerCase() };
}

/**
 * İmleç zamanı gerçek ve kanonik bir an olmalıdır: `2026-02-31` gibi takvimde
 * olmayan değer (JavaScript onu Mart'a kaydırır) ya da SQL Server `datetime2`
 * aralığı dışındaki yıl (0000) reddedilir.
 */
function isCanonicalCursorInstant(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value || '')) return false;
  if (Number(value.slice(0, 4)) < 1) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

/**
 * Genel API'nin nextCursor alanı mevcut UpdatedAt sırasını korur. İlk sayfa
 * ayrıca arayüze değişmez CreatedAt taraması için scanCursor verir; böylece
 * derin geçmiş yeniden baştan oynatılmaz ve UpdatedAt sıçraması satır atlatmaz.
 */
export async function listAssistantConversations({ cursor = null, signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  const decoded = cursor == null ? null : decodeCursor(cursor);
  const scan = decoded?.kind === 'scan' ? decoded : null;
  const before = decoded?.kind === 'recent' ? decoded : null;
  const result = await withConversationSql(sicil, signal, (scope) => listConversations(directExecutor(scope), sicil, {
    limit: ASSISTANT_LIMITS.conversationPageSize,
    before,
    scan
  }));
  if (!result.knownSicil) throw unknownSicil();
  const last = result.conversations[result.conversations.length - 1];
  const nextCursor = result.hasMore && last
    ? (scan ? encodeScanCursor(last) : encodeCursor(last))
    : null;
  return {
    conversations: result.conversations,
    nextCursor,
    ...(cursor == null ? { scanCursor: result.hasMore ? encodeScanCursor() : null } : {})
  };
}

function requireConversationId(value) {
  if (!isAssistantId(value)) throw invalidRequest('CONVERSATION_ID_INVALID');
  return value.toLowerCase();
}

/** Tek konuşma ve iletileri. Başka Sicil'in konuşması var olmayan konuşmayla AYNI yanıtı alır. */
export async function loadAssistantConversation({ conversationId, signal = null }) {
  const sicil = await getTrustedCurrentSicil();
  const id = requireConversationId(conversationId);
  const result = await withConversationSql(sicil, signal, (scope) => loadConversation(directExecutor(scope), sicil, {
    conversationId: id,
    maxMessages: ASSISTANT_LIMITS.maxConversationMessages
  }));
  if (!result.knownSicil) throw unknownSicil();
  if (!result.conversation) throw conversationNotFound();
  const evidence = await optionalEvidence(sicil, signal, { conversationId: id });
  return {
    conversation: result.conversation,
    messages: discloseSavedMessages(result.messages, evidence)
  };
}

/**
 * Kalıcı Rota yanıtı yalnızca güncel yetki dönemi doğrulanırsa açıklanır.
 * Kanıt ya da yetki okunamazsa korunan metin ve özetler birlikte gizlenir.
 */
async function optionalEvidence(sicil, signal, target, { revalidate = true } = {}) {
  try {
    const evidence = await loadEvidenceFor(sicil, signal, target);
    // Kimlikler parçalar hâlinde doğrulanır (bkz. revalidateEvidence): uzun bir
    // konuşmanın bütün yanıtları tek bir sınır aşımıyla gizlenmez.
    // Nüfusu kalıcı kayda sığmayan yanıt güncel yetkiyle doğrulanamaz; bu durum
    // yalnızca kayıtlı künyeden türetilir, güncel yetki hakkında bilgi vermez.
    evidence.unverifiable = new Set([...(evidence.authorizationByMessage || new Map())]
      .filter(([, entries]) => entries.some((entry) => entry.unverifiable)).map(([id]) => id));
    if (revalidate && evidence.byMessage.size) {
      const context = createToolTurnContext({ sicil });
      const deadline = createAiDeadline({ timeoutMs: context.limits.maxCumulativeSqlMs, parentSignal: signal });
      const visible = new Map();
      evidence.unavailableMessages = new Set();
      try {
        await context.revalidateAuthorization(deadline.signal);
        for (const [id, summaries] of [...evidence.byMessage].reverse()) {
          if (deadline.signal.aborted) { evidence.unavailableMessages.add(id); continue; }
          const entries = evidence.authorizationByMessage.get(id);
          if (!entries?.length) continue;
          const messageDeadline = createAiDeadline({ timeoutMs: context.limits.callTimeoutMs, parentSignal: deadline.signal });
          try {
            const authorized = await context.revalidateEvidence(entries, messageDeadline.signal);
            if (entries.every((entry) => authorized.has(entry.id))) visible.set(id, summaries);
          } catch (error) {
            if (error?.code === 'UNAUTHORIZED' || signal?.aborted) throw error;
            evidence.unavailableMessages.add(id);
          } finally { messageDeadline.dispose(); }
        }
        evidence.byMessage = visible;
      } finally { deadline.dispose(); }
    }
    return evidence;
  } catch (error) {
    if (error?.code === 'UNAUTHORIZED' || signal?.aborted) throw error;
    return { unavailable: true };
  }
}

/**
 * Kanıt kaydı okunamadığında atıf işareti taşıyan yanıt temkinle gizlenir.
 * Genel sohbet yanıtı Rota kanıtına hiç dayanmaz: içindeki düz `【R1】` metni
 * gizleme nedeni değildir. Kanıt kaydı okunabiliyorsa yalnızca kayıtlı kanıt
 * dönemleri belirleyicidir.
 */
function citedWithoutKnownEvidence(message, evidence) {
  if (message.finishReason === 'general' || message.source === 'general') return false;
  if (!(evidence?.unavailable || evidence?.ready === false || !evidence?.epochsByMessage)) return false;
  return /【R[1-9]\d?】/.test(String(message.content || ''));
}

const UNVERIFIABLE_SAVED_ANSWER_TEXT = 'Bu kayıtlı yanıt çok sayıda kayda dayandığı için güncel yetkinizle yeniden doğrulanamıyor. Güncel bilgi için soruyu yeniden sorun.';

function discloseSavedMessages(messages, evidence) {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (evidence?.unverifiable?.has(message.id)) {
      return { ...message, content: UNVERIFIABLE_SAVED_ANSWER_TEXT, evidence: [], finishReason: 'unavailable' };
    }
    const saved = evidence?.byMessage?.get(message.id);
    if (saved?.length) return { ...message, evidence: saved };
    if (evidence?.epochsByMessage?.has(message.id) || citedWithoutKnownEvidence(message, evidence)) {
      if (evidence?.unavailable || evidence?.ready === false || evidence?.unavailableMessages?.has(message.id)) {
        return { ...message, content: 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', evidence: [], finishReason: 'unavailable' };
      }
      return { ...message, content: 'Kayıt bulunamadı ya da bu kaydı görüntüleme yetkiniz yok.', evidence: [], finishReason: 'not_found' };
    }
    return message;
  });
}

/**
 * Önceki tur hâlâ yetkili bir açıklamayla bittiyse adaylar ve kullanıcının
 * numaralı seçimi. Seçim sunucuda kayıtlı aday kimliğine bağlanır; model
 * sırayı kimliğe çevirmez. Seçim değilse adaylar bu turda kimlik olamaz.
 */
function pendingClarification(history, content) {
  const last = history.at(-1);
  if (last?.role !== 'assistant' || last.finishReason !== 'clarification') return null;
  const candidates = clarificationReferences(last.clarificationContext);
  if (!candidates.length) return null;
  const ordinal = selectedCandidateOrdinal(content, candidates.length);
  const question = history.at(-2)?.role === 'user' ? String(history.at(-2).content || '') : '';
  return { candidates, selected: ordinal == null ? null : candidates.find((candidate) => candidate.ordinal === ordinal) || null, question };
}

const FALLBACK_GROUNDED_HISTORY_TEXT = '[Önceki Rota verisi yanıtı güncel kanıt olmadığı için bu tur bağlamına alınmadı.]';

function fallbackAssistantHistory(history, evidence) {
  return history.map((message) => {
    if (message.role !== 'assistant') return message;
    const grounded = evidence?.epochsByMessage?.has(message.id) || citedWithoutKnownEvidence(message, evidence);
    if (grounded) return { ...message, content: FALLBACK_GROUNDED_HISTORY_TEXT };
    return message;
  });
}

/**
 * Konuşmayı iletileriyle siler. Başarılı silmeden sonra süren üretim
 * durdurulur; başka Sicil'in konuşması silinmez ve varlığı öğrenilemez.
 */
export async function deleteAssistantConversation({ conversationId, signal = null }) {
  const sicil = await getTrustedCurrentSicil();
  const id = requireConversationId(conversationId);
  let submitted = null;
  let result;
  try {
    result = await withConversationSql(sicil, signal, (scope) => {
      const executor = boundedExecutor(scope.pool, scope.signal, {
        track: (query) => {
          submitted = scope.signal;
          scope.track(query);
        },
        // HTTP iptal edilse bile sürücünün başarılı silme sonucu üretimi durdurur.
        onResult: (result) => {
          const row = result.recordsets?.[0]?.[0];
          if (row?.KnownSicil && Number(row.Deleted) > 0) abortAssistantGeneration({ sicil, conversationId: id });
        }
      });
      return deleteConversation(executor, sicil, { conversationId: id });
    });
  } catch (error) {
    // Gönderilen silme İPTAL edildi (istemci ya da süre sınırı): sürücü sonucu
    // bildirmeden DELETE işlenmiş olabilir. Kullanıcı konuşmanın silinmesini
    // istedi; süren üretim durdurulur (silme işlenmediyse tur yanıtsız ve yeniden
    // denenebilir kalır). Sürücünün bildirdiği kesin hata silme değildir.
    if (submitted?.aborted) abortAssistantGeneration({ sicil, conversationId: id });
    throw error;
  }
  if (!result.knownSicil) throw unknownSicil();
  if (!result.deleted) throw conversationNotFound();
  abortAssistantGeneration({ sicil, conversationId: id });
  return { deleted: true, conversationId: id };
}

/* ── Tur ─────────────────────────────────────────────────────── */

/**
 * Tur isteği: `conversationId`, `turnId`, `message`, `mode` ve `expectedSequence`.
 * Tanınmayan alan (ör. `model`, `profile`, `sicil`, `messages`, `system`)
 * reddedilir: tarayıcı model, profil, kimlik ya da geçmiş belirleyemez.
 */
function parseTurnInput(body) {
  for (const key of Object.keys(body)) {
    if (!TURN_FIELDS.has(key)) throw invalidRequest('UNKNOWN_FIELD');
  }
  const conversationId = body.conversationId == null ? null : requireConversationId(body.conversationId);
  if (!isAssistantId(body.turnId)) throw invalidRequest('TURN_ID_INVALID');
  if (!isAssistantMode(body.mode)) throw invalidRequest('MODE_UNSUPPORTED', 'Seçilen yanıt kipi desteklenmiyor.');
  const source = body.source ?? 'rota';
  if (!['rota', 'general'].includes(source)) throw invalidRequest('SOURCE_UNSUPPORTED');
  // Kayıtlı serbest metnin (açıklama, ileti, değişiklik metni) okunması kullanıcının açık seçimidir; model açamaz.
  if (body.includeText != null && typeof body.includeText !== 'boolean') throw invalidRequest('INCLUDE_TEXT_INVALID');
  const includeText = body.includeText === true;
  let message = null;
  if (body.message != null) {
    const normalized = normalizeAssistantMessage(body.message);
    if (!normalized.ok) throw invalidRequest(normalized.reason, normalized.message);
    message = normalized.value;
  }
  if (message == null && conversationId == null) throw invalidRequest('MESSAGE_REQUIRED', 'İleti boş olamaz.');
  const expectedSequence = body.expectedSequence ?? null;
  if (expectedSequence != null && (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0 || expectedSequence > ASSISTANT_LIMITS.maxConversationMessages)) throw invalidRequest('SEQUENCE_INVALID');
  return { conversationId, turnId: body.turnId.toLowerCase(), mode: body.mode, source, includeText, message, expectedSequence };
}

function outcomeFailure(prepared, input) {
  switch (prepared.outcome) {
    case 'UNAUTHORIZED':
      return unknownSicil();
    case 'NOT_FOUND':
      return conversationNotFound();
    case 'TURN_NOT_FOUND':
      return conversationNotFound('TURN_NOT_FOUND');
    case 'STALE':
      return conflict('CONVERSATION_STALE', 'Bu konuşma başka bir pencerede değişti. Konuşmayı yenileyip iletinizi yeniden gönderin.');
    case 'FULL':
      return conflict('CONVERSATION_FULL', 'Bu konuşma azami uzunluğa ulaştı. Devam etmek için yeni bir konuşma başlatın.');
    case 'UNANSWERED':
      return conflict('TURN_UNANSWERED', 'Önce yanıtı tamamlanmamış son iletiyi yeniden deneyin veya yeni bir konuşma başlatın.');
    case 'EXISTING':
      if (input.message != null && prepared.turn.content !== input.message) {
        return conflict('TURN_ID_REUSED', 'Bu ileti kimliği farklı bir içerikle kullanılmış. Sayfayı yenileyip yeniden gönderin.');
      }
      if (!prepared.answer && !prepared.turn.latest) {
        return conflict('TURN_NOT_LATEST', 'Yalnızca konuşmanın son iletisi yeniden denenebilir.');
      }
      return null;
    case 'CREATED':
      return null;
    default:
      return conversationNotFound();
  }
}

/**
 * Turu hazırlar (akış başlamadan önce; hatalar olağan JSON yanıtıyla döner).
 *
 * Sıra: aynı kaynak (uçta) → güvenilir Sicil → rehber üyeliği → gövde (sınırlı
 * ve süre sınırlı) → kayıtlı yanıtı salt okunur arama → yapılandırma ve kip →
 * konuşmada tek üretim hakkı → kısa SQL
 * işlemi (kullanıcı iletisi ya da var olan tur) → sunucuda kurulan sınırlı
 * bağlam. Aynı turun yeniden gönderimi ikinci ileti üretmez; yanıtı zaten
 * yazılmış tur yeniden üretilmez, kayıtlı yanıtı oynatılır.
 */
export async function prepareAssistantTurn({ readBody, signal = null }) {
  const sicil = await getTrustedCurrentSicil();
  await verifyDirectoryMember(sicil, signal);
  const body = await withinDeadline(TURN_BODY_TIMEOUT_MS, signal, (scoped) => readBody(scoped), () => invalidRequest('BODY_TIMEOUT'));
  const input = parseTurnInput(body);
  let conversationId = input.conversationId;
  const prepareWith = (executor, readOnly) => prepareConversationTurn(executor, sicil, {
    conversationId,
    newConversationId: randomUUID(),
    userMessageId: randomUUID(),
    turnId: input.turnId,
    content: input.message,
    expectedSequence: input.expectedSequence,
    title: conversationTitleFrom(input.message),
    maxMessages: ASSISTANT_LIMITS.maxConversationMessages,
    historyLimit: ASSISTANT_CONTEXT_POLICY.historyWindow,
    readOnly
  });
  // Salt okunur geçiş hiçbir satır yazmaz ve kilit almaz: işlem açılmaz.
  const prepare = (readOnly) => withConversationSql(sicil, signal, (scope) => (readOnly
    ? prepareWith(directExecutor(scope), true)
    : inTransaction(scope, (executor) => prepareWith(executor, false))));
  // Kayıtlı yanıt için yapılandırma ya da üretim hakkı gerekmez.
  const existing = await prepare(true);
  if (!existing.knownSicil) throw unknownSicil();
  if (existing.outcome === 'EXISTING') {
    const failure = outcomeFailure(existing, input);
    if (failure) throw failure;
  }
  if (existing.answer) {
    const failure = outcomeFailure(existing, input);
    if (failure) throw failure;
    const replayEvidence = await optionalEvidence(sicil, signal, {
      conversationId: existing.conversation.id,
      messageId: existing.answer.id
    });
    return {
      sicil, claim: null, mode: existing.answer.mode, profile: assistantProfileForMode(existing.answer.mode), grounded: false,
      conversation: existing.conversation, userMessage: existing.turn.message,
      replay: discloseSavedMessages([existing.answer], replayEvidence)[0],
      modelMessages: [], context: { trimmed: Boolean(existing.answer.contextTrimmed), omittedMessages: Math.max(0, Number(existing.answer.contextOmittedMessages) || 0) }
    };
  }
  const config = requireAiAvailable(readAiConfig());
  const profile = assistantProfileForMode(input.mode);
  const registry = await withinDeadline(AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS, signal, () => loadAiModelRegistry({ path: config.registryPath }), () => (
    new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details: { reason: 'MODEL_REGISTRY_INVALID' } })
  ));
  if (!routeAvailable(registry, input.mode)) {
    throw new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
      message: `${assistantModeLabel(input.mode)} kipi bu kurulumda kullanılamıyor.`,
      details: { reason: 'MODE_UNAVAILABLE' }
    });
  }
  // Rota verisi araçları: özellik açık, kipin araç profili kurulu ve 0018
  // uygulanmışsa tur kanıta dayalı yoldan yanıtlanır; araçlar açıkken eksik
  // hazırlık durumu model çağırmadan unavailable sonucuna gider.
  // Şema yoklamasının geçici hatası (kapı dolu, SQL zaman aşımı) tur kaydedilmeden
  // yinelenebilir hata olarak döner; kalıcı bir "unavailable" yanıtı yazılmaz.
  const grounded = input.source !== 'general' && await groundedTurnAvailable({ config, registry, mode: input.mode, sicil, signal });
  const claim = await withinDeadline(Math.min(config.requestTimeoutMs, 30000), signal, (scoped) => claimAssistantGeneration({
    sicil, conversationId: input.conversationId, turnId: input.turnId, content: input.message ?? existing.turn?.content, signal: scoped
  }), () => conflict('GENERATION_IN_PROGRESS', 'Bu konuşmada bir yanıt hâlâ üretiliyor. Tamamlanmasını bekleyip yeniden deneyin.'));
  try {
    conversationId = claim.conversationId;
    const prepared = await prepare(false);
    if (!prepared.knownSicil) throw unknownSicil();
    const failure = outcomeFailure(prepared, input);
    if (failure) throw failure;
    claim.bindConversation(prepared.conversation.id);
    const useTools = grounded && !prepared.answer;
    let history = prepared.history;
    if (history.some((message) => message.role === 'assistant')) {
      // Geçmiş yanıtlar bağlama yer tutucu olarak girer: yalnızca kanıt dönemleri gerekir.
      const priorEvidence = await optionalEvidence(sicil, signal, { conversationId: prepared.conversation.id }, { revalidate: false });
      history = fallbackAssistantHistory(history, priorEvidence);
      const last = history.at(-1);
      if (useTools && last?.role === 'assistant' && last.finishReason === 'clarification') {
        // Aday kimlikleri yalnızca son açıklama için ve güncel yetkiyle açılır.
        const current = await optionalEvidence(sicil, signal, { conversationId: prepared.conversation.id, messageId: last.id });
        if (current?.byMessage?.has(last.id)) {
          history = [...history.slice(0, -1), { ...last, clarificationContext: current.clarificationByMessage?.get(last.id) }];
        }
      }
    }
    const contextInput = {
      history,
      userContent: prepared.turn.content,
      priorMessageCount: Math.max(0, prepared.turn.sequence - 1)
    };
    const context = useTools ? buildGroundedContext(contextInput) : buildAssistantContext(contextInput);
    const clarification = useTools ? pendingClarification(history, prepared.turn.content) : null;
    return {
      sicil,
      claim,
      mode: prepared.answer?.mode || input.mode,
      profile: prepared.answer ? assistantProfileForMode(prepared.answer.mode) : (useTools ? assistantToolProfileForMode(input.mode) : profile),
      grounded: useTools,
      // Gerekli veri toplandıktan sonra bildirilen muhakeme ihtiyacı Derin profile devredilir.
      escalationProfile: useTools && toolRouteAvailable(registry, ASSISTANT_MODES.DEEP)
        ? assistantToolProfileForMode(ASSISTANT_MODES.DEEP) : null,
      general: input.source === 'general',
      allowedTextFields: input.includeText ? [...EVIDENCE_TEXT_FIELDS] : [],
      clarification,
      dataUnavailable: config.toolsEnabled && input.source !== 'general' && !grounded,
      conversation: prepared.conversation,
      userMessage: prepared.turn.message,
      replay: prepared.answer ? discloseSavedMessages([prepared.answer], await optionalEvidence(sicil, signal, { conversationId: prepared.conversation.id, messageId: prepared.answer.id }))[0] : null,
      modelMessages: context.messages,
      context: { trimmed: context.trimmed, omittedMessages: context.omittedMessages }
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}

/**
 * Tamamlanmış yanıtın kısa işlemle yazımı; geçici hatada (kapı dolu, bağlantı)
 * en fazla üç deneme. Yazım istemcinin iptaline bağlı değildir (bütçe sınırlıdır).
 */
function persistAnswer(turn, write) {
  return withinDeadline(ANSWER_PERSIST_BUDGET_MS, null, async (budgetSignal) => {
    for (let attempt = 1; ; attempt += 1) {
      let lifecycle;
      try {
        return await withConversationSql(turn.sicil, budgetSignal, (scope) => inTransaction(scope, write),
          { trackLifecycle: (pending) => { lifecycle = pending; } });
      } catch (error) {
        const transient = error?.code === AI_ERROR_CODES.AI_BUSY || error?.code === 'DATABASE_UNAVAILABLE';
        if (!transient || attempt >= 3) throw error;
        // BEGIN, COMMIT ve ROLLBACK dahil önceki iş tamamen bitmeden yinelenmez.
        await raceWithAbort(() => Promise.allSettled([lifecycle]), budgetSignal);
        await abortableDelay(250 * attempt, budgetSignal);
      }
    }
  }, conversationTimeout);
}

/**
 * Hazırlanan tur için yanıtı üretir ve TAMAMLANAN yanıtı yazar: genel sohbet
 * `aiGateway.streamChat` ile, kanıta dayalı tur `aiGateway.runToolSession` ile.
 * Durdurulan, süresi dolan ya da yarıda kesilen yanıt yazılmaz; kullanıcı turu
 * yanıtsız (yeniden denenebilir) kalır.
 *
 * Yanıtın yazımı istemcinin iptaline bağlı değildir: model yanıtı tamamladıysa
 * bağlantı o anda kesilse de yanıt kaybolmaz (yazım yine süre sınırlıdır).
 */
export async function generateAssistantAnswer(turn, { signal = null, onStatus = null, onText }) {
  if (turn.grounded) return generateGroundedAssistantAnswer(turn, { signal, onStatus, onText });
  const result = turn.dataUnavailable ? { text: 'Rota verisine şu anda ulaşılamıyor. Daha sonra yeniden deneyin.', finishReason: 'unavailable' } : await getAiGateway().streamChat({
    profile: turn.profile,
    messages: turn.modelMessages,
    signal,
    onStatus,
    onText
  });
  if (turn.dataUnavailable) await onText(result.text);
  if (turn.general && result.finishReason === 'stop') result.finishReason = 'general';
  const messageId = randomUUID();
  const stored = await persistAnswer(turn, (executor) => appendConversationAnswer(executor, turn.sicil, {
    conversationId: turn.conversation.id,
    messageId,
    replyToMessageId: turn.userMessage.id,
    content: result.text,
    mode: turn.mode,
    finishReason: !turn.dataUnavailable && ['stop', 'end_turn', 'eos', 'stop_sequence', 'length', 'content_filter'].includes(result.finishReason)
      ? `general_${result.finishReason}` : result.finishReason,
    contextTrimmed: turn.context.trimmed,
    contextOmittedMessages: turn.context.omittedMessages
  }));
  if (!stored.knownSicil) throw unknownSicil();
  if (!stored.persisted || !stored.message) {
    throw conversationNotFound('ANSWER_NOT_PERSISTED');
  }
  const reconciled = stored.message.id !== messageId;
  const answer = reconciled ? discloseSavedMessages([stored.message], await optionalEvidence(turn.sicil, signal, {
    conversationId: turn.conversation.id, messageId: stored.message.id
  }))[0] : stored.message;
  return {
    conversation: stored.conversation,
    answer,
    reconciled,
    finishReason: answer.finishReason,
    firstTokenMs: result.firstTokenMs
  };
}

function evidenceSchemaMissing() {
  return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, {
    message: 'Bilgin kanıt kaydı için veritabanı güncellemesi (0018) uygulanmamış. Sistem yöneticinize başvurun.',
    details: { reason: 'EVIDENCE_SCHEMA_MISSING' }
  });
}

/** Veri sonrası muhakeme devri; iptal, kimlik ve süre aşımı yukarı taşınır. */
async function escalateGroundedTurn(turn, request, { signal, onText, runIn }) {
  const telemetry = (outcome, models = []) => recordGroundedEscalation({
    requestedMode: turn.mode, models: [...request.models, ...models], reason: request.reason, toolsReused: request.toolsReused, outcome
  });
  let result;
  try {
    result = await runIn(turn.escalationProfile, { resume: request.resume });
  } catch (error) {
    // Yalnızca yapay zekâ hizmetinin hatası Standart sonucuna döner; iptal, kimlik ve veri hataları turu bitirir.
    if (signal?.aborted || !isAiError(error) || error.code === AI_ERROR_CODES.AI_CANCELLED) {
      telemetry('error');
      request.traceError?.(error);
      throw error;
    }
    const timedOut = error.code === AI_ERROR_CODES.AI_TIMEOUT;
    telemetry(timedOut ? 'timeout' : 'error');
    // Süre aşımı doğrulama hatası değildir: sağlayıcının yoğunluğu güvenli iletiyle gizlenmez.
    if (timedOut) { request.traceError?.(error); throw error; }
    return request.fallback(onText);
  }
  telemetry(result.outcome, result.models);
  return result;
}

/**
 * Rota verisi araçlarıyla, kanıta dayalı yanıt. Model ve araç turları SQL
 * işlemi dışında çalışır; yanıt ve atıf yaptığı kanıtlar yalnızca yanıt
 * doğrulandıktan (ya da güvenli iletiye düştükten) SONRA, tek kısa işlemde
 * yazılır. Durdurulan ya da süresi dolan tur yazılmaz.
 */
async function generateGroundedAssistantAnswer(turn, { signal, onStatus, onText }) {
  const options = {
    messages: turn.modelMessages,
    catalog: toolCatalogForModel(),
    context: createToolTurnContext({ sicil: turn.sicil }),
    allowedTextFields: turn.allowedTextFields || [],
    clarification: turn.clarification || null,
    onStatus,
    onText: async () => {},
    deferDisclosure: true
  };
  const runIn = (profile, extra) => getAiGateway().runToolSession({
    profile,
    signal,
    run: (session) => {
      if (Number(session.sicil) !== Number(turn.sicil)) throw unknownSicil();
      return runGroundedTurn(session, { ...options, ...extra });
    }
  });
  let grounded = await runIn(assistantToolProfileForMode('standard'), { escalation: Boolean(turn.escalationProfile) });
  if (grounded.outcome === 'escalate') grounded = await escalateGroundedTurn(turn, grounded, { signal, onText: options.onText, runIn });
  const messageId = randomUUID();
  let stored;
  try {
    stored = await persistAnswer(turn, (executor) => appendGroundedConversationAnswer(executor, turn.sicil, {
      conversationId: turn.conversation.id,
      messageId,
      replyToMessageId: turn.userMessage.id,
      content: grounded.text,
      mode: turn.mode,
      finishReason: grounded.finishReason,
      contextTrimmed: turn.context.trimmed,
      contextOmittedMessages: turn.context.omittedMessages,
      evidence: grounded.evidenceRows
    }));
  } catch (error) {
    if (isMissingEvidenceSchema(error)) {
      noteEvidenceSchema(false);
      throw evidenceSchemaMissing();
    }
    throw error;
  }
  if (!stored.knownSicil) throw unknownSicil();
  if (!stored.persisted || !stored.message) {
    throw conversationNotFound('ANSWER_NOT_PERSISTED');
  }
  const evidence = await optionalEvidence(turn.sicil, signal, {
    conversationId: turn.conversation.id, messageId: stored.message.id
  });
  // Bu turda doğrulanıp yazılan yanıt gösterilir; kalıcı nüfusu sınıra sığmayan
  // yanıt yalnızca SONRAKİ açılışlarda doğrulanamaz sayılır.
  const own = stored.message.id === messageId;
  const liveAuthorized = own && evidence?.unverifiable?.has(messageId) && await grounded.guardDisclosure?.(signal);
  const answer = liveAuthorized
    ? { ...stored.message, evidence: grounded.evidence }
    : discloseSavedMessages([stored.message], evidence)[0];
  const deliveredOutcome = answer.finishReason === 'stop' ? 'grounded' : answer.finishReason === 'grounding_failed' ? 'failed' : answer.finishReason;
  grounded.completeDisclosure?.(deliveredOutcome);
  await onText(answer.content);
  return {
    conversation: stored.conversation,
    answer: { ...answer, evidence: answer.evidence || [] },
    reconciled: stored.message.id !== messageId,
    finishReason: answer.finishReason,
    contentAuthoritative: true,
    firstTokenMs: null
  };
}
