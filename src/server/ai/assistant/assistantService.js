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
import { AI_DIRECTORY_PREFLIGHT_TIMEOUT_MS, createAiDeadline, raceWithAbort } from '../aiDeadline.js';
import { AiError } from '../aiErrors.js';
import { getAiGateway } from '../aiRuntime.js';
import { createAiSqlGate } from '../aiSqlGate.js';
import { loadAiModelRegistry } from '../modelRegistryLoader.js';
import { abortAssistantGeneration, claimAssistantGeneration } from './assistantGenerations.js';
import { ASSISTANT_CONTEXT_POLICY, buildAssistantContext } from './assistantPrompt.js';
import {
  appendConversationAnswer,
  deleteConversation,
  isMissingConversationSchema,
  listConversations,
  loadConversation,
  prepareConversationTurn
} from './conversationStore.js';

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

/** Konuşma SQL işlerinin süre sınırı (havuz, kapı sırası ve sorgu dâhil). */
export const AI_CONVERSATION_SQL_TIMEOUT_MS = 10000;
/** Tur isteği gövdesinin en büyük boyutu ve okunma süresi. */
export const ASSISTANT_TURN_BODY_BYTES = 64 * 1024;
const TURN_BODY_TIMEOUT_MS = 10000;
const TURN_FIELDS = new Set(['conversationId', 'turnId', 'message', 'mode']);

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
}

/** Yalnızca testler: konuşma SQL kapısının doluluğu. */
export function assistantConversationGateStatusForTests() {
  return conversationGate.status();
}

