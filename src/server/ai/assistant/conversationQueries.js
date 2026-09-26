import 'server-only';

/**
 * Rota AI konuşma geçmişinin SQL metinleri (0017).
 *
 * Metinler derleme anında sabittir; çalışma anında hiçbir SQL birleştirilmez.
 * Her toplu iş YALNIZCA güvenilir oturumdan gelen `@sicil` ile çalışır:
 * konuşma satırına her erişim `OwnerSicil = @sicil` koşulu taşır ve ileti
 * satırlarına yalnızca bu koşulla doğrulanmış konuşma üzerinden ulaşılır. Başka
 * bir Sicil'in konuşması, var olmayan bir konuşmayla AYNI sonucu verir: ne
 * içeriği ne de varlığı öğrenilebilir.
 *
 * Rehber üyeliği aynı gidiş-dönüşte denetlenir; rehberde olmayan Sicil için
 * hiçbir konuşma satırı okunmaz, yazılmaz ya da silinmez.
 */

const KNOWN_SICIL = `
  DECLARE @knownSicil bit = CASE WHEN EXISTS (
    SELECT 1 FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil
  ) THEN 1 ELSE 0 END;`;

const CONVERSATION_COLUMNS = 'c.ConversationId, c.Title, c.CreatedAt, c.UpdatedAt, c.MessageCount';
const MESSAGE_COLUMNS = 'm.MessageId, m.Sequence, m.Role, m.Content, m.ClientTurnId, m.ReplyToMessageId, m.Mode, m.FinishReason, m.CreatedAt';

/** Son etkinliğe göre sıralı ilk sayfa (`@limit` = sayfa + 1; fazlası "daha var" demektir). */
export const AI_CONVERSATION_LIST_SQL = `${KNOWN_SICIL}
  SELECT @knownSicil AS KnownSicil;
  IF @knownSicil = 1
    SELECT TOP (@limit) ${CONVERSATION_COLUMNS}
    FROM dbo.MR_AiConversations c
    WHERE c.OwnerSicil = @sicil
    ORDER BY c.UpdatedAt DESC, c.ConversationId DESC;`;

/** Anahtar kümesi sayfalaması: imleçteki (UpdatedAt, ConversationId) çiftinden eski konuşmalar. */
export const AI_CONVERSATION_LIST_BEFORE_SQL = `${KNOWN_SICIL}
  SELECT @knownSicil AS KnownSicil;
  IF @knownSicil = 1
    SELECT TOP (@limit) ${CONVERSATION_COLUMNS}
    FROM dbo.MR_AiConversations c
    WHERE c.OwnerSicil = @sicil
      AND (c.UpdatedAt < @beforeUpdatedAt
        OR (c.UpdatedAt = @beforeUpdatedAt AND c.ConversationId < @beforeConversationId))
    ORDER BY c.UpdatedAt DESC, c.ConversationId DESC;`;

/** Tek konuşma ve iletileri (konuşma başına ileti sayısı sınırlıdır; `TOP` ayrıca korur). */
export const AI_CONVERSATION_LOAD_SQL = `${KNOWN_SICIL}
  SELECT @knownSicil AS KnownSicil;
  IF @knownSicil = 1
  BEGIN
    SELECT ${CONVERSATION_COLUMNS}
    FROM dbo.MR_AiConversations c
    WHERE c.ConversationId = @conversationId AND c.OwnerSicil = @sicil;
    SELECT TOP (@maxMessages) ${MESSAGE_COLUMNS}
    FROM dbo.MR_AiConversationMessages m
    JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
    WHERE m.ConversationId = @conversationId AND c.OwnerSicil = @sicil
    ORDER BY m.Sequence DESC;
  END`;

/**
 * Konuşmayı iletileriyle birlikte siler (yabancı anahtar ON DELETE CASCADE).
 * Başka Sicil'in ya da var olmayan konuşma aynı sonucu verir: `Deleted = 0`.
 */
export const AI_CONVERSATION_DELETE_SQL = `${KNOWN_SICIL}
  DECLARE @deleted int = 0;
  IF @knownSicil = 1
  BEGIN
    DELETE c FROM dbo.MR_AiConversations c
    WHERE c.ConversationId = @conversationId AND c.OwnerSicil = @sicil;
    SET @deleted = @@ROWCOUNT;
  END
  SELECT @knownSicil AS KnownSicil, @deleted AS Deleted;`;

