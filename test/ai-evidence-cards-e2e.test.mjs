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
import { AYSE, NOW, PROJECTS, TASKS, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer, coveringBlocks, isCompositionCall } from './helpers/compositionScenario.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { normalizeEvidenceCards, hasBindingMarks } = await import('../src/domain/ai/evidenceCards.js');
const { strongTexts } = await import('../src/features/ai/assistant/evidenceCardAnchors.js');

const QUESTION = 'Geciken görevlerimi göster.';
const OVERDUE_LIST = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'],
  population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } };
const plan = (request = OVERDUE_LIST) => ({ type: 'tool-calls', preface: [declared(request, { language: 'tr' })], calls: [] });

function stackFor(t, { composition = true, seed = rotaToolSeed() } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  return createAiStack(t, { sicil: AYSE, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_ANSWER_COMPOSITION: composition ? 'true' : 'false' } });
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

for (const composition of [false, true]) {
  test(`açık tablo isteği sunulurken kart ayarı korunur (${composition ? 'açık' : 'kapalı'})`, async (t) => {
    const stack = stackFor(t, { composition });
    stack.provider.enqueue(plan({ ...OVERDUE_LIST, metrics: [...OVERDUE_LIST.metrics, 'task.title'], layout: 'table' }), ...(composition ? [composer()] : []));
    const done = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Geciken görevlerimi tabloyla göster.' }));
    assert.match(done.assistantMessage.content, /\|.*Görev|Görev.*\|/);
    assert.equal(Boolean(done.evidenceCards), composition);
    assert.equal(hasBindingMarks(done.assistantMessage.content), false);
  });
}

test('ICE-2: grafik isteği model düzeni kapalıyken sunucu düzeniyle karşılanır; doğrulanmış sayı ek model çağrısı olmadan karta bağlanır', async (t) => {
  const stack = stackFor(t, { composition: false });
  const declaration = JSON.parse(declared(OVERDUE_LIST, { language: 'tr' }));
  declaration.arguments.visual = true;
  stack.provider.enqueue({ type: 'tool-calls', preface: [JSON.stringify(declaration)], calls: [] });
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Geciken görevlerimi grafikle göster.' }));
  const content = done.assistantMessage.content;
  assert.match(content, /gecik/i);
  assert.match(content, /grafik|rota-chart/i);
  assert.equal(hasBindingMarks(content), false);
  // Sunucu düzeninin konum işaretleri belirlenimcidir: kart, model düzeni kapalı yapılandırmada da teslim edilir.
  const cards = normalizeEvidenceCards(done.evidenceCards);
  assert.ok(cards, `kart tanımlayıcısı olmalı: ${content}`);
  const strong = strongTexts(content);
  for (const anchor of cards.anchors) assert.equal(strong[anchor.strong], anchor.text);
  // Model yalnızca planlama turunu gördü; kart için düzen ya da başka bir model çağrısı yoktur.
  assert.equal(stack.provider.calls.length, 1, 'yalnızca planlayıcı çağrılmalı');
  assert.equal(stack.provider.calls.some(isCompositionCall), false);
});

