/**
 * Rota AI · arayüz.
 *
 * Tarayıcı gerektirmeyen kurallar saf modüllerde sınanır (durum makinesi,
 * sunum, yazma alanı tuşları, kaydırma, güvenli Markdown). Gerçek bileşenler
 * tarayıcı olmadan çizilir: Demo Kipinde istek atılmaması, panelin açılıp
 * kapanınca durumunu koruması, gönderimin yalnızca izin verilen alanları
 * taşıması ve yanıt eylemlerinin yalnızca uygun durumda görünmesi.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import React from 'react';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

// Yalnızca model adlarını okumak için (sunucu modülü tarayıcı koduna girmez).
registerServerOnlyShim();

const { useRotaAssistant, RotaAssistantLauncher, RotaAssistantPanel } = await import('../src/features/ai/assistant/RotaAssistant.jsx');
const { AssistantComposer, DEEP_MODE_HELP, INCLUDE_TEXT_HELP } = await import('../src/features/ai/assistant/AssistantComposer.jsx');
const { AssistantThread, AssistantTurn } = await import('../src/features/ai/assistant/AssistantThread.jsx');
const { AssistantConversationList } = await import('../src/features/ai/assistant/AssistantConversationList.jsx');
const { AssistantMarkdown, renderBlock, renderInline } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { createAssistantController, retryableTurnKey, turnsFromMessages } = await import('../src/features/ai/assistant/assistantController.js');
const presentation = await import('../src/features/ai/assistant/assistantPresentation.js');
const interaction = await import('../src/features/ai/assistant/assistantInteraction.js');
const { parseAssistantMarkdown, parseInline, safeLinkHref } = await import('../src/features/ai/assistant/assistantMarkdown.js');
const { conversationTitleFrom, normalizeAssistantMessage } = await import('../src/domain/ai/assistantContract.js');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');

const MODEL_NAMES = DEFAULT_AI_MODEL_REGISTRY.models.map((model) => model.id);
const CONVERSATION_A = '6f1c2d3e-4a5b-4c6d-8e7f-00112233aaaa';
const CONVERSATION_B = '6f1c2d3e-4a5b-4c6d-8e7f-00112233bbbb';
let idCounter = 0;
const createId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

const READINESS = Object.freeze({
  available: true,
  reason: null,
  credentialSource: 'default',
  modes: [{ id: 'standard', label: 'Standart', available: true }, { id: 'deep', label: 'Derin düşünme', available: true }],
  limits: { maxMessageChars: 8000, maxConversationMessages: 100 }
});

test('controller keeps a selected Rota source when Rota data or the mode is unavailable', async () => {
  for (const rotaData of [
    { enabled: true, available: false, reason: 'EVIDENCE_SCHEMA_MISSING', modes: [{ id: 'standard', available: true }] },
    { enabled: true, available: true, modes: [{ id: 'standard', available: false }] }
  ]) {
    const api = fakeApi({ loadAssistantReadinessRequest: async () => ({ ok: true, assistant: { ...READINESS, rotaData } }) });
    const { controller } = await readyController({ api });
    controller.send('Genel soru');
    await drain();
    // Sunucu sabit "unavailable" sonucunu verir; genel sohbete yalnızca kullanıcı geçer.
    assert.equal(api.turns[0].input.source, undefined);
    api.turns[0].resolve({ ok: false, code: 'REQUEST_CANCELLED', cancelled: true });
    await drain();
    controller.dispose();
  }
});

test('welcome suggestion clicks select general chat only when enabled Rota data is unavailable', async (t) => {
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => callback();
  t.after(() => { globalThis.requestAnimationFrame = previousFrame; });
  for (const { rotaData, mode = 'standard', source = 'rota', expectedSource } of [
    { rotaData: { enabled: true, available: false, reason: 'EVIDENCE_SCHEMA_MISSING' }, expectedSource: 'general' },
    { rotaData: { enabled: true, available: false, reason: 'EVIDENCE_SCHEMA_UNKNOWN' }, expectedSource: 'general' },
    { rotaData: { enabled: true, available: true, modes: [{ id: 'standard', available: true }, { id: 'deep', available: false }] }, mode: 'deep', expectedSource: 'general' },
    { rotaData: { enabled: true, available: true, modes: [{ id: 'standard', available: true }] }, expectedSource: 'rota' },
    { rotaData: { enabled: true, available: true, modes: [{ id: 'standard', available: true }] }, source: 'general', expectedSource: 'general' },
    { rotaData: { enabled: false }, expectedSource: undefined }
  ]) {
    const api = fakeApi({ loadAssistantReadinessRequest: async () => ({ ok: true, assistant: { ...READINESS, rotaData } }) });
    const { controller, state } = await readyController({ api });
    controller.setMode(mode);
    controller.setSource(source);
    const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
    const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
    assert.equal(state().source, source, 'readiness alone does not change the selected source');
    composer().props.onChange('Elle yazılan taslak');
    panel.render();
    assert.equal(state().source, source, 'typing does not change the selected source');
    let focused = 0;
    composer().props.inputRef.current = { focus() { focused += 1; } };
    const welcome = findElement(panel.output, (node) => node.type?.name === 'Welcome');
    const suggestions = mountComponent(welcome.type, welcome.props);
    const button = findElement(suggestions.output, (node) => node.props?.className === 'rota-assistant-suggestion');
    assert.ok(button);
    button.props.onClick();
    panel.render();
    assert.equal(state().source, expectedSource || source);
    assert.equal(composer().props.value, textOf(button));
    assert.equal(focused, 1);
    assert.equal(api.turns.length, 0, 'the suggestion remains a draft until submitted');
    assert.equal(composer().props.onSubmit(composer().props.value).ok, true);
    assert.equal(api.turns[0].input.message, textOf(button).trim());
    assert.equal(api.turns[0].input.source, expectedSource === 'general' ? 'general' : undefined);
    assert.equal(api.turns[0].input.mode, mode);
    panel.unmount();
    suggestions.unmount();
    controller.dispose();
  }
});

test('composer disables unavailable Rota data and displays the readiness explanation', () => {
  const view = mountComponent(AssistantComposer, composerProps({ dataEnabled: true, dataAvailable: false,
    dataUnavailableMessage: 'Rota verisi hazırlığı tamamlanmamış. Genel sohbet kullanılabilir.', source: 'general' }).props);
  const sourceGroup = findElement(view.output, (node) => typeof node.type === 'function' && node.props?.label === 'Yanıt kaynağı');
  const option = findElement(mountComponent(sourceGroup.type, sourceGroup.props).output, (node) => node.props?.['data-value'] === 'rota');
  assert.equal(option.props.disabled, true);
  const status = findElement(view.output, (node) => node.props?.role === 'status');
  assert.match(status.props.children, /Genel sohbet/);
});

/** Denetleyicinin istemci ikizi: akış istekleri test elle ilerletene kadar askıda kalır. */
function fakeApi(overrides = {}) {
  const turns = [];
  const api = {
    turns,
    loadAssistantReadinessRequest: async () => ({ ok: true, assistant: READINESS }),
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [], nextCursor: null }),
    loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: 'Konuşma' }, messages: [] }),
    deleteAssistantConversationRequest: async () => ({ ok: true, deleted: true }),
    streamAssistantTurnRequest(input) {
      return new Promise((resolve) => turns.push({ input, resolve, emit: (type, data) => input.onEvent({ type, data }) }));
    },
    ...overrides
  };
  return api;
}

function acceptedData(conversationId, turn, content) {
  return {
    conversation: { id: conversationId, title: content.slice(0, 20) },
    userMessage: { id: createId(), content, createdAt: '2026-09-26T10:00:00.000Z', turnId: turn.input.turnId },
    context: { trimmed: false, omittedMessages: 0 }
  };
}

function doneResult(conversationId) {
  return { ok: true, done: { conversation: { id: conversationId, title: 'Başlık' }, assistantMessage: { id: createId(), mode: 'standard', finishReason: 'stop', createdAt: 'x' } } };
}

async function readyController(options = {}) {
  const api = options.api || fakeApi();
  const flushes = [];
  const controller = createAssistantController({
    api,
    createId,
    reconciliationDelaysMs: options.reconciliationDelaysMs || [],
    schedule: (callback) => {
      flushes.push(callback);
      return () => { const index = flushes.indexOf(callback); if (index >= 0) flushes.splice(index, 1); };
    }
  });
  await controller.activate();
  return { controller, api, flushes, state: () => controller.getState() };
}

async function drain() {
  for (let round = 0; round < 6; round += 1) await immediate();
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function withDataMode(t, dataMode) {
  const previous = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode, async setDataMode() {} };
  t.after(() => { DataModeContext._currentValue = previous; });
}

function stubFetch(t, handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body ?? null, signal: init.signal };
    calls.push(call);
    return handler(call);
  };
  t.after(() => { globalThis.fetch = previous; });
  return calls;
}

/* ── Denetleyici: gönderim, akış, durdurma, yeniden deneme ─── */

test('gönderim: boş ve yalnızca boşluk içeren ileti gönderilmez; yanıt sürerken ikinci gönderim engellenir', async () => {
  const { controller, api } = await readyController();
  for (const blank of ['', '   ', '\n\t ']) {
    assert.deepEqual(controller.send(blank).reason, 'MESSAGE_REQUIRED');
  }
  assert.equal(controller.send('x'.repeat(8001)).reason, 'MESSAGE_TOO_LONG');
  assert.equal(api.turns.length, 0);
  assert.equal(controller.send('  İlk soru  ').ok, true);
  assert.equal(controller.send('İkinci soru').ok, false, 'çift gönderim engellenir');
  assert.equal(api.turns.length, 1);
  assert.equal(api.turns[0].input.message, 'İlk soru');
});

test('kayıtlı bağlam uyarısı üretim zamanındaki metadata ile korunur; yanıtsız tur uyarı almaz', () => {
  const turns = turnsFromMessages([
    { id: 'u1', sequence: 99, role: 'user', content: 'Eski soru', turnId: createId(), createdAt: '2026-09-20T10:00:00.000Z' },
    { id: 'a1', sequence: 100, role: 'assistant', content: 'Eski yanıt', replyToId: 'u1', mode: 'standard', finishReason: 'stop', contextTrimmed: false, createdAt: '2026-09-20T10:00:01.000Z' },
    { id: 'u2', sequence: 101, role: 'user', content: 'Yanıtsız soru', turnId: createId(), createdAt: '2026-09-20T10:00:02.000Z' }
  ]);
  assert.equal(turns[0].contextTrimmed, false, 'bugünün politikası eski yanıtı yeniden sınıflandırmaz');
  assert.equal(turns[1].answer.status, 'unanswered');
  assert.equal(turns[1].contextTrimmed, false, 'yanıt yoksa bağlam uyarısı gösterilmez');

  const trimmed = turnsFromMessages([
    { id: 'u3', sequence: 1, role: 'user', content: 'Soru', turnId: createId(), createdAt: '2026-09-20T11:00:00.000Z' },
    { id: 'a3', sequence: 2, role: 'assistant', content: 'Yanıt', replyToId: 'u3', mode: 'deep', finishReason: 'stop', contextTrimmed: true, contextOmittedMessages: 3, createdAt: '2026-09-20T11:00:01.000Z' }
  ]);
  assert.equal(trimmed[0].contextTrimmed, true);
});

test('akan parçalar TEK yanıtı günceller; ilk parça beklemeden, sonrakiler birleştirilerek çizilir', async () => {
  const { controller, api, flushes, state } = await readyController();
  controller.send('Soru');
  const [turn] = api.turns;
  turn.emit('accepted', acceptedData(CONVERSATION_A, turn, 'Soru'));
  turn.emit('status', { phase: 'generating' });
  turn.emit('delta', { text: 'Bir' });
  assert.equal(state().active.turns[0].answer.content, 'Bir');
  assert.equal(state().active.turns[0].answer.status, 'streaming');
  turn.emit('delta', { text: ' iki' });
  turn.emit('delta', { text: ' üç' });
  assert.equal(state().active.turns[0].answer.content, 'Bir', 'sonraki parçalar kısa aralıkla toplu çizilir');
  assert.equal(flushes.length, 1, 'tek zamanlayıcı kurulur');
  flushes.shift()();
  assert.equal(state().active.turns[0].answer.content, 'Bir iki üç');
  assert.equal(state().active.turns.length, 1);
  turn.resolve(doneResult(CONVERSATION_A));
  await drain();
  const [only] = state().active.turns;
  assert.equal(only.answer.status, 'complete');
  assert.equal(only.answer.content, 'Bir iki üç');
  assert.equal(state().running[CONVERSATION_A], undefined);
});

test('Durdur isteği keser, kısmi metni korur; durdurulan üretimin geç gelen parçası ve sonucu uygulanmaz', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [first] = api.turns;
  first.emit('accepted', acceptedData(CONVERSATION_A, first, 'Soru'));
  first.emit('delta', { text: 'kısmi' });
  assert.equal(controller.stop(), true);
  assert.equal(first.input.signal.aborted, true);
  assert.equal(state().active.turns[0].answer.status, 'stopped');
  first.emit('delta', { text: ' GEÇ' });
  first.resolve({ ok: false, code: 'REQUEST_CANCELLED', cancelled: true, partial: true });
  await drain();
  assert.equal(state().active.turns[0].answer.content, 'kısmi');

  // Yeni üretim başladıktan sonra eski üretimin olayları yeni turu etkilemez.
  assert.equal(controller.retry(state().active.turns[0].key).ok, true);
  const second = api.turns[1];
  first.emit('delta', { text: ' ESKİ' });
  second.emit('accepted', acceptedData(CONVERSATION_A, second, 'Soru'));
  second.emit('delta', { text: 'yeni' });
  assert.equal(state().active.turns[0].answer.content, 'yeni');
});

test('yeniden deneme aynı tur kimliği, içerik ve konuşmayla gider; ikinci kullanıcı iletisi oluşmaz; yalnızca son tur denenir', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Birinci');
  const [first] = api.turns;
  first.emit('accepted', acceptedData(CONVERSATION_A, first, 'Birinci'));
  first.resolve({ ok: false, code: 'AI_PROVIDER_UNAVAILABLE', partial: false, retryable: true });
  await drain();
  const key = retryableTurnKey(state().active.turns);
  assert.equal(key, first.input.turnId);
  assert.equal(controller.retry(key).ok, true);
  const retried = api.turns[1];
  assert.deepEqual(
    [retried.input.turnId, retried.input.message, retried.input.conversationId],
    [first.input.turnId, 'Birinci', CONVERSATION_A]
  );
  assert.equal(state().active.turns.length, 1);
  retried.resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(controller.retry(key).ok, false, 'tamamlanan tur yeniden denenmez');
  controller.send('İkinci');
  api.turns[2].resolve({ ok: false, code: 'AI_TIMEOUT' });
  await drain();
  assert.equal(controller.retry(first.input.turnId).ok, false, 'son olmayan tur yeniden denenmez');
});

test('konuşma değiştirmek eski yüklemeyi ve süren üretimin görünümünü geçersiz kılar; geri dönülünce metin yeniden bağlanır', async () => {
  let releaseSlow;
  const api = fakeApi({
    loadAssistantConversationRequest: (id) => new Promise((resolve) => {
      const reply = () => resolve({ ok: true, conversation: { id, title: id === CONVERSATION_A ? 'A' : 'B' }, messages: [] });
      if (id === CONVERSATION_A && !releaseSlow) releaseSlow = reply;
      else reply();
    })
  });
  const { controller, state } = await readyController({ api });
  const slow = controller.openConversation(CONVERSATION_A);
  await controller.openConversation(CONVERSATION_B);
  releaseSlow();
  await slow;
  assert.equal(state().active.id, CONVERSATION_B, 'geç gelen eski konuşma yenisinin yerine geçmez');

  controller.newConversation();
  controller.send('Uzun soru');
  const run = api.turns[0];
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'Uzun soru'));
  run.emit('delta', { text: 'A-' });
  await controller.openConversation(CONVERSATION_B);
  run.emit('delta', { text: 'devam' });
  assert.equal(state().active.id, CONVERSATION_B);
  assert.equal(state().active.turns.length, 0, 'başka konuşmanın metni açık konuşmaya yazılmaz');
  assert.ok(state().running[CONVERSATION_A], 'üretim arka planda sürer');
  api.loadAssistantConversationRequest = async (id) => ({
    ok: true,
    conversation: { id, title: 'A' },
    messages: [{ id: createId(), sequence: 1, role: 'user', content: 'Uzun soru', turnId: run.input.turnId, createdAt: 'x' }]
  });
  await controller.openConversation(CONVERSATION_A);
  assert.equal(state().active.turns[0].answer.content, 'A-devam');
  assert.equal(state().active.turns[0].answer.status, 'streaming');
});

test('silme sunucu onayından sonra listeden düşer; açık konuşma silinince yeni konuşmaya geçilir', async () => {
  const api = fakeApi({
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [{ id: CONVERSATION_A, title: 'A' }, { id: CONVERSATION_B, title: 'B' }], nextCursor: null })
  });
  let respond;
  api.deleteAssistantConversationRequest = () => new Promise((resolve) => { respond = resolve; });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  const pending = controller.deleteConversation(CONVERSATION_A);
  assert.equal(state().list.items.length, 2, 'onaydan önce liste değişmez');
  assert.equal(state().deleting[CONVERSATION_A], true);
  respond({ ok: true, deleted: true });
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(state().list.items.map((item) => item.id), [CONVERSATION_B]);
  assert.equal(state().active.id, null);
  assert.equal(state().announcement.text, 'Konuşma silindi.');

  api.deleteAssistantConversationRequest = async () => ({ ok: false, code: 'DATABASE_UNAVAILABLE', message: 'Ulaşılamadı.' });
  const failed = await controller.deleteConversation(CONVERSATION_B);
  assert.equal(failed.ok, false);
  assert.deepEqual(state().list.items.map((item) => item.id), [CONVERSATION_B], 'başarısız silme listeyi değiştirmez');
});

