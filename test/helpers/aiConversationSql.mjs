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
    ContextTrimmed: row.ContextTrimmed ?? null,
    ContextOmittedMessages: row.ContextOmittedMessages ?? null,
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

function sortCreated(rows) {
  return [...rows].sort((left, right) => (right.CreatedAt - left.CreatedAt) || compareGuid(right.ConversationId, left.ConversationId));
}

function list(db, params, sicil, known) {
  if (!known) return [[{ KnownSicil: 0 }]];
  let rows = db.aiConversations.filter((row) => row.OwnerSicil === sicil);
  const scanning = Object.hasOwn(params, 'beforeCreatedAt');
  if (scanning && params.beforeCreatedAt != null) {
    const before = new Date(params.beforeCreatedAt).getTime();
    rows = rows.filter((row) => row.CreatedAt.getTime() < before
      || (row.CreatedAt.getTime() === before && compareGuid(row.ConversationId, params.beforeConversationId) < 0));
  } else if (!scanning && params.beforeUpdatedAt != null) {
    const before = new Date(params.beforeUpdatedAt).getTime();
    rows = rows.filter((row) => row.UpdatedAt.getTime() < before
      || (row.UpdatedAt.getTime() === before && compareGuid(row.ConversationId, params.beforeConversationId) < 0));
  }
  const sorted = scanning ? sortCreated(rows) : sortRecent(rows);
  return [[{ KnownSicil: 1 }], sorted.slice(0, Number(params.limit)).map(conversationRow)];
}

function load(db, params, sicil, known) {
  db.aiConversationHooks?.beforeLoad?.(params);
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
      const removed = new Set(db.aiConversationMessages.filter((row) => sameGuid(row.ConversationId, conversation.ConversationId)).map((row) => guid(row.MessageId)));
      db.aiConversationMessages = db.aiConversationMessages.filter((row) => !sameGuid(row.ConversationId, conversation.ConversationId));
      // Kanıtlar iletiyle birlikte silinir (0018 · ON DELETE CASCADE).
      db.aiMessageEvidence = (db.aiMessageEvidence || []).filter((row) => !removed.has(guid(row.MessageId)));
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
    if (!conversation && params.conversationId == null && params.content != null && !params.readOnly) {
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
      else if (params.content == null || params.readOnly) outcome = 'TURN_NOT_FOUND';
      else if (params.expectedSequence != null && params.expectedSequence !== (lastSequence ?? 0)) outcome = 'STALE';
      else if (messages.at(-1)?.Role === 'user') outcome = 'UNANSWERED';
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
          ContextTrimmed: null,
          ContextOmittedMessages: null,
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
  if (!knownSicil(db, sicil)) return [[{ KnownSicil: 0, AnswerPersisted: 0 }]];
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
      ContextTrimmed: Boolean(params.contextTrimmed),
      ContextOmittedMessages: Math.max(0, Number(params.contextOmittedMessages) || 0),
      CreatedAt: at
    });
    conversation.MessageCount += 1;
    conversation.UpdatedAt = at;
    persisted = 1;
  }
  const written = conversation && db.aiConversationMessages.find((row) => row.Role === 'assistant' && sameGuid(row.ReplyToMessageId, params.replyToMessageId) && sameGuid(row.ConversationId, params.conversationId));
  if (written) persisted = 1;
  return [
    [{ KnownSicil: 1, AnswerPersisted: persisted }],
    conversation ? [conversationRow(conversation)] : [],
    written ? [messageRow(written)] : []
  ];
}

function missingEvidenceSchemaError() {
  const error = new Error("Invalid object name 'dbo.MR_AiMessageEvidence'.");
  error.number = 208;
  return error;
}

function evidenceConstraint(name) {
  const error = new Error(`The INSERT statement conflicted with the CHECK constraint "${name}".`);
  error.number = 547;
  return error;
}

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 0018 kısıtlarıyla kanıt satırları (bkz. MR_Upgrade_0018_Ai_Message_Evidence.sql). */
function insertEvidence(db, messageId, rows) {
  for (const row of rows) {
    if (!Number.isInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > 16) throw evidenceConstraint('CK_MR_AiMessageEvidence_Ordinal');
    if (!/^rota_/.test(String(row.toolName || ''))) throw evidenceConstraint('CK_MR_AiMessageEvidence_ToolName');
    if (!isJson(row.summaryJson) || String(row.summaryJson).length > 4000) throw evidenceConstraint('CK_MR_AiMessageEvidence_SummaryJson');
    if (!isJson(row.evidenceJson) || String(row.evidenceJson).length * 2 > 65536) throw evidenceConstraint('CK_MR_AiMessageEvidence_EvidenceJson');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(String(row.generatedAt || ''))) throw new Error('Conversion failed when converting date and/or time from character string.');
    if (db.aiMessageEvidence.some((existing) => sameGuid(existing.MessageId, messageId) && existing.Ordinal === row.ordinal)) {
      const error = new Error("Violation of PRIMARY KEY constraint 'PK_MR_AiMessageEvidence'.");
      error.number = 2627;
      throw error;
    }
    db.aiMessageEvidence.push({
      MessageId: guid(messageId),
      Ordinal: row.ordinal,
      ToolName: row.toolName,
      EvidenceType: row.evidenceType,
      Label: row.label,
      EntityType: row.entityType ?? null,
      EntityId: row.entityId ?? null,
      GeneratedAt: `${row.generatedAt}Z`,
      IsComplete: row.isComplete ? 1 : 0,
      IsTruncated: row.isTruncated ? 1 : 0,
      SummaryJson: row.summaryJson,
      EvidenceJson: row.evidenceJson
    });
  }
}

