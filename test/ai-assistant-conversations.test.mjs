/**
 * Rota AI · konuşma geçmişi (0017) ve tur yaşam döngüsü.
 *
 * Gerçek rota gövdeleri, gerçek hizmet ve depo kodu, bellek içi SQL Server
 * ikizi ve belirlenimci sağlayıcı ikiziyle sınanır: Sicil sahipliği, başka
 * Sicil'in konuşmasının okunamaması/yazılamaması/silinememesi ve VARLIĞININ
 * öğrenilememesi, kullanıcı iletisinin üretimden önce, yanıtın yalnızca
 * tamamlanınca yazılması, aynı turun yeniden denenmesinin ikinci ileti
 * üretmemesi, sayfalı liste, başlıklar, sınırlar ve SQL işlerinin model
 * üretiminden bağımsız (işlem açık kalmadan) yürümesi.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  SICIL_A,
  SICIL_B,
  SICIL_UNKNOWN,
  createAiStack,
  deleteAssistantConversation,
  listAssistantConversations,
  loadAssistantConversation,
  parseSseText,
  sendTurn,
  turnRequest,
  turnsRoute
} from './helpers/aiStack.mjs';

const { isWithinSqlTransaction } = await import('../src/server/db/pool.js');
const { activeAssistantGenerationCountForTests } = await import('../src/server/ai/assistant/assistantGenerations.js');
const { ASSISTANT_CONTEXT_POLICY, buildAssistantContext } = await import('../src/server/ai/assistant/assistantPrompt.js');
const { ASSISTANT_DEFAULT_TITLE, ASSISTANT_LIMITS, conversationTitleFrom } = await import('../src/domain/ai/assistantContract.js');
const { aiRuntimeLoad } = await import('../src/server/ai/aiRuntime.js');

function accepted(result) {
  return result.events.find((event) => event.event === 'accepted')?.data;
}

function terminal(result) {
  return result.events.at(-1);
}

function answerText(result) {
  return result.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join('');
}

/** Yeni konuşma açan ve akışı sonuna kadar okuyan tur. */
async function startConversation(message = 'Bir toplantı gündemi hazırlar mısın?', extra = {}) {
  const turnId = randomUUID();
  const result = await sendTurn({ turnId, message, ...extra });
  assert.equal(result.status, 200, result.text);
  return { turnId, result, conversationId: accepted(result).conversation.id };
}

/** Akışı olay olay okuyan okuyucu (testin kendi ayrıştırıcısıyla). */
function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          const [event] = parseSseText(block).events;
          if (event) return event;
          continue;
        }
        const step = await reader.read();
        if (step.done) return null;
        buffer += decoder.decode(step.value, { stream: true });
      }
    },
    async rest() {
      const events = [];
      for (let event = await this.next(); event; event = await this.next()) events.push(event);
      return events;
    },
    cancel: () => reader.cancel()
  };
}

async function until(predicate, rounds = 400) {
  for (let round = 0; round < rounds && !predicate(); round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'beklenen durum oluşmadı');
}

/* ── Oluşturma ve sahiplik ─────────────────────────────────── */

test('ilk tur güvenilir Sicil adına konuşma açar; kullanıcı iletisi ve tamamlanan yanıt sırayla kaydedilir', async (t) => {
  const { db, provider } = createAiStack(t);
  const { result, conversationId, turnId } = await startConversation('  Bir toplantı gündemi hazırlar mısın?  ');
  assert.deepEqual(result.events.map((event) => event.event), ['accepted', 'status', 'delta', 'delta', 'done']);
  assert.equal(answerText(result), 'Merhaba, bağlantı çalışıyor.');
  const [conversation] = db.aiConversations;
  assert.equal(conversation.OwnerSicil, SICIL_A);
  assert.equal(conversation.ConversationId.toLowerCase(), conversationId);
  assert.equal(conversation.Title, 'Bir toplantı gündemi hazırlar mısın?');
  assert.equal(conversation.MessageCount, 2);
  const [question, answer] = db.aiConversationMessages;
  assert.deepEqual([question.Sequence, question.Role, question.Content, question.ClientTurnId.toLowerCase()], [1, 'user', 'Bir toplantı gündemi hazırlar mısın?', turnId]);
  assert.deepEqual([answer.Sequence, answer.Role, answer.Content, answer.Mode, answer.FinishReason], [2, 'assistant', 'Merhaba, bağlantı çalışıyor.', 'standard', 'stop']);
  assert.equal(answer.ReplyToMessageId, question.MessageId);
  const done = terminal(result).data;
  assert.equal(done.assistantMessage.id, answer.MessageId.toLowerCase());
  assert.equal(done.conversation.messageCount, 2);
  assert.equal(provider.calls.length, 1);
});