test('kip seçimi yalnızca izin verilen ve kurulumda açık olan kiplerle yapılır; tur isteği kipi taşır', async () => {
  const api = fakeApi({
    loadAssistantReadinessRequest: async () => ({ ok: true, assistant: { ...READINESS, modes: [{ id: 'standard', available: true }, { id: 'deep', available: false }] } })
  });
  const { controller, state } = await readyController({ api });
  assert.equal(controller.setMode('deep'), false);
  assert.equal(controller.setMode('chat.reasoning'), false);
  assert.equal(state().mode, 'standard');
  const open = await readyController();
  assert.equal(open.controller.setMode('deep'), true);
  open.controller.send('Derin soru');
  assert.equal(open.api.turns[0].input.mode, 'deep');
});

test('anlamlı durum değişiklikleri duyurulur; akan parçalar duyuru üretmez', async () => {
  const { controller, api, flushes, state } = await readyController();
  controller.send('Soru');
  assert.equal(state().announcement.text, 'İleti gönderildi, yanıt hazırlanıyor.');
  const before = state().announcement.id;
  const [turn] = api.turns;
  turn.emit('accepted', acceptedData(CONVERSATION_A, turn, 'Soru'));
  for (let index = 0; index < 20; index += 1) turn.emit('delta', { text: `${index} ` });
  flushes.splice(0).forEach((flush) => flush());
  assert.equal(state().announcement.id, before);
  turn.resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(state().announcement.text, 'Yanıt tamamlandı.');
});

test('oturum hatası paneli hata durumuna geçirir; dispose bütün istekleri keser ve geç sonuçları geçersiz kılar', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  api.turns[0].resolve({ ok: false, code: 'UNAUTHORIZED', message: 'Oturum yok.' });
  await drain();
  assert.equal(state().status, 'error');
  assert.equal(state().failure.action, 'reload');

  const fresh = await readyController();
  fresh.controller.send('Soru');
  const [turn] = fresh.api.turns;
  fresh.controller.dispose();
  assert.equal(turn.input.signal.aborted, true);
  turn.emit('accepted', acceptedData(CONVERSATION_A, turn, 'Soru'));
  turn.resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(fresh.state().status, 'idle');
  assert.equal(fresh.state().active.turns.length, 0);
});

test('kayıtlı iletiler turlara çevrilir; yanıtı olmayan kullanıcı iletisi yanıtsız turdur ve yeniden denenebilir', () => {
  const turns = turnsFromMessages([
    { id: 'u2', sequence: 3, role: 'user', content: 'İkinci', turnId: 't2' },
    { id: 'u1', sequence: 1, role: 'user', content: 'Birinci', turnId: 't1' },
    { id: 'a1', sequence: 2, role: 'assistant', content: 'Yanıt', replyToId: 'u1', mode: 'deep', finishReason: 'length' }
  ]);
  assert.deepEqual(turns.map((turn) => [turn.key, turn.answer.status]), [['t1', 'complete'], ['t2', 'unanswered']]);
  assert.equal(turns[0].answer.mode, 'deep');
  assert.equal(retryableTurnKey(turns), 't2');
  assert.equal(retryableTurnKey(turns.slice(0, 1)), null);
});

test('kayıtlı konuşma yalnız tamamlanmış yanıta kaydedilen bağlam uyarısını gösterir', () => {
  const messages = [];
  for (let index = 0; index < 11; index += 1) {
    const userId = `u-${index}`;
    messages.push({ id: userId, sequence: index * 2 + 1, role: 'user', content: `Soru ${index}`, turnId: `t-${index}` });
    messages.push({
      id: `a-${index}`, sequence: index * 2 + 2, role: 'assistant', content: `Yanıt ${index}`, replyToId: userId,
      contextTrimmed: index === 10, contextOmittedMessages: index === 10 ? 2 : 0
    });
  }
  messages.push({ id: 'u-last', sequence: 23, role: 'user', content: 'Devam', turnId: 't-last' });
  const turns = turnsFromMessages(messages);
  assert.equal(turns.at(-3).contextTrimmed, false);
  assert.equal(turns.at(-2).contextTrimmed, true, 'üretim zamanında kısaltılan tamamlanmış yanıt uyarıyı korur');
  assert.equal(turns.at(-1).contextTrimmed, false, 'yanıtsız tur uyarı almaz');
});

/* ── Sunum ────────────────────────────────────────────────── */

test('hata görünümü kategorileri ayırır; kapasite yoğunluğu çökme gibi değil geçici uyarı olarak anlatılır', () => {
  const view = presentation.assistantFailureView;
  assert.deepEqual([view({ code: 'AI_BUSY' }).tone, view({ code: 'AI_BUSY' }).retryable], ['warn', true]);
  assert.equal(view({ code: 'AI_QUEUE_TIMEOUT' }).title, 'Bilgin şu anda yoğun');
  assert.deepEqual([view({ code: 'AI_KEY_MISSING' }).action, view({ code: 'AI_KEY_MISSING' }).retryable], ['settings', false]);
  assert.equal(view({ code: 'AI_KEY_INVALID', credentialSource: 'personal' }).title, 'Kişisel anahtar kabul edilmedi');
  assert.equal(view({ code: 'AI_KEY_INVALID', credentialSource: 'personal' }).action, 'settings');
  assert.equal(view({ code: 'AI_UNAUTHORIZED', credentialSource: 'default' }).title, 'Kurumsal anahtar kabul edilmedi');
  assert.equal(view({ code: 'AI_UNAUTHORIZED', credentialSource: 'default' }).action, null);
  assert.equal(view({ code: 'AI_RATE_LIMITED', message: 'Sınır.' }).tone, 'warn');
  assert.match(view({ code: 'AI_TIMEOUT', partial: true }).message, /yarıda kesildi/);
  assert.equal(view({ code: 'AI_PROVIDER_UNAVAILABLE', partial: false }).title, 'Hizmete ulaşılamıyor');
  assert.equal(view({ code: 'AI_PROVIDER_UNAVAILABLE', partial: true }).title, 'Yanıt yarıda kesildi');
  assert.equal(view({ code: 'STREAM_INTERRUPTED' }).title, 'Yanıt yarıda kesildi');
  assert.deepEqual([view({ code: 'REQUEST_CANCELLED' }).tone, view({ code: 'AI_CANCELLED' }).tone], ['muted', 'muted']);
  assert.equal(view({ code: 'NETWORK' }).title, 'Bağlantı sorunu');
  assert.equal(view({ code: 'STREAM_STALLED' }).title, 'Bağlantı yanıt vermiyor');
  assert.match(view({ code: 'AI_PROVIDER_RESPONSE_INVALID', reason: 'EMPTY_COMPLETION' }).message, /görünür bir yanıt üretmeden/);
  assert.equal(view({ code: 'AI_PROVIDER_RESPONSE_INVALID', reason: 'EMPTY_COMPLETION' }).action, 'new-conversation');
  assert.equal(view({ code: 'CONFLICT', reason: 'CONVERSATION_FULL', message: 'Dolu.' }).action, 'new-conversation');
  assert.equal(view({ code: 'CONFLICT', reason: 'TURN_UNANSWERED' }).action, 'new-conversation');
  assert.match(view({ code: 'CONFLICT', reason: 'GENERATION_IN_PROGRESS' }).message, /başka bir pencerede/);
  assert.equal(view({ code: 'NOT_FOUND' }).action, 'new-conversation');
  assert.equal(view({ code: 'UNAUTHORIZED' }).action, 'reload');
  assert.equal(view({ code: 'AI_REQUEST_INVALID', phase: 'stream' }).action, 'new-conversation');
  const unexpected = view({ code: 'BEKLENMEYEN', message: '' });
  assert.equal(unexpected.title, 'Yanıt alınamadı');
  assert.equal(unexpected.message, 'Yanıt alınamadı. Yeniden deneyebilirsiniz.');
  // İstemcide oluşan sonuçlar ve yoğunluk her zaman kendi sabit metniyle anlatılır.
  for (const code of ['AI_BUSY', 'AI_QUEUE_TIMEOUT', 'NETWORK', 'STREAM_STALLED', 'REQUEST_CANCELLED', 'PROTOCOL_ERROR']) {
    assert.doesNotMatch(JSON.stringify(view({ code, message: 'Error: at Object.<anonymous> (/srv/app.js:1:1)' })), /\/srv\/app\.js/, code);
  }
});

test('hazırlık, evre, bitiş nedeni, sayaç ve göreli zaman metinleri', () => {
  assert.equal(presentation.readinessNotice(READINESS), null);
  assert.equal(presentation.readinessNotice({ available: false, reason: 'AI_KEY_MISSING' }).action, 'settings');
  assert.equal(presentation.readinessNotice({ available: false, reason: 'BİLİNMEYEN' }).title, 'Bilgin yapılandırılmadı');
  assert.equal(presentation.generationPhaseLabel('sending', 'standard'), 'Gönderiliyor…');
  assert.equal(presentation.generationPhaseLabel('generating', 'deep'), 'Yanıt oluşturuluyor…');
  assert.equal(presentation.generationPhaseLabel('thinking', 'standard'), 'Derin düşünülüyor…');
  assert.equal(presentation.generationPhaseLabel('streaming', 'standard'), null);
  assert.match(presentation.finishReasonNote('length'), /uzunluk sınırına/);
  assert.equal(presentation.finishReasonNote('stop'), null);
  assert.equal(presentation.characterCountLabel(100, 8000), null);
  assert.equal(presentation.characterCountLabel(7000, 8000), '7.000 / 8.000');
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  assert.equal(presentation.relativeTimeLabel('2026-09-26T11:59:40.000Z', now), 'şimdi');
  assert.equal(presentation.relativeTimeLabel('2026-09-26T11:30:00.000Z', now), '30 dk önce');
  assert.equal(presentation.relativeTimeLabel('bozuk', now), '');
  assert.match(presentation.DEMO_NOTICE.title, /Gerçek Sistem/);
});

/* ── Etkileşim kuralları ──────────────────────────────────── */

test('Enter gönderir, Shift+Enter satır ekler; IME birleştirmesi ve yanıt sürerken gönderim yapılmaz', () => {
  const action = interaction.composerKeyAction;
  assert.equal(action({ key: 'Enter' }), 'send');
  assert.equal(action({ key: 'Enter', shiftKey: true }), null);
  assert.equal(action({ key: 'Enter', altKey: true }), null);
  assert.equal(action({ key: 'Enter', isComposing: true }), null);
  assert.equal(action({ key: 'Enter', keyCode: 229 }), null);
  assert.equal(action({ key: 'Enter' }, { canSubmit: false }), 'blocked');
  assert.equal(action({ key: 'a' }), null);
});

test('kaydırma yalnızca kullanıcı en alttayken izler; yeni ileti ve konuşma değişimi en alta götürür', () => {
  const { isNearBottom, followState } = interaction;
  assert.equal(isNearBottom({ scrollTop: 952, scrollHeight: 1400, clientHeight: 400 }), true);
  assert.equal(isNearBottom({ scrollTop: 500, scrollHeight: 1400, clientHeight: 400 }), false);
  assert.equal(followState({ following: true, reason: 'scroll', metrics: { scrollTop: 100, scrollHeight: 1400, clientHeight: 400 } }), false);
  assert.equal(followState({ following: false, reason: 'delta' }), false, 'yukarıdaki kullanıcı her parçada geri çekilmez');
  assert.equal(followState({ following: false, reason: 'send' }), true);
  assert.equal(followState({ following: false, reason: 'open' }), true);
  assert.equal(followState({ following: false, reason: 'jump' }), true);
});

test('kopyalama Clipboard API varsa onu, yoksa gizli metin alanını kullanır; yalnızca görünen metni kopyalar', async () => {
  const written = [];
  assert.equal(await interaction.copyTextToClipboard('Yanıt', { clipboard: { writeText: async (text) => written.push(text) }, document: null }), true);
  assert.deepEqual(written, ['Yanıt']);
  const appended = [];
  const fakeDocument = {
    body: { appendChild: (node) => appended.push(node) },
    activeElement: null,
    createElement: () => ({ value: '', style: {}, setAttribute() {}, select() {}, remove() { this.removed = true; } }),
    execCommand: (command) => command === 'copy'
  };
  assert.equal(await interaction.copyTextToClipboard('Düz HTTP', { clipboard: undefined, document: fakeDocument }), true);
  assert.equal(appended[0].value, 'Düz HTTP');
  assert.equal(appended[0].removed, true);
  assert.equal(await interaction.copyTextToClipboard('', { clipboard: undefined, document: fakeDocument }), false);
  assert.equal(await interaction.copyTextToClipboard('x', { clipboard: { writeText: async () => { throw new Error('izin yok'); } }, document: { ...fakeDocument, execCommand: () => false } }), false);
});

/* ── Güvenli Markdown ─────────────────────────────────────── */

function collectElements(node, list = []) {
  if (node == null || typeof node !== 'object') return list;
  if (Array.isArray(node)) {
    node.forEach((child) => collectElements(child, list));
    return list;
  }
  list.push(node);
  collectElements(node.props?.children, list);
  return list;
}

test('Markdown: paragraf, liste, vurgu, kod, tablo ve bağlantı korunur; HTML yorumlanmaz, görsel yüklenmez', () => {
  const source = [
    '# Başlık',
    '',
    'Paragraf **kalın**, *italik*, `kod` ve [Rota](https://rota.example.internal/yardim).',
    '',
    '- madde 1',
    '- madde 2',
    '',
    '1. adım',
    '2. adım',
    '',
    '```js',
    'console.log("<b>değil</b>");',
    '```',
    '',
    '| A | B |',
    '|---|--:|',
    '| 1 | 2 |',
    '',
    '<script>alert(1)</script> <img src=x onerror=alert(1)>',
    '',
    '![grafik](https://evil.example/pixel.png) [tıkla](javascript:alert(1)) [veri](data:text/html,x)'
  ].join('\n');
  const elements = collectElements(parseAssistantMarkdown(source).map((block, index) => renderBlock(block, `b${index}`)));
  const types = new Set(elements.map((element) => (typeof element.type === 'string' ? element.type : element.type?.name)));
  for (const expected of ['h3', 'p', 'strong', 'em', 'code', 'a', 'ul', 'ol', 'li', 'table', 'th', 'td']) {
    assert.ok(types.has(expected), `${expected} çizilmeli`);
  }
  assert.ok(types.has('CodeBlock'));
  for (const forbidden of ['script', 'img', 'iframe']) assert.equal(types.has(forbidden), false, `${forbidden} çizilmemeli`);
  assert.equal(elements.some((element) => element.props && 'dangerouslySetInnerHTML' in element.props), false);
  for (const element of elements) {
    for (const key of Object.keys(element.props || {})) assert.doesNotMatch(key, /^on[A-Z]/, `model çıktısı olay işleyicisi üretmez: ${key}`);
  }
  const links = elements.filter((element) => element.type === 'a');
  assert.deepEqual(links.map((link) => link.props.href), ['https://rota.example.internal/yardim', 'https://evil.example/pixel.png']);
  for (const link of links) {
    assert.equal(link.props.target, '_blank');
    assert.match(link.props.rel, /noopener/);
    assert.match(link.props.rel, /noreferrer/);
    assert.equal(link.props.title, link.props.href);
  }
  assert.match(textOf(links[1]), /^Görsel: grafik/);
  const text = textOf(elements[0]) + elements.map((element) => textOf(element)).join('');
  assert.match(text, /<script>alert\(1\)<\/script>/, 'HTML metin olarak görünür');
});

test('güvenli bağlantı: yalnızca mutlak http/https/mailto; kimlik bilgisi taşıyan ve göreli adresler reddedilir', () => {
  assert.equal(safeLinkHref('https://ornek.example/a b'), null);
  assert.equal(safeLinkHref('https://kullanici:parola@ornek.example'), null);
  assert.equal(safeLinkHref('/api/mergen-rota/snapshot'), null);
  assert.equal(safeLinkHref('JAVASCRIPT:alert(1)'), null);
  assert.equal(safeLinkHref('vbscript:x'), null);
  assert.equal(safeLinkHref('mailto:destek@ornek.example'), 'mailto:destek@ornek.example');
  assert.equal(safeLinkHref('https://ornek.example/yol?q=1'), 'https://ornek.example/yol?q=1');
});

test('Markdown çözücü sınırlıdır: kötü niyetli girdiler doğrusal zamanda biter; yarım kod bloğu güvenle çizilir', () => {
  const started = Date.now();
  for (const input of ['['.repeat(60000), '*a '.repeat(20000), '`'.repeat(1) + ' `'.repeat(30000), '[a]('.repeat(15000), '> '.repeat(5000) + 'x']) {
    parseAssistantMarkdown(input);
  }
  assert.ok(Date.now() - started < 2000, 'patolojik girdiler hızlı biter');
  const [block] = parseAssistantMarkdown('```python\nprint("akış sürüyor")');
  assert.deepEqual([block.type, block.closed, block.text], ['code', false, 'print("akış sürüyor")']);
  assert.equal(parseAssistantMarkdown('1923. yılda kuruldu.')[0].type, 'paragraph', 'Türkçe sıra sayısı liste sayılmaz');
  assert.deepEqual(parseInline('dosya_adi_v2 ve ~5 gün').map((node) => node.type), ['text']);
  assert.equal(renderInline(parseInline('**a**'))[0].type, 'strong');
});

