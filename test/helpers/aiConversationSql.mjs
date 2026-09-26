/**
 * `MR_AiConversations` / `MR_AiConversationMessages` (0017) için bellek içi
 * SQL ikizi.
 *
 * Gerçek sorgu metinleri (`src/server/ai/assistant/conversationQueries.js`)
 * ayırt edici sonuç adlarıyla tanınır ve SQL Server'daki anlamlarıyla
 * uygulanır: her erişim `@sicil` sahipliğiyle sınırlıdır, rehberde olmayan
 * Sicil hiçbir satıra dokunamaz, tekillik kısıtları (tur, tek yanıt, ilk tur)
 * ihlal edilirse 2601 hatası verilir ve silme iletileri de siler (CASCADE).
 * GUID'ler SQL Server gibi BÜYÜK harfle döner. Zaman damgaları tekdüze artar:
 * aynı milisaniyede açılan konuşmaların sırası testte belirsiz kalmaz.
 */

let clock = 0;

function now() {
  clock = Math.max(Date.now(), clock + 1);
  return new Date(clock);
}

function guid(value) {
  return value == null ? null : String(value).toUpperCase();
}

function sameGuid(left, right) {
  if (left == null || right == null) return false;
  return String(left).toUpperCase() === String(right).toUpperCase();
}

/** SQL Server `uniqueidentifier` sıralamasına benzer biçimde son gruptan başa karşılaştırır. */
function compareGuid(left, right) {
  const a = String(left).toUpperCase().split('-').reverse().join('');
  const b = String(right).toUpperCase().split('-').reverse().join('');
  return a < b ? -1 : a > b ? 1 : 0;
}

function duplicateKey(index) {
  const error = new Error(`Cannot insert duplicate key row in object 'dbo.MR_AiConversationMessages' with unique index '${index}'.`);
  error.number = 2601;
  return error;
}

function missingSchemaError() {
  const error = new Error("Invalid object name 'dbo.MR_AiConversations'.");
  error.number = 208;
  return error;
}

function logStatement(db, sqlText, params) {
  db.aiConversationLog ||= { statements: [] };
  db.aiConversationLog.statements.push({ sql: sqlText, params: { ...params } });
}

const knownSicil = (db, sicil) => db.people.some((person) => Number(person.Sicil) === sicil);

function conversationRow(row) {
  return row ? {
    ConversationId: row.ConversationId,
    Title: row.Title,
    CreatedAt: row.CreatedAt,
    UpdatedAt: row.UpdatedAt,
    MessageCount: row.MessageCount
  } : null;
}

function messageRow(row) {
  return {
    MessageId: row.MessageId,
    Sequence: row.Sequence,
    Role: row.Role,
    Content: row.Content,
    ClientTurnId: row.ClientTurnId,
    ReplyToMessageId: row.ReplyToMessageId,
    Mode: row.Mode,
    FinishReason: row.FinishReason,
    CreatedAt: row.CreatedAt
  };
}

function ownedConversation(db, sicil, conversationId) {
  return db.aiConversations.find((row) => sameGuid(row.ConversationId, conversationId) && row.OwnerSicil === sicil) || null;
}

function messagesOf(db, conversationId) {
  return db.aiConversationMessages
    .filter((row) => sameGuid(row.ConversationId, conversationId))
    .sort((left, right) => left.Sequence - right.Sequence);
}

function insertMessage(db, message) {
  const siblings = messagesOf(db, message.ConversationId);
  if (siblings.some((row) => row.Sequence === message.Sequence)) throw duplicateKey('UX_MR_AiConversationMessages_Sequence');
  if (message.ClientTurnId && siblings.some((row) => sameGuid(row.ClientTurnId, message.ClientTurnId))) {
    throw duplicateKey('UX_MR_AiConversationMessages_Turn');
  }
  if (message.ReplyToMessageId && db.aiConversationMessages.some((row) => sameGuid(row.ReplyToMessageId, message.ReplyToMessageId))) {
    throw duplicateKey('UX_MR_AiConversationMessages_Reply');
  }
  db.aiConversationMessages.push(message);
}

function sortRecent(rows) {
  return [...rows].sort((left, right) => (right.UpdatedAt - left.UpdatedAt) || compareGuid(right.ConversationId, left.ConversationId));
}

function list(db, params, sicil, known) {
  if (!known) return [[{ KnownSicil: 0 }]];
  let rows = db.aiConversations.filter((row) => row.OwnerSicil === sicil);
  if (params.beforeUpdatedAt != null) {
    const before = new Date(params.beforeUpdatedAt).getTime();
    rows = rows.filter((row) => row.UpdatedAt.getTime() < before
      || (row.UpdatedAt.getTime() === before && compareGuid(row.ConversationId, params.beforeConversationId) < 0));
  }
  return [[{ KnownSicil: 1 }], sortRecent(rows).slice(0, Number(params.limit)).map(conversationRow)];
}

function load(db, params, sicil, known) {
  if (!known) return [[{ KnownSicil: 0 }]];
  const conversation = ownedConversation(db, sicil, params.conversationId);
  const messages = conversation ? messagesOf(db, conversation.ConversationId).reverse().slice(0, Number(params.maxMessages)) : [];
  return [[{ KnownSicil: 1 }], conversation ? [conversationRow(conversation)] : [], messages.map(messageRow)];
}

function remove(db, params, sicil, known) {
  let deleted = 0;
  if (known) {
    const conversation = ownedConversation(db, sicil, params.conversationId);
    if (conversation) {
      db.aiConversationHooks?.beforeDelete?.(conversation);
      db.aiConversations = db.aiConversations.filter((row) => row !== conversation);
      db.aiConversationMessages = db.aiConversationMessages.filter((row) => !sameGuid(row.ConversationId, conversation.ConversationId));
      deleted = 1;
    }
  }
  return [[{ KnownSicil: known ? 1 : 0, Deleted: deleted }]];
}