test('konuşmaya eklenen tur önceki TAMAMLANMIŞ çiftleri bağlam olarak alır; tarayıcı geçmiş göndermez', async (t) => {
  const { db, provider } = createAiStack(t);
  const { conversationId } = await startConversation('İlk soru');
  provider.enqueue({ type: 'stream', text: 'İkinci yanıt' });
  const second = await sendTurn({ conversationId, turnId: randomUUID(), message: 'İkinci soru' });
  assert.equal(terminal(second).event, 'done');
  const messages = provider.calls[1].messages;
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(messages.slice(1).map((message) => message.content), ['İlk soru', 'Merhaba, bağlantı çalışıyor.', 'İkinci soru']);
  assert.match(messages[0].content, /Rota AI/);
  assert.match(messages[0].content, /erişimin YOK/);
  assert.deepEqual(db.aiConversationMessages.map((row) => [row.Sequence, row.Role]), [[1, 'user'], [2, 'assistant'], [3, 'user'], [4, 'assistant']]);
  const loaded = await loadAssistantConversation(conversationId);
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.messages.map((message) => message.content), ['İlk soru', 'Merhaba, bağlantı çalışıyor.', 'İkinci soru', 'İkinci yanıt']);
});

test('liste ve okuma yalnızca kendi konuşmalarını döndürür; başkasının konuşması YOK gibi yanıtlanır', async (t) => {
  const { db, useSicil } = createAiStack(t);
  const own = await startConversation('A’nın gizli planı');
  await startConversation('A’nın ikinci konuşması');
  useSicil(SICIL_B);
  const b = await startConversation('B’nin sorusu');

  const listB = await listAssistantConversations();
  assert.deepEqual(listB.body.conversations.map((item) => item.id), [b.conversationId]);
  const foreign = await loadAssistantConversation(own.conversationId);
  const missing = await loadAssistantConversation(randomUUID());
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body, 'başka Sicil’in konuşması var olmayan konuşmayla AYNI yanıtı alır');
  assert.doesNotMatch(foreign.text, /gizli planı/);

  useSicil(SICIL_A);
  const listA = await listAssistantConversations();
  assert.equal(listA.body.conversations.length, 2);
  assert.equal(listA.body.conversations.some((item) => item.id === b.conversationId), false);
  assert.equal(db.aiConversations.length, 3);
});

test('başka Sicil’in konuşmasına ileti eklenemez, yeniden denenemez ve silinemez; varlığı öğrenilemez', async (t) => {
  const { db, provider, useSicil } = createAiStack(t);
  const own = await startConversation('A’nın konuşması');
  const before = JSON.stringify(db.aiConversationMessages);
  useSicil(SICIL_B);
  const append = await sendTurn({ conversationId: own.conversationId, turnId: randomUUID(), message: 'B araya giriyor' });
  const replay = await sendTurn({ conversationId: own.conversationId, turnId: own.turnId, message: null });
  const removed = await deleteAssistantConversation(own.conversationId);
  const missingAppend = await sendTurn({ conversationId: randomUUID(), turnId: randomUUID(), message: 'B araya giriyor' });
  const missingDelete = await deleteAssistantConversation(randomUUID());
  for (const response of [append, replay, removed]) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  }
  assert.deepEqual(append.body, missingAppend.body);
  assert.deepEqual(removed.body, missingDelete.body);
  assert.equal(JSON.stringify(db.aiConversationMessages), before, 'A’nın konuşması değişmez');
  assert.equal(db.aiConversations.length, 1);
  assert.equal(provider.calls.length, 1, 'başkasının konuşmasında model çağrılmaz');
});

test('rehberde olmayan Sicil konuşma açamaz ve listeleyemez', async (t) => {
  const { db, provider } = createAiStack(t, { sicil: SICIL_UNKNOWN });
  const turn = await sendTurn({ turnId: randomUUID(), message: 'Merhaba' });
  const list = await listAssistantConversations();
  for (const response of [turn, list]) {
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHORIZED');
  }
  assert.equal(db.aiConversations.length, 0);
  assert.equal(provider.calls.length, 0);
});