/* ── Bileşenler ───────────────────────────────────────────── */

function Probe() {
  return { assistant: useRotaAssistant() };
}

test('Demo Kipinde panel açılır ama hiçbir istek gönderilmez; açıklama gösterilir, yazma alanı yoktur', async (t) => {
  withDataMode(t, 'demo');
  const calls = stubFetch(t, () => { throw new Error('Demo Kipinde istek atılmamalı'); });
  const probe = mountComponent(Probe, {});
  t.after(() => probe.unmount());
  probe.output.assistant.openPanel();
  probe.render();
  await drain();
  probe.render();
  const { assistant } = probe.output;
  assert.equal(assistant.open, true);
  assert.equal(assistant.actual, false);
  assert.equal(calls.length, 0);
  const panel = mountComponent(RotaAssistantPanel, { assistant, onOpenSettings() {} });
  assert.ok(findElement(panel.output, (node) => node.props?.notice?.title === presentation.DEMO_NOTICE.title));
  assert.equal(findElement(panel.output, (node) => node.type === AssistantComposer), null);
  assert.equal(findElement(panel.output, (node) => node.props?.['aria-label'] === 'Yeni konuşma'), null);
});

test('panel açılıp kapanınca durum korunur; kapalı panel hiçbir şey çizmez; Gerçek Sistem’de hazırlık ve liste yeniden okunur', async (t) => {
  withDataMode(t, 'actual');
  const calls = stubFetch(t, (call) => {
    if (call.url.endsWith('/assistant')) return Response.json({ assistant: READINESS });
    if (call.url.endsWith('/assistant/conversations')) return Response.json({ conversations: [], nextCursor: null });
    throw new Error(`beklenmeyen istek: ${call.method} ${call.url}`);
  });
  const probe = mountComponent(Probe, {});
  t.after(() => probe.unmount());
  const controller = probe.output.assistant.controller;
  probe.output.assistant.openPanel();
  probe.render();
  await drain();
  probe.render();
  assert.equal(probe.output.assistant.controller.getState().status, 'ready');
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url.replace(/^.*\/ai/, '')}`).sort(), ['GET /assistant', 'GET /assistant/conversations']);

  const panel = mountComponent(RotaAssistantPanel, { assistant: probe.output.assistant, onOpenSettings() {} });
  const composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  assert.ok(composer);
  assert.equal(panel.output.props.role, 'complementary', 'masaüstünde panel kipsizdir');
  assert.equal(panel.output.props['aria-modal'], undefined);

  probe.output.assistant.close({ restoreFocus: false });
  probe.render();
  assert.equal(mountComponent(RotaAssistantPanel, { assistant: probe.output.assistant }).output, null);
  probe.output.assistant.openPanel();
  probe.render();
  await drain();
  assert.equal(probe.output.assistant.controller, controller, 'denetleyici (konuşma durumu) korunur');
  assert.equal(calls.length, 4, 'yeniden açılış hazırlığı ve listeyi yeniler');
  assert.equal(calls.filter((call) => call.url.endsWith('/conversations')).length, 2);
});

test('gönderim yalnızca konuşma, tur, ileti ve kipi taşır; model adı, profil ya da anahtar göndermez', async (t) => {
  withDataMode(t, 'actual');
  const sent = [];
  stubFetch(t, (call) => {
    if (call.url.endsWith('/assistant')) return Response.json({ assistant: READINESS });
    if (call.url.endsWith('/assistant/conversations')) return Response.json({ conversations: [], nextCursor: null });
    if (call.url.endsWith('/assistant/turns')) {
      sent.push(call);
      return Response.json({ error: { code: 'AI_BUSY', message: 'Yoğun.' } }, { status: 503 });
    }
    throw new Error(`beklenmeyen istek: ${call.url}`);
  });
  const probe = mountComponent(Probe, {});
  t.after(() => probe.unmount());
  probe.output.assistant.openPanel();
  probe.render();
  await drain();
  probe.render();
  const panel = mountComponent(RotaAssistantPanel, { assistant: probe.output.assistant, onOpenSettings() {} });
  const composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  composer.props.onModeChange('deep');
  assert.equal(composer.props.onSubmit('Derin bir soru').ok, true);
  await drain();
  const [call] = sent;
  assert.equal(call.method, 'POST');
  const body = JSON.parse(call.body);
  // Rota verisi özelliği kapalıyken kaynak gönderilmez; yanıt "Genel sohbet" olarak işaretlenmez.
  assert.deepEqual(Object.keys(body).sort(), ['conversationId', 'expectedSequence', 'message', 'mode', 'turnId']);
  assert.equal(body.source, undefined);
  assert.equal(body.mode, 'deep');
  for (const forbidden of [...MODEL_NAMES, 'chat.reasoning', 'chat.general', 'apiKey', 'Authorization', 'sicil']) {
    assert.equal(call.body.includes(forbidden), false, `gövde taşımamalı: ${forbidden}`);
  }
  probe.render();
  const turn = probe.output.assistant.controller.getState().active.turns[0];
  assert.equal(turn.answer.status, 'failed');
  assert.equal(turn.answer.error.title, 'Bilgin şu anda yoğun');
});

test('başlatıcı açıklığı ve arka planda süren yanıtı erişilebilir biçimde bildirir', () => {
  const controllerWith = (running) => ({ subscribe: () => () => {}, getState: () => ({ running }) });
  const base = { open: false, controller: controllerWith({}), toggle() {}, launcherRef: { current: null } };
  const idle = mountComponent(RotaAssistantLauncher, { assistant: base }).output;
  assert.equal(idle.props['aria-expanded'], false);
  assert.equal(idle.props['aria-controls'], undefined);
  assert.equal(textOf(idle).includes('yanıt hazırlanıyor'), false);
  const generating = controllerWith({ [CONVERSATION_A]: { token: 1 } });
  const busy = mountComponent(RotaAssistantLauncher, { assistant: { ...base, controller: generating } }).output;
  assert.match(textOf(busy), /yanıt hazırlanıyor/);
  const open = mountComponent(RotaAssistantLauncher, { assistant: { ...base, open: true, controller: generating } }).output;
  assert.equal(open.props['aria-expanded'], true);
  assert.equal(open.props['aria-controls'], 'rota-assistant-panel');
  assert.equal(textOf(open).includes('yanıt hazırlanıyor'), false, 'panel açıkken işaret gösterilmez');
});

test('kabuk yardımcının durumuna abone olmaz: akan parçalar uygulamanın geri kalanını yeniden çizdirmez', async (t) => {
  withDataMode(t, 'demo');
  const probe = mountComponent(Probe, {});
  t.after(() => probe.unmount());
  const before = probe.output.assistant;
  assert.equal('state' in before, false);
  before.controller.setView('history');
  probe.render();
  assert.equal(probe.output.assistant, before, 'denetleyici durumu değişince kabuğa verilen nesne değişmez');
});

function composerProps(overrides = {}) {
  const submitted = [];
  return {
    submitted,
    props: {
      value: 'Merhaba',
      onChange() {},
      onSubmit: (value) => { submitted.push(value); return { ok: true }; },
      onStop() {},
      mode: 'standard',
      modes: READINESS.modes,
      onModeChange() {},
      maxChars: 8000,
      inputRef: { current: null },
      ...overrides
    }
  };
}

function keyDown(textarea, init) {
  let prevented = false;
  textarea.props.onKeyDown({ key: 'Enter', shiftKey: false, altKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() { prevented = true; }, ...init });
  return prevented;
}

test('ileti sınırı kanonik metne uygulanır; konuşma başlığında bağlantı hedefi gösterilmez', () => {
  const raw = `${'x'.repeat(7995)}${'\n'.repeat(10)}`;
  const normalized = normalizeAssistantMessage(raw);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.length, 7995);
  assert.equal(conversationTitleFrom('[Bütçe raporu](https://intranet/reports/123) hakkında'), 'Bütçe raporu hakkında');
  assert.equal(conversationTitleFrom('![Grafik](https://intranet/chart.png) özeti'), 'Grafik özeti');

  const padded = mountComponent(AssistantComposer, composerProps({ value: raw }).props);
  assert.equal(findElement(padded.output, (node) => node.props?.type === 'submit').props.disabled, false);
  assert.equal(findElement(padded.output, (node) => node.type === 'textarea').props['aria-invalid'], undefined);
  assert.match(textOf(padded.output), /7\.995 \/ 8\.000/);
  padded.unmount();
});

test('yazma alanı: Enter gönderir, Shift+Enter ve IME göndermez; boş ileti gönderilemez; sınır aşımı açıklanır', () => {
  const { submitted, props } = composerProps();
  const view = mountComponent(AssistantComposer, props);
  const textarea = findElement(view.output, (node) => node.type === 'textarea');
  assert.equal(keyDown(textarea, { shiftKey: true }), false);
  assert.equal(keyDown(textarea, { nativeEvent: { isComposing: true } }), false);
  assert.deepEqual(submitted, []);
  assert.equal(keyDown(textarea, {}), true);
  assert.deepEqual(submitted, ['Merhaba']);

  const blank = mountComponent(AssistantComposer, composerProps({ value: '   ' }).props);
  assert.equal(findElement(blank.output, (node) => node.props?.type === 'submit').props.disabled, true);
  const long = mountComponent(AssistantComposer, composerProps({ value: 'x'.repeat(8001) }).props);
  assert.equal(findElement(long.output, (node) => node.type === 'textarea').props['aria-invalid'], true);
  assert.match(textOf(long.output), /en fazla 8\.000 karakter/);
  assert.equal(findElement(long.output, (node) => node.props?.type === 'submit').props.disabled, true);
  const modes = [];
  const modeToggle = findElement(mountComponent(AssistantComposer, { ...props, onModeChange: (value) => modes.push(value) }).output,
    (node) => typeof node.type === 'function' && node.type.name === 'ModeToggle');
  const chip = mountComponent(modeToggle.type, modeToggle.props).output;
  const deep = mountComponent(chip.type, chip.props).output;
  assert.equal(deep.props.role, 'switch', 'Derin düşünme erişilebilir bir anahtardır; Standart varsayılandır');
  assert.equal(deep.props['aria-checked'], false);
  assert.equal(textOf(findElement(deep, (node) => node.props?.className === 'rota-assistant-toggle-label')), 'Derin düşünme');
  assert.equal(findElement(deep, (node) => node.props?.className === 'rota-assistant-toggle-short').props['aria-hidden'], 'true');
  assert.equal(deep.props.title, DEEP_MODE_HELP);
  deep.props.onClick();
  const on = mountComponent(chip.type, mountComponent(modeToggle.type, { ...modeToggle.props, mode: 'deep' }).output.props).output;
  assert.equal(on.props['aria-checked'], true);
  on.props.onClick();
  assert.deepEqual(modes, ['deep', 'standard']);
  const single = mountComponent(modeToggle.type, { ...modeToggle.props, modes: [READINESS.modes[0], { ...READINESS.modes[1], available: false }] }).output;
  assert.equal(single, null, 'tek kip varsa seçim gösterilmez');
});

test('composer locks both modes during generation and unlocks them after completion or cancellation', () => {
  for (const mode of ['standard', 'deep']) {
    const changes = [];
    const view = mountComponent(AssistantComposer, composerProps({ mode, generating: true, onModeChange: (value) => changes.push(value) }).props);
    const button = () => {
      const toggle = findElement(view.output, (node) => node.type?.name === 'ModeToggle');
      const chip = mountComponent(toggle.type, toggle.props).output;
      return mountComponent(chip.type, chip.props).output;
    };
    assert.equal(button().props.disabled, true);
    assert.equal(button().props['aria-checked'], mode === 'deep');
    view.render(composerProps({ mode, generating: false, onModeChange: (value) => changes.push(value) }).props);
    assert.equal(button().props.disabled, false);
    button().props.onClick();
    assert.deepEqual(changes, [mode === 'deep' ? 'standard' : 'deep']);
    view.render(composerProps({ mode, disabled: true, generating: false }).props);
    assert.equal(button().props.disabled, true);
    view.unmount();
  }
});

test('yanıt kaynağı bölümlü radyo grubudur; serbest metin onayı kısa, açıklamalı bir anahtardır', () => {
  const sources = [];
  const consents = [];
  const base = composerProps({ dataEnabled: true, source: 'rota', onSourceChange: (value) => sources.push(value), onIncludeTextChange: (value) => consents.push(value) }).props;
  const segmentsOf = (output) => {
    const element = findElement(output, (node) => typeof node.type === 'function' && node.type.name === 'SegmentedChoice' && node.props.label === 'Yanıt kaynağı');
    return element && mountComponent(element.type, element.props).output;
  };
  const view = mountComponent(AssistantComposer, base);
  assert.equal(findElement(view.output, (node) => node.type === 'select'), null, 'yerel açılır liste kullanılmaz');
  const group = segmentsOf(view.output);
  assert.equal(group.props.role, 'radiogroup');
  assert.deepEqual(group.props.children.map((radio) => [textOf(radio), radio.props['aria-checked'], radio.props.tabIndex, radio.props.disabled]),
    [['Rota verisi', true, 0, false], ['Genel sohbet', false, -1, false]]);
  group.props.children[0].props.onClick();
  group.props.children[1].props.onClick();
  assert.deepEqual(sources, ['general'], 'seçili kaynağa yeniden basmak bir değişiklik değildir');

  // Onay anahtarı aynı satırdaki kısa bir haptır; tam ad ekran okuyucuda kalır, kısa etiket yalnızca süstür.
  const textToggleOf = (output) => {
    const element = findElement(output, (node) => typeof node.type === 'function' && node.type.name === 'ToggleChip' && node.props.label === 'Notlar ve iletiler');
    return element && mountComponent(element.type, element.props).output;
  };
  const toggle = textToggleOf(view.output);
  assert.equal(toggle.props.role, 'switch');
  assert.equal(textOf(findElement(toggle, (node) => node.props?.className === 'rota-assistant-toggle-label')), 'Notlar ve iletiler');
  assert.equal(findElement(toggle, (node) => node.props?.className === 'rota-assistant-toggle-short').props['aria-hidden'], 'true');
  assert.equal(toggle.props['aria-checked'], false);
  assert.equal(toggle.props.title, INCLUDE_TEXT_HELP);
  const help = findElement(view.output, (node) => node.props?.id === toggle.props['aria-describedby']);
  assert.equal(textOf(help), INCLUDE_TEXT_HELP, 'açıklama ekran okuyucuya da bağlıdır');
  toggle.props.onClick();
  assert.deepEqual(consents, [true]);
  const on = mountComponent(AssistantComposer, { ...base, includeText: true });
  textToggleOf(on.output).props.onClick();
  assert.deepEqual(consents, [true, false]);

  const general = mountComponent(AssistantComposer, { ...base, source: 'general' });
  assert.equal(textToggleOf(general.output), null, 'genel sohbette Rota metni onayı yoktur');
  const unavailable = segmentsOf(mountComponent(AssistantComposer, { ...base, dataAvailable: false, dataUnavailableMessage: 'Rota verisi kullanılamıyor.' }).output);
  assert.deepEqual(unavailable.props.children.map((radio) => [radio.props.disabled, radio.props.tabIndex]), [[true, -1], [false, 0]],
    'kullanılamayan seçili kaynak varken grup sekmeyle yine erişilebilir');
  const busy = mountComponent(AssistantComposer, { ...base, generating: true });
  assert.equal(segmentsOf(busy.output).props.children.every((radio) => radio.props.disabled), true);
  assert.equal(textToggleOf(busy.output).props.disabled, true);
  // Kaynak, onay, kip ve Gönder tek araç çubuğundadır.
  const toolbar = findElement(view.output, (node) => node.props?.className === 'rota-assistant-toolbar');
  const kinds = React.Children.toArray(toolbar.props.children).map((child) => child.type?.name || child.props?.className);
  assert.deepEqual(kinds, ['SegmentedChoice', 'ToggleChip', 'rota-assistant-composer-counter', 'ModeToggle', 'rota-assistant-composer-action']);
});

test('gönder ve Durdur aynı sabit yuvada yer değiştirir', () => {
  const slotOf = (generating) => findElement(mountComponent(AssistantComposer, composerProps({ generating }).props).output,
    (node) => node.props?.className === 'rota-assistant-composer-action');
  assert.equal(slotOf(false).props.children.props.type, 'submit');
  assert.equal(slotOf(false).props.children.props['aria-label'], 'Gönder');
  const stop = slotOf(true).props.children;
  assert.equal(stop.props.className, 'rota-assistant-stop');
  assert.equal(textOf(stop), 'Durdur', 'simgeli Durdur düğmesinin erişilebilir adı vardır');
});

test('yanıt sürerken gönder yerine Durdur görünür; Enter gönderim yapmaz ve açıklama gösterir', () => {
  const stopped = [];
  const { submitted, props } = composerProps({ generating: true, onStop: () => stopped.push(true) });
  const view = mountComponent(AssistantComposer, props);
  assert.equal(findElement(view.output, (node) => node.props?.type === 'submit'), null);
  const stop = findElement(view.output, (node) => node.type === 'button' && textOf(node).includes('Durdur'));
  stop.props.onClick();
  assert.deepEqual(stopped, [true]);
  assert.equal(keyDown(findElement(view.output, (node) => node.type === 'textarea'), {}), true);
  view.render();
  assert.deepEqual(submitted, []);
  assert.match(textOf(view.output), /Önce yanıtı durdurun/);
  assert.equal(findElement(view.output, (node) => node.type === 'textarea').props.disabled, false, 'taslak yazmak engellenmez');
});

function turn(status, extra = {}) {
  return {
    key: 't1',
    turnId: 't1',
    user: { id: 'u1', content: 'Soru', pending: false },
    answer: { status, content: status === 'waiting' ? '' : 'Yanıt **metni**', mode: 'standard', finishReason: 'stop', error: null, ...extra },
    contextTrimmed: false
  };
}

test('yanıt eylemleri yalnızca uygun durumda görünür: kopyalama tamamlanmış yanıtta, yeniden deneme yalnızca son başarısız turda', () => {
  const find = (props, predicate) => findElement(mountComponent(AssistantTurn, { onRetry() {}, onAction() {}, ...props }).output, predicate);
  const copy = (node) => node.props?.['aria-label']?.startsWith('Yanıtı kopyala');
  const copyButton = (node) => typeof node.type === 'function' && node.type.name === 'CopyAnswerButton';
  assert.ok(find({ turn: turn('complete') }, copyButton));
  assert.equal(find({ turn: turn('streaming') }, copyButton), null);
  assert.equal(find({ turn: turn('waiting') }, copyButton), null);
  assert.equal(find({ turn: turn('failed') }, copy), null);
  const failure = presentation.assistantFailureView({ code: 'AI_TIMEOUT' });
  const notice = (node) => typeof node.type === 'function' && node.type.name === 'AnswerNotice';
  assert.equal(find({ turn: turn('failed', { error: failure }), canRetry: true }, notice).props.retryable, true);
  assert.equal(find({ turn: turn('failed', { error: failure }), canRetry: false }, notice).props.retryable, false);
  const keyMissing = presentation.assistantFailureView({ code: 'AI_KEY_MISSING' });
  assert.equal(find({ turn: turn('failed', { error: keyMissing }), canRetry: true }, notice).props.retryable, false,
    'yeniden denemenin işe yaramayacağı hata için düğme gösterilmez');
  // Yanıtsız son tur yeni ileti göndermeyi kapatır: kullanıcı yalnızca yeniden denemeye mahkûm kalmaz.
  const noticeActions = (failureCode) => {
    const actions = [];
    const element = find({ turn: turn('failed', { error: presentation.assistantFailureView({ code: failureCode }) }), canRetry: true }, notice);
    const rendered = mountComponent(element.type, { ...element.props, onAction: (action) => actions.push(action) }).output;
    return { actions, rendered };
  };
  for (const code of ['AI_TIMEOUT', 'STREAM_STALLED', 'REQUEST_TIMEOUT', 'NETWORK']) {
    const { actions, rendered } = noticeActions(code);
    const escape = findElement(rendered, (item) => item.type === 'button' && textOf(item).includes('Yeni konuşma başlat'));
    assert.ok(escape, code);
    escape.props.onClick();
    assert.deepEqual(actions, ['new-conversation'], code);
  }
  // Kendi yönlendirmesi olan hata kendi eylemini korur.
  assert.ok(findElement(noticeActions('AI_KEY_MISSING').rendered, (item) => item.type === 'button' && textOf(item).includes('Ayarlar’ı aç')));
  assert.ok(find({ turn: turn('unanswered', { content: '' }), canRetry: true }, notice));
  const checkingFailure = presentation.assistantFailureView({ code: 'STREAM_INTERRUPTED' });
  const checking = mountComponent(AssistantTurn, {
    turn: turn('interrupted', { content: '', error: checkingFailure }),
    reconciling: true,
    onRetry() {},
    onAction() {}
  }).output;
  assert.match(textOf(checking), /sonucu kontrol ediliyor/);
  assert.doesNotMatch(textOf(checking), /kaydedilmedi/);
  assert.equal(findElement(checking, (node) => typeof node.type === 'function' && node.type.name === 'AnswerNotice'), null);
  const settledPartial = mountComponent(AssistantTurn, { turn: turn('interrupted'), onRetry() {}, onAction() {} }).output;
  assert.match(textOf(settledPartial), /tamamlanmadı/);
  assert.doesNotMatch(textOf(settledPartial), /kaydedilmedi/);
  const waiting = mountComponent(AssistantTurn, { turn: turn('waiting'), phase: 'thinking', onRetry() {}, onAction() {} }).output;
  assert.match(textOf(waiting), /Derin düşünülüyor/);
  assert.equal(findElement(waiting, (node) => node.props?.['aria-busy'] === true) != null, true);
});

test('akış metni canlı bölge değildir; tamamlanan yanıt güvenli Markdown ile çizilir', () => {
  const thread = mountComponent(AssistantThread, { conversationKey: 'c', turns: [turn('streaming')], onRetry() {}, onAction() {} }).output;
  assert.equal(findElement(thread, (node) => node.props?.['aria-live'] != null || node.props?.role === 'log'), null);
  const answer = mountComponent(AssistantTurn, { turn: turn('complete'), onRetry() {}, onAction() {} }).output;
  assert.ok(findElement(answer, (node) => node.type === AssistantMarkdown));
  const markdown = mountComponent(AssistantMarkdown, { text: 'Yanıt **metni**' }).output;
  assert.equal(markdown.props.className, 'assistant-md');
});

test('konuşma silme açık onay ister; vazgeçilebilir; onay sunucuya gider', async () => {
  const deleted = [];
  const list = { items: [{ id: CONVERSATION_A, title: 'Planlama', updatedAt: new Date().toISOString() }], nextCursor: null, loading: false, loadingMore: false, error: null };
  const view = mountComponent(AssistantConversationList, {
    list,
    onOpen() {},
    onDelete: async (id) => { deleted.push(id); return { ok: true }; },
    onLoadMore() {},
    onReload() {}
  });
  const row = () => findElement(view.output, (node) => node.props?.item?.id === CONVERSATION_A);
  row().props.onAskDelete();
  view.render();
  assert.equal(row().props.confirming, true);
  assert.deepEqual(deleted, [], 'ilk tıklama silmez');
  row().props.onCancelDelete();
  view.render();
  assert.equal(row().props.confirming, false);
  row().props.onAskDelete();
  view.render();
  await row().props.onConfirmDelete();
  assert.deepEqual(deleted, [CONVERSATION_A]);
});

test('panel başlığındaki eylemler etiketlidir; geçmiş görünümü düğmeyle açılıp kapanır', async (t) => {
  withDataMode(t, 'actual');
  const { controller } = await readyController();
  const assistant = { controller, state: controller.getState(), open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} };
  const panel = mountComponent(RotaAssistantPanel, { assistant, onOpenSettings() {} });
  for (const label of ['Geçmiş konuşmalar', 'Yeni konuşma', 'Bilgin’i kapat']) {
    assert.ok(findElement(panel.output, (node) => node.type === 'button' && node.props['aria-label'] === label), label);
  }
  findElement(panel.output, (node) => node.props?.['aria-label'] === 'Geçmiş konuşmalar').props.onClick();
  assert.equal(controller.getState().view, 'history');
  assert.ok(findElement(panel.output, (node) => node.props?.['aria-live'] === 'polite'), 'tek, nazik canlı bölge vardır');
  assert.ok(React.isValidElement(panel.output));
});

test('geciken konuşma okuması tamamlanan yanıtı yanıtsız göstermez', async () => {
  let resolveRead;
  let reads = 0;
  const api = fakeApi({ loadAssistantConversationRequest: () => {
    reads += 1;
    if (reads === 1) return new Promise((resolve) => { resolveRead = resolve; });
    return Promise.resolve({ ok: true, conversation: { id: CONVERSATION_A, title: 'Güncel' }, messages: [
      { id: 'user', role: 'user', sequence: 1, content: 'Soru', turnId: api.turns[0].input.turnId },
      { id: 'answer', role: 'assistant', sequence: 2, replyToId: 'user', content: 'Tam yanıt' }
    ] });
  } });
  const { controller, state } = await readyController({ api });
  controller.send('Soru');
  const [turn] = api.turns;
  turn.emit('accepted', acceptedData(CONVERSATION_A, turn, 'Soru'));
  controller.newConversation();
  const opening = controller.openConversation(CONVERSATION_A);
  turn.emit('delta', { text: 'Tam yanıt' });
  turn.resolve(doneResult(CONVERSATION_A));
  await drain();
  resolveRead({ ok: true, conversation: { id: CONVERSATION_A, title: 'Eski' }, messages: [
    { id: 'user', role: 'user', sequence: 1, content: 'Soru', turnId: turn.input.turnId }
  ] });
  await opening;
  assert.equal(reads, 2);
  assert.equal(state().active.turns[0].answer.status, 'complete');
  assert.equal(state().active.turns[0].answer.content, 'Tam yanıt');
});

test('geciken ilk liste yeni konuşmayı ve güncel başlığı korur', async () => {
  let resolveList;
  const api = fakeApi({ listAssistantConversationsRequest: () => new Promise((resolve) => { resolveList = resolve; }) });
  const controller = createAssistantController({ api, createId });
  const activation = controller.activate();
  await drain();
  controller.send('Yeni');
  const [turn] = api.turns;
  turn.emit('accepted', acceptedData(CONVERSATION_A, turn, 'Yeni'));
  turn.resolve(doneResult(CONVERSATION_A));
  await drain();
  resolveList({ ok: true, conversations: [{ id: CONVERSATION_A, title: 'Eski' }, { id: CONVERSATION_B, title: 'Diğer' }], nextCursor: 'cursor' });
  await activation;
  assert.deepEqual(controller.getState().list.items.map((item) => item.title), ['Başlık', 'Diğer']);
  assert.equal(controller.getState().list.nextCursor, 'cursor');
});

test('bağlanmamış başarısız tur yeniden denenmeden atılmaz', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Eski');
  api.turns[0].resolve({ ok: false, code: 'NETWORK', retryable: true });
  await drain();
  assert.equal(controller.send('Yeni').ok, false);
  assert.deepEqual(state().active.turns.map((turn) => turn.user.content), ['Eski']);
  assert.equal(controller.retry(api.turns[0].input.turnId).ok, true);
  assert.equal(api.turns[1].input.turnId, api.turns[0].input.turnId);
});

test('kaydı doğrulanmamış yeniden deneme kesin kapanışta iletiyi taslağa geri verir', async () => {
  const { controller, api, state } = await readyController();
  await controller.openConversation(CONVERSATION_A);
  controller.send('Korunacak ileti');
  api.turns[0].resolve({ ok: false, phase: 'request', code: 'NETWORK', retryable: true });
  await drain();
  const turnKey = state().active.turns[0].key;
  assert.equal(controller.retry(turnKey).ok, true);
  api.turns[1].resolve({ ok: false, phase: 'request', code: 'NOT_FOUND', retryable: false });
  await drain();
  assert.equal(state().active.closed, true);
  assert.equal(state().active.recoveredDraft.text, 'Korunacak ileti');
  assert.equal(state().active.turns.length, 0);
});

test('Durdur sonrasında istek bitene kadar yeniden gönderilemez; geç çatışma yeniden denenebilir', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [turn] = api.turns;
  turn.emit('accepted', acceptedData(CONVERSATION_A, turn, 'Soru'));
  controller.stop();
  assert.equal(controller.canSend(), false);
  assert.equal(controller.retry(turn.input.turnId).ok, false);
  turn.resolve({ ok: false, cancelled: true });
  await drain();
  assert.equal(controller.retry(turn.input.turnId).ok, true);
  api.turns[1].resolve({ ok: false, code: 'CONFLICT', reason: 'GENERATION_IN_PROGRESS' });
  await drain();
  assert.equal(state().active.turns[0].answer.error.retryable, true);
});

test('silme sürerken gönderim engellenir ve eski liste silineni geri getiremez', async () => {
  let finishDelete;
  let finishList;
  const api = fakeApi({ deleteAssistantConversationRequest: () => new Promise((resolve) => { finishDelete = resolve; }) });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  api.listAssistantConversationsRequest = () => new Promise((resolve) => { finishList = resolve; });
  const listing = controller.refreshList();
  const deletion = controller.deleteConversation(CONVERSATION_A);
  assert.equal(controller.send('Silinen konuşmaya').ok, false);
  finishDelete({ ok: true });
  await deletion;
  finishList({ ok: true, conversations: [{ id: CONVERSATION_A, title: 'Silindi' }], nextCursor: null });
  await listing;
  assert.deepEqual(state().list.items, []);
});

test('yalnız derin kip kullanılabiliyorsa gönderim o kiple yapılır', async () => {
  const api = fakeApi({ loadAssistantReadinessRequest: async () => ({ ok: true, assistant: {
    ...READINESS, modes: [{ id: 'standard', available: false }, { id: 'deep', available: true }]
  } }) });
  const { controller } = await readyController({ api });
  controller.send('Soru');
  assert.equal(api.turns[0].input.mode, 'deep');
});

test('hazırlık yenilemesi anahtar kaldırılınca gönderimi kapatır', async () => {
  const { controller, api } = await readyController();
  api.loadAssistantReadinessRequest = async () => ({ ok: true, assistant: { ...READINESS, available: false, reason: 'AI_KEY_MISSING' } });
  await controller.activate({ refresh: true });
  assert.equal(controller.canSend(), false);
});

test('artan Markdown çözümlemesi tam çözümle eşleşir ve biten blokları yeniden kullanır', async () => {
  const { createAssistantMarkdownParser } = await import('../src/features/ai/assistant/assistantMarkdown.js');
  const parse = createAssistantMarkdownParser();
  const source = '# Başlık\n\nBir **paragraf**.\n\n- bir\n  - alt\n\n- iki\n\n> alıntı\n> devam\n\n|a|b|\n|-|-|\n|1|2|\n\n```js\nconst a = 1;\n```\n\nSon <https://example.com>.';
  for (let size = 1; size <= source.length; size += 1) {
    assert.deepEqual(parse(source.slice(0, size)), parseAssistantMarkdown(source.slice(0, size)), `uzunluk ${size}`);
  }
  const first = parse(source)[0];
  assert.equal(parse(source + '\n\nYeni paragraf')[0], first);
  assert.deepEqual(parse('Yeni yanıt'), parseAssistantMarkdown('Yeni yanıt'));
});

test('açısal bağlantı taraması eksik veya çok uzaktaki kapanışta doğrusal kalır', () => {
  const original = String.prototype.indexOf;
  let searched = 0;
  String.prototype.indexOf = function (needle, from) {
    if (needle === '>') searched += this.length - (from || 0);
    return original.call(this, needle, from);
  };
  try {
    for (const suffix of ['', '>']) {
      const text = '<'.repeat(64000) + suffix;
      assert.equal(parseInline(text).map((node) => node.value).join(''), text);
    }
    assert.ok(searched <= 128002, `taranan karakter ${searched}`);
  } finally {
    String.prototype.indexOf = original;
  }
});

test('masaüstünde panel dışındaki Escape kapatır; IME ve önlenen olaylar kapatmaz', async (t) => {
  const previous = globalThis.window;
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.MutationObserver;
  globalThis.document = { body: { classList: { contains: () => false } } };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.document = previousDocument; globalThis.MutationObserver = previousObserver; });
  const events = new EventTarget();
  globalThis.window = events;
  t.after(() => { globalThis.window = previous; });
  const { controller } = await readyController();
  let closed = 0;
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close: () => { closed += 1; } };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  t.after(() => panel.unmount());
  const escape = (extra = {}) => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: 'Escape', ...extra });
    return event;
  };
  events.dispatchEvent(escape({ isComposing: true }));
  events.dispatchEvent(escape({ keyCode: 229 }));
  const prevented = escape();
  prevented.preventDefault();
  events.dispatchEvent(prevented);
  assert.equal(closed, 0);
  events.dispatchEvent(escape());
  assert.equal(closed, 1);
  panel.render({ assistant: { ...assistant, open: false } });
  events.dispatchEvent(escape());
  assert.equal(closed, 1, 'kapalı panel dinleyiciyi bırakır');
});

test('modal odak tuzağı gezinme kapanışında odağı geri almaz', async (t) => {
  const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
  const previous = globalThis.document;
  let restored = 0;
  const opener = { isConnected: true, focus() { restored += 1; } };
  globalThis.document = { activeElement: opener, addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.document = previous; });
  const restoreFocusEnabledRef = { current: true };
  const props = { containerRef: { current: null }, initialFocusRef: { current: null }, restoreFocusRef: { current: opener }, restoreFocusEnabledRef, enabled: true };
  const probe = mountComponent((input) => { useModalFocusTrap(input); return null; }, props);
  t.after(() => probe.unmount());
  restoreFocusEnabledRef.current = false;
  probe.render({ ...props, enabled: false });
  assert.equal(restored, 0);
  restoreFocusEnabledRef.current = true;
  probe.render(props);
  probe.render({ ...props, enabled: false });
  assert.equal(restored, 0, 'odak DOM temizlenmeden geri verilmez');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(restored, 1, 'olağan kapanış hâlâ odağı geri verir');
});

test('anahtar değişiminde son hazırlık okuması kazanır', async () => {
  const { controller, api } = await readyController();
  const pending = [];
  api.loadAssistantReadinessRequest = () => new Promise((resolve) => pending.push(resolve));
  const first = controller.activate({ refresh: true });
  const second = controller.activate({ refresh: true });
  pending[1]({ ok: true, assistant: { ...READINESS, available: false, reason: 'AI_KEY_MISSING' } });
  await second;
  pending[0]({ ok: true, assistant: READINESS });
  await first;
  assert.equal(controller.canSend(), false);
});

test('Durdur ile yarışan kabul konuşmayı bağlar ve tamamlanan yanıt kazanır', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [run] = api.turns;
  controller.stop();
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'Soru'));
  assert.equal(state().active.id, CONVERSATION_A);
  assert.equal(state().list.items[0].id, CONVERSATION_A);
  assert.equal(state().running[CONVERSATION_A].phase, 'stopping');
  run.emit('delta', { text: 'Tam yanıt' });
  run.resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(state().active.turns[0].answer.status, 'complete');
  assert.equal(state().active.turns[0].answer.content, 'Tam yanıt');
  assert.equal(Object.keys(state().running).length, 0);
});

test('SQL yanıtı canlı metin, Durdur ve geç hata tarafından değiştirilemez', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [run] = api.turns;
  const accepted = acceptedData(CONVERSATION_A, run, 'Soru');
  accepted.context.trimmed = true;
  run.emit('accepted', accepted);
  run.emit('delta', { text: 'Kısmi' });
  api.loadAssistantConversationRequest = async (id) => ({ ok: true, conversation: { id, title: 'Soru' }, messages: [
    { ...accepted.userMessage, role: 'user', sequence: 1 },
    { id: createId(), role: 'assistant', sequence: 2, replyToId: accepted.userMessage.id, content: 'SQL tam yanıtı', mode: 'standard' }
  ] });
  controller.newConversation();
  await controller.openConversation(CONVERSATION_A);
  assert.equal(state().active.turns[0].answer.status, 'complete');
  assert.equal(state().active.turns[0].contextTrimmed, true);
  run.emit('delta', { text: ' geç metin' });
  controller.stop();
  run.resolve({ ok: false, code: 'REQUEST_CANCELLED', cancelled: true });
  await drain();
  assert.equal(state().active.turns[0].answer.status, 'complete');
  assert.equal(state().active.turns[0].answer.content, 'SQL tam yanıtı');
});

test('başarısız silme istemci üretimini kesmez; başarılı silme geç sonucu geri getirmez', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [run] = api.turns;
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'Soru'));
  api.deleteAssistantConversationRequest = async () => ({ ok: false, code: 'DATABASE_UNAVAILABLE' });
  assert.equal((await controller.deleteConversation(CONVERSATION_A)).ok, false);
  assert.equal(run.input.signal.aborted, false);
  assert.ok(state().running[CONVERSATION_A]);
  api.deleteAssistantConversationRequest = async () => ({ ok: true });
  await controller.deleteConversation(CONVERSATION_A);
  assert.equal(run.input.signal.aborted, true);
  run.resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
  assert.equal(Object.keys(state().running).length, 0);
});

test('var olan konuşmada kabul edilmemiş tur korunur', async () => {
  const { controller, api, state } = await readyController();
  await controller.openConversation(CONVERSATION_A);
  controller.send('Kaydedilmeyen');
  api.turns[0].resolve({ ok: false, code: 'CONFLICT' });
  await drain();
  assert.equal(controller.send('Yeni soru').ok, false);
  assert.deepEqual(state().active.turns.map((turn) => turn.user.content), ['Kaydedilmeyen']);
});

test('canlı tura dönüşte kısaltılmış bağlam uyarısı korunur', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [run] = api.turns;
  const accepted = acceptedData(CONVERSATION_A, run, 'Soru');
  accepted.context.trimmed = true;
  run.emit('accepted', accepted);
  api.loadAssistantConversationRequest = async (id) => ({ ok: true, conversation: { id, title: 'Soru' }, messages: [{ ...accepted.userMessage, role: 'user', sequence: 1 }] });
  controller.newConversation();
  await controller.openConversation(CONVERSATION_A);
  assert.equal(state().active.turns[0].contextTrimmed, true);
});

test('aynı satırdaki ters tırnak kodu çit açmaz; dört boşluklu çit kod içinde kalır', () => {
  for (const inline of ['```x```', '```npm install``` komutunu çalıştırın']) {
    const blocks = parseAssistantMarkdown(`${inline}\n\n# Başlık`);
    assert.equal(blocks[0].type, 'paragraph');
    assert.equal(blocks.at(-1).type, 'heading');
  }
  for (const indent of ['    ', '\t']) {
    const blocks = parseAssistantMarkdown('```js\n' + indent + '```\n# kod\n```\n\n# Başlık');
    assert.equal(blocks[0].type, 'code');
    assert.match(blocks[0].text ?? blocks[0].content ?? '', /# kod/);
    assert.equal(blocks.at(-1).type, 'heading');
  }
});

