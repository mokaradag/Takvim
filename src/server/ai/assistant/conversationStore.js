import 'server-only';
import { sql } from '../../db/pool.js';
import {
  AI_CONVERSATION_APPEND_ANSWER_SQL,
  AI_CONVERSATION_DELETE_SQL,
  AI_CONVERSATION_LIST_BEFORE_SQL,
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

const MISSING_TABLE_NUMBERS = new Set([207, 208]);
const CONVERSATION_TABLES = ['MR_AiConversations', 'MR_AiConversationMessages'];

/** 0017 uygulanmamış kurulumda konuşma tabloları yoktur; uygulamanın geri kalanı çalışır. */
export function isMissingConversationSchema(error) {
  const candidates = [error, error?.originalError, error?.originalError?.info, error?.cause, ...(error?.precedingErrors || [])];
  return candidates.some((entry) => entry
    && (MISSING_TABLE_NUMBERS.has(Number(entry.number)) || /Invalid object name/i.test(String(entry.message || '')))
    && CONVERSATION_TABLES.some((table) => String(entry.message || '').includes(table)));
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
export async function listConversations(executor, sicil, { limit, before = null }) {
  const request = sicilRequest(executor, sicil);
  request.input('limit', sql.Int, limit + 1);
  if (before) {
    request.input('beforeUpdatedAt', sql.DateTime2(3), new Date(before.updatedAt));
    request.input('beforeConversationId', sql.UniqueIdentifier, before.id);
  }
  const [known, rows = []] = recordsetsOf(await request.query(before ? AI_CONVERSATION_LIST_BEFORE_SQL : AI_CONVERSATION_LIST_SQL));
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
  conversationId, newConversationId, userMessageId, turnId, content, title, maxMessages, historyLimit, readOnly = false
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
  conversationId, messageId, replyToMessageId, content, mode, finishReason
}) {
  const request = sicilRequest(executor, sicil);
  request.input('conversationId', sql.UniqueIdentifier, conversationId);
  request.input('messageId', sql.UniqueIdentifier, messageId);
  request.input('replyToMessageId', sql.UniqueIdentifier, replyToMessageId);
  request.input('content', sql.NVarChar(sql.MAX), content);
  request.input('mode', sql.VarChar(10), mode);
  request.input('finishReason', sql.VarChar(40), finishReason);
  const [[state] = [], conversations = [], messages = []] = recordsetsOf(await request.query(AI_CONVERSATION_APPEND_ANSWER_SQL));
  return {
    knownSicil: Boolean(state?.KnownSicil),
    persisted: Boolean(state?.AnswerPersisted),
    conversation: conversationRow(conversations[0]),
    message: messageRow(messages[0])
  };
}