/* ── Silme ────────────────────────────────────────────────── */

test('kendi konuşmasını silen kullanıcı konuşmayı ve bütün iletilerini kaldırır; diğer konuşmalar kalır', async (t) => {
  const { db } = createAiStack(t);
  const first = await startConversation('Silinecek');
  const second = await startConversation('Kalacak');
  const removed = await deleteAssistantConversation(first.conversationId);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true, deleted: true, conversationId: first.conversationId });
  assert.deepEqual(db.aiConversations.map((row) => row.ConversationId.toLowerCase()), [second.conversationId]);
  assert.equal(db.aiConversationMessages.every((row) => row.ConversationId.toLowerCase() === second.conversationId), true);
  assert.equal((await deleteAssistantConversation(first.conversationId)).status, 404, 'ikinci silme bulunamadı döner');
});

test('silme, aynı kullanıcının o konuşmada süren üretimini durdurur; yarım yanıt yazılmaz', async (t) => {
  const { db, provider } = createAiStack(t);
  const { conversationId } = await startConversation('İlk');
  provider.enqueue({ type: 'deferred-stream' });
  const response = await turnsRoute.POST(turnRequest({ conversationId, turnId: randomUUID(), message: 'Uzun sürecek', mode: 'standard' }));
  const reader = sseReader(response);
  assert.equal((await reader.next()).event, 'accepted');
  await provider.waitForActive(1);
  provider.calls[1].emit('yarım');
  assert.equal((await reader.next()).event, 'status');
  assert.equal((await reader.next()).event, 'delta');
  assert.equal((await deleteAssistantConversation(conversationId)).status, 200);
  const rest = await reader.rest();
  assert.equal(rest.at(-1).event, 'error');
  assert.equal(rest.at(-1).data.code, 'AI_CANCELLED');
  assert.equal(provider.calls[1].aborted, true);
  assert.equal(db.aiConversations.length, 0);
  assert.equal(db.aiConversationMessages.length, 0);
  assert.equal(activeAssistantGenerationCountForTests(), 0);
  assert.equal(aiRuntimeLoad().active, 0);
});

/* ── Yeniden deneme ve yinelenen gönderim ─────────────────── */

test('durdurulan turun kullanıcı iletisi kalır, yanıtı yazılmaz; aynı turun yeniden denenmesi İKİNCİ ileti üretmez', async (t) => {
  const { db, provider } = createAiStack(t);
  provider.enqueue({ type: 'deferred-stream' });
  const turnId = randomUUID();
  const controller = new AbortController();
  const response = await turnsRoute.POST(turnRequest({ turnId, message: 'Durdurulacak soru', mode: 'standard', conversationId: null }, { signal: controller.signal }));
  const reader = sseReader(response);
  const acceptedEvent = await reader.next();
  const conversationId = acceptedEvent.data.conversation.id;
  await provider.waitForActive(1);
  provider.calls[0].emit('yarım yanıt');
  await reader.next();
  await reader.next();
  controller.abort();
  await reader.cancel();
  await until(() => activeAssistantGenerationCountForTests() === 0 && aiRuntimeLoad().active === 0);
  assert.equal(provider.calls[0].aborted, true);
  assert.deepEqual(db.aiConversationMessages.map((row) => row.Role), ['user'], 'yalnızca kullanıcı iletisi kalır');

  // Yeni konuşmanın ilk turu, konuşma kimliği bilinmeden de aynı turdur (ilk tur tekilliği).
  provider.enqueue({ type: 'stream', text: 'Yeniden denenen yanıt' });
  const retried = await sendTurn({ conversationId: null, turnId, message: 'Durdurulacak soru' });
  assert.equal(terminal(retried).event, 'done');
  assert.equal(accepted(retried).conversation.id, conversationId);
  assert.equal(accepted(retried).userMessage.id, acceptedEvent.data.userMessage.id);
  assert.equal(db.aiConversations.length, 1);
  assert.deepEqual(db.aiConversationMessages.map((row) => [row.Sequence, row.Role, row.Content]), [
    [1, 'user', 'Durdurulacak soru'],
    [2, 'assistant', 'Yeniden denenen yanıt']
  ]);

  // İletisiz yeniden deneme (yalnızca tur kimliğiyle) de aynı sonuca varır; yanıtı yazılmış tur yeniden üretilmez.
  const replayed = await sendTurn({ conversationId, turnId, message: null });
  assert.equal(terminal(replayed).event, 'done');
  assert.equal(terminal(replayed).data.replayed, true);
  assert.equal(answerText(replayed), 'Yeniden denenen yanıt');
  assert.equal(provider.calls.length, 2, 'kayıtlı yanıt oynatılır, model yeniden çağrılmaz');
  assert.equal(db.aiConversationMessages.length, 2);
});