test('dizin çözüm durumu kartı düzeltir, model ve kalıcı kanıt görünümü korunur', async (t) => {
  const seed = rotaToolSeed();
  const taskId = TASKS.OVERDUE;
  seed.taskAssignees.push({ TaskId: taskId, Sicil: 919999 });
  const stack = stackFor(t, { seed });
  stack.provider.enqueue(plan(), composer());
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
  const card = done.evidenceCards.cards.find((item) => item.kind === 'tasks');
  const row = card.items.find((item) => item.id === taskId);
  assert.ok(row?.assignees.length);
  assert.equal(row.unresolvedAssignees, 1);
  assert.doesNotMatch(JSON.stringify(card), /Seçilen kişi|919999/);
  const persisted = JSON.stringify(stack.db.aiMessageEvidence);
  assert.doesNotMatch(persisted, /cardAssignments|unresolvedAssignees/);
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

test('teslim yetkisi daraldığında sayım ve izinli kart korunur', async (t) => {
  const seed = rotaToolSeed();
  seed.taskAssignees.push({ TaskId: TASKS.READ_1, Sicil: AYSE }, { TaskId: TASKS.READ_2, Sicil: AYSE });
  const stack = stackFor(t, { seed });
  const { AI_CONVERSATION_APPEND_GROUNDED_ANSWER_SQL: writeAnswer } = await import('../src/server/ai/assistant/conversationQueries.js');
  let changed = false;
  stack.db.queryBarrier = { entered: 0, released: Promise.resolve(), match(sql) {
    if (!changed && sql === writeAnswer) {
      changed = true;
      stack.db.projectAccess = stack.db.projectAccess.filter(row => row.ProjectId !== PROJECTS.READ || row.Sicil !== AYSE);
    }
    return false;
  } };
  const request = { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'project' },
    layout: 'list', filters: { assignee: 'me' } };
  stack.provider.enqueue(plan(request), composer());
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Görevlerimi proje başına say.' }));
  assert.ok(changed);
  assert.equal(done.assistantMessage.finishReason, 'stop');
  assert.match(done.assistantMessage.content, /Okuma Projesi/u);
  const cards = normalizeEvidenceCards(done.evidenceCards);
  assert.ok(cards?.cards.some(card => card.items?.some(item => item.id === TASKS.OVERDUE)), 'etkilenmeyen kart kalmalı');
  assert.equal(cards.cards.some(card => card.items?.some(item => item.id === TASKS.READ_1)), false);
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

test('görev ve sorumlu okumaları arasında atama değişirse yanıt tamamlanır ama çelişkili kart üretilmez', async (t) => {
  const { ZEYNEP } = await import('./helpers/aiToolFixtures.mjs');
  const seed = rotaToolSeed();
  // Tam erişimli projedeki gecikmiş görev ilk okumada sorumlusuzdur; ikinci okumada görünür bir sorumlu atanır.
  seed.taskAssignees = seed.taskAssignees.filter((row) => row.TaskId !== TASKS.OVERDUE);
  const stack = stackFor(t, { seed });
  let mutated = false;
  stack.db.queryBarrier = {
    entered: 0,
    released: Promise.resolve(),
    match(sql) {
      if (!mutated && /JOIN\s+dbo\.MR_TaskAssignees\s+ta\s+ON\s+ta\.TaskId\s*=\s*visible\.TaskId/i.test(sql)) {
        mutated = true;
        stack.db.taskAssignees.push({ TaskId: TASKS.OVERDUE, Sicil: ZEYNEP });
      }
      return false;
    }
  };
  const ALL_OVERDUE = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'],
    population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto',
    filters: { deadline: 'overdue' } };
  stack.provider.enqueue(plan(ALL_OVERDUE), composer());
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Geciken görevleri göster.' }));
  assert.equal(mutated, true, 'ikinci sorumlu okuması simüle edilmeli');
  assert.equal(done.assistantMessage.finishReason, 'unavailable', 'çelişkili okuma yetki sınırında kapalı reddedilmeli');
  assert.equal(hasBindingMarks(done.assistantMessage.content), false);
  assert.equal(done.evidenceCards, undefined, 'çelişkili sorumluluk bilgisi karta taşınmamalı');
});

test('denetim karakterlerinden oluşan ad kartta görünür sayılmaz ve model kaydı genişlemez', async (t) => {
  const seed = rotaToolSeed();
  seed.people.find((person) => person.Sicil === AYSE).DisplayName = '\u200E\u202E';
  const stack = stackFor(t, { seed });
  stack.provider.enqueue(plan(), composer());
  const done = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
  const collection = done.evidenceCards.cards.find((card) => card.kind === 'tasks');
  const row = collection.items.find((item) => item.id === TASKS.OVERDUE);
  assert.equal(row.assignment, 'unresolved');
  assert.equal(row.unresolvedAssignees, 1);
  assert.equal(row.assigneesClipped, undefined);
  assert.deepEqual(row.assignees, []);
  assert.doesNotMatch(JSON.stringify(stack.db.aiMessageEvidence), /cardAssignments|hiddenCount/);
});
