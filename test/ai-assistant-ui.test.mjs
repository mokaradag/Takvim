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
const { AssistantComposer } = await import('../src/features/ai/assistant/AssistantComposer.jsx');
const { AssistantThread, AssistantTurn } = await import('../src/features/ai/assistant/AssistantThread.jsx');
const { AssistantConversationList } = await import('../src/features/ai/assistant/AssistantConversationList.jsx');
const { AssistantMarkdown, renderBlock, renderInline } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { createAssistantController, retryableTurnKey, turnsFromMessages } = await import('../src/features/ai/assistant/assistantController.js');
const presentation = await import('../src/features/ai/assistant/assistantPresentation.js');
const interaction = await import('../src/features/ai/assistant/assistantInteraction.js');
const { parseAssistantMarkdown, parseInline, safeLinkHref } = await import('../src/features/ai/assistant/assistantMarkdown.js');
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

/* ── Sunum ────────────────────────────────────────────────── */

test('hata görünümü kategorileri ayırır; kapasite yoğunluğu çökme gibi değil geçici uyarı olarak anlatılır', () => {
  const view = presentation.assistantFailureView;
  assert.deepEqual([view({ code: 'AI_BUSY' }).tone, view({ code: 'AI_BUSY' }).retryable], ['warn', true]);
  assert.equal(view({ code: 'AI_QUEUE_TIMEOUT' }).title, 'Rota AI şu anda yoğun');
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
  assert.equal(view({ code: 'CONFLICT', reason: 'CONVERSATION_FULL', message: 'Dolu.' }).action, 'new-conversation');
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
  assert.equal(presentation.readinessNotice({ available: false, reason: 'BİLİNMEYEN' }).title, 'Rota AI yapılandırılmadı');
  assert.equal(presentation.generationPhaseLabel('sending', 'standard'), 'Gönderiliyor…');
  assert.equal(presentation.generationPhaseLabel('generating', 'deep'), 'Derin düşünülüyor…');
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

test('panel açılıp kapanınca durum korunur; kapalı panel hiçbir şey çizmez; Gerçek Sistem’de hazırlık yeniden, liste bir kez okunur', async (t) => {
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
  assert.equal(calls.length, 3, 'yeniden açılış hazırlığı doğrular, listeyi korur');
  assert.equal(calls.filter((call) => call.url.endsWith('/conversations')).length, 1);
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
  assert.deepEqual(Object.keys(body).sort(), ['conversationId', 'message', 'mode', 'turnId']);
  assert.equal(body.mode, 'deep');
  for (const forbidden of [...MODEL_NAMES, 'chat.reasoning', 'chat.general', 'apiKey', 'Authorization', 'sicil']) {
    assert.equal(call.body.includes(forbidden), false, `gövde taşımamalı: ${forbidden}`);
  }
  probe.render();
  const turn = probe.output.assistant.controller.getState().active.turns[0];
  assert.equal(turn.answer.status, 'failed');
  assert.equal(turn.answer.error.title, 'Rota AI şu anda yoğun');
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
  const modeSwitch = findElement(view.output, (node) => typeof node.type === 'function' && node.type.name === 'ModeSwitch');
  const group = mountComponent(modeSwitch.type, modeSwitch.props).output;
  assert.equal(group.props.role, 'radiogroup', 'kip seçimi erişilebilir bir radyo grubudur');
  const radios = group.props.children;
  assert.deepEqual(radios.map((radio) => [radio.props.role, radio.props['aria-checked'], radio.props.tabIndex]), [['radio', true, 0], ['radio', false, -1]]);
  const single = mountComponent(modeSwitch.type, { ...modeSwitch.props, modes: [READINESS.modes[0], { ...READINESS.modes[1], available: false }] }).output;
  assert.equal(single, null, 'tek kip varsa seçim gösterilmez');
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
  assert.ok(find({ turn: turn('unanswered', { content: '' }), canRetry: true }, notice));
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
  for (const label of ['Geçmiş konuşmalar', 'Yeni konuşma', 'Rota AI’yi kapat']) {
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

test('bağlanmamış başarısız taslaktan yeni ileti eski turu taşımaz', async () => {
  const { controller, api, state } = await readyController();
  controller.send('Eski');
  api.turns[0].resolve({ ok: false, code: 'NETWORK', retryable: true });
  await drain();
  assert.equal(controller.send('Yeni').ok, true);
  assert.deepEqual(state().active.turns.map((turn) => turn.user.content), ['Yeni']);
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

test('var olan konuşmada kabul edilmemiş tur yeni iletiye taşınmaz', async () => {
  const { controller, api, state } = await readyController();
  await controller.openConversation(CONVERSATION_A);
  controller.send('Kaydedilmeyen');
  api.turns[0].resolve({ ok: false, code: 'CONFLICT' });
  await drain();
  controller.send('Yeni soru');
  assert.deepEqual(state().active.turns.map((turn) => turn.user.content), ['Yeni soru']);
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
  t.after(() => { globalThis.document = previousDocument; globalThis.MutationObserver = previousObserver; });
  const listeners = [];
  globalThis.window = {
    addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) { const i = listeners.findIndex((item) => item.type === type && item.fn === fn); if (i >= 0) listeners.splice(i, 1); }
  };
  const { controller } = await readyController();
  const closed = [];
  const panel = mountComponent(RotaAssistantPanel, { assistant: {
    controller, open: true, actual: true, focusRequest: 0, launcherRef: { current: null }, close() { closed.push('assistant'); }
  } });
  const dialog = mountComponent(ProjectCreateDialog, { open: true, onClose() { closed.push('project'); } });
  t.after(() => { dialog.unmount(); panel.unmount(); globalThis.window = previous; });
  const event = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const { fn } of [...listeners].filter((item) => item.type === 'keydown').sort((a, b) => Number(b.capture) - Number(a.capture))) fn(event);
  assert.deepEqual(closed, ['project']);
});