test('aynı tur kimliği farklı içerikle kullanılamaz; yalnızca son yanıtsız tur yeniden denenebilir', async (t) => {
  const { db, provider } = createAiStack(t);
  const first = await startConversation('Birinci');
  const reused = await sendTurn({ conversationId: first.conversationId, turnId: first.turnId, message: 'Başka içerik' });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.details.reason, 'TURN_ID_REUSED');

  provider.enqueue({ type: 'status', status: 503 });
  const unanswered = randomUUID();
  const failed = await sendTurn({ conversationId: first.conversationId, turnId: unanswered, message: 'Yanıtsız kalacak' });
  assert.equal(terminal(failed).event, 'error');
  assert.equal(terminal(failed).data.code, 'AI_PROVIDER_UNAVAILABLE');
  await sendTurn({ conversationId: first.conversationId, turnId: randomUUID(), message: 'Sonraki soru' });
  const stale = await sendTurn({ conversationId: first.conversationId, turnId: unanswered, message: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.reason, 'TURN_NOT_LATEST');
  const unknownTurn = await sendTurn({ conversationId: first.conversationId, turnId: randomUUID(), message: null });
  assert.equal(unknownTurn.status, 404);
  assert.equal(db.aiConversationMessages.filter((row) => row.Role === 'user').length, 3);
});

test('konuşmada aynı anda tek yanıt üretilir; ikinci tur süren üretim bitene kadar reddedilir', async (t) => {
  const { provider } = createAiStack(t);
  const { conversationId } = await startConversation('İlk');
  provider.enqueue({ type: 'deferred-stream' });
  const running = sseReader(await turnsRoute.POST(turnRequest({ conversationId, turnId: randomUUID(), message: 'Uzun', mode: 'standard' })));
  assert.equal((await running.next()).event, 'accepted');
  const second = await sendTurn({ conversationId, turnId: randomUUID(), message: 'Araya giren' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.details.reason, 'GENERATION_IN_PROGRESS');
  // Farklı bir konuşma aynı kullanıcı için engellenmez.
  const other = await startConversation('Başka konuşma');
  assert.equal(terminal(other.result).event, 'done');
  await provider.waitForActive(1);
  provider.calls[1].emit('bitti');
  provider.calls[1].complete();
  assert.equal((await running.rest()).at(-1).event, 'done');
  const after = await sendTurn({ conversationId, turnId: randomUUID(), message: 'Artık serbest' });
  assert.equal(terminal(after).event, 'done');
});

/* ── Liste, sıralama ve başlıklar ─────────────────────────── */

test('liste son etkinliğe göre sıralıdır, sayfalıdır ve sayfalar örtüşmez; yeni ileti konuşmayı başa taşır', async (t) => {
  createAiStack(t);
  const created = [];
  for (let index = 0; index < ASSISTANT_LIMITS.conversationPageSize + 5; index += 1) {
    created.push((await startConversation(`Konuşma ${index + 1}`)).conversationId);
  }
  const first = await listAssistantConversations();
  assert.equal(first.body.conversations.length, ASSISTANT_LIMITS.conversationPageSize);
  assert.ok(first.body.nextCursor);
  assert.deepEqual(first.body.conversations.map((item) => item.id), [...created].reverse().slice(0, ASSISTANT_LIMITS.conversationPageSize));
  assert.equal('messages' in first.body.conversations[0], false, 'liste iletileri yüklemez');
  const second = await listAssistantConversations(first.body.nextCursor);
  assert.equal(second.status, 200);
  assert.equal(second.body.conversations.length, 5);
  assert.equal(second.body.nextCursor, null);
  const ids = [...first.body.conversations, ...second.body.conversations].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);

  await sendTurn({ conversationId: created[0], turnId: randomUUID(), message: 'Eski konuşmaya dönüş' });
  const refreshed = await listAssistantConversations();
  assert.equal(refreshed.body.conversations[0].id, created[0]);
  assert.equal(refreshed.body.conversations[0].messageCount, 4);

  const invalid = await listAssistantConversations('bozuk-imlec');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.details.reason, 'CURSOR_INVALID');
});