test('taslak panel kapanışında korunur ve konuşma değişiminde temizlenir', async (t) => {
  const { controller } = await readyController();
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  t.after(() => panel.unmount());
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  composer().props.onChange('A taslağı');
  panel.render();
  panel.render({ assistant: { ...assistant, open: false } });
  panel.render({ assistant });
  assert.equal(composer().props.value, 'A taslağı');
  await controller.openConversation(CONVERSATION_B);
  panel.render();
  assert.equal(composer().props.value, '');
});

test('En yeni kaydırmasının ara olayları izlemeyi kapatmaz; yukarı kaydırmak kapatır', () => {
  const turns = [{ key: 'tur', user: { content: 'Soru' }, answer: { status: 'streaming', content: 'Yanıt' } }];
  const view = mountComponent(AssistantThread, { conversationKey: 'a', turns });
  const node = { scrollTop: 100, scrollHeight: 1000, clientHeight: 200, scrollTo() {} };
  const scroll = () => findElement(view.output, (element) => element.props?.className === 'rota-assistant-thread');
  const jump = () => findElement(view.output, (element) => element.props?.className === 'rota-assistant-jump');
  scroll().ref.current = node;
  scroll().props.onScroll({ currentTarget: node });
  node.scrollTop = 50;
  scroll().props.onScroll({ currentTarget: node });
  view.render();
  assert.ok(jump());
  jump().props.onClick();
  view.render();
  node.scrollTop = 150;
  scroll().props.onScroll({ currentTarget: node });
  view.render();
  assert.equal(jump(), null);
  node.scrollTop = 100;
  scroll().props.onScroll({ currentTarget: node });
  view.render();
  assert.ok(jump());
  view.unmount();
});

