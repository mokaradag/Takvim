import 'server-only';
import { sql } from '../../db/pool.js';
import { normalizeEvidenceSummary } from '../../../domain/ai/evidenceContract.js';
import {
  AI_CONVERSATION_APPEND_ANSWER_SQL,
  AI_CONVERSATION_APPEND_GROUNDED_ANSWER_SQL,
  AI_CONVERSATION_DELETE_SQL,
  AI_CONVERSATION_EVIDENCE_SQL,
  AI_CONVERSATION_LIST_BEFORE_SQL,
  AI_CONVERSATION_SCAN_SQL,
  AI_CONVERSATION_LIST_SQL,
  AI_CONVERSATION_LOAD_SQL,
  AI_CONVERSATION_PREPARE_TURN_SQL
} from './conversationQueries.js';

/**
 * Rota AI konuşma geçmişinin kalıcılığı (0017).
 *
 * Her sorgu yalnızca çağıranın verdiği güvenilir `@sicil` ile çalışır ve SABİT
 * metinlerden (`conversationQueries.js`) gelir. Kimlikler SQL Server'dan büyük
 * harfle döner; uygulama içinde küçük harfle karşılaştırılır.
 */

const MISSING_TABLE_NUMBER = 208;
const MISSING_COLUMN_NUMBER = 207;
const CONVERSATION_TABLES = ['MR_AiConversations', 'MR_AiConversationMessages'];
/** 0017 tablolarının sütunları; SQL Server "Invalid column name" iletisinde tablo adını vermez. */
const CONVERSATION_COLUMN_NAMES = new Set([
  'ConversationId', 'OwnerSicil', 'Title', 'OriginTurnId', 'CreatedAt', 'UpdatedAt', 'MessageCount',
  'MessageId', 'Sequence', 'Role', 'Content', 'ClientTurnId', 'ReplyToMessageId', 'Mode', 'FinishReason', 'ContextTrimmed', 'ContextOmittedMessages'
]);

function missingConversationTable(entry) {
  return (Number(entry.number) === MISSING_TABLE_NUMBER || /Invalid object name/i.test(String(entry.message || '')))
    && CONVERSATION_TABLES.some((table) => String(entry.message || '').includes(table));
}

function missingConversationColumn(entry) {
  if (Number(entry.number) !== MISSING_COLUMN_NUMBER && !/Invalid column name/i.test(String(entry.message || ''))) return false;
  const match = /['"‘’]([^'"‘’]+)['"‘’]/.exec(String(entry.message || ''));
  return match != null && CONVERSATION_COLUMN_NAMES.has(match[1]);
}

/**
 * 0017 uygulanmamış (ya da yarım uygulanmış) kurulumda konuşma tabloları ya da
 * sütunları yoktur; uygulamanın geri kalanı çalışır. Yalnızca konuşma
 * sorgularının hatası için çağrılır.
 */
export function isMissingConversationSchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry && (missingConversationTable(entry) || missingConversationColumn(entry)));
}

const SCHEMA_STATE_KEY = Symbol.for('mergen-rota.ai-conversation-schema');

export function conversationSchemaState() {
  return { ...(globalThis[SCHEMA_STATE_KEY] || { ready: null, observedAt: null }) };
}

export function noteConversationSchema(ready) {
  globalThis[SCHEMA_STATE_KEY] = { ready, observedAt: new Date().toISOString() };
}

export function resetConversationSchemaForTests() {
  delete globalThis[SCHEMA_STATE_KEY];
  delete globalThis[EVIDENCE_SCHEMA_STATE_KEY];
}

/* ── Kanıt kaydı (0018) ─────────────────────────────────────── */

const EVIDENCE_SCHEMA_STATE_KEY = Symbol.for('mergen-rota.ai-evidence-schema');
const EVIDENCE_TABLE = 'MR_AiMessageEvidence';

/** 0018'in son gözlemi: `ready` null ise henüz denetlenmedi. */
export function evidenceSchemaState() {
  return { ...(globalThis[EVIDENCE_SCHEMA_STATE_KEY] || { ready: null, observedAt: null }) };
}

export function noteEvidenceSchema(ready, at = new Date()) {
  globalThis[EVIDENCE_SCHEMA_STATE_KEY] = { ready: Boolean(ready), observedAt: at.toISOString() };
}

/** Kanıt tablosunun yokluğu (0018 geri alınmış ya da yarım uygulanmış kurulum). */
export function isMissingEvidenceSchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry && (Number(entry.number) === MISSING_TABLE_NUMBER || /Invalid object name/i.test(String(entry.message || '')))
    && String(entry.message || '').includes(EVIDENCE_TABLE));
}