test('başlık ilk iletiden belirlenimci üretilir: biçim işaretleri atılır, uzun metin kelime sınırında kısalır', async (t) => {
  assert.equal(conversationTitleFrom('## **Proje** `planı` > hazırla'), 'Proje planı hazırla');
  assert.equal(conversationTitleFrom('   \n\t '), ASSISTANT_DEFAULT_TITLE);
  assert.equal(conversationTitleFrom('###'), ASSISTANT_DEFAULT_TITLE);
  const long = conversationTitleFrom('Çok uzun bir soru metni ki başlığa sığmaması gerekir ve kelime sınırında kesilmesi beklenir');
  assert.ok(long.length <= ASSISTANT_LIMITS.maxTitleChars);
  assert.ok(long.endsWith('…'));
  assert.doesNotMatch(long, /\s…$/);
  const { db } = createAiStack(t);
  await startConversation('### ');
  assert.equal(db.aiConversations[0].Title, ASSISTANT_DEFAULT_TITLE);
});

/* ── Sınırlar ─────────────────────────────────────────────── */

test('ileti uzunluğu sınırı sunucuda da uygulanır; sınırdaki ileti kabul edilir', async (t) => {
  const { db, provider } = createAiStack(t);
  const tooLong = await sendTurn({ turnId: randomUUID(), message: 'x'.repeat(ASSISTANT_LIMITS.maxMessageChars + 1) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.details.reason, 'MESSAGE_TOO_LONG');
  const blank = await sendTurn({ turnId: randomUUID(), message: ' \n\t ' });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.details.reason, 'MESSAGE_REQUIRED');
  assert.equal(db.aiConversations.length, 0);
  assert.equal(provider.calls.length, 0);
  const exact = await sendTurn({ turnId: randomUUID(), message: 'y'.repeat(ASSISTANT_LIMITS.maxMessageChars) });
  assert.equal(terminal(exact).event, 'done');
});

test('konuşma azami ileti sayısına ulaşınca yeni tur reddedilir ve yeni konuşma önerilir', async (t) => {
  const { db, provider } = createAiStack(t);
  const { conversationId } = await startConversation('Başlangıç');
  const conversation = db.aiConversations[0];
  conversation.MessageCount = ASSISTANT_LIMITS.maxConversationMessages - 1;
  const full = await sendTurn({ conversationId, turnId: randomUUID(), message: 'Bir tane daha' });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.details.reason, 'CONVERSATION_FULL');
  assert.equal(provider.calls.length, 1);
});

test('bağlam sınırlıdır: en yeni tamamlanmış çiftler bütçeye sığdığı kadar girer, yanıtsız turlar girmez', () => {
  const history = [];
  let sequence = 0;
  const add = (role, content, replyToId = null) => {
    sequence += 1;
    const message = { id: `m${sequence}`, sequence, role, content, replyToId };
    history.push(message);
    return message;
  };
  for (let index = 0; index < 15; index += 1) {
    const question = add('user', `soru ${index}`);
    add('assistant', `yanıt ${index}`, question.id);
  }
  add('user', 'yanıtsız kalan soru');
  const context = buildAssistantContext({ history, userContent: 'yeni soru', priorMessageCount: history.length });
  assert.equal(context.messages.length, 1 + ASSISTANT_CONTEXT_POLICY.maxHistoryMessages + 1);
  assert.equal(context.messages[1].content, 'soru 5');
  assert.equal(context.messages.at(-2).content, 'yanıt 14');
  assert.equal(context.messages.at(-1).content, 'yeni soru');
  assert.equal(context.messages.some((message) => message.content === 'yanıtsız kalan soru'), false);
  assert.equal(context.trimmed, true);
  assert.equal(context.omittedMessages, 10);

  const huge = [{ id: 'q', role: 'user', content: 'a'.repeat(30000) }, { id: 'r', role: 'assistant', content: 'b'.repeat(30000), replyToId: 'q' }];
  const clipped = buildAssistantContext({ history: huge, userContent: 'soru', priorMessageCount: 2 });
  assert.ok(clipped.messages.reduce((sum, message) => sum + message.content.length, 0) < ASSISTANT_CONTEXT_POLICY.maxContextChars + 4000);
  assert.ok(clipped.messages[1].content.endsWith('[…ileti bağlam için kısaltıldı]'));

  const untrimmed = buildAssistantContext({ history: history.slice(0, 4), userContent: 'x', priorMessageCount: 4 });
  assert.equal(untrimmed.trimmed, false);
});

