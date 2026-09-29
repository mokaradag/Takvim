/**
 * Rota AI · olağan Rota işleyişinden yalıtım ve çok kullanıcılı davranış.
 *
 * Süreye dayalı ("50 ms içinde bitmeli") doğrulama yoktur: model üretimi
 * denetlenen bir engelde (`deferred-stream`) bekletilir ve olağan işlemlerin
 * bu sırada tamamlandığı, üretimin ise hâlâ sürdüğü doğrudan gözlenir. Böylece
 * yapay zekâyı küresel bir uygulama kuyruğuna bağlayan gelecekteki bir
 * değişiklik bu testi kırar.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { corporateSeed, createActualStack, CORPORATE_ROOT_WBS_ID } from './helpers/actualStack.mjs';
import { createFakeAiProvider } from './helpers/fakeAiProvider.mjs';
import {
  DEFAULT_KEY,
  MASTER_KEY,
  PERSONAL_KEY_A,
  SICIL_A,
  SICIL_B,
  createAiStack,
  listAssistantConversations,
  loadAssistantConversation,
  parseSseText,
  saveKey,
  turnRequest,
  turnsRoute
} from './helpers/aiStack.mjs';
import { createNewTask } from '../src/state/appState.js';

const { aiRuntimeLoad, resetAiRuntimeForTests, setAiProviderForTests } = await import('../src/server/ai/aiRuntime.js');
const { resetAiConfigCacheForTests } = await import('../src/server/ai/aiConfig.js');
const { resetAiModelRegistryForTests } = await import('../src/server/ai/modelRegistryLoader.js');
const { resetAiTelemetryForTests } = await import('../src/server/ai/aiTelemetry.js');
const { isWithinSqlTransaction } = await import('../src/server/db/pool.js');
const { activeAssistantGenerationCountForTests, resetAssistantGenerationsForTests } = await import('../src/server/ai/assistant/assistantGenerations.js');
const { resetAssistantConversationGateForTests } = await import('../src/server/ai/assistant/assistantService.js');
const { resetAiDirectoryGateForTests } = await import('../src/server/ai/aiCredentialService.js');

function resetAssistant() {
  resetAiRuntimeForTests();
  resetAiConfigCacheForTests();
  resetAiModelRegistryForTests();
  resetAiTelemetryForTests();
  resetAiDirectoryGateForTests();
  resetAssistantGenerationsForTests();
  resetAssistantConversationGateForTests();
}

/** Gerçek Sistem yığınının üstüne Rota AI'yi açar; sağlayıcı SQL işlem durumunu kaydeder. */
function enableAssistant(t) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    MERGEN_ROTA_AI_ENABLED: 'true',
    MERGEN_ROTA_AI_BASE_URL: 'http://127.0.0.1:9/v1',
    MERGEN_ROTA_AI_DEFAULT_API_KEY: DEFAULT_KEY,
    MERGEN_ROTA_AI_CREDENTIAL_MASTER_KEY: MASTER_KEY
  });
  resetAssistant();
  const provider = createFakeAiProvider();
  const streamChatCompletion = provider.streamChatCompletion.bind(provider);
  provider.insideSqlTransaction = [];
  provider.streamChatCompletion = (input) => {
    provider.insideSqlTransaction.push(isWithinSqlTransaction());
    return streamChatCompletion(input);
  };
  setAiProviderForTests(provider);
  t.after(() => {
    setAiProviderForTests(null);
    resetAssistant();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return provider;
}

/** Akışı arka planda okuyan tur; olaylar geldikçe biriktirilir. */
function turnInBackground(body, { signal } = {}) {
  const state = { events: [], settled: false };
  state.promise = turnsRoute.POST(turnRequest({ mode: 'standard', conversationId: null, ...body }, { signal })).then(async (response) => {
    state.status = response.status;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        const boundary = buffer.lastIndexOf('\n\n');
        if (boundary >= 0) {
          state.events.push(...parseSseText(buffer.slice(0, boundary + 2)).events);
          buffer = buffer.slice(boundary + 2);
        }
      }
    } catch {
      // İstemci iptali okumayı keser.
    }
    state.settled = true;
    return state;
  });
  return state;
}

async function until(predicate, rounds = 400) {
  for (let round = 0; round < rounds && !predicate(); round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'beklenen durum oluşmadı');
}

async function createTask(stack) {
  const project = stack.project('P4417041');
  const task = createNewTask({ ...stack.state, workspaceMode: 'project', selectedProjectId: project.id }, undefined,
    'task-5e6f7081-92a3-4b4c-8d5e-6f708192a3b4');
  return stack.persistence.mutate('task/create', { type: 'task/add', task });
}

test('süren bir Rota AI akışı anlık görüntüyü ve görev kaydını bekletmez; üretim sırasında SQL işlemi açık kalmaz', async (t) => {
  const stack = await createActualStack(corporateSeed());
  t.after(() => stack.dispose());
  const provider = enableAssistant(t);
  provider.enqueue({ type: 'deferred-stream' });
  const client = new AbortController();
  t.after(() => client.abort());
  const turn = turnInBackground({ turnId: randomUUID(), message: 'Uzun sürecek bir soru' }, { signal: client.signal });
  await provider.waitForActive(1);
  provider.calls[0].emit('İlk parça');
  await until(() => turn.events.some((event) => event.event === 'delta'));

  // Engel: model üretimi burada durur; olağan işlemler tamamlanmalıdır.
  const reloaded = await stack.reload({ refreshMode: 'manual' });
  assert.ok(reloaded.projects.some((project) => project.code === 'P4417041'));
  const created = await createTask(stack);
  assert.equal(created.ok, true, created.error?.message);
  assert.equal(stack.db.tasks[0].WbsId, CORPORATE_ROOT_WBS_ID);

  assert.equal(turn.settled, false, 'Rota AI akışı hâlâ sürüyor');
  assert.equal(aiRuntimeLoad().active, 1);
  assert.deepEqual(provider.insideSqlTransaction, [false]);
  assert.ok(stack.db.transactions.every((entry) => entry.commitStatementIndex != null || entry.rollbackStatementIndex != null),
    'açık kalan SQL işlemi yoktur');

  provider.calls[0].emit(' ve son parça');
  provider.calls[0].complete();
  await turn.promise;
  assert.equal(turn.events.at(-1).event, 'done');
  assert.deepEqual(stack.db.aiConversationMessages.map((row) => [row.Role, row.Content]), [
    ['user', 'Uzun sürecek bir soru'],
    ['assistant', 'İlk parça ve son parça']
  ]);
  assert.equal(aiRuntimeLoad().active, 0);
});