function evidenceByMessage(rows = []) {
  const byMessage = new Map();
  for (const row of rows) {
    let summary = null;
    try {
      summary = normalizeEvidenceSummary(JSON.parse(String(row.SummaryJson || 'null')));
    } catch {
      summary = null;
    }
    if (!summary) continue;
    const messageId = idOrNull(row.MessageId);
    if (!byMessage.has(messageId)) byMessage.set(messageId, []);
    byMessage.get(messageId).push(summary);
  }
  return byMessage;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function idOrNull(value) {
  return value == null ? null : String(value).toLowerCase();
}

function conversationRow(row) {
  if (!row) return null;
  return {
    id: idOrNull(row.ConversationId),
    title: String(row.Title || ''),
    createdAt: isoOrNull(row.CreatedAt),
    updatedAt: isoOrNull(row.UpdatedAt),
    messageCount: Number(row.MessageCount) || 0
  };
}

function messageRow(row) {
  if (!row) return null;
  return {
    id: idOrNull(row.MessageId),
    sequence: Number(row.Sequence),
    role: row.Role === 'assistant' ? 'assistant' : 'user',
    content: String(row.Content ?? ''),
    turnId: idOrNull(row.ClientTurnId),
    replyToId: idOrNull(row.ReplyToMessageId),
    mode: row.Mode || null,
    finishReason: row.FinishReason || null,
    contextTrimmed: row.ContextTrimmed == null ? null : Boolean(row.ContextTrimmed),
    contextOmittedMessages: row.ContextOmittedMessages == null ? null : Number(row.ContextOmittedMessages),
    createdAt: isoOrNull(row.CreatedAt)
  };
}

function sicilRequest(executor, sicil) {
  const request = executor.request();
  request.input('sicil', sql.Int, sicil);
  return request;
}

const recordsetsOf = (result) => result.recordsets || [];
const knownSicilOf = (recordset) => Boolean(recordset?.[0]?.KnownSicil);

/** Son etkinliğe göre sıralı, SINIRLI konuşma listesi (`limit` + 1 satır okunur). */
export async function listConversations(executor, sicil, { limit, before = null, scan = null }) {
  const request = sicilRequest(executor, sicil);
  request.input('limit', sql.Int, limit + 1);
  if (scan) {
    request.input('beforeCreatedAt', sql.DateTime2(3), scan.createdAt ? new Date(scan.createdAt) : null);
    request.input('beforeConversationId', sql.UniqueIdentifier, scan.id || null);
  } else if (before) {
    request.input('beforeUpdatedAt', sql.DateTime2(3), new Date(before.updatedAt));
    request.input('beforeConversationId', sql.UniqueIdentifier, before.id);
  }
  const result = scan
    ? await request.query(AI_CONVERSATION_SCAN_SQL)
    : await request.query(before ? AI_CONVERSATION_LIST_BEFORE_SQL : AI_CONVERSATION_LIST_SQL);
  const [known, rows = []] = recordsetsOf(result);
  const conversations = rows.map(conversationRow);
  return {
    knownSicil: knownSicilOf(known),
    conversations: conversations.slice(0, limit),
    hasMore: conversations.length > limit
  };
}

/** Konuşma ve iletileri sıra numarasına göre; başka Sicil'in konuşması `conversation: null` döner. */
export async function loadConversation(executor, sicil, { conversationId, maxMessages }) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  request.input('maxMessages', sql.Int, maxMessages);
  const [known, conversations = [], messages = []] = recordsetsOf(await request.query(AI_CONVERSATION_LOAD_SQL));
  const conversation = conversationRow(conversations[0]);
  return {
    knownSicil: knownSicilOf(known),
    conversation,
    messages: conversation ? messages.map(messageRow).sort((left, right) => left.sequence - right.sequence) : []
  };
}

export async function deleteConversation(executor, sicil, { conversationId }) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  const [[row] = []] = recordsetsOf(await request.query(AI_CONVERSATION_DELETE_SQL));
  return { knownSicil: Boolean(row?.KnownSicil), deleted: Number(row?.Deleted || 0) > 0 };
}

/**
 * Kullanıcı turunu hazırlar; bkz. `AI_CONVERSATION_PREPARE_TURN_SQL`.
 * `content: null` yeniden denemedir (yeni ileti yazılmaz).
 */
export async function prepareConversationTurn(executor, sicil, {
  conversationId, newConversationId, userMessageId, turnId, content, title, maxMessages, historyLimit, expectedSequence = null, readOnly = false
}) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  request.input('newConversationId', sql.UniqueIdentifier, newConversationId);
  request.input('userMessageId', sql.UniqueIdentifier, userMessageId);
  request.input('turnId', sql.UniqueIdentifier, turnId);
  request.input('content', sql.NVarChar(sql.MAX), content);
  request.input('title', sql.NVarChar(120), title);
  request.input('maxMessages', sql.Int, maxMessages);
  request.input('historyLimit', sql.Int, historyLimit);
  request.input('readOnly', sql.Bit, readOnly);
  request.input('expectedSequence', sql.Int, expectedSequence);
  const [[state] = [], conversations = [], history = [], turnRows = []] = recordsetsOf(await request.query(AI_CONVERSATION_PREPARE_TURN_SQL));
  const turnMessages = turnRows.map(messageRow);
  return {
    knownSicil: Boolean(state?.KnownSicil),
    outcome: String(state?.PrepareOutcome || 'NOT_FOUND'),
    conversation: conversationRow(conversations[0]),
    turn: state?.TurnMessageId ? {
      message: turnMessages.find((message) => message.role === 'user') || null,
      sequence: Number(state.TurnSequence),
      content: String(state.TurnContent ?? ''),
      latest: Number(state.TurnSequence) === Number(state.LastSequence)
    } : null,
    history: history.map(messageRow).sort((left, right) => left.sequence - right.sequence),
    answer: turnMessages.find((message) => message.role === 'assistant') || null
  };
}