test('uzun konuşmada bağlamın kısaldığı ilk olayda bildirilir', async (t) => {
  const { provider } = createAiStack(t);
  const { conversationId } = await startConversation('Soru 0');
  for (let index = 1; index <= 11; index += 1) {
    await sendTurn({ conversationId, turnId: randomUUID(), message: `Soru ${index}` });
  }
  const last = await sendTurn({ conversationId, turnId: randomUUID(), message: 'Son soru' });
  assert.deepEqual(accepted(last).context, { trimmed: true, omittedMessages: 4 });
  assert.equal(provider.calls.at(-1).messages.length, 1 + ASSISTANT_CONTEXT_POLICY.maxHistoryMessages + 1);
});

/* ── SQL ve model üretimi ─────────────────────────────────── */

test('SQL işleri model üretiminden bağımsızdır: üretim sırasında işlem açık değildir, yanıt ancak tamamlanınca yazılır', async (t) => {
  const { db, provider } = createAiStack(t);
  const observations = [];
  const streamChatCompletion = provider.streamChatCompletion.bind(provider);
  provider.streamChatCompletion = (input) => {
    observations.push({
      insideTransaction: isWithinSqlTransaction(),
      statements: db.aiConversationLog.statements.map((entry) => (entry.sql.includes('AS PrepareOutcome') ? 'prepare' : entry.sql.includes('AS AnswerPersisted') ? 'append' : 'other')),
      userMessages: db.aiConversationMessages.filter((row) => row.Role === 'user').length,
      answers: db.aiConversationMessages.filter((row) => row.Role === 'assistant').length
    });
    return streamChatCompletion(input);
  };
  await startConversation('SQL bağımsızlık sorusu');
  assert.deepEqual(observations, [{ insideTransaction: false, statements: ['prepare'], userMessages: 1, answers: 0 }]);
  assert.deepEqual(db.aiConversationLog.statements.map((entry) => (entry.sql.includes('AS AnswerPersisted') ? 'append' : 'prepare')), ['prepare', 'append']);
});

test('konuşma tabloları kurulmamışsa (0017 uygulanmamış) anlaşılır yapılandırma hatası döner; model çağrılmaz', async (t) => {
  const { provider } = createAiStack(t, { seed: { aiConversationSchemaMissing: true } });
  const turn = await sendTurn({ turnId: randomUUID(), message: 'Merhaba' });
  const list = await listAssistantConversations();
  for (const response of [turn, list]) {
    assert.equal(response.body.error.code, 'AI_CONFIGURATION_ERROR');
    assert.equal(response.body.error.details.reason, 'CONVERSATION_SCHEMA_MISSING');
    assert.doesNotMatch(response.text, /Invalid object name|MR_AiConversations/);
  }
  assert.equal(provider.calls.length, 0);
});

test('model yanıtı tamamladıktan sonra istemci ayrılsa da yanıt kaybolmaz', async (t) => {
  const { db, provider } = createAiStack(t);
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  db.queryBarrier = { match: (sql) => sql.includes('AS AnswerPersisted'), entered: 0, released: blocked };
  provider.enqueue({ type: 'stream', text: 'Tamamlanmış yanıt' });
  const controller = new AbortController();
  const response = await turnsRoute.POST(turnRequest({ turnId: randomUUID(), message: 'Soru', mode: 'standard', conversationId: null }, { signal: controller.signal }));
  await until(() => db.queryBarrier.entered === 1);
  assert.deepEqual(db.aiConversationMessages.map((row) => row.Role), ['user']);
  controller.abort();
  unblock();
  await response.text().catch(() => {});
  await until(() => activeAssistantGenerationCountForTests() === 0);
  assert.deepEqual(db.aiConversationMessages.map((row) => row.Role), ['user', 'assistant']);
});