function prepare(db, params, sicil, known) {
  let outcome = 'UNAUTHORIZED';
  let conversation = null;
  let turn = null;
  let lastSequence = null;
  if (known) {
    outcome = 'NOT_FOUND';
    conversation = params.conversationId == null
      ? db.aiConversations.find((row) => row.OwnerSicil === sicil && sameGuid(row.OriginTurnId, params.turnId)) || null
      : ownedConversation(db, sicil, params.conversationId);
    if (!conversation && params.conversationId == null && params.content != null) {
      const at = now();
      conversation = {
        ConversationId: guid(params.newConversationId),
        OwnerSicil: sicil,
        Title: params.title,
        OriginTurnId: guid(params.turnId),
        MessageCount: 0,
        CreatedAt: at,
        UpdatedAt: at
      };
      db.aiConversations.push(conversation);
    }
    if (conversation) {
      const messages = messagesOf(db, conversation.ConversationId);
      turn = messages.find((row) => sameGuid(row.ClientTurnId, params.turnId)) || null;
      lastSequence = messages.length ? messages[messages.length - 1].Sequence : null;
      if (turn) outcome = 'EXISTING';
      else if (params.content == null) outcome = 'TURN_NOT_FOUND';
      else if (conversation.MessageCount > Number(params.maxMessages) - 2) outcome = 'FULL';
      else {
        const at = now();
        turn = {
          MessageId: guid(params.userMessageId),
          ConversationId: conversation.ConversationId,
          Sequence: (lastSequence ?? 0) + 1,
          Role: 'user',
          Content: params.content,
          ClientTurnId: guid(params.turnId),
          ReplyToMessageId: null,
          Mode: null,
          FinishReason: null,
          CreatedAt: at
        };
        insertMessage(db, turn);
        conversation.MessageCount += 1;
        conversation.UpdatedAt = at;
        lastSequence = turn.Sequence;
        outcome = 'CREATED';
      }
    }
  }
  db.aiConversationHooks?.afterPrepare?.({ outcome, conversation, turn });
  const history = conversation && turn
    ? messagesOf(db, conversation.ConversationId).filter((row) => row.Sequence < turn.Sequence).reverse().slice(0, Number(params.historyLimit))
    : [];
  const turnRows = conversation && turn
    ? messagesOf(db, conversation.ConversationId).filter((row) => row === turn || sameGuid(row.ReplyToMessageId, turn.MessageId))
    : [];
  return [
    [{
      KnownSicil: known ? 1 : 0,
      PrepareOutcome: outcome,
      ConversationId: conversation?.ConversationId ?? null,
      TurnMessageId: turn?.MessageId ?? null,
      TurnSequence: turn?.Sequence ?? null,
      LastSequence: lastSequence,
      TurnContent: turn?.Content ?? null
    }],
    conversation ? [conversationRow(conversation)] : [],
    history.map(messageRow),
    turnRows.map(messageRow)
  ];
}

function append(db, params, sicil) {
  db.aiConversationHooks?.beforeAppend?.(params);
  const conversation = ownedConversation(db, sicil, params.conversationId);
  const question = conversation && messagesOf(db, conversation.ConversationId)
    .find((row) => sameGuid(row.MessageId, params.replyToMessageId) && row.Role === 'user');
  const answered = db.aiConversationMessages.some((row) => sameGuid(row.ReplyToMessageId, params.replyToMessageId));
  let persisted = 0;
  if (conversation && question && !answered) {
    const messages = messagesOf(db, conversation.ConversationId);
    const at = now();
    insertMessage(db, {
      MessageId: guid(params.messageId),
      ConversationId: conversation.ConversationId,
      Sequence: (messages.length ? messages[messages.length - 1].Sequence : 0) + 1,
      Role: 'assistant',
      Content: params.content,
      ClientTurnId: null,
      ReplyToMessageId: guid(params.replyToMessageId),
      Mode: params.mode ?? null,
      FinishReason: params.finishReason ?? null,
      CreatedAt: at
    });
    conversation.MessageCount += 1;
    conversation.UpdatedAt = at;
    persisted = 1;
  }
  const written = persisted ? db.aiConversationMessages.find((row) => sameGuid(row.MessageId, params.messageId)) : null;
  return [
    [{ AnswerPersisted: persisted }],
    conversation ? [conversationRow(conversation)] : [],
    written ? [messageRow(written)] : []
  ];
}

export function runAiConversationQuery(db, sqlText, params) {
  if (!sqlText.includes('MR_AiConversation')) return null;
  if (db.aiConversationSchemaMissing) throw missingSchemaError();
  logStatement(db, sqlText, params);
  const sicil = Number(params.sicil);
  const known = knownSicil(db, sicil);
  if (sqlText.includes('AS PrepareOutcome')) return prepare(db, params, sicil, known);
  if (sqlText.includes('AS AnswerPersisted')) return append(db, params, sicil);
  if (sqlText.includes('DELETE c FROM dbo.MR_AiConversations c')) return remove(db, params, sicil, known);
  if (sqlText.includes('TOP (@maxMessages)')) return load(db, params, sicil, known);
  if (sqlText.includes('ORDER BY c.UpdatedAt DESC, c.ConversationId DESC')) return list(db, params, sicil, known);
  throw new Error(`Fake SQL Server: desteklenmeyen konuşma deyimi: ${sqlText.trim().slice(0, 120)}`);
}