test('proje penceresinin Escape olayı önce açılmış yardımcıyı kapatmaz', async (t) => {
  const { ProjectCreateDialog } = await import('../src/components/shell/ProjectCreateDialog.jsx');
  const previous = globalThis.window;
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.MutationObserver;
  globalThis.document = { body: { classList: { contains: () => false } } };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const listeners = [];
  globalThis.window = {
    addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) { const i = listeners.findIndex((item) => item.type === type && item.fn === fn); if (i >= 0) listeners.splice(i, 1); }
  };
  globalThis.document.addEventListener = (type, fn) => listeners.push({ type, fn, document: true });
  globalThis.document.removeEventListener = globalThis.window.removeEventListener;
  const { controller } = await readyController();
  const closed = [];
  const panel = mountComponent(RotaAssistantPanel, { assistant: {
    controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() { closed.push('assistant'); }
  } });
  const dialog = mountComponent(ProjectCreateDialog, { open: true, onClose() { closed.push('project'); } });
  t.after(() => { dialog.unmount(); panel.unmount(); globalThis.window = previous; globalThis.document = previousDocument; globalThis.MutationObserver = previousObserver; });
  const event = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const { fn } of [...listeners].filter((item) => item.type === 'keydown').sort((a, b) => Number(Boolean(b.document)) - Number(Boolean(a.document)))) fn(event);
  assert.deepEqual(closed, ['project']);
  closed.length = 0;
  const consumed = { ...event, defaultPrevented: true };
  for (const { fn } of listeners.filter((item) => item.type === 'keydown')) fn(consumed);
  assert.deepEqual(closed, [], 'alt seçicinin tükettiği Escape üst pencereleri kapatmaz');
});

test('hazırlık yenilenirken gönderim kapanır, çalışan turun Durdur eylemi kalır', async () => {
  const { controller, api } = await readyController();
  controller.send('Soru');
  let resolve;
  api.loadAssistantReadinessRequest = () => new Promise((done) => { resolve = done; });
  const refresh = controller.activate({ refresh: true });
  assert.equal(controller.canSend(), false);
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  let composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  assert.equal(composer.props.generating, true);
  assert.equal(composer.props.disabled, false, 'yenileme yazma odağını kaybettirmez');
  assert.equal(composer.props.submitDisabled, true);
  assert.equal(controller.canSend(), false);
  resolve({ ok: true, assistant: { ...READINESS, available: false, reason: 'AI_KEY_MISSING' } });
  await refresh;
  panel.render();
  composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  assert.equal(composer.props.generating, true);
  composer.props.onStop();
  assert.equal(api.turns[0].input.signal.aborted, true);
  panel.unmount();
  controller.dispose();
});

test('kabul edilen taslağın görünüm anahtarı ve sonraki ileti metni korunur', async () => {
  const { controller, api, state } = await readyController();
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, launcherRef: { current: null }, close() {} } });
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  controller.send('İlk');
  panel.render();
  composer().props.onChange('Sonraki taslak');
  panel.render();
  const key = state().active.viewKey;
  api.turns[0].emit('accepted', acceptedData(CONVERSATION_A, api.turns[0], 'İlk'));
  panel.render();
  assert.equal(state().active.viewKey, key);
  assert.equal(composer().props.value, 'Sonraki taslak');
  panel.unmount();
  controller.dispose();
});

test('geçmiş yenilemesi, etkin konuşmanın yeniden okunması ve oturum hatası', async () => {
  let reads = 0;
  const api = fakeApi({ loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: `Okuma ${++reads}` }, messages: [] }) });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  await controller.openConversation(CONVERSATION_A);
  assert.equal(reads, 2);
  api.listAssistantConversationsRequest = async () => ({ ok: true, conversations: [{ id: CONVERSATION_B, title: 'Başka pencere' }], nextCursor: null });
  await controller.activate({ refresh: true });
  assert.equal(state().list.items[0].id, CONVERSATION_B);
  api.listAssistantConversationsRequest = async () => ({ ok: false, code: 'SESSION_REQUIRED' });
  await controller.activate({ refresh: true });
  assert.equal(controller.canSend(), false);
  assert.equal(state().failure.action, 'reload');
});

test('sayfalama güncellenip başa taşınan konuşmayı atlamaz', async () => {
  const a = { id: CONVERSATION_A, updatedAt: '2026-09-26T10:00:00Z' };
  const b = { id: CONVERSATION_B, updatedAt: '2026-09-26T09:00:00Z' };
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [a], nextCursor: 'old' }) });
  const { controller, state } = await readyController({ api });
  const cursors = [];
  api.listAssistantConversationsRequest = async ({ cursor }) => {
    cursors.push(cursor);
    return cursor == null ? { ok: true, conversations: [{ ...b, updatedAt: '2026-09-26T11:00:00Z' }], nextCursor: 'new' }
      : { ok: true, conversations: [a], nextCursor: null };
  };
  await controller.loadMore();
  // Baş sayfa yeniden okunur; eski sayfalar var olan imleçten sürer (tüm geçmiş yeniden oynatılmaz).
  assert.deepEqual(cursors, [null, 'new', 'old']);
  assert.deepEqual(state().list.items.map((item) => item.id), [b.id, a.id]);
});

test('yeniden oynatılan eski konuşma etkinlik sırasını bozmaz', async () => {
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [{ id: CONVERSATION_B, updatedAt: '2026-09-27' }], nextCursor: null }) });
  const { controller, state } = await readyController({ api });
  controller.send('Soru');
  const data = acceptedData(CONVERSATION_A, api.turns[0], 'Soru');
  data.conversation.updatedAt = '2026-09-26';
  api.turns[0].emit('accepted', data);
  assert.equal(state().list.items[0].id, CONVERSATION_B);
  controller.dispose();
});

test('silme hatası son konuşmalarda da görünür', async () => {
  const api = fakeApi({
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [{ id: CONVERSATION_A, title: 'Başlık' }], nextCursor: null }),
    deleteAssistantConversationRequest: async () => ({ ok: false, code: 'NETWORK' })
  });
  const { controller, state } = await readyController({ api });
  await controller.deleteConversation(CONVERSATION_A);
  const list = mountComponent(AssistantConversationList, { list: state().list, limit: 4 });
  assert.match(textOf(list.output), /Bağlantı sorunu/);
  list.unmount();
});

test('tablo satırları sınırlanır, kalan içerik tek metin düğümünde korunur', () => {
  const source = '| başlık |\n| --- |\n' + '|x|\n'.repeat(15000);
  const blocks = parseAssistantMarkdown(source);
  assert.equal(blocks[0].rows.length, 200);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].children.length, 1);
  assert.equal(blocks[1].children[0].value.split('\n').length, 14800);
});

test('Retry-After dolmadan denetleyici ve düğme yeniden denemeyi engeller', async (t) => {
  const oldNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  t.after(() => { Date.now = oldNow; });
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  api.turns[0].resolve({ ok: false, code: 'AI_RATE_LIMITED', retryAfterMs: 30000 });
  await drain();
  const turn = state().active.turns[0];
  assert.equal(turn.answer.error.retryAt, 31000);
  assert.equal(controller.retry(turn.key).ok, false);
  const view = mountComponent(AssistantTurn, { turn, canRetry: true });
  const notice = findElement(view.output, (node) => node.props?.failure);
  const rendered = mountComponent(notice.type, notice.props);
  assert.equal(findElement(rendered.output, (node) => node.type === 'button').props.disabled, true);
  assert.match(textOf(rendered.output), /30 sn/);
  now = 31000;
  assert.equal(controller.retry(turn.key).ok, true);
  rendered.unmount();
  view.unmount();
  controller.dispose();
});

test('kapanan modal daha yeni bir yüzeyin odağını geri almaz', async (t) => {
  const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
  const previous = globalThis.document;
  let restores = 0;
  const opener = { isConnected: true, focus() { restores += 1; } };
  globalThis.document = { activeElement: opener, body: {}, addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.document = previous; });
  const props = { containerRef: { current: null }, initialFocusRef: { current: null }, enabled: true };
  const probe = mountComponent((input) => { useModalFocusTrap(input); return null; }, props);
  t.after(() => probe.unmount());
  probe.render({ ...props, enabled: false });
  globalThis.document.activeElement = { isConnected: true };
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(restores, 0);

});

test('geçmiş zaman etiketleri dakika geçince yenilenir ve zamanlayıcı temizlenir', (t) => {
  const previous = { now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  let now = Date.parse('2026-09-27T10:00:00Z');
  let tick;
  let cleared = false;
  Date.now = () => now;
  globalThis.setInterval = (fn, ms) => { assert.equal(ms, 60000); tick = fn; return 1; };
  globalThis.clearInterval = () => { cleared = true; };
  t.after(() => { Date.now = previous.now; globalThis.setInterval = previous.setInterval; globalThis.clearInterval = previous.clearInterval; });
  const list = mountComponent(AssistantConversationList, { list: { items: [{ id: CONVERSATION_A, updatedAt: new Date(now).toISOString() }] } });
  const row = () => findElement(list.output, (node) => node.props?.item);
  assert.equal(presentation.relativeTimeLabel(row().props.item.updatedAt, row().props.now), 'şimdi');
  now += 120000;
  tick();
  list.render();
  assert.equal(presentation.relativeTimeLabel(row().props.item.updatedAt, row().props.now), '2 dk önce');
  list.unmount();
  assert.equal(cleared, true);
});

test('hazırlık veya görünüm değişimi odak isteği olmadan odağı çalmaz', async (t) => {
  const previous = globalThis.document;
  globalThis.document = { activeElement: null };
  t.after(() => { globalThis.document = previous; });
  const { controller, api } = await readyController();
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  let focused = 0;
  const composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  composer.props.inputRef.current = { focus() { focused += 1; } };
  panel.render({ assistant: { ...assistant, focusRequest: 1 } });
  focused = 0;
  controller.setView('history');
  panel.render();
  controller.setView('chat');
  panel.render();
  api.loadAssistantReadinessRequest = async () => ({ ok: true, assistant: { ...READINESS, available: false } });
  await controller.activate({ refresh: true });
  panel.render();
  assert.equal(focused, 0);
  panel.render({ assistant: { ...assistant, focusRequest: 2 } });
  assert.equal(focused, 1);
  panel.unmount();
});


test('yanıt kopyası görünen metindir; geçerli URL sonları korunur', async () => {
  const { assistantMarkdownText } = await import('../src/features/ai/assistant/assistantMarkdown.js');
  assert.equal(assistantMarkdownText('**Önemli** [doküman](https://example.com)'), 'Önemli doküman');
  assert.equal(assistantMarkdownText('```js\na_b > 3\n```'), 'a_b > 3');
  for (const end of ['_', '~', '*']) {
    const url = `https://example.com/item${end}`;
    const link = parseInline(url).find((node) => node.type === 'link');
    assert.equal(link.href, url);
  }
  const turn = { key: 'a', user: { content: 'Soru' }, answer: { status: 'complete', content: '**Önemli** [doküman](https://example.com)' } };
  const view = mountComponent(AssistantTurn, { turn });
  const copyButton = findElement(view.output, (node) => node.type?.name === 'CopyAnswerButton');
  // Kopya metni çizimde değil tıklamada çıkarılır; kopyalanan metin görünen metindir.
  assert.equal(copyButton.props.source, turn.answer.content);
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const written = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text) => written.push(text) } } });
  try {
    const button = mountComponent(copyButton.type, copyButton.props);
    await findElement(button.output, (node) => node.type === 'button').props.onClick();
    button.unmount();
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
  }
  assert.deepEqual(written, ['Önemli doküman']);
  view.unmount();
});