/** Kip → profil. Tanınmayan kip hiçbir profile çözülmez. */
export function assistantProfileForMode(mode) {
  return isAssistantMode(mode) ? MODE_PROFILES[mode] : null;
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
    message: 'Rota AI konuşma geçmişi için veritabanı güncellemesi (0017) uygulanmamış. Sistem yöneticinize başvurun.',
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
function withConversationSql(sicil, signal, work) {
  return withinDeadline(AI_CONVERSATION_SQL_TIMEOUT_MS, signal, async (scoped) => {
    const pool = await getSqlPool();
    try {
      return await conversationGate.run(sicil, scoped, (track) => work({ pool, track, signal: scoped }));
    } catch (error) {
      if (isMissingConversationSchema(error)) throw conversationSchemaMissing();
      throw error;
    }
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
  const sicil = await getTrustedCurrentSicil();
  // İçerik okumadan her iki konuşma tablosunu doğrula.
  const schema = await withConversationSql(sicil, signal, (scope) => loadConversation(directExecutor(scope), sicil, {
    conversationId: '00000000-0000-0000-0000-000000000000', maxMessages: 0
  }));
  if (!schema.knownSicil) throw unknownSicil();
  const available = modes.some((mode) => mode.available);
  return {
    available,
    reason: available ? null : 'PROFILE_UNAVAILABLE',
    credentialSource: status.effectiveSource,
    modes,
    limits: READINESS_LIMITS
  };
}

/* ── Konuşma listesi, okuma ve silme ─────────────────────────── */

function encodeCursor(conversation) {
  return Buffer.from(`${conversation.updatedAt}|${conversation.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const invalid = () => invalidRequest('CURSOR_INVALID');
  if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const [updatedAt, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !isAssistantId(id) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt || '')
    || Number.isNaN(Date.parse(updatedAt))) throw invalid();
  return { updatedAt, id: id.toLowerCase() };
}

/** Son etkinliğe göre sıralı, sayfalı konuşma listesi (yalnızca kendi konuşmaları). */
export async function listAssistantConversations({ cursor = null, signal = null } = {}) {
  const sicil = await getTrustedCurrentSicil();
  const before = cursor == null ? null : decodeCursor(cursor);
  const result = await withConversationSql(sicil, signal, (scope) => listConversations(directExecutor(scope), sicil, {
    limit: ASSISTANT_LIMITS.conversationPageSize,
    before
  }));
  if (!result.knownSicil) throw unknownSicil();
  const last = result.conversations[result.conversations.length - 1];
  return { conversations: result.conversations, nextCursor: result.hasMore && last ? encodeCursor(last) : null };
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
  return { conversation: result.conversation, messages: result.messages };
}

/**
 * Konuşmayı iletileriyle siler. Başarılı silmeden sonra süren üretim
 * durdurulur; başka Sicil'in konuşması silinmez ve varlığı öğrenilemez.
 */
export async function deleteAssistantConversation({ conversationId, signal = null }) {
  const sicil = await getTrustedCurrentSicil();
  const id = requireConversationId(conversationId);
  const result = await withConversationSql(sicil, signal, (scope) => deleteConversation(directExecutor(scope), sicil, { conversationId: id }));
  if (!result.knownSicil) throw unknownSicil();
  if (!result.deleted) throw conversationNotFound();
  abortAssistantGeneration({ sicil, conversationId: id });
  return { deleted: true, conversationId: id };
}

/* ── Tur ─────────────────────────────────────────────────────── */

/**
 * Tur isteği: yalnızca `conversationId`, `turnId`, `message` ve `mode`.
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
  let message = null;
  if (body.message != null) {
    const normalized = normalizeAssistantMessage(body.message);
    if (!normalized.ok) throw invalidRequest(normalized.reason, normalized.message);
    message = normalized.value;
  }
  if (message == null && conversationId == null) throw invalidRequest('MESSAGE_REQUIRED', 'İleti boş olamaz.');
  return { conversationId, turnId: body.turnId.toLowerCase(), mode: body.mode, message };
}

function outcomeFailure(prepared, input) {
  switch (prepared.outcome) {
    case 'UNAUTHORIZED':
      return unknownSicil();
    case 'NOT_FOUND':
      return conversationNotFound();
    case 'TURN_NOT_FOUND':
      return conversationNotFound('TURN_NOT_FOUND');
    case 'FULL':
      return conflict('CONVERSATION_FULL', 'Bu konuşma azami uzunluğa ulaştı. Devam etmek için yeni bir konuşma başlatın.');
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
  const prepare = (readOnly) => withConversationSql(sicil, signal, (scope) => inTransaction(scope, (executor) => prepareConversationTurn(executor, sicil, {
    conversationId: input.conversationId,
    newConversationId: randomUUID(),
    userMessageId: randomUUID(),
    turnId: input.turnId,
    content: input.message,
    title: conversationTitleFrom(input.message),
    maxMessages: ASSISTANT_LIMITS.maxConversationMessages,
    historyLimit: readOnly ? 0 : ASSISTANT_CONTEXT_POLICY.historyWindow,
    readOnly
  })));
  // Kayıtlı yanıt için yapılandırma ya da üretim hakkı gerekmez.
  const existing = await prepare(true);
  if (!existing.knownSicil) throw unknownSicil();
  if (existing.answer) {
    const failure = outcomeFailure(existing, input);
    if (failure) throw failure;
    return {
      sicil, claim: null, mode: input.mode, profile: assistantProfileForMode(input.mode),
      conversation: existing.conversation, userMessage: existing.turn.message,
      replay: existing.answer, modelMessages: [], context: { trimmed: false, omittedMessages: 0 }
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
  const claim = claimAssistantGeneration({ sicil, conversationId: input.conversationId, turnId: input.turnId });
  try {
    const prepared = await prepare(false);
    if (!prepared.knownSicil) throw unknownSicil();
    const failure = outcomeFailure(prepared, input);
    if (failure) throw failure;
    claim.bindConversation(prepared.conversation.id);
    const context = buildAssistantContext({
      history: prepared.history,
      userContent: prepared.turn.content,
      priorMessageCount: Math.max(0, prepared.turn.sequence - 1)
    });
    return {
      sicil,
      claim,
      mode: input.mode,
      profile,
      conversation: prepared.conversation,
      userMessage: prepared.turn.message,
      replay: prepared.answer,
      modelMessages: context.messages,
      context: { trimmed: context.trimmed, omittedMessages: context.omittedMessages }
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}

/**
 * Hazırlanan tur için yanıtı `aiGateway.streamChat` ile üretir ve TAMAMLANAN
 * yanıtı yazar. Durdurulan, süresi dolan ya da yarıda kesilen yanıt yazılmaz;
 * kullanıcı turu yanıtsız (yeniden denenebilir) kalır.
 *
 * Yanıtın yazımı istemcinin iptaline bağlı değildir: model yanıtı tamamladıysa
 * bağlantı o anda kesilse de yanıt kaybolmaz (yazım yine süre sınırlıdır).
 */
export async function generateAssistantAnswer(turn, { signal = null, onStatus = null, onText }) {
  const result = await getAiGateway().streamChat({
    profile: turn.profile,
    messages: turn.modelMessages,
    signal,
    onStatus,
    onText
  });
  const messageId = randomUUID();
  const persist = () => withConversationSql(turn.sicil, null, (scope) => inTransaction(scope, (executor) => appendConversationAnswer(executor, turn.sicil, {
    conversationId: turn.conversation.id,
    messageId,
    replyToMessageId: turn.userMessage.id,
    content: result.text,
    mode: turn.mode,
    finishReason: result.finishReason
  })));
  let stored;
  for (let attempt = 1; ; attempt += 1) {
    try {
      stored = await persist();
      break;
    } catch (error) {
      const transient = error?.code === AI_ERROR_CODES.AI_BUSY || error?.code === 'DATABASE_UNAVAILABLE';
      if (!transient || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  if (!stored.knownSicil) throw unknownSicil();
  if (!stored.persisted || !stored.message) {
    throw conversationNotFound('ANSWER_NOT_PERSISTED');
  }
  return {
    conversation: stored.conversation,
    answer: stored.message,
    finishReason: result.finishReason,
    firstTokenMs: result.firstTokenMs
  };
}
