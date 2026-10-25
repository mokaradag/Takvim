/**
 * Rota AI · doğrulanmış kanıttan doğal yanıt (uçtan uca).
 *
 * Gerçek uç, konuşma deposu, ağ geçidi araç oturumu, araç yürütücüsü ve yetki yükleyicisi bellek içi
 * SQL ikiziyle çalışır; yalnızca dil modeli belirlenimci ikizdir. Sınanan sözleşme: düzen turu aynı
 * oturumda, araçsız, dar çıktı sınırıyla ve tek kez yürür; değerleri, tabloları ve kaynakları sunucu
 * yazar; düzenin her başarısızlığı (bozuk çıktı, kesik çıktı, boş yanıt, sağlayıcı hatası, süre) aynı
 * doğrulanmış belirlenimci anlatıma döner; Derin düşünmeye devir ya da düzeltme turu yoktur; iptal
 * hiçbir şey yazmaz; günlük içerik taşımaz.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { captureConsole, createAiStack, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer, coveringBlocks, isCompositionCall } from './helpers/compositionScenario.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { aiHealthComponent } = await import('../src/server/ai/aiHealth.js');
const { compositionSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { COMPOSITION_RUNTIME } = await import('../src/server/ai/assistant/answerComposition.js');
const { activeAssistantGenerationCountForTests } = await import('../src/server/ai/assistant/assistantGenerations.js');
const { prepareAssistantTurn, generateAssistantAnswer } = await import('../src/server/ai/assistant/assistantService.js');
const { parseAnswerChart } = await import('../src/domain/ai/answerChart.js');
const { parseAssistantMarkdown } = await import('../src/features/ai/assistant/assistantMarkdown.js');

const STANDARD = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'];
const DEEP = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'];
const QUESTION = 'Geciken görevlerimi göster.';
const OVERDUE_LIST = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'],
  population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } };
const plan = (request = OVERDUE_LIST, { language = 'tr' } = {}) => ({ type: 'tool-calls', preface: [declared(request, { language })], calls: [] });

function stackFor(t, { composition = true, env = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  return createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_ANSWER_COMPOSITION: composition ? 'true' : 'false', ...env } });
}

const doneOf = (response) => {
  const done = response.events.find((event) => event.event === 'done');
  assert.ok(done, `done olayı yok: ${response.text}`);
  return done.data;
};
const turnLines = (logs) => logs.filter((line) => line.includes('"operation":"ai.grounded.turn"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));

test('kanıtlı yanıt aynı oturumda tek, araçsız ve dar sınırlı düzen turuyla doğal yazılır', async (t) => {
  let deterministic;
  await t.test('belirlenimci karşılaştırma', async (inner) => {
    const stack = stackFor(inner, { composition: false });
    stack.provider.enqueue(plan());
    doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION }));
    deterministic = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson));
  });
  const stack = stackFor(t);
  const logs = captureConsole(t);
  let sheet;
  stack.provider.enqueue(plan(), composer((view) => {
    const total = view.facts.find((fact) => fact.row == null && fact.kind === 'number');
    const label = view.facts.find((fact) => fact.role === 'label' && fact.row === 1);
    const days = view.facts.find((fact) => fact.table && fact.row === 1 && fact.kind === 'number');
    return { blocks: [{ type: 'paragraph', text: `Şu anda {${total.id}} gecikmiş göreviniz var; en uzun süredir geciken {${label.id}}, {${days.id}} gündür bekliyor.` },
      { type: 'rows', source: 'T1', style: 'table' }, { type: 'chart', source: 'G1', style: 'bar' }] };
  }, (view) => { sheet = view; }));
  const response = await sendTurn({ turnId: randomUUID(), message: QUESTION });
  const answer = doneOf(response).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD.model, STANDARD.model], 'düzen Standart modelde kalır');
  const compose = stack.provider.calls[1];
  assert.ok(isCompositionCall(compose));
  assert.deepEqual([compose.tools ?? [], compose.toolChoice ?? 'none', compose.maxOutputTokens], [[], 'none', COMPOSITION_RUNTIME.maxOutputTokens]);
  assert.equal(compose.messages[0].content, compositionSystemPrompt(), 'sabit önek');
  assert.equal(compose.messages.length, 2, 'düzen turu konuşma geçmişini ve araç sonuçlarını yeniden göndermez');
  assert.equal(sheet.question, QUESTION);
  assert.ok(response.events.some((event) => event.event === 'status' && event.data.phase === 'composing'));
  assert.match(answer.content, /^Şu anda \*\*3\*\* gecikmiş göreviniz var; en uzun süredir geciken \*\*Haftalık durum toplantısı\*\*, \*\*23\*\* gündür bekliyor\\\. 【R1】/);
  const blocks = parseAssistantMarkdown(answer.content);
  const chart = parseAnswerChart(blocks.find((block) => block.type === 'code').text);
  assert.deepEqual(chart.items.map((item) => [item.label, item.value]), [['Haftalık durum toplantısı', 23], ['Radar test planı', 10], ['Kısmi kendi görevim', 1]]);
  assert.deepEqual(answer.evidence.map((item) => item.id), ['R1']);
  // Kalıcı kanıt düzenden bağımsızdır: belirlenimci yoldakiyle aynı kayıt ve takip kümesi.
  const stored = stack.db.aiMessageEvidence.map((row) => JSON.parse(row.EvidenceJson));
  assert.deepEqual(stored.map((row) => [row.tool, row.resultScope]), deterministic.map((row) => [row.tool, row.resultScope]));
  const [line] = turnLines(logs);
  assert.equal(turnLines(logs).length, 1, 'tek tamamlanma kaydı');
  assert.deepEqual({ ...line.context.presentation, ms: null }, { mode: 'composed', reason: null, issue: null, blocks: 3, chart: 'bar', charts: 1, ms: null });
  assert.deepEqual(line.context.rounds.map((round) => [round.purpose, round.budget, round.calls]), [['plan', STANDARD.maxOutputTokens, 1], ['compose', COMPOSITION_RUNTIME.maxOutputTokens, 0]]);
  assert.equal(line.context.escalated, false);
  for (const secret of [QUESTION, 'Haftalık durum toplantısı', 'Radar test planı', String(AYSE), 'gecikmiş göreviniz']) {
    assert.equal(logs.some((text) => text.includes(secret)), false, `günlük içerik taşımaz: ${secret}`);
  }
  const { grounding } = aiTelemetrySnapshot();
  assert.deepEqual(grounding.presentation, { composed: 1, narrative: 0, byReason: {}, charts: 1 });
  assert.equal(grounding.escalations.total, 0);
});

test('düzenin her başarısızlığı aynı doğrulanmış anlatıma döner; düzeltme ya da Derin devri yoktur', async (t) => {
  let baseline;
  await t.test('belirlenimci anlatım', async (inner) => {
    const stack = stackFor(inner, { composition: false });
    stack.provider.enqueue(plan());
    baseline = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage.content;
  });
  const failures = [
    ['düz metin', { type: 'answer', native: true, text: 'Şu anda üç gecikmiş göreviniz var.' }, 'INVALID', 'SHAPE_INVALID'],
    ['uydurma yuva', composer(() => ({ blocks: [{ type: 'paragraph', text: 'Toplam {F99}.' }, { type: 'rows', source: 'T1' }] })), 'INVALID', 'UNKNOWN_SLOT'],
    ['uydurma sayı', composer((view) => ({ blocks: [{ type: 'paragraph', text: `Toplam {${view.facts.find((fact) => fact.row == null).id}}, bunların 2 tanesi kritik.` }, { type: 'rows', source: 'T1' }] })), 'INVALID', 'UNSUPPORTED_NUMBER'],
    ['eksik kapsam', composer((view) => ({ blocks: [{ type: 'paragraph', text: `Toplam {${view.facts.find((fact) => fact.row == null).id}}.` }] })), 'INVALID', 'COVERAGE_INCOMPLETE'],
    ['kesik çıktı', { type: 'answer', native: true, text: '{"blocks":[{"type":"paragraph","text":"Şu', finishReason: 'length' }, 'LENGTH', null],
    ['boş yanıt', { type: 'answer', native: true, text: '', chunks: [], finishReason: 'stop' }, 'EMPTY', null],
    ['sağlayıcı hatası', { type: 'status', status: 503 }, 'PROVIDER', null]
  ];
  for (const [name, behavior, reason, issue] of failures) await t.test(name, async (inner) => {
    const stack = stackFor(inner);
    const logs = captureConsole(inner);
    stack.provider.enqueue(plan(), behavior);
    const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
    assert.equal(answer.finishReason, 'stop');
    assert.equal(answer.content, baseline, 'doğrulanmış anlatım değişmeden gösterilir');
    assert.equal(stack.provider.calls.length, 2, 'ikinci düzen turu, düzeltme ya da devir yok');
    assert.ok(stack.provider.calls.every((call) => call.model === STANDARD.model));
    assert.equal(stack.db.aiMessageEvidence.length, 1);
    const [line] = turnLines(logs);
    assert.deepEqual([line.context.presentation.mode, line.context.presentation.reason, line.context.presentation.issue], ['narrative', reason, issue]);
    assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 0);
  });
});

test('Derin kipte düzen Derin oturumunda yürür ve düşünmeye yer bırakan profil sınırını kullanır', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), composer());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION, mode: 'deep' })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.deepEqual(stack.provider.calls.map((call) => [call.model, call.maxOutputTokens]), [[DEEP.model, DEEP.maxOutputTokens], [DEEP.model, DEEP.maxOutputTokens]]);
  assert.match(answer.content, /^Doğrulanmış veriye göre öne çıkan /);
});

test('kalan süre düzen penceresine yetmiyorsa düzen istenmez; doğrulanmış anlatım gösterilir', async (t) => {
  const stack = stackFor(t, { env: { MERGEN_ROTA_AI_REQUEST_TIMEOUT_MS: '1000' } });
  const logs = captureConsole(t);
  // Plan turunda zamanı ilerletmek düzen penceresini oturumun kalan süresinin altına indirir.
  stack.provider.enqueue({ type: 'script', respond: () => { t.mock.timers.setTime(Date.now() + 40000); return plan(); } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.equal(stack.provider.calls.length, 1, 'düzen turu açılmadı');
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  assert.equal(turnLines(logs)[0].context.presentation.reason, 'BUDGET');
});

test('düzen turu takılırsa kendi penceresinde kesilir, oturum düşmez ve doğrulanmış anlatım teslim edilir', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const stack = createAiStack(t, { sicil: AYSE, seed: rotaToolSeed(), env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true',
    MERGEN_ROTA_AI_PROVIDER_FIRST_EVENT_TIMEOUT_MS: '600000', MERGEN_ROTA_AI_PROVIDER_IDLE_TIMEOUT_MS: '600000' } });
  const logs = captureConsole(t);
  stack.provider.enqueue(plan(), { type: 'stall' });
  const pending = sendTurn({ turnId: randomUUID(), message: QUESTION });
  await stack.provider.waitForCalls(2);
  assert.equal(stack.provider.calls.length, 2);
  t.mock.timers.tick(COMPOSITION_RUNTIME.timeoutMs + 1);
  const answer = doneOf(await pending).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
  assert.equal(stack.provider.calls[1].aborted, true, 'takılan istek kesildi');
  assert.equal(turnLines(logs)[0].context.presentation.reason, 'TIMEOUT');
  assert.equal(activeAssistantGenerationCountForTests(), 0);
});

test('düzen sırasında kullanıcı durdurursa hiçbir yanıt ya da kanıt yazılmaz ve kaynaklar bırakılır', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), { type: 'deferred-stream' });
  const controller = new AbortController();
  const turn = await prepareAssistantTurn({ readBody: async () => ({ turnId: randomUUID(), message: QUESTION, mode: 'standard' }) });
  t.after(() => turn.claim.release());
  const pending = generateAssistantAnswer(turn, { signal: controller.signal, onText: async () => {} });
  for (let index = 0; index < 400 && stack.provider.calls.length < 2; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(isCompositionCall(stack.provider.calls[1]));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'AI_CANCELLED');
  assert.deepEqual(stack.db.aiConversationMessages.map((row) => row.Role), ['user']);
  assert.equal(stack.db.aiMessageEvidence.length, 0);
  assert.equal(stack.provider.calls[1].aborted, true);
});

test('işletim anahtarı kapalıyken model turu yoktur; geçersiz değer güvenle kapalı sayılır', async (t) => {
  for (const value of ['false', 'tru']) await t.test(value, async (inner) => {
    const stack = stackFor(inner, { env: { MERGEN_ROTA_AI_ANSWER_COMPOSITION: value } });
    stack.provider.enqueue(plan());
    const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
    assert.equal(stack.provider.calls.length, 1);
    assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
    assert.equal(/Doğal yanıt düzeni ayarı/.test(aiHealthComponent().message), value === 'tru', 'geçersiz değer yöneticiye bildirilir');
  });
});

test('İngilizce plan İngilizce olgu sayfası ve yanıt üretir', async (t) => {
  const stack = stackFor(t);
  let sheet;
  stack.provider.enqueue(plan(OVERDUE_LIST, { language: 'en' }), composer(coveringBlocks, (view) => { sheet = view; }));
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: 'Show my overdue tasks.' })).assistantMessage;
  assert.equal(sheet.language, 'en');
  assert.ok(sheet.facts.some((fact) => fact.value === '7 September 2026'));
  assert.match(answer.content, /^Here is what the verified data shows/);
  assert.match(answer.content, /\| Task \| Deadline \| Overdue days \|/);
});

test('kısmi kapsamlı kanıtın notu düzenlenmiş yanıta da sunucu tarafından eklenir', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), composer());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.ok(answer.content.trimEnd().endsWith('_Not: Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar; ilgili projelerin tamamını yansıtmayabilir._'));
});
