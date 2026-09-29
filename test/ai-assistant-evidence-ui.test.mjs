/**
 * Rota AI · kanıta dayalı yanıtın tarayıcı tarafı.
 *
 * Akış çözücüsü (`revise`, veri alanı konusu, yetkili metin ve kanıt künyesi),
 * denetleyici (taslağın kaldırılması, evre konusu, kanıtın tura bağlanması),
 * atıf işaretinin güvenli Markdown çözümü ve çizimi, kanıt paneli ve sunum
 * metinleri tarayıcı olmadan sınanır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';

const { createAssistantStreamDecoder, loadAssistantConversationRequest } = await import('../src/features/ai/assistant/assistantClient.js');
const { createAssistantController, turnsFromMessages } = await import('../src/features/ai/assistant/assistantController.js');
const { AssistantTurn } = await import('../src/features/ai/assistant/AssistantThread.jsx');
const { renderInline } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { assistantMarkdownText, parseAssistantMarkdown, parseInline } = await import('../src/features/ai/assistant/assistantMarkdown.js');
const presentation = await import('../src/features/ai/assistant/assistantPresentation.js');
const { GROUNDING_FAILURE_TEXT } = await import('../src/domain/ai/evidenceContract.js');

const CONVERSATION_ID = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const TURN_ID = '0a1b2c3d-4e5f-4a6b-9c7d-8e9fa0b1c2d3';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ANSWER_ID = '99999999-8888-4777-8666-555555555555';
const GENERATED_AT = '2026-09-29T08:12:00.000Z';

const conversation = { id: CONVERSATION_ID, title: 'Deneme', createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z', messageCount: 1 };
const userMessage = { id: USER_ID, sequence: 1, role: 'user', content: 'Soru', turnId: TURN_ID, replyToId: null, mode: null, finishReason: null, createdAt: 'x', length: 4 };
const assistantMessage = { id: ANSWER_ID, sequence: 2, role: 'assistant', turnId: null, replyToId: USER_ID, mode: 'standard', finishReason: 'stop', createdAt: 'x' };

function evidence(id, extra = {}) {
  return {
    id,
    kind: 'task-list',
    label: 'Görev listesi · 8 görev',
    entity: { type: 'project', id: 'p1', name: 'Radar Modernizasyonu' },
    generatedAt: GENERATED_AT,
    complete: true,
    truncated: false,
    partial: false,
    counts: { returned: 8, total: 8 },
    highlights: [{ label: 'Süzgeç', value: 'Açık görevler' }],
    ...extra
  };
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ACCEPTED = frame('accepted', { v: 1, conversation, userMessage, mode: 'standard', replay: false, context: { trimmed: false, omittedMessages: 0 }, rotaData: true });

/* ── Akış çözücüsü ────────────────────────────────────────── */

test('çözücü: revise gösterilen taslağı geçersiz kılar; sonuç uzunluğu yalnız yeni metinle karşılaştırılır', () => {
  const answer = 'Radar projesinde 8 görev var. 【R1】';
  const decoder = createAssistantStreamDecoder();
  const events = decoder.push(
    ACCEPTED
    + frame('delta', { text: 'Önce Rota verisine bakayım.' })
    + frame('revise', {})
    + frame('status', { phase: 'tools', topic: 'tasks' })
    + frame('delta', { text: answer })
    + frame('done', { conversation: { ...conversation, messageCount: 2 }, assistantMessage: { ...assistantMessage, length: answer.length }, replayed: false })
  );
  assert.deepEqual(events.map((event) => event.type), ['accepted', 'delta', 'revise', 'status', 'delta', 'done']);
  assert.equal(decoder.terminal.type, 'done');
});

test('çözücü: evre konusu yalnızca bilinen veri alanlarından biri olabilir; bilinmeyen konu atılır', () => {
  const decoder = createAssistantStreamDecoder();
  const events = decoder.push(ACCEPTED
    + frame('status', { phase: 'tools', topic: 'projects' })
    + frame('status', { phase: 'tools', topic: 'rota_task_search' })
    + frame('status', { phase: 'verifying' }));
  const statuses = events.filter((event) => event.type === 'status').map((event) => event.data);
  assert.deepEqual(statuses, [{ phase: 'tools', topic: 'projects' }, { phase: 'tools' }, { phase: 'verifying' }]);
});