test('bağlantı etiketleri ortak biçim belirteci bütçesini aşamaz', () => {
  const budget = { delimiters: 398 };
  const nodes = parseInline('[**bir**](https://example.com) [**iki**](https://example.com)', { budget });
  assert.equal(budget.delimiters, 400);
  const links = nodes.filter((node) => node.type === 'link');
  assert.equal(links[0].children[0].type, 'strong');
  assert.equal(links[1].children.some((node) => node.type === 'strong'), false);
});

test('kabul öncesi kesin ret taslağı korur ve yeni iletiyi kilitlemez', async () => {
  for (const existing of [false, true]) {
    const { controller, api, state } = await readyController();
    if (existing) await controller.openConversation(CONVERSATION_A);
    controller.send('Korunacak soru');
    api.turns[0].resolve({ ok: false, phase: 'request', code: 'AI_CONFIGURATION_ERROR', reason: 'MODE_UNAVAILABLE' });
    await drain();
    assert.equal(state().active.turns.length, 0);
    assert.equal(state().active.recoveredDraft.text, 'Korunacak soru');
    assert.ok(state().active.notice);
    assert.equal(controller.send('Yeni soru').ok, true);
    controller.dispose();
  }
});

test('ilk geçmiş hatası boş karşılama ekranında gösterilir', async () => {
  const { controller } = await readyController({ api: fakeApi({ listAssistantConversationsRequest: async () => ({ ok: false, code: 'DATABASE_UNAVAILABLE' }) }) });
  await drain();
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
  const welcome = findElement(panel.output, (node) => node.type?.name === 'Welcome');
  const list = findElement(welcome.props.recent, (node) => node.type === AssistantConversationList);
  assert.ok(list.props.list.error);
  panel.unmount();
});

test('hazırlık beklerken başka modalın odağı korunur', async (t) => {
  const previous = globalThis.document;
  const body = {};
  globalThis.document = { activeElement: body, body };
  t.after(() => { globalThis.document = previous; });
  let ready;
  const controller = createAssistantController({ api: fakeApi({ loadAssistantReadinessRequest: () => new Promise((resolve) => { ready = resolve; }) }) });
  const pending = controller.activate();
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  t.after(() => { panel.unmount(); controller.dispose(); });
  globalThis.document.activeElement = { isConnected: true, closest: () => ({ role: 'dialog' }) };
  ready({ ok: true, assistant: READINESS });
  await pending;
  panel.render();
  let focused = 0;
  findElement(panel.output, (node) => node.type === AssistantComposer).props.inputRef.current = { focus() { focused += 1; } };
  panel.render();
  assert.equal(focused, 0);
});

test('açık panel mobil düzenden masaüstüne geçince yazma odağını korur', async (t) => {
  const previous = { window: globalThis.window, document: globalThis.document, observer: globalThis.MutationObserver };
  const media = { matches: false, addEventListener(_event, fn) { this.change = fn; }, removeEventListener() {} };
  const body = { classList: { contains: () => false } };
  globalThis.document = { body, activeElement: body, addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: (query) => query.includes('760') ? media : null, addEventListener() {}, removeEventListener() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const { controller } = await readyController();
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  t.after(() => { panel.unmount(); controller.dispose(); globalThis.window = previous.window; globalThis.document = previous.document; globalThis.MutationObserver = previous.observer; });
  let restored = 0;
  const heading = { isConnected: true, focus() { restored += 1; globalThis.document.activeElement = heading; } };
  const input = { isConnected: true, focus() { globalThis.document.activeElement = input; } };
  panel.output.ref.current = { contains: (node) => node === heading || node === input, setAttribute() {}, removeAttribute() {} };
  findElement(panel.output, (node) => node.type === AssistantComposer).props.inputRef.current = input;
  globalThis.document.activeElement = heading;
  media.matches = true;
  media.change();
  panel.render();
  assert.equal(globalThis.document.activeElement, input);
  media.matches = false;
  media.change();
  panel.render();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(restored, 0);
  assert.equal(globalThis.document.activeElement, input);
});


test('yeniden denemedeki kesin ret önceki belirsiz teslimatı silmez', async () => {
  const { controller, api, state } = await readyController();
  await controller.openConversation(CONVERSATION_A);
  controller.send('Teslim edilmiş olabilir');
  api.turns[0].resolve({ ok: false, code: 'NETWORK_ERROR' });
  await drain();
  controller.retry(state().active.turns[0].key);
  api.turns[1].resolve({ ok: false, phase: 'request', code: 'AI_CONFIGURATION_ERROR' });
  await drain();
  assert.equal(state().active.turns.length, 1);
  assert.equal(state().active.turns[0].answer.status, 'failed');
  controller.dispose();
});

/* ── İnceleme bulgularının gerilemeleri ───────────────────── */

test('sunum: sunucu iptali Durdur değildir; geçersiz sağlayıcı yanıtı yinelenemez; olağan dışı bitiş nedeni açıklanır', () => {
  const cancelled = presentation.assistantFailureView({ code: 'AI_CANCELLED' });
  assert.doesNotMatch(cancelled.message, /durdurdunuz/);
  assert.match(cancelled.message, /sunucuda durduruldu/);
  assert.match(presentation.assistantFailureView({ code: 'REQUEST_CANCELLED' }).message, /durdurdunuz/);
  assert.equal(presentation.assistantFailureView({ code: 'AI_PROVIDER_RESPONSE_INVALID', retryable: false }).retryable, false);
  assert.equal(presentation.assistantFailureView({ code: 'AI_PROVIDER_RESPONSE_INVALID' }).retryable, false);
  assert.match(presentation.finishReasonNote('content_filter'), /içerik süzgeci/);
  assert.match(presentation.finishReasonNote('tool_calls'), /eksik olabilir/);
  assert.equal(presentation.finishReasonNote(null), null);
  assert.equal(presentation.assistantFailureView({ code: 'AI_KEY_INVALID', credentialSource: 'personal' }).credential, true);
});

test('eşit zamanlı konuşmalar sunucunun kimlik sırasını (SQL Server uniqueidentifier) izler', async () => {
  const at = '2026-09-26T10:00:00.000Z';
  // Metin olarak küçük ama SQL Server sırasında büyük (son grup en anlamlıdır).
  const high = { id: '00000000-0000-4000-8000-000000000001', title: 'Yüksek', updatedAt: at };
  const low = { id: 'ffffffff-0000-4000-8000-000000000000', title: 'Düşük', updatedAt: at };
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [low, high], nextCursor: null }) });
  const { state } = await readyController({ api });
  assert.deepEqual(state().list.items.map((item) => item.title), ['Yüksek', 'Düşük']);
});

test('kabul öncesi belirsiz hata (akış kurulamadı) turu atmaz; aynı kimlikle yeniden denenir', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Belki kaydedildi');
  api.turns[0].resolve({ ok: false, phase: 'request', code: 'AI_INTERNAL_ERROR', status: 500, retryable: false });
  await drain();
  assert.deepEqual(state().active.turns.map((turn) => turn.user.content), ['Belki kaydedildi']);
  assert.equal(state().active.turns[0].answer.error.retryable, true);
  assert.equal(controller.send('Yeni').ok, false);
  assert.equal(controller.retry(api.turns[0].input.turnId).ok, true);
  assert.equal(api.turns[1].input.turnId, api.turns[0].input.turnId);
});

test('kimliği doğrulanmamış turun yeniden denemesi kesin retle de kilitlenmez', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  api.turns[0].resolve({ ok: false, code: 'NETWORK', retryable: true });
  await drain();
  controller.retry(state().active.turns[0].key);
  api.turns[1].resolve({ ok: false, phase: 'request', code: 'AI_DISABLED' });
  await drain();
  assert.equal(state().active.turns[0].answer.error.retryable, true);
  assert.equal(retryableTurnKey(state().active.turns), api.turns[0].input.turnId);
});

test('dolan ya da silinmiş konuşmaya yeni ileti gönderilemez; taslak korunur', async () => {
  for (const failure of [{ code: 'CONFLICT', reason: 'CONVERSATION_FULL' }, { code: 'NOT_FOUND' }]) {
    const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [{ id: CONVERSATION_A, title: 'A', updatedAt: '2026-09-26T10:00:00.000Z' }], nextCursor: null }) });
    const { controller, state } = await readyController({ api });
    await controller.openConversation(CONVERSATION_A);
    controller.send('Sığmayan soru');
    api.turns[0].resolve({ ok: false, phase: 'request', ...failure });
    await drain();
    assert.equal(state().active.closed, true, failure.code);
    assert.equal(state().active.recoveredDraft.text, 'Sığmayan soru');
    assert.equal(controller.canSend(), false);
    assert.equal(controller.send('Tekrar').ok, false);
    assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), failure.code !== 'NOT_FOUND');
    controller.newConversation();
    assert.equal(controller.canSend(), true, 'yeni konuşmada gönderim açılır');
    controller.dispose();
  }
});

test('kabul öncesi oturum hatası panel düzeyinde bir kez gösterilir', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  api.turns[0].resolve({ ok: false, phase: 'request', code: 'SESSION_REQUIRED' });
  await drain();
  assert.equal(state().status, 'error');
  assert.equal(state().failure.action, 'reload');
  assert.equal(state().active.notice, null);
});

test('Geçmiş’te açık konuşma silinince liste görünümü korunur', async () => {
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [{ id: CONVERSATION_A, title: 'A' }, { id: CONVERSATION_B, title: 'B' }], nextCursor: null }) });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  controller.setView('history');
  await controller.deleteConversation(CONVERSATION_A);
  assert.equal(state().view, 'history');
  assert.equal(state().active.id, null);
  assert.deepEqual(state().list.items.map((item) => item.id), [CONVERSATION_B]);
});

test('Durdur ya da kopan akıştan sonra konuşma sunucuyla uzlaştırılır; kaydedilen yanıt tamamlanmış görünür', async () => {
  for (const outcome of ['stop', 'network']) {
    let release;
    const api = fakeApi();
    const { controller, state } = await readyController({ api });
    controller.send('Soru');
    const [run] = api.turns;
    const data = acceptedData(CONVERSATION_A, run, 'Soru');
    run.emit('accepted', data);
    run.emit('delta', { text: 'Kısmi' });
    api.loadAssistantConversationRequest = (id) => new Promise((resolve) => { release = () => resolve({ ok: true, conversation: { id, title: 'Soru' }, messages: [
      { ...data.userMessage, role: 'user', sequence: 1 },
      { id: createId(), role: 'assistant', sequence: 2, replyToId: data.userMessage.id, content: 'Kaydedilmiş tam yanıt', mode: 'standard', finishReason: 'stop' }
    ] }); });
    if (outcome === 'stop') {
      controller.stop();
      run.resolve({ ok: false, code: 'REQUEST_CANCELLED', cancelled: true, partial: true });
    } else {
      run.resolve({ ok: false, code: 'NETWORK', retryable: true, partial: true });
    }
    await drain();
    assert.equal(controller.canSend(), false, `${outcome}: uzlaştırma bitmeden yeni tur başlamaz`);
    assert.equal(controller.canSend({ retry: true }), true, 'aynı tur uzlaştırma sırasında yinelenebilir');
    release();
    await drain();
    assert.equal(state().active.turns[0].answer.status, 'complete', outcome);
    assert.equal(state().active.turns[0].answer.content, 'Kaydedilmiş tam yanıt');
    assert.equal(controller.canSend(), true);
    controller.dispose();
  }
});

test('uzlaştırma yanıt bulamazsa kısmi metin ve yeniden deneme korunur', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [run] = api.turns;
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'Soru'));
  run.emit('delta', { text: 'Kısmi' });
  run.resolve({ ok: false, code: 'STREAM_INTERRUPTED', retryable: true, partial: true });
  await drain();
  assert.equal(state().active.turns[0].answer.status, 'interrupted');
  assert.equal(state().active.turns[0].answer.content, 'Kısmi');
  assert.equal(controller.retry(run.input.turnId).ok, true);
});

test('yeniden deneme yeni metin üretmeden biterse önceki kısmi yanıt korunur', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [first] = api.turns;
  first.emit('accepted', acceptedData(CONVERSATION_A, first, 'Soru'));
  first.emit('delta', { text: 'Önceki kısmi yanıt' });
  controller.stop();
  first.resolve({ ok: false, code: 'REQUEST_CANCELLED', cancelled: true, partial: true });
  await drain();
  assert.equal(controller.retry(first.input.turnId).ok, true);
  api.turns[1].resolve({ ok: false, phase: 'request', code: 'DATABASE_UNAVAILABLE', retryable: true });
  await drain();
  assert.equal(state().active.turns[0].answer.content, 'Önceki kısmi yanıt');
  controller.retry(first.input.turnId);
  controller.stop();
  assert.equal(state().active.turns[0].answer.content, 'Önceki kısmi yanıt', 'metin gelmeden durdurulan deneme de korur');
});

test('yerini yeni okumaya bırakan liste okuması kesilir', async () => {
  const signals = [];
  const pending = [];
  const { controller, api } = await readyController();
  api.listAssistantConversationsRequest = ({ signal }) => new Promise((resolve) => { signals.push(signal); pending.push(resolve); });
  const first = controller.refreshList();
  const second = controller.refreshList();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  pending.forEach((resolve) => resolve({ ok: true, conversations: [], nextCursor: null }));
  await Promise.all([first, second]);
});

test('açık paneldeki geçici hazırlık hatası konuşmayı gizlemez; bildirim olarak gösterilir ve sonra temizlenir', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  api.loadAssistantReadinessRequest = async () => ({ ok: false, code: 'NETWORK', retryable: true });
  await controller.activate({ refresh: true });
  assert.equal(state().status, 'ready');
  assert.equal(state().active.turns.length, 1);
  assert.equal(state().active.notice.title, 'Bağlantı sorunu');
  api.loadAssistantReadinessRequest = async () => ({ ok: true, assistant: READINESS });
  await controller.activate({ refresh: true });
  assert.equal(state().active.notice, null);
  controller.dispose();
});

test('anahtar düzeltilip hazırlık yenilenince anahtar hatasıyla biten tur yeniden denenebilir olur', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const [run] = api.turns;
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'Soru'));
  run.resolve({ ok: false, phase: 'stream', code: 'AI_KEY_INVALID', credentialSource: 'personal' });
  await drain();
  assert.equal(state().active.turns[0].answer.error.retryable, false);
  await controller.activate({ refresh: true });
  assert.equal(state().active.turns[0].answer.error.retryable, true);
  assert.equal(controller.retry(run.input.turnId).ok, true);
});

test('kopya metni liste işaretlerini ve sıra numaralarını korur', async () => {
  const { assistantMarkdownText } = await import('../src/features/ai/assistant/assistantMarkdown.js');
  assert.equal(assistantMarkdownText('1. Birinci\n2. İkinci\n   - alt\n\n- a\n- b'), '1. Birinci\n2. İkinci\n   • alt\n\n• a\n• b');
  assert.equal(assistantMarkdownText('3. Üç\n4. Dört'), '3. Üç\n4. Dört');
});

test('Markdown blok ve liste maddesi sayısı sınırlıdır; kalan içerik düz metin olarak korunur', async () => {
  const { MARKDOWN_LIMITS, createAssistantMarkdownParser } = await import('../src/features/ai/assistant/assistantMarkdown.js');
  const source = '- x\n'.repeat(16000);
  const blocks = parseAssistantMarkdown(source);
  const count = (items) => items.reduce((sum, block) => sum + 1 + (block.items ? block.items.reduce((inner, item) => inner + count(item), 0) : 0) + (block.type === 'quote' ? count(block.children) : 0), 0);
  assert.ok(count(blocks) <= MARKDOWN_LIMITS.maxBlocks + blocks[0].items.length + 1);
  assert.ok(blocks[0].items.length < 16000);
  assert.equal(blocks.at(-1).type, 'paragraph');
  assert.equal(blocks.at(-1).children.length, 1);
  const parse = createAssistantMarkdownParser();
  for (const size of [4000, 9000, source.length]) assert.deepEqual(parse(source.slice(0, size)), parseAssistantMarkdown(source.slice(0, size)));
});

test('yanıt bitince "yanıt sürerken gönderilemez" açıklaması kalkar', () => {
  const { props } = composerProps({ generating: true });
  const view = mountComponent(AssistantComposer, props);
  keyDown(findElement(view.output, (node) => node.type === 'textarea'), {});
  view.render();
  assert.match(textOf(view.output), /Önce yanıtı durdurun/);
  view.render({ ...props, generating: false });
  assert.doesNotMatch(textOf(view.output), /Önce yanıtı durdurun/);
  view.unmount();
});

test('panel dışındaki Escape odağı başlatıcıya taşımaz; panel içindeki Escape taşır', async (t) => {
  const previous = { window: globalThis.window, document: globalThis.document, observer: globalThis.MutationObserver };
  const events = new EventTarget();
  const outside = { isConnected: true };
  const inside = { isConnected: true };
  globalThis.window = events;
  globalThis.document = { body: { classList: { contains: () => false } }, activeElement: outside };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.window = previous.window; globalThis.document = previous.document; globalThis.MutationObserver = previous.observer; });
  const { controller } = await readyController();
  const closes = [];
  const assistant = { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close: (options) => closes.push(options) };
  const panel = mountComponent(RotaAssistantPanel, { assistant });
  t.after(() => { panel.unmount(); controller.dispose(); });
  panel.output.ref.current = { contains: (node) => node === inside, setAttribute() {}, removeAttribute() {} };
  const escape = () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
  events.dispatchEvent(escape());
  globalThis.document.activeElement = inside;
  events.dispatchEvent(escape());
  assert.deepEqual(closes, [{ restoreFocus: false }, { restoreFocus: true }]);
});