/**
 * Kullanıcı turunu hazırlar (kısa bir SQL işleminin içinde; model çağrısından
 * ÖNCE biter).
 *
 * - `@conversationId` boşsa yeni konuşma açılır; aynı turun yeniden gönderimi
 *   `(OwnerSicil, OriginTurnId)` ile önceki konuşmayı bulur, ikincisini açmaz.
 * - Aynı `@turnId` ikinci kullanıcı iletisi üretmez (`EXISTING`); `@content`
 *   boşsa (yeniden deneme) yalnızca var olan tur kullanılabilir.
 * - Konuşma ileti sınırına yaklaştıysa (kullanıcı + yanıt için yer yoksa) `FULL`.
 * - Tur ve son ileti sırası, modelin bağlamı için tur ÖNCESİ son iletiler, turun
 *   kendisi ve var olan yanıtı (yeniden oynatma için) aynı gidiş-dönüşte döner.
 *
 * Konuşma satırı `UPDLOCK, HOLDLOCK` ile kilitlenir: aynı konuşmadaki eşzamanlı
 * turlar sıra numarasında çakışmaz, aynı ilk turun çift gönderimi iki konuşma
 * açmaz.
 */
export const AI_CONVERSATION_PREPARE_TURN_SQL = `${KNOWN_SICIL}
  DECLARE @conversation uniqueidentifier = NULL;
  DECLARE @outcome varchar(20) = 'UNAUTHORIZED';
  DECLARE @turnMessageId uniqueidentifier = NULL;
  DECLARE @turnSequence int = NULL;
  DECLARE @turnContent nvarchar(max) = NULL;
  DECLARE @lastSequence int = NULL;
  IF @knownSicil = 1
  BEGIN
    SET @outcome = 'NOT_FOUND';
    IF @conversationId IS NULL
      SELECT @conversation = c.ConversationId
      FROM dbo.MR_AiConversations c WITH (UPDLOCK, HOLDLOCK)
      WHERE c.OwnerSicil = @sicil AND c.OriginTurnId = @turnId;
    ELSE
      SELECT @conversation = c.ConversationId
      FROM dbo.MR_AiConversations c WITH (UPDLOCK, HOLDLOCK)
      WHERE c.ConversationId = @conversationId AND c.OwnerSicil = @sicil;

    IF @conversation IS NULL AND @conversationId IS NULL AND @content IS NOT NULL AND @readOnly = 0
    BEGIN
      INSERT dbo.MR_AiConversations(ConversationId, OwnerSicil, Title, OriginTurnId)
      VALUES (@newConversationId, @sicil, @title, @turnId);
      SET @conversation = @newConversationId;
    END

    IF @conversation IS NOT NULL
    BEGIN
      SELECT @turnMessageId = m.MessageId, @turnSequence = m.Sequence, @turnContent = m.Content
      FROM dbo.MR_AiConversationMessages m
      JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
      WHERE m.ConversationId = @conversation AND c.OwnerSicil = @sicil AND m.ClientTurnId = @turnId;
      SELECT @lastSequence = MAX(m.Sequence)
      FROM dbo.MR_AiConversationMessages m
      JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
      WHERE m.ConversationId = @conversation AND c.OwnerSicil = @sicil;

      IF @turnMessageId IS NOT NULL
        SET @outcome = 'EXISTING';
      ELSE IF @content IS NULL OR @readOnly = 1
        SET @outcome = 'TURN_NOT_FOUND';
      ELSE IF EXISTS (
        SELECT 1 FROM dbo.MR_AiConversations c
        WHERE c.ConversationId = @conversation AND c.OwnerSicil = @sicil AND c.MessageCount > @maxMessages - 2
      )
        SET @outcome = 'FULL';
      ELSE
      BEGIN
        SET @turnSequence = ISNULL(@lastSequence, 0) + 1;
        INSERT dbo.MR_AiConversationMessages(MessageId, ConversationId, Sequence, Role, Content, ClientTurnId)
        VALUES (@userMessageId, @conversation, @turnSequence, 'user', @content, @turnId);
        UPDATE c SET c.MessageCount = c.MessageCount + 1, c.UpdatedAt = SYSUTCDATETIME()
        FROM dbo.MR_AiConversations c
        WHERE c.ConversationId = @conversation AND c.OwnerSicil = @sicil;
        SET @turnMessageId = @userMessageId;
        SET @turnContent = @content;
        SET @lastSequence = @turnSequence;
        SET @outcome = 'CREATED';
      END
    END
  END
  SELECT @knownSicil AS KnownSicil, @outcome AS PrepareOutcome, @conversation AS ConversationId,
    @turnMessageId AS TurnMessageId, @turnSequence AS TurnSequence, @lastSequence AS LastSequence,
    @turnContent AS TurnContent;
  SELECT ${CONVERSATION_COLUMNS}
  FROM dbo.MR_AiConversations c
  WHERE c.ConversationId = @conversation AND c.OwnerSicil = @sicil;
  SELECT TOP (@historyLimit) ${MESSAGE_COLUMNS}
  FROM dbo.MR_AiConversationMessages m
  JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
  WHERE m.ConversationId = @conversation AND c.OwnerSicil = @sicil AND m.Sequence < @turnSequence
  ORDER BY m.Sequence DESC;
  SELECT ${MESSAGE_COLUMNS}
  FROM dbo.MR_AiConversationMessages m
  JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
  WHERE m.ConversationId = @conversation AND c.OwnerSicil = @sicil
    AND (m.MessageId = @turnMessageId OR m.ReplyToMessageId = @turnMessageId);`;