test('çözücü: sunucunun kayıtlı metni esastır; kanıt künyesi doğrulanır, bozuk öğe atılır ve sıraya dizilir', () => {
  const content = 'Doğrulanmış yanıt. 【R2】【R1】';
  const decoder = createAssistantStreamDecoder();
  decoder.push(ACCEPTED + frame('delta', { text: 'Akışta farklı taslak' }) + frame('done', {
    conversation: { ...conversation, messageCount: 2 },
    assistantMessage: {
      ...assistantMessage,
      content,
      length: content.length,
      evidence: [
        evidence('R2'),
        evidence('R1'),
        evidence('R1', { label: 'Yinelenen' }),
        { id: 'R99x', kind: 'task-list', generatedAt: GENERATED_AT },
        evidence('R3', { kind: 'sql' }),
        evidence('R4', { generatedAt: 'dün' }),
        evidence('R5', { label: { html: '<b>' }, highlights: 'dizi değil', counts: { returned: -1, total: 1.5 } })
      ]
    },
    replayed: false
  }));
  const done = decoder.terminal.data.assistantMessage;
  assert.equal(done.content, content);
  assert.deepEqual(done.evidence.map((item) => item.id), ['R1', 'R2', 'R5']);
  const odd = done.evidence.find((item) => item.id === 'R5');
  assert.equal(odd.label, 'Görev listesi', 'metin olmayan etiket türün adına düşer');
  assert.deepEqual(odd.highlights, []);
  assert.deepEqual(odd.counts, { returned: null, total: null });

  // Yetkili metnin uzunluğu tutmuyorsa sonuç kabul edilmez.
  const broken = createAssistantStreamDecoder();
  assert.throws(() => broken.push(ACCEPTED + frame('done', {
    conversation, assistantMessage: { ...assistantMessage, content, length: content.length + 1 }, replayed: false
  })), /ANSWER_LENGTH_MISMATCH/);
});

test('konuşma okuması kanıt künyesini akıştaki kuralla doğrular', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => Response.json({
    conversation,
    messages: [
      { ...userMessage },
      { ...assistantMessage, content: 'Yanıt 【R1】', evidence: [evidence('R1'), { id: 'R2', kind: 'bilinmeyen', generatedAt: GENERATED_AT }] },
      { ...assistantMessage, id: '99999999-8888-4777-8666-555555555556', sequence: 3, content: 'Genel yanıt' }
    ]
  });
  const loaded = await loadAssistantConversationRequest(CONVERSATION_ID);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.messages[1].evidence.map((item) => item.id), ['R1']);
  assert.equal(Object.hasOwn(loaded.messages[2], 'evidence'), false);
});

/* ── Denetleyici ──────────────────────────────────────────── */

let idCounter = 0;
const createId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

function fakeApi() {
  const turns = [];
  return {
    turns,
    loadAssistantReadinessRequest: async () => ({
      ok: true,
      assistant: {
        available: true,
        reason: null,
        modes: [{ id: 'standard', label: 'Standart', available: true }],
        limits: { maxMessageChars: 8000, maxConversationMessages: 100 }
      }
    }),
    listAssistantConversationsRequest: async () => ({ ok: true, conversations: [], nextCursor: null }),
    loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: 'Konuşma' }, messages: [] }),
    deleteAssistantConversationRequest: async () => ({ ok: true, deleted: true }),
    streamAssistantTurnRequest(input) {
      return new Promise((resolve) => turns.push({ input, resolve, emit: (type, data) => input.onEvent({ type, data }) }));
    }
  };
}