test('yeni taslak yazılmışken reddedilen ileti kaybolmaz; geri alınabilir', async () => {
  const { controller, api } = await readyController();
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  controller.send('Reddedilen ileti');
  panel.render();
  composer().props.onChange('Yeni taslak');
  panel.render();
  api.turns[0].resolve({ ok: false, phase: 'request', code: 'AI_CONFIGURATION_ERROR', reason: 'MODE_UNAVAILABLE' });
  await drain();
  panel.render();
  assert.equal(composer().props.value, 'Yeni taslak', 'yazılan taslak ezilmez');
  const restore = findElement(panel.output, (node) => node.type === 'button' && textOf(node).includes('İletiyi geri al'));
  assert.ok(restore, 'reddedilen ileti geri alınabilir');
  restore.props.onClick();
  panel.render();
  assert.equal(composer().props.value, 'Reddedilen ileti\n\nYeni taslak');
  assert.equal(findElement(panel.output, (node) => node.type === 'button' && textOf(node).includes('İletiyi geri al')), null);
  panel.unmount();
  controller.dispose();
});

test('geçici konuşma yükleme hatası yeniden deneme eylemi sunar', async () => {
  let reads = 0;
  const api = fakeApi({ loadAssistantConversationRequest: async (id) => (++reads === 1
    ? { ok: false, code: 'DATABASE_UNAVAILABLE', message: 'Ulaşılamadı.' }
    : { ok: true, conversation: { id, title: 'A' }, messages: [] }) });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
  const retry = findElement(panel.output, (node) => node.type === 'button' && textOf(node).includes('Yeniden dene'));
  assert.ok(retry);
  await retry.props.onClick();
  await drain();
  assert.equal(reads, 2);
  assert.equal(state().active.failure, null);
  panel.unmount();
  controller.dispose();
});

test('silinen konuşma satırından sonra odak kalan satıra taşınır', async () => {
  const items = [{ id: CONVERSATION_A, title: 'A', updatedAt: new Date().toISOString() }, { id: CONVERSATION_B, title: 'B', updatedAt: new Date().toISOString() }];
  const list = { items, nextCursor: null, loading: false, loadingMore: false, error: null };
  let focused = null;
  const view = mountComponent(AssistantConversationList, { list, onOpen() {}, onDelete: async () => ({ ok: true }), onLoadMore() {}, onReload() {} });
  const row = (id) => findElement(view.output, (node) => node.props?.item?.id === id);
  row(CONVERSATION_B).props.openRef({ focus: () => { focused = CONVERSATION_B; } });
  row(CONVERSATION_A).props.onAskDelete();
  view.render();
  const confirm = row(CONVERSATION_A).props.onConfirmDelete();
  view.render({ list: { ...list, items: [items[1]] }, onOpen() {}, onDelete: async () => ({ ok: true }), onLoadMore() {}, onReload() {} });
  await confirm;
  view.render({ list: { ...list, items: [items[1]] }, onOpen() {}, onDelete: async () => ({ ok: true }), onLoadMore() {}, onReload() {} });
  assert.equal(focused, CONVERSATION_B);
  view.unmount();
});

test('arkadaki pencere, sonradan üstte açılan kipli pencerenin Escape olayını tüketmez', async (t) => {
  const { ProjectCreateDialog } = await import('../src/components/shell/ProjectCreateDialog.jsx');
  const { useModalFocusTrap } = await import('../src/hooks/useModalFocusTrap.js');
  const previous = { window: globalThis.window, document: globalThis.document };
  const listeners = [];
  globalThis.document = {
    activeElement: null,
    body: {},
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) { const i = listeners.findIndex((item) => item.type === type && item.fn === fn); if (i >= 0) listeners.splice(i, 1); }
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previous.window; globalThis.document = previous.document; });
  const closed = [];
  const dialog = mountComponent(ProjectCreateDialog, { open: true, onClose() { closed.push('project'); } });
  const palette = mountComponent((input) => { useModalFocusTrap(input); return null; }, {
    containerRef: { current: null }, initialFocusRef: { current: null }, onClose: () => closed.push('palette')
  });
  const escape = () => ({ key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  const fire = () => { const event = escape(); for (const { fn } of listeners.filter((item) => item.type === 'keydown')) fn(event); };
  fire();
  assert.deepEqual(closed, ['palette'], 'Escape en üstteki pencereyi kapatır');
  palette.unmount();
  fire();
  assert.deepEqual(closed, ['palette', 'project']);
  dialog.unmount();
});

test('kapalı ipucu Escape olayını tüketmez; açılmayı bekleyen ipucu tüketir', async (t) => {
  const { Tooltip } = await import('../src/components/ui-extras.jsx');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = mountComponent(Tooltip, { content: 'Açıklama', children: 'Tetik' });
  const trigger = () => findElement(view.output, (node) => typeof node.props?.onKeyDown === 'function');
  const escape = () => ({ key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  const closed = escape();
  trigger().props.onKeyDown(closed);
  assert.equal(closed.defaultPrevented, false, 'kapalı ipucu Escape’i üstteki pencereye bırakır');
  trigger().props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 10, bottom: 10 }) } });
  const pending = escape();
  trigger().props.onKeyDown(pending);
  assert.equal(pending.defaultPrevented, true, 'açılmayı bekleyen ipucu iptal edilir');
  view.render();
  const again = escape();
  trigger().props.onKeyDown(again);
  assert.equal(again.defaultPrevented, false, 'kapatılan ipucu sonraki Escape’i tüketmez');
  view.unmount();
});

test('kabul beklenirken konuşma değişimi reddedilen metni kaybettirmez', async () => {
  const { controller, api, state } = await readyController();
  await controller.openConversation(CONVERSATION_A);
  controller.send('Kaybolmamalı');
  controller.setView('history');
  assert.equal(controller.newConversation(), false);
  assert.equal(await controller.openConversation(CONVERSATION_B), false);
  api.turns[0].resolve({ ok: false, phase: 'request', code: 'CONFLICT', reason: 'CONVERSATION_FULL', retryable: false });
  await drain();
  assert.equal(state().active.id, CONVERSATION_A);
  assert.equal(state().active.recoveredDraft.text, 'Kaybolmamalı');
  assert.equal(controller.newConversation(), true);
  controller.dispose();
});

test('uzlaştırma ilk olumsuz okumadan sonra geç kaydedilen yanıtı bulur', async () => {
  const { controller, api, state } = await readyController({ reconciliationDelaysMs: [1, 1] });
  controller.send('Soru');
  const run = api.turns[0];
  const data = acceptedData(CONVERSATION_A, run, 'Soru');
  run.emit('accepted', data);
  let reads = 0;
  let release;
  api.loadAssistantConversationRequest = async () => {
    if (++reads === 1) return { ok: true, conversation: data.conversation, messages: [] };
    return new Promise((resolve) => { release = () => resolve({ ok: true, conversation: data.conversation, messages: [
      { id: createId(), role: 'assistant', sequence: 2, replyToId: data.userMessage.id, content: 'Geç kayıt' }
    ] }); });
  };
  run.resolve({ ok: false, code: 'STREAM_INTERRUPTED', retryable: true });
  await drain();
  assert.equal(controller.canSend(), false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(reads, 2);
  assert.equal(controller.canSend(), false);
  release();
  await drain();
  assert.equal(state().active.turns[0].answer.content, 'Geç kayıt');
  assert.equal(state().active.turns[0].answer.status, 'complete');
  assert.equal(controller.canSend(), true);
  controller.dispose();
});

test('uzlaştırma sürerken yazma alanı açık kalır ama yeni gönderim engellenir', async () => {
  const { controller, api } = await readyController({ reconciliationDelaysMs: [1000] });
  controller.send('Soru');
  const run = api.turns[0];
  const data = acceptedData(CONVERSATION_A, run, 'Soru');
  run.emit('accepted', data);
  api.loadAssistantConversationRequest = (_id, options = {}) => new Promise((resolve) => {
    options.signal?.addEventListener('abort', () => resolve({ ok: false, code: 'REQUEST_CANCELLED' }), { once: true });
  });
  run.resolve({ ok: false, code: 'STREAM_INTERRUPTED', partial: true, retryable: true });
  await drain();
  const panel = mountComponent(RotaAssistantPanel, {
    assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} }
  });
  const composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  assert.equal(composer.props.disabled, false);
  assert.equal(composer.props.submitDisabled, true);
  panel.unmount();
  controller.dispose();
});

test('tam konuşma baştan gönderime kapanır ama yanıtsız son tur yinelenebilir', async () => {
  const user = { id: createId(), turnId: createId(), role: 'user', content: 'Son soru', sequence: 99 };
  const api = fakeApi({ loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: 'Dolu', messageCount: 99 }, messages: [user] }) });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  assert.equal(state().active.messageCount, 99);
  assert.equal(controller.canSend(), false);
  assert.equal(controller.send('Yeni').ok, false);
  assert.equal(controller.retry(user.turnId).ok, true);
  controller.dispose();
});

test('değişmez tarama imleci güncel baş sayfayı tek turda birleştirir', async () => {
  const boundary = { id: CONVERSATION_A, title: 'Sınır', updatedAt: '2026-09-26T10:00:00Z' };
  const moved = { id: createId(), title: 'Başa taşınan', updatedAt: '2026-09-28T10:00:00Z' };
  const older = { id: createId(), title: 'Daha eski', updatedAt: '2026-09-20T10:00:00Z' };
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [boundary], nextCursor: 'legacy', scanCursor: 'scan-start' }) });
  const { controller, state } = await readyController({ api });
  const calls = [];
  api.listAssistantConversationsRequest = async ({ cursor }) => {
    calls.push(cursor);
    if (cursor == null) return { ok: true, conversations: [moved, boundary], nextCursor: 'legacy', scanCursor: 'scan-start' };
    assert.equal(cursor, 'scan-start');
    return { ok: true, conversations: [boundary, older], nextCursor: 'scan-next' };
  };
  await controller.loadMore();
  assert.deepEqual(calls, [null, 'scan-start']);
  assert.deepEqual(new Set(state().list.items.map((item) => item.id)), new Set([moved.id, boundary.id, older.id]));
  assert.equal(state().list.nextCursor, 'scan-next');
  controller.dispose();
});

test('ardışık Daha eski çağrıları yeni kayıt aralığını denetleyip eski imleçten sürer', async () => {
  const boundary = { id: CONVERSATION_A, title: 'Sınır', updatedAt: '2026-09-26T10:00:00Z' };
  const olderA = { id: createId(), title: 'Eski A', updatedAt: '2026-09-25T10:00:00Z' };
  const olderB = { id: createId(), title: 'Eski B', updatedAt: '2026-09-24T10:00:00Z' };
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [boundary], nextCursor: 'legacy', scanCursor: 'scan-start' }) });
  const { controller } = await readyController({ api });
  const scans = [];
  api.listAssistantConversationsRequest = async ({ cursor }) => {
    if (cursor == null) return { ok: true, conversations: [boundary], nextCursor: 'legacy', scanCursor: 'scan-start' };
    scans.push(cursor);
    if (cursor === 'scan-start') return { ok: true, conversations: [olderA], nextCursor: 'scan-2' };
    if (cursor === 'scan-2') return { ok: true, conversations: [olderB], nextCursor: null };
    throw new Error(`beklenmeyen imleç: ${cursor}`);
  };
  await controller.loadMore();
  await controller.loadMore();
  assert.deepEqual(scans, ['scan-start', 'scan-start', 'scan-2']);
  controller.dispose();
});

test('birden fazla konuşmanın reddedilen iletileri ayrı tutulur', async () => {
  const { controller, api } = await readyController();
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  for (const id of [CONVERSATION_A, CONVERSATION_B]) {
    await controller.openConversation(id); panel.render();
    controller.send(`Ret ${id}`); panel.render();
    composer().props.onChange(`Taslak ${id}`); panel.render();
    api.turns.at(-1).resolve({ ok: false, phase: 'request', code: 'AI_CONFIGURATION_ERROR', retryable: false });
    await drain(); panel.render();
  }
  await controller.openConversation(CONVERSATION_A); panel.render();
  findElement(panel.output, (node) => node.type === 'button' && textOf(node).includes('İletiyi geri al')).props.onClick(); panel.render();
  assert.equal(composer().props.value, `Ret ${CONVERSATION_A}\n\nTaslak ${CONVERSATION_A}`);
  panel.unmount(); controller.dispose();
});

test('yanıt kabulüyle dolan konuşmanın önceden yazılmış taslağı yeni konuşmaya taşınır', async () => {
  const api = fakeApi({
    loadAssistantConversationRequest: async (id) => ({
      ok: true,
      conversation: { id, title: 'Sınıra yakın', messageCount: 98 },
      messages: []
    })
  });
  const { controller } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  const panel = mountComponent(RotaAssistantPanel, {
    assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} }
  });
  let composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  assert.equal(composer.props.onSubmit('Son soru').ok, true);
  panel.render();
  composer = findElement(panel.output, (node) => node.type === AssistantComposer);
  composer.props.onChange('Sonraki konuşmanın taslağı');
  panel.render();
  const run = api.turns[0];
  const accepted = acceptedData(CONVERSATION_A, run, 'Son soru');
  accepted.conversation.messageCount = 99;
  run.emit('accepted', accepted);
  panel.render();
  const newConversation = findElement(panel.output, (node) => node.type === 'button' && node.props?.['aria-label'] === 'Yeni konuşma');
  assert.ok(newConversation);
  newConversation.props.onClick();
  panel.render();
  assert.equal(controller.getState().active.id, null);
  assert.equal(findElement(panel.output, (node) => node.type === AssistantComposer).props.value, 'Sonraki konuşmanın taslağı');
  panel.unmount();
  controller.dispose();
});

test('başlıktaki yeni konuşma eylemi açık konuşmanın taslağını yeni konuşmaya taşımaz', async () => {
  const { controller } = await readyController();
  await controller.openConversation(CONVERSATION_A);
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  composer().props.onChange('A konuşmasının taslağı'); panel.render();
  findElement(panel.output, (node) => node.props?.['aria-label'] === 'Yeni konuşma').props.onClick(); panel.render();
  assert.equal(controller.getState().active.id, null);
  assert.equal(composer().props.value, '', 'yeni konuşma boş başlar');
  await controller.openConversation(CONVERSATION_A); panel.render();
  assert.equal(composer().props.value, 'A konuşmasının taslağı', 'kaynak konuşmanın taslağı kendi konuşmasında kalır');
  panel.unmount(); controller.dispose();
});

test('konuşma silinince süren uzlaştırma iptal edilir ve geç okuma konuşmayı diriltmez', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const run = api.turns[0];
  const data = acceptedData(CONVERSATION_A, run, 'Soru');
  run.emit('accepted', data);
  run.emit('delta', { text: 'kısmi' });
  const user = { ...data.userMessage, role: 'user', sequence: 1 };
  const answer = { id: createId(), role: 'assistant', sequence: 2, replyToId: user.id, content: 'Geç yanıt' };
  let releaseRead;
  api.loadAssistantConversationRequest = (_id, options = {}) => new Promise((resolve) => {
    releaseRead = () => resolve({ ok: true, conversation: data.conversation, messages: [user, answer] });
    assert.equal(options.signal.aborted, false);
  });
  run.resolve({ ok: false, code: 'STREAM_INTERRUPTED', partial: true, retryable: true });
  await drain();
  assert.ok(releaseRead);
  assert.equal(Boolean(state().reconciling[CONVERSATION_A]), true);
  assert.deepEqual(await controller.deleteConversation(CONVERSATION_A), { ok: true });
  assert.equal(state().reconciling[CONVERSATION_A], undefined);
  releaseRead();
  await drain();
  assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
  assert.equal(state().active.id, null);
  controller.dispose();
});

test('uzlaştırma tamamlanınca daha önce başlamış tarihçe okuması yanıtı silemez', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const run = api.turns[0];
  const data = acceptedData(CONVERSATION_A, run, 'Soru');
  run.emit('accepted', data);
  const user = { ...data.userMessage, role: 'user', sequence: 1 };
  const answer = { id: createId(), role: 'assistant', sequence: 2, replyToId: user.id, content: 'Kaydedilen' };
  let reconcile;
  let stale;
  let reads = 0;
  api.loadAssistantConversationRequest = async () => {
    reads += 1;
    if (reads === 1) return new Promise((resolve) => { reconcile = () => resolve({ ok: true, conversation: data.conversation, messages: [user, answer] }); });
    if (reads === 2) return new Promise((resolve) => { stale = () => resolve({ ok: true, conversation: data.conversation, messages: [user] }); });
    return { ok: true, conversation: data.conversation, messages: [user, answer] };
  };
  run.resolve({ ok: false, code: 'STREAM_INTERRUPTED', retryable: true });
  await drain();
  const loading = controller.openConversation(CONVERSATION_A);
  reconcile(); await drain();
  stale(); await loading;
  assert.equal(reads, 3);
  assert.equal(state().active.turns[0].answer.content, 'Kaydedilen');
  controller.dispose();
});

test('ilk turdan sonra konuşmaya geri dönmek taslak anahtarını değiştirmez', async () => {
  const { controller, api, state } = await readyController();
  const key = state().active.viewKey;
  controller.send('İlk soru');
  const run = api.turns[0];
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'İlk soru'));
  run.resolve(doneResult(CONVERSATION_A));
  await drain();
  await controller.openConversation(CONVERSATION_B);
  await controller.openConversation(CONVERSATION_A);
  assert.equal(state().active.viewKey, key);
  controller.dispose();
});