/** Tamamlanmış yanıtı yazar; `persisted: false` yanıtın yazılmadığını söyler (konuşma silinmiş olabilir). */
export async function appendConversationAnswer(executor, sicil, {
  conversationId, messageId, replyToMessageId, content, mode, finishReason, contextTrimmed, contextOmittedMessages
}) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  request.input('messageId', sql.UniqueIdentifier, messageId);
  request.input('replyToMessageId', sql.UniqueIdentifier, replyToMessageId);
  request.input('content', sql.NVarChar(sql.MAX), content);
  request.input('mode', sql.VarChar(10), mode);
  request.input('finishReason', sql.VarChar(40), finishReason);
  request.input('contextTrimmed', sql.Bit, Boolean(contextTrimmed));
  request.input('contextOmittedMessages', sql.Int, Math.max(0, Number(contextOmittedMessages) || 0));
  const [[state] = [], conversations = [], messages = []] = recordsetsOf(await request.query(AI_CONVERSATION_APPEND_ANSWER_SQL));
  return {
    knownSicil: Boolean(state?.KnownSicil),
    persisted: Boolean(state?.AnswerPersisted),
    conversation: conversationRow(conversations[0]),
    message: messageRow(messages[0])
  };
}

/**
 * Konuşmadaki yanıtların kanıt özetleri. 0018 yoksa `ready: false` ve boş
 * eşleme döner; kanıt metni (EvidenceJson) okunmaz, yalnızca güvenli özet.
 */
export async function loadConversationEvidence(executor, sicil, { conversationId, messageId = null, maxEvidence }) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  request.input('messageId', sql.UniqueIdentifier, messageId);
  request.input('maxEvidence', sql.Int, maxEvidence);
  let result;
  try {
    result = await request.query(AI_CONVERSATION_EVIDENCE_SQL);
  } catch (error) {
    if (!isMissingEvidenceSchema(error)) throw error;
    return { knownSicil: true, ready: false, byMessage: new Map() };
  }
  const [[state] = [], rows = []] = recordsetsOf(result);
  return {
    knownSicil: Boolean(state?.KnownSicil),
    ready: Boolean(state?.EvidenceReady),
    byMessage: evidenceByMessage(rows)
  };
}

/**
 * Kanıta dayalı yanıtı ve atıf yaptığı kanıtları tek işlemde yazar. Kanıtlar
 * yalnızca yanıt bu çağrıda eklendiyse yazılır; `evidence` yazılan (ya da
 * tura önceden yazılmış yanıtın) kanıt özetleridir.
 */
export async function appendGroundedConversationAnswer(executor, sicil, {
  conversationId, messageId, replyToMessageId, content, mode, finishReason, contextTrimmed, contextOmittedMessages, evidence = []
}) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  request.input('messageId', sql.UniqueIdentifier, messageId);
  request.input('replyToMessageId', sql.UniqueIdentifier, replyToMessageId);
  request.input('content', sql.NVarChar(sql.MAX), content);
  request.input('mode', sql.VarChar(10), mode);
  request.input('finishReason', sql.VarChar(40), finishReason);
  request.input('contextTrimmed', sql.Bit, Boolean(contextTrimmed));
  request.input('contextOmittedMessages', sql.Int, Math.max(0, Number(contextOmittedMessages) || 0));
  request.input('evidence', sql.NVarChar(sql.MAX), JSON.stringify(evidence.map((row) => ({
    ...row,
    // datetime2 dönüşümü saat dilimi işaretsiz ISO 8601 bekler; değer zaten UTC'dir.
    generatedAt: String(row.generatedAt).replace(/Z$/, '')
  }))));
  const [[state] = [], conversations = [], messages = [], evidenceRows = []] = recordsetsOf(
    await request.query(AI_CONVERSATION_APPEND_GROUNDED_ANSWER_SQL)
  );
  const message = messageRow(messages[0]);
  return {
    knownSicil: Boolean(state?.KnownSicil),
    persisted: Boolean(state?.AnswerPersisted),
    inserted: Boolean(state?.AnswerInserted),
    conversation: conversationRow(conversations[0]),
    message,
    evidence: message ? (evidenceByMessage(evidenceRows).get(message.id) || []) : []
  };
}