/**
 * Tamamlanmış yanıtı yazar (kısa bir SQL işleminin içinde; model çağrısından
 * SONRA). Yalnızca konuşma hâlâ bu Sicil'e aitse, yanıtlanan tur konuşmada
 * varsa ve tura daha önce yanıt yazılmadıysa yazılır; aksi hâlde
 * `Persisted = 0` döner (ör. konuşma bu arada silindi).
 */
export const AI_CONVERSATION_APPEND_ANSWER_SQL = `${KNOWN_SICIL}
  DECLARE @persisted bit = 0;
  DECLARE @sequence int = NULL;
  IF @knownSicil = 1 AND EXISTS (
      SELECT 1 FROM dbo.MR_AiConversations c WITH (UPDLOCK, HOLDLOCK)
      WHERE c.ConversationId = @conversationId AND c.OwnerSicil = @sicil
    )
    AND EXISTS (
      SELECT 1 FROM dbo.MR_AiConversationMessages m
      JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
      WHERE m.MessageId = @replyToMessageId AND m.ConversationId = @conversationId
        AND c.OwnerSicil = @sicil AND m.Role = 'user'
    )
    AND NOT EXISTS (
      SELECT 1 FROM dbo.MR_AiConversationMessages m
      WHERE m.ReplyToMessageId = @replyToMessageId
    )
  BEGIN
    SELECT @sequence = ISNULL(MAX(m.Sequence), 0) + 1
    FROM dbo.MR_AiConversationMessages m
    JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
    WHERE m.ConversationId = @conversationId AND c.OwnerSicil = @sicil;
    INSERT dbo.MR_AiConversationMessages(MessageId, ConversationId, Sequence, Role, Content, ReplyToMessageId, Mode, FinishReason)
    VALUES (@messageId, @conversationId, @sequence, 'assistant', @content, @replyToMessageId, @mode, @finishReason);
    UPDATE c SET c.MessageCount = c.MessageCount + 1, c.UpdatedAt = SYSUTCDATETIME()
    FROM dbo.MR_AiConversations c
    WHERE c.ConversationId = @conversationId AND c.OwnerSicil = @sicil AND @knownSicil = 1;
    SET @persisted = 1;
  END
  IF @knownSicil = 1 AND EXISTS (
    SELECT 1 FROM dbo.MR_AiConversationMessages m
    JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
    WHERE m.MessageId = @messageId AND m.ReplyToMessageId = @replyToMessageId
      AND m.ConversationId = @conversationId AND c.OwnerSicil = @sicil
  ) SET @persisted = 1;
  SELECT @knownSicil AS KnownSicil, @persisted AS AnswerPersisted;
  SELECT ${CONVERSATION_COLUMNS}
  FROM dbo.MR_AiConversations c
  WHERE c.ConversationId = @conversationId AND c.OwnerSicil = @sicil AND @knownSicil = 1;
  SELECT ${MESSAGE_COLUMNS}
  FROM dbo.MR_AiConversationMessages m
  JOIN dbo.MR_AiConversations c ON c.ConversationId = m.ConversationId
  WHERE m.MessageId = @messageId AND c.OwnerSicil = @sicil AND @knownSicil = 1;`;