test('iki kullanıcı: ayrı konuşmalar, kendi anahtar kaynakları, ayrı geçmiş; eşzamanlı üretim kapasite sınırı içinde yürür', async (t) => {
  const { db, provider, useSicil } = createAiStack(t, {
    env: { MERGEN_ROTA_AI_MAX_ACTIVE_REQUESTS: '2', MERGEN_ROTA_AI_MAX_ACTIVE_PER_USER: '1', MERGEN_ROTA_AI_MAX_QUEUED_PER_USER: '0' }
  });
  await saveKey(PERSONAL_KEY_A);
  provider.enqueue({ type: 'deferred-stream' }, { type: 'deferred-stream' });

  const a = turnInBackground({ turnId: randomUUID(), message: 'A’nın sorusu' });
  await provider.waitForActive(1);
  useSicil(SICIL_B);
  const b = turnInBackground({ turnId: randomUUID(), message: 'B’nin sorusu' });
  await provider.waitForActive(2);
  assert.equal(aiRuntimeLoad().activeUsers, 2, 'iki kullanıcının üretimi aynı anda sürer');
  assert.deepEqual(provider.calls.map((call) => call.apiKey), [PERSONAL_KEY_A, DEFAULT_KEY], 'her kullanıcı Phase 1 anahtar çözümüyle kendi kaynağını kullanır');

  // B'nin ikinci konuşması kullanıcı sınırına takılır; A'nın akışını etkilemez.
  const bSecond = turnInBackground({ turnId: randomUUID(), message: 'B’nin ikinci sorusu' });
  await bSecond.promise;
  assert.equal(bSecond.events.at(-1).data.code, 'AI_BUSY');

  provider.calls[0].emit('A yanıtı');
  provider.calls[1].emit('B yanıtı');
  provider.calls[0].complete();
  provider.calls[1].complete();
  await Promise.all([a.promise, b.promise]);
  assert.equal(a.events.at(-1).event, 'done');
  assert.equal(b.events.at(-1).event, 'done');

  const aConversation = a.events[0].data.conversation.id;
  const bConversation = b.events[0].data.conversation.id;
  const listB = await listAssistantConversations();
  assert.deepEqual(listB.body.conversations.map((item) => item.id).sort(), [bConversation, bSecond.events[0].data.conversation.id].sort());
  assert.equal((await loadAssistantConversation(aConversation)).status, 404);
  useSicil(SICIL_A);
  const listA = await listAssistantConversations();
  assert.deepEqual(listA.body.conversations.map((item) => item.id), [aConversation]);
  const owners = new Map(db.aiConversations.map((row) => [row.ConversationId.toLowerCase(), row.OwnerSicil]));
  assert.equal(owners.get(aConversation), SICIL_A);
  assert.equal(owners.get(bConversation), SICIL_B);
});

test('bir kullanıcının durdurduğu ya da geç kalan üretimi öteki kullanıcının konuşmasını değiştirmez', async (t) => {
  const { db, provider, useSicil } = createAiStack(t);
  provider.enqueue({ type: 'deferred-stream', ignoreAbort: true }, { type: 'deferred-stream' });
  const clientA = new AbortController();
  const a = turnInBackground({ turnId: randomUUID(), message: 'A durduracak' }, { signal: clientA.signal });
  await provider.waitForActive(1);
  useSicil(SICIL_B);
  const b = turnInBackground({ turnId: randomUUID(), message: 'B devam edecek' });
  await provider.waitForActive(2);

  provider.calls[0].emit('A kısmi');
  clientA.abort();
  await a.promise;
  await until(() => activeAssistantGenerationCountForTests() === 1);
  // A'nın sinyale uymayan sağlayıcısından geç gelen parça hiçbir yere yazılmaz.
  provider.calls[0].emit(' A GEÇ PARÇA');
  provider.calls[0].complete();
  provider.calls[1].emit('B yanıtı');
  provider.calls[1].complete();
  await b.promise;

  assert.equal(b.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join(''), 'B yanıtı');
  const byOwner = (sicil) => {
    const ids = new Set(db.aiConversations.filter((row) => row.OwnerSicil === sicil).map((row) => row.ConversationId));
    return db.aiConversationMessages.filter((row) => ids.has(row.ConversationId)).map((row) => [row.Role, row.Content]);
  };
  assert.deepEqual(byOwner(SICIL_A), [['user', 'A durduracak']]);
  assert.deepEqual(byOwner(SICIL_B), [['user', 'B devam edecek'], ['assistant', 'B yanıtı']]);
  assert.equal(JSON.stringify(db.aiConversationMessages).includes('GEÇ PARÇA'), false);
  assert.equal(aiRuntimeLoad().active, 0);
  assert.equal(activeAssistantGenerationCountForTests(), 0);
});