async function readyController() {
  const api = fakeApi();
  const flushes = [];
  const controller = createAssistantController({
    api,
    createId,
    reconciliationDelaysMs: [],
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

function accept(turn) {
  turn.emit('accepted', {
    conversation: { id: CONVERSATION_ID, title: 'Soru' },
    userMessage: { id: createId(), content: 'Soru', createdAt: '2026-09-26T10:00:00.000Z', turnId: turn.input.turnId },
    context: { trimmed: false, omittedMessages: 0 },
    rotaData: true
  });
}

test('denetleyici: araç evresinin konusu gösterilir; revise taslağı kaldırır; kayıtlı metin ve kanıt tura bağlanır', async () => {
  const { controller, api, flushes, state } = await readyController();
  controller.send('Radar projesinde kaç görev var?');
  const [turn] = api.turns;
  accept(turn);
  turn.emit('delta', { text: 'Önce Rota verisine bakayım.' });
  assert.equal(state().active.turns[0].answer.content, 'Önce Rota verisine bakayım.');
  turn.emit('revise', {});
  assert.equal(state().active.turns[0].answer.content, '', 'gösterilen taslak kaldırılır');
  assert.equal(state().active.turns[0].answer.status, 'waiting');
  turn.emit('status', { phase: 'tools', topic: 'tasks' });
  assert.deepEqual([state().running[CONVERSATION_ID].phase, state().running[CONVERSATION_ID].topic], ['tools', 'tasks']);
  turn.emit('status', { phase: 'verifying' });
  assert.deepEqual([state().running[CONVERSATION_ID].phase, state().running[CONVERSATION_ID].topic], ['verifying', null]);
  const content = 'Radar projesinde 8 görev var. 【R1】';
  turn.emit('delta', { text: content });
  flushes.splice(0).forEach((flush) => flush());
  turn.resolve({
    ok: true,
    done: {
      conversation: { id: CONVERSATION_ID, title: 'Soru', messageCount: 2 },
      assistantMessage: { id: createId(), mode: 'standard', finishReason: 'stop', createdAt: 'x', content, evidence: [evidence('R1')] }
    }
  });
  await drain();
  const [only] = state().active.turns;
  assert.equal(only.answer.status, 'complete');
  assert.equal(only.answer.content, content);
  assert.deepEqual(only.answer.evidence.map((item) => item.id), ['R1']);
});

test('denetleyici: kayıtlı konuşmadaki kanıt künyesi yanıta bağlanır; kanıtsız yanıtın kanıtı yoktur', () => {
  const turns = turnsFromMessages([
    { id: 'u1', sequence: 1, role: 'user', content: 'Soru', turnId: 't1' },
    { id: 'a1', sequence: 2, role: 'assistant', content: 'Yanıt 【R1】', replyToId: 'u1', mode: 'standard', finishReason: 'stop', evidence: [evidence('R1')] },
    { id: 'u2', sequence: 3, role: 'user', content: 'Genel', turnId: 't2' },
    { id: 'a2', sequence: 4, role: 'assistant', content: 'Genel yanıt', replyToId: 'u2', mode: 'standard', finishReason: 'stop' }
  ]);
  assert.deepEqual(turns[0].answer.evidence.map((item) => item.id), ['R1']);
  assert.equal(turns[1].answer.evidence, null);
});

/* ── Atıf işareti ve kanıt paneli ─────────────────────────── */

test('Markdown: geçerli atıf işareti kaynak düğümüdür; biçimsiz işaret düz metin kalır; kopya metni [R1] taşır', () => {
  const tokens = parseInline('Toplam 8 görev 【R1】【R12】 ve 【R0】 【X】 【R1');
  const cites = tokens.filter((token) => token.type === 'cite').map((token) => token.id);
  assert.deepEqual(cites, ['R1', 'R12']);
  const plain = tokens.filter((token) => token.type === 'text').map((token) => token.value).join('');
  assert.ok(plain.includes('【R0】'));
  assert.ok(plain.includes('【X】'));
  const sup = findElement(renderInline(parseInline('Toplam 8 görev. 【R1】')), (node) => node.type === 'sup');
  assert.equal(sup.props.className, 'assistant-md-cite');
  assert.equal(sup.props['aria-label'], 'Kaynak R1');
  assert.equal(sup.props.children, 'R1');
  const blocks = parseAssistantMarkdown('- Madde 【R2】');
  assert.equal(JSON.stringify(blocks).includes('"cite"'), true, 'liste maddesinde de atıf çözülür');
  assert.equal(assistantMarkdownText('Toplam **8** görev. 【R1】'), 'Toplam 8 görev. [R1]');
});

function renderTurn(answer, props = {}) {
  return mountComponent(AssistantTurn, {
    turn: { key: 't1', turnId: 't1', user: { id: 'u1', content: 'Soru', pending: false }, answer, contextTrimmed: false },
    onRetry() {},
    onAction() {},
    ...props
  }).output;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

test('kanıt paneli: kaynak sayısı, veri zamanı, tür, kısmi kapsam ve kısaltma notları ile öne çıkan değerler gösterilir', () => {
  const answer = {
    status: 'complete',
    content: 'Yanıt 【R1】【R2】',
    mode: 'standard',
    finishReason: 'stop',
    error: null,
    evidence: [
      evidence('R1'),
      evidence('R2', { kind: 'task-analytics', label: 'Görev özeti · 2 görev', partial: true, truncated: true, counts: { returned: 20, total: 45 } })
    ]
  };
  const output = renderTurn(answer);
  const element = findElement(output, (node) => typeof node.type === 'function' && node.type.name === 'AnswerEvidence');
  assert.ok(element, 'kanıt paneli çizilir');
  const panel = mountComponent(element.type, element.props).output;
  assert.equal(panel.type, 'details', 'panel varsayılan olarak kapalı ayrıntı öğesidir');
  const text = textOf(panel);
  assert.match(text, /2 Rota kaynağı/);
  assert.match(text, /Veri zamanı: 29 Eyl 2026 11:12/);
  assert.match(text, /Görev listesi · 8 görev/);
  assert.match(text, /Görev özeti/);
  assert.match(text, /Yalnızca yetkili kayıtlar/);
  assert.match(text, /Kısaltılmış sonuç/);
  assert.match(text, /20 \/ 45 kayıt gösterildi/);
  assert.match(text, /Açık görevler/);
  assert.equal(text.includes('rota_'), false, 'araç adı gösterilmez');
  assert.ok(findElement(output, (node) => typeof node.type === 'function' && node.type.name === 'CopyAnswerButton'));
});

test('doğrulanamayan yanıt: kopyalama yok, açıklayıcı not var; kanıtsız yanıtta panel çizilmez', () => {
  const failed = renderTurn({ status: 'complete', content: GROUNDING_FAILURE_TEXT, mode: 'standard', finishReason: 'grounding_failed', error: null, evidence: [] });
  assert.equal(findElement(failed, (node) => typeof node.type === 'function' && node.type.name === 'CopyAnswerButton'), null);
  assert.match(textOf(failed), /Rota verisiyle doğrulanamadığı/);
  const evidencePanel = (node) => typeof node.type === 'function' && node.type.name === 'AnswerEvidence';
  assert.equal(findElement(failed, evidencePanel), null);
  const streaming = renderTurn({ status: 'streaming', content: 'Akan', mode: 'standard', finishReason: null, error: null, evidence: [evidence('R1')] });
  assert.equal(findElement(streaming, evidencePanel), null, 'kanıt yalnızca tamamlanan yanıtta');
});

test('bekleme evresi veri alanını söyler; araç adı, bağımsız değişken ya da SQL göstermez', () => {
  const waiting = (phase, topic) => textOf(renderTurn({ status: 'waiting', content: '', mode: 'standard', finishReason: null, error: null }, { phase, topic }));
  assert.match(waiting('tools', 'tasks'), /Görevler inceleniyor…/);
  assert.match(waiting('tools', 'baseline'), /Baz plan karşılaştırılıyor…/);
  assert.match(waiting('tools', 'bilinmeyen'), /Rota verisi okunuyor…/);
  assert.match(waiting('verifying', null), /Yanıt kaynaklarla doğrulanıyor…/);
});

test('sunum: kanıt özet ve not metinleri', () => {
  assert.equal(presentation.evidenceSummaryLabel([]), null);
  assert.equal(presentation.evidenceSummaryLabel([evidence('R1'), evidence('R2'), evidence('R3')]), '3 Rota kaynağı');
  assert.equal(presentation.evidenceKindLabel('baseline'), 'Baz plan karşılaştırması');
  assert.equal(presentation.evidenceKindLabel('bilinmeyen'), 'Rota kaynağı');
  assert.equal(presentation.evidenceTimeLabel('bozuk'), null);
  assert.equal(presentation.evidenceTimeLabel('2026-09-29T21:30:00.000Z'), 'Veri zamanı: 30 Eyl 2026 00:30', 'Türkiye saatiyle');
  assert.deepEqual(presentation.evidenceNotes(evidence('R1')), []);
  assert.equal(presentation.isGroundingFailure('grounding_failed'), true);
  assert.equal(presentation.isGroundingFailure('stop'), false);
  assert.match(presentation.finishReasonNote('grounding_failed'), /doğrulanamadığı/);
});
