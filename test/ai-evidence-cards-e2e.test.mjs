/**
 * Bilgin etkileşimli kanıt kartları (ICE-1) · uçtan uca.
 *
 * Gerçek uç, konuşma deposu, araç yürütücüsü, yetki yükleyicisi ve kalıcılık bellek içi SQL ikiziyle çalışır; yalnızca dil
 * modeli belirlenimci ikizdir. Sınanan sözleşme: kart tanımlayıcısı yalnızca yeni üretilmiş, doğrulanmış yanıtın `done`
 * olayında ayrı alan olarak gelir; yanıt metni, kalıcı ileti ve kalıcı kanıt işaretsiz ve değişmezdir; model kart için
 * ek çağrı, ek araç ya da ek metin görmez; geri yüklenen ve yeniden oynatılan yanıt kart taşımaz.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { captureConsole, createAiStack, loadAssistantConversation, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer, coveringBlocks, isCompositionCall } from './helpers/compositionScenario.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { normalizeEvidenceCards, hasBindingMarks } = await import('../src/domain/ai/evidenceCards.js');
const { strongTexts } = await import('../src/features/ai/assistant/evidenceCardAnchors.js');

const QUESTION = 'Geciken görevlerimi göster.';
const OVERDUE_LIST = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'],
  population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } };
const plan = (request = OVERDUE_LIST) => ({ type: 'tool-calls', preface: [declared(request, { language: 'tr' })], calls: [] });

function stackFor(t, { composition = true } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  return createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_ANSWER_COMPOSITION: composition ? 'true' : 'false' } });
}

const doneOf = (response) => {
  const done = response.events.find((event) => event.event === 'done');
  assert.ok(done, `done olayı yok: ${response.text}`);
  return done.data;
};

test('doğrulanmış görev sayımı done olayında görev kartına bağlanır; metin ve kalıcı kayıt işaretsiz kalır', async (t) => {
  const stack = stackFor(t);
  const calls = [];
  stack.provider.enqueue(plan(), composer(coveringBlocks, (view, call) => { calls.push(call); }));
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
  const content = done.assistantMessage.content;
  assert.equal(hasBindingMarks(content), false, 'teslim edilen metin işaret taşımamalı');
  const stored = stack.db.aiConversationMessages.filter((row) => row.Role === 'assistant');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].Content, content, 'kalıcı ileti teslim edilen metnin aynısı olmalı');
  assert.equal(hasBindingMarks(stored[0].Content), false, 'kalıcı ileti işaret taşımamalı');
  assert.ok(stack.db.aiMessageEvidence.length > 0);
  for (const row of stack.db.aiMessageEvidence) assert.equal(/evidenceCards|anchors|"cards"/.test(row.EvidenceJson), false, 'kalıcı kanıt kart taşımamalı');
  assert.ok(done.evidenceCards, `kart tanımlayıcısı yok: ${content}`);
  const cards = normalizeEvidenceCards(done.evidenceCards);
  assert.ok(cards, 'tanımlayıcı katı doğrulamadan geçmeli');
  const strong = strongTexts(content);
  for (const anchor of cards.anchors) assert.equal(strong[anchor.strong], anchor.text, 'bağ, teslim edilen metnin aynı kalın düğümüne işaret etmeli');
  const collection = cards.cards.find((card) => card.kind === 'tasks');
  assert.ok(collection, 'görev koleksiyonu kartı olmalı');
  assert.equal(collection.tone, 'overdue');
  assert.equal(collection.items.length, collection.total);
  assert.ok(collection.items.every((item) => item.overdue && item.overdueDays > 0 && item.status !== 'done'));
  // Kanıt yükündeki gizli ya da korumalı alanlar karta taşınmaz.
  const serialized = JSON.stringify(done.evidenceCards);
  assert.doesNotMatch(serialized, /sicil|access|description|authorization|evidenceId|"R\d+"/i);
  // Model kart için ek çağrı ya da ek metin görmez: düzen turu tektir ve sayfada işaret yoktur.
  assert.equal(calls.length, 1);
  assert.equal(hasBindingMarks(JSON.stringify(calls[0].messages)), false);
});

test('model düzeni kapalıyken (belirlenimci anlatım) kart üretilmez ve yanıt değişmez', async (t) => {
  const stack = stackFor(t, { composition: false });
  stack.provider.enqueue(plan());
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
  assert.equal(done.evidenceCards, undefined);
  assert.equal(hasBindingMarks(done.assistantMessage.content), false);
});

test('aynı turun yeniden denenmesi kayıtlı yanıtı oynatır ve kart taşımaz', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), composer());
  const turnId = randomUUID();
  const first = doneOf(await sendTurn({ turnId, message: QUESTION }));
  assert.ok(first.evidenceCards);
  const replay = doneOf(await sendTurn({ turnId, message: QUESTION, conversationId: first.conversation.id }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.evidenceCards, undefined);
  assert.equal(stack.provider.calls.filter((call) => isCompositionCall(call)).length, 1);
});

test('yanıt düzeni sırasında yetki kalkarsa yanıt kullanılamaz olur ve kart gönderilmez', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), composer(coveringBlocks, () => {
    // Kanıt okunduktan sonra, teslimden önce erişim kalkar: son yetki denetimi kapalı ret verir.
    stack.db.projectAccess = [];
    stack.db.taskAssignees = [];
  }));
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
  assert.equal(done.evidenceCards, undefined);
  assert.equal(done.assistantMessage.finishReason, 'unavailable');
});

test('kayıtlı konuşma yeniden açıldığında yanıtlar kart taşımaz; günlük kart içeriği yazmaz', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(plan(), composer());
  const first = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
  assert.ok(first.evidenceCards);
  const loaded = await loadAssistantConversation(first.conversation.id);
  const serialized = JSON.stringify(loaded.body ?? loaded);
  assert.match(serialized, /gecikmiş/);
  assert.equal(/evidenceCards|anchors|"cards"/.test(serialized), false, 'geri yüklenen konuşma kart taşımamalı');
  const titles = first.evidenceCards.cards.flatMap((card) => card.items.map((item) => item.id));
  for (const line of logs) {
    assert.equal(/evidenceCards|anchors/.test(line), false, 'günlük kart alanı taşımamalı');
    assert.equal(titles.some((id) => line.includes(id)), false, 'günlük kart satırı taşımamalı');
  }
});