function evidenceRowsFor(db, messageIds) {
  const wanted = new Set(messageIds.map(guid));
  return (db.aiMessageEvidence || [])
    .filter((row) => wanted.has(guid(row.MessageId)))
    .map((row) => ({ MessageId: row.MessageId, Ordinal: row.Ordinal, SummaryJson: row.SummaryJson }));
}

function appendGrounded(db, params, sicil) {
  db.aiConversationHooks?.beforeAppend?.(params);
  if (db.aiEvidenceSchemaMissing) throw missingEvidenceSchemaError();
  if (!knownSicil(db, sicil)) return [[{ KnownSicil: 0, AnswerPersisted: 0, AnswerInserted: 0 }]];
  const conversation = ownedConversation(db, sicil, params.conversationId);
  const question = conversation && messagesOf(db, conversation.ConversationId)
    .find((row) => sameGuid(row.MessageId, params.replyToMessageId) && row.Role === 'user');
  const answered = db.aiConversationMessages.some((row) => sameGuid(row.ReplyToMessageId, params.replyToMessageId));
  let inserted = 0;
  if (conversation && question && !answered) {
    const messages = messagesOf(db, conversation.ConversationId);
    const at = now();
    const message = {
      MessageId: guid(params.messageId),
      ConversationId: conversation.ConversationId,
      Sequence: (messages.length ? messages[messages.length - 1].Sequence : 0) + 1,
      Role: 'assistant',
      Content: params.content,
      ClientTurnId: null,
      ReplyToMessageId: guid(params.replyToMessageId),
      Mode: params.mode ?? null,
      FinishReason: params.finishReason ?? null,
      ContextTrimmed: Boolean(params.contextTrimmed),
      ContextOmittedMessages: Math.max(0, Number(params.contextOmittedMessages) || 0),
      CreatedAt: at
    };
    // Tek toplu iş: kanıt kısıtı ihlal edilirse yanıt da yazılmaz (XACT_ABORT).
    const evidenceRows = JSON.parse(params.evidence || '[]');
    const snapshot = db.aiMessageEvidence.length;
    insertMessage(db, message);
    try {
      insertEvidence(db, message.MessageId, evidenceRows.slice(0, 16));
    } catch (error) {
      db.aiConversationMessages = db.aiConversationMessages.filter((row) => row !== message);
      db.aiMessageEvidence.length = snapshot;
      throw error;
    }
    conversation.MessageCount += 1;
    conversation.UpdatedAt = at;
    inserted = 1;
  }
  const written = conversation && db.aiConversationMessages.find((row) => row.Role === 'assistant' && sameGuid(row.ReplyToMessageId, params.replyToMessageId) && sameGuid(row.ConversationId, params.conversationId));
  return [
    [{ KnownSicil: 1, AnswerPersisted: written ? 1 : 0, AnswerInserted: inserted }],
    conversation ? [conversationRow(conversation)] : [],
    written ? [messageRow(written)] : [],
    written ? evidenceRowsFor(db, [written.MessageId]).sort((left, right) => left.Ordinal - right.Ordinal) : []
  ];
}

function evidence(db, params, sicil, known) {
  const ready = !db.aiEvidenceSchemaMissing;
  if (!known || !ready) return [[{ KnownSicil: known ? 1 : 0, EvidenceReady: ready ? 1 : 0 }]];
  const conversation = ownedConversation(db, sicil, params.conversationId);
  const messages = conversation ? messagesOf(db, conversation.ConversationId) : [];
  const ids = messages.filter((row) => !params.messageId || sameGuid(row.MessageId, params.messageId)).map((row) => row.MessageId);
  const order = new Map(messages.map((row) => [guid(row.MessageId), row.Sequence]));
  const rows = evidenceRowsFor(db, ids)
    .sort((left, right) => order.get(guid(left.MessageId)) - order.get(guid(right.MessageId)) || left.Ordinal - right.Ordinal)
    .slice(0, Number(params.maxEvidence));
  return [[{ KnownSicil: 1, EvidenceReady: 1 }], rows];
}

export function runAiConversationQuery(db, sqlText, params) {
  if (!sqlText.includes('MR_AiConversation')) return null;
  if (db.aiConversationSchemaMissing) throw missingSchemaError();
  logStatement(db, sqlText, params);
  const sicil = Number(params.sicil);
  const known = knownSicil(db, sicil);
  if (sqlText.includes('AS PrepareOutcome')) return prepare(db, params, sicil, known);
  if (sqlText.includes('AS AnswerInserted')) return appendGrounded(db, params, sicil);
  if (sqlText.includes('AS AnswerPersisted')) return append(db, params, sicil);
  if (sqlText.includes('AS EvidenceReady')) return evidence(db, params, sicil, known);
  if (sqlText.includes('DELETE c FROM dbo.MR_AiConversations c')) return remove(db, params, sicil, known);
  if (sqlText.includes('TOP (@maxMessages)')) return load(db, params, sicil, known);
  if (sqlText.includes('ORDER BY c.CreatedAt DESC, c.ConversationId DESC')) return list(db, params, sicil, known);
  if (sqlText.includes('ORDER BY c.UpdatedAt DESC, c.ConversationId DESC')) return list(db, params, sicil, known);
  throw new Error(`Fake SQL Server: desteklenmeyen konuşma deyimi: ${sqlText.trim().slice(0, 120)}`);
}