test('uzlaştırma sürerken aynı tur yinelenir ve eski okuma yeni üretimi değiştiremez', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const first = api.turns[0];
  const accepted = acceptedData(CONVERSATION_A, first, 'Soru');
  first.emit('accepted', accepted);
  let release;
  let signal;
  api.loadAssistantConversationRequest = (_id, options) => {
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  };
  controller.stop();
  first.resolve({ ok: false, code: 'REQUEST_CANCELLED', cancelled: true });
  await drain();
  assert.equal(controller.canSend(), false);
  assert.equal(controller.retry(first.input.turnId).ok, true);
  assert.equal(api.turns[1].input.turnId, first.input.turnId);
  assert.equal(signal.aborted, true);
  release({ ok: false, code: 'NOT_FOUND' });
  await drain();
  assert.equal(Boolean(state().active.closed), false);
  assert.ok(state().running[CONVERSATION_A]);
  api.turns[1].resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(state().active.turns[0].answer.status, 'complete');
  assert.equal(controller.canSend(), true);
  controller.dispose();
});

test('uzlaştırma silinmiş konuşmayı kapatır ve oturum hatasını panel düzeyine taşır', async () => {
  for (const code of ['NOT_FOUND', 'UNAUTHORIZED', 'SESSION_REQUIRED']) {
    const { controller, api, state } = await readyController();
    controller.send('Soru');
    const first = api.turns[0];
    first.emit('accepted', acceptedData(CONVERSATION_A, first, 'Soru'));
    api.loadAssistantConversationRequest = async () => ({ ok: false, code });
    first.resolve({ ok: false, code: 'NETWORK', partial: true });
    await drain();
    assert.equal(controller.canSend(), false, code);
    assert.equal(controller.retry(first.input.turnId).ok, false, code);
    if (code === 'NOT_FOUND') {
      assert.equal(state().active.closed, true);
      assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
    } else {
      assert.equal(state().status, 'error');
      assert.ok(state().failure);
    }
    controller.dispose();
  }
});

test('açma sırasında NOT_FOUND ile kaldırılan konuşmayı eski liste yenilemesi geri getirmez', async () => {
  const row = { id: CONVERSATION_A, title: 'Silinmiş', updatedAt: '2026-09-28T10:00:00.000Z' };
  let listCall = 0;
  let releaseList;
  const api = fakeApi({
    listAssistantConversationsRequest: async () => {
      listCall += 1;
      if (listCall === 1) return { ok: true, conversations: [row], nextCursor: null };
      return new Promise((resolve) => { releaseList = () => resolve({ ok: true, conversations: [row], nextCursor: null }); });
    },
    loadAssistantConversationRequest: async () => ({ ok: false, code: 'NOT_FOUND' })
  });
  const { controller, state } = await readyController({ api });
  const refresh = controller.refreshList();
  assert.ok(releaseList);
  await controller.openConversation(CONVERSATION_A);
  assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
  releaseList();
  await refresh;
  assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
  controller.dispose();
});

test('tur isteğindeki NOT_FOUND ile kaldırılan konuşmayı eski liste yenilemesi geri getirmez', async () => {
  const row = { id: CONVERSATION_A, title: 'Silinmiş', updatedAt: '2026-09-28T10:00:00.000Z', messageCount: 0 };
  let listCall = 0;
  let releaseList;
  const api = fakeApi({
    listAssistantConversationsRequest: async () => {
      listCall += 1;
      if (listCall === 1) return { ok: true, conversations: [row], nextCursor: null };
      return new Promise((resolve) => { releaseList = () => resolve({ ok: true, conversations: [row], nextCursor: null }); });
    },
    loadAssistantConversationRequest: async () => ({ ok: true, conversation: row, messages: [] })
  });
  const { controller, state } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  const refresh = controller.refreshList();
  assert.ok(releaseList);
  assert.equal(controller.send('Soru').ok, true);
  api.turns[0].resolve({ ok: false, phase: 'request', code: 'NOT_FOUND' });
  await drain();
  assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
  releaseList();
  await refresh;
  assert.equal(state().list.items.some((item) => item.id === CONVERSATION_A), false);
  controller.dispose();
});

test('sayfalama başka pencerede silinmiş eski satırı yeniden eklemez', async () => {
  const removed = { id: CONVERSATION_A, title: 'Silinen', updatedAt: '2026-09-28T10:00:00Z' };
  const boundary = { id: CONVERSATION_B, title: 'Sınır', updatedAt: '2026-09-27T10:00:00Z' };
  const older = { id: createId(), title: 'Eski', updatedAt: '2026-09-26T10:00:00Z' };
  const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: [removed, boundary], nextCursor: 'old' }) });
  const { controller, state } = await readyController({ api });
  api.listAssistantConversationsRequest = async ({ cursor }) => ({ ok: true, conversations: cursor ? [older] : [boundary], nextCursor: cursor ? null : 'old' });
  await controller.loadMore();
  assert.deepEqual(state().list.items.map((item) => item.id), [boundary.id, older.id]);
  controller.dispose();
});

test('kanonik GUID ilk grupları SQL sıralamasında ikinci kez ters çevrilmez', async () => {
  for (const [highId, lowId] of [
    ['00000000-0000-4100-8000-000000000000', '00000000-0000-4001-8000-000000000000'],
    ['00000000-0100-4000-8000-000000000000', '00000000-0001-4000-8000-000000000000'],
    ['01000000-0000-4000-8000-000000000000', '00000001-0000-4000-8000-000000000000']
  ]) {
    const rows = [lowId, highId].map((id) => ({ id, title: id, updatedAt: '2026-09-28T10:00:00Z' }));
    const api = fakeApi({ listAssistantConversationsRequest: async () => ({ ok: true, conversations: rows, nextCursor: null }) });
    const { controller, state } = await readyController({ api });
    assert.deepEqual(state().list.items.map((row) => row.id), [highId, lowId]);
    controller.dispose();
  }
});

test('hazırlık yenilenirken yazma alanı monte ve etkin kalır', async () => {
  const { controller, api } = await readyController();
  const props = { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } };
  const panel = mountComponent(RotaAssistantPanel, props);
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  composer().props.onChange('Korunan taslak'); panel.render();
  let release;
  api.loadAssistantReadinessRequest = () => new Promise((resolve) => { release = resolve; });
  const pending = controller.activate({ refresh: true }); panel.render();
  assert.ok(composer());
  assert.equal(composer().props.disabled, false);
  assert.equal(composer().props.value, 'Korunan taslak');
  assert.equal(controller.send('Gönderilmez').ok, false);
  release({ ok: true, assistant: READINESS }); await pending; panel.render();
  assert.equal(composer().props.value, 'Korunan taslak');
  panel.unmount(); controller.dispose();
});

test('son yakın konuşma silinince boş görünüm odak hedefi sunar', async () => {
  const item = { id: CONVERSATION_A, title: 'Son', updatedAt: new Date().toISOString() };
  const props = { limit: 3, list: { items: [item] }, onOpen() {}, onDelete: async () => ({ ok: true }) };
  const view = mountComponent(AssistantConversationList, props);
  const row = () => findElement(view.output, (node) => node.props?.item?.id === item.id);
  row().props.onAskDelete(); view.render();
  await row().props.onConfirmDelete();
  view.render({ ...props, list: { items: [] } });
  const empty = findElement(view.output, (node) => node.type === 'p' && node.props.tabIndex === -1);
  assert.ok(empty);
  assert.ok(empty.ref);
  view.unmount();
});

test('yalnız gönderim engeli yazmayı açık tutar ama Enter ve düğmeden göndermez', () => {
  let sent = 0;
  const view = mountComponent(AssistantComposer, { value: 'Taslak', maxChars: 8000, submitDisabled: true, onSubmit() { sent += 1; }, onChange() {} });
  const input = findElement(view.output, (node) => node.type === 'textarea');
  assert.equal(input.props.disabled, false);
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  view.output.props.onSubmit({ preventDefault() {} });
  assert.equal(sent, 0);
  assert.ok(findElement(view.output, (node) => node.type === 'button' && node.props.type === 'submit').props.disabled);
  view.unmount();
});

test('yeniden deneme kabul edilmeden reddedilirse kayıtlı turun uzlaştırması sürer', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const first = api.turns[0];
  const data = acceptedData(CONVERSATION_A, first, 'Soru');
  first.emit('accepted', data);
  const releases = [];
  api.loadAssistantConversationRequest = () => new Promise((resolve) => releases.push(resolve));
  first.resolve({ ok: false, code: 'NETWORK', retryable: true }); await drain();
  assert.equal(controller.retry(first.input.turnId).ok, true);
  api.turns[1].resolve({ ok: false, phase: 'request', code: 'CONFLICT', reason: 'GENERATION_IN_PROGRESS' }); await drain();
  assert.equal(controller.canSend(), false);
  releases[0]({ ok: false, code: 'NOT_FOUND' }); await drain();
  assert.equal(Boolean(state().active.closed), false);
  releases[1]({ ok: true, conversation: data.conversation, messages: [{ id: createId(), role: 'assistant', replyToId: data.userMessage.id, content: 'Kaydedildi' }] });
  await drain();
  assert.equal(state().active.turns[0].answer.status, 'complete');
  controller.dispose();
});


test('baş sayfadan düşen geçilmiş kayıt ve sonradan eklenen kayıt taramada kaybolmaz', async () => {
  const row = (id, date) => ({ id, title: id, createdAt: date, updatedAt: date });
  const a = row(CONVERSATION_A, '2026-09-26T10:00:00Z');
  const b = row(CONVERSATION_B, '2026-09-25T10:00:00Z');
  const old = row(createId(), '2026-09-24T10:00:00Z');
  const fresh = row(createId(), '2026-09-27T10:00:00Z');
  const promoted = { ...old, updatedAt: '2026-09-29T10:00:00Z' };
  let round = 0;
  const api = fakeApi({ listAssistantConversationsRequest: async ({ cursor }) => {
    if (cursor == null) return { ok: true, conversations: [round ? promoted : a], nextCursor: 'legacy', scanCursor: 'scan-start' };
    if (cursor === 'scan-start') return { ok: true, conversations: round ? [fresh] : [a, b], nextCursor: round ? 'newer-next' : 'older' };
    if (cursor === 'newer-next') return { ok: true, conversations: [a, b], nextCursor: 'older' };
    if (cursor === 'older') return { ok: true, conversations: [promoted], nextCursor: null };
    throw new Error(cursor);
  } });
  const { controller, state } = await readyController({ api });
  await controller.loadMore();
  round = 1;
  await controller.loadMore();
  assert.deepEqual(new Set(state().list.items.map((item) => item.id)), new Set([a.id, b.id, old.id, fresh.id]));
  assert.equal(state().list.nextCursor, null);
  controller.dispose();
});

test('kaydedilmemiş taslak yeni konuşmada ve kayıtlı konuşmaya geçişte erişilebilir kalır', async () => {
  const { controller } = await readyController();
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() {} } });
  const composer = () => findElement(panel.output, (node) => node.type === AssistantComposer);
  composer().props.onChange('Gönderilmemiş taslak'); panel.render();
  findElement(panel.output, (node) => node.type === 'button' && node.props.title === 'Yeni konuşma').props.onClick(); panel.render();
  assert.equal(composer().props.value, 'Gönderilmemiş taslak');
  controller.setView('history'); panel.render();
  const list = findElement(panel.output, (node) => node.type === AssistantConversationList);
  await list.props.onOpen(CONVERSATION_A); panel.render();
  assert.equal(composer().props.value, 'Gönderilmemiş taslak');
  panel.unmount(); controller.dispose();
});

test('yanıtsız son tur yeni gönderimi kapatır ama yeniden deneme açık kalır', async () => {
  const user = { id: createId(), turnId: createId(), role: 'user', content: 'Soru', sequence: 1 };
  const api = fakeApi({ loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: 'Soru', messageCount: 1 }, messages: [user] }) });
  const { controller } = await readyController({ api });
  await controller.openConversation(CONVERSATION_A);
  assert.equal(controller.canSend(), false);
  assert.equal(controller.send('Başka soru').ok, false);
  assert.equal(api.turns.length, 0);
  assert.equal(controller.retry(user.turnId).ok, true);
  controller.dispose();
});

test('uzlaştırılan kayıtlı yanıt geçici üretilen metnin yerini alır', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Soru');
  const run = api.turns[0];
  run.emit('accepted', acceptedData(CONVERSATION_A, run, 'Soru'));
  run.emit('delta', { text: 'Geçici metin' });
  const result = doneResult(CONVERSATION_A);
  result.done.reconciled = true;
  result.done.assistantMessage.content = 'Kayıtlı metin';
  run.resolve(result); await drain();
  assert.equal(state().active.turns[0].answer.content, 'Kayıtlı metin');
  controller.dispose();
});



test('başka sekmenin anahtar bildirimi açık panelin hazırlığını yeniler ve kanal kapanır', async (t) => {
  withDataMode(t, 'actual');
  const previousWindow = globalThis.window;
  const channels = [];
  class Channel {
    constructor(name) { this.name = name; channels.push(this); }
    close() { this.closed = true; }
  }
  globalThis.window = { BroadcastChannel: Channel, addEventListener() {}, removeEventListener() {} };
  t.after(() => { globalThis.window = previousWindow; });
  let available = false;
  stubFetch(t, (call) => {
    if (call.url.endsWith('/assistant')) return Response.json({ assistant: available ? READINESS : { ...READINESS, available: false, modes: READINESS.modes.map((mode) => ({ ...mode, available: false })) } });
    return Response.json({ conversations: [], nextCursor: null });
  });
  const probe = mountComponent(Probe, {});
  t.after(() => probe.unmount());
  probe.output.assistant.openPanel(); probe.render(); await drain();
  assert.equal(probe.output.assistant.controller.getState().readiness.available, false);
  assert.equal(channels.length, 1);
  available = true;
  channels[0].onmessage({ data: 'changed' }); await drain();
  assert.equal(probe.output.assistant.controller.getState().readiness.available, true);
  probe.output.assistant.close({ restoreFocus: false }); probe.render();
  assert.equal(channels[0].closed, true);
});

test('kayıt yapan kipli pencerenin Escape olayı masaüstü yardımcısını kapatmaz', async (t) => {
  const { useModalFocusTrap, hasBlockingModal } = await import('../src/hooks/useModalFocusTrap.js');
  const previous = { window: globalThis.window, document: globalThis.document, observer: globalThis.MutationObserver };
  const events = new EventTarget();
  const docEvents = new EventTarget();
  globalThis.window = events;
  globalThis.document = { body: { classList: { contains: () => false } }, activeElement: null,
    addEventListener: docEvents.addEventListener.bind(docEvents), removeEventListener: docEvents.removeEventListener.bind(docEvents) };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const { controller } = await readyController();
  const closes = [];
  const panel = mountComponent(RotaAssistantPanel, { assistant: { controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() { closes.push('assistant'); } } });
  const trap = mountComponent((props) => { useModalFocusTrap(props); return null; }, {
    containerRef: { current: null }, initialFocusRef: { current: null }, blocked: true, priority: 310, onClose() { closes.push('modal'); }
  });
  try {
    assert.equal(hasBlockingModal(), true);
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    docEvents.dispatchEvent(event); events.dispatchEvent(event);
    assert.deepEqual(closes, []);
  } finally {
    trap.unmount(); panel.unmount(); controller.dispose();
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.MutationObserver = previous.observer;
  }
});

test('free-text opt-in belongs to one turn: sending consumes it, and context changes reset it', async () => {
  const rotaData = { enabled: true, available: true, modes: [{ id: 'standard', available: true }, { id: 'deep', available: true }] };
  const { controller, api, state } = await readyController({ api: fakeApi({ loadAssistantReadinessRequest: async () => ({ ok: true, assistant: { ...READINESS, rotaData } }) }) });
  controller.setIncludeText(true);
  assert.equal(state().includeText, true);
  assert.equal(controller.send('Rapor görevinin notunu göster').ok, true);
  assert.equal(api.turns[0].input.includeText, true, 'the consenting turn carries the opt-in');
  assert.equal(state().includeText, false, 'the opt-in is consumed when the turn is sent');
  const [first] = api.turns;
  first.emit('accepted', acceptedData(CONVERSATION_A, first, 'Rapor görevinin notunu göster'));
  first.resolve(doneResult(CONVERSATION_A));
  await drain();
  assert.equal(controller.send('Peki terminleri?').ok, true);
  assert.equal(api.turns[1].input.includeText, undefined, 'the next turn does not inherit the opt-in');
  api.turns[1].resolve({ ok: false, code: 'NETWORK', retryable: true });
  await drain();
  assert.equal(controller.retry(api.turns[1].input.turnId).ok, true);
  assert.equal(api.turns[2].input.includeText, undefined, 'a retry needs a fresh opt-in');
  api.turns[2].resolve(doneResult(CONVERSATION_A));
  await drain();
  for (const change of [() => controller.newConversation(), () => controller.openConversation(CONVERSATION_B), () => controller.setSource('general')]) {
    controller.setSource('rota');
    controller.setIncludeText(true);
    await change();
    await drain();
    assert.equal(state().includeText, false);
  }
  controller.setSource('rota');
  controller.setIncludeText(true);
  controller.setSource('rota');
  assert.equal(state().includeText, true, 'selecting the same source keeps the current choice');
});
