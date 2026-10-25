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
import { captureConsole, createAiStack, readSse, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer, compositionView, coveringBlocks, isCompositionCall } from './helpers/compositionScenario.mjs';
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
    return { blocks: [{ type: 'details', source: 'D1' }, { type: 'rows', source: 'T1', style: 'table' }, { type: 'chart', source: 'G1', style: 'bar' }] };
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
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
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
    ['uydurma yuva', composer(() => ({ blocks: [{ type: 'paragraph', text: 'Toplam {F99}.' }, { type: 'rows', source: 'T1' }] })), 'INVALID', 'BLOCK_INVALID'],
    ['uydurma sayı', composer(() => ({ blocks: [{ type: 'paragraph', text: 'Toplam {F1}, bunların 2 tanesi kritik.' }, { type: 'rows', source: 'T1' }] })), 'INVALID', 'BLOCK_INVALID'],
    ['eksik kapsam', composer(() => ({ blocks: [{ type: 'details', source: 'D1' }] })), 'INVALID', 'COVERAGE_INCOMPLETE'],
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
  assert.match(answer.content, /^Eşleşen \*\*3\*\* görev bulundu/);
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
  assert.equal(Object.hasOwn(sheet, 'facts'), false);
  assert.match(answer.content, /^\*\*3\*\* matching tasks were found/);
  assert.match(answer.content, /\| Task \| Deadline \| Overdue days \|/);
});

test('kısmi kapsamlı kanıtın notu düzenlenmiş yanıta da sunucu tarafından eklenir', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), composer());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.ok(answer.content.trimEnd().endsWith('_Not: Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar; ilgili projelerin tamamını yansıtmayabilir._'));
});


test('etkin düzen akışı kısa dış gözcüye ilerleme bildirir; ham model metni yayımlanmaz', async (t) => {
  const { assistantStreamResponse } = await import('../src/server/ai/assistant/assistantStreamResponse.js');
  const stack = stackFor(t);
  stack.provider.enqueue(plan(), { type: 'deferred-stream' });
  const turn = await prepareAssistantTurn({ readBody: async () => ({ turnId: randomUUID(), message: QUESTION, mode: 'standard' }) });
  t.after(() => turn.claim.release());
  const stallMs = 100;
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  assert.ok(stallMs < COMPOSITION_RUNTIME.timeoutMs);
  const pending = readSse(assistantStreamResponse(turn, { stallMs, keepaliveMs: 10, progressEventMs: 10 }));
  await stack.provider.waitForCalls(2);
  const call = stack.provider.calls[1];
  // Toplam bekleme dış gözcüyü aşar; her olay kendi başına ilerlemedir.
  for (let index = 0; index < 12; index += 1) {
    clock += stallMs / 3;
    call.think();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  call.emit(JSON.stringify(coveringBlocks(compositionView(call))));
  call.complete();
  const response = await pending;
  assert.equal(response.events.some((event) => event.event === 'error'), false, response.text);
  assert.equal(doneOf(response).assistantMessage.finishReason, 'stop');
  assert.ok(response.events.some((event) => event.event === 'progress'));
  assert.equal(response.events.some((event) => event.event === 'delta' && event.data.text?.includes('"blocks"')), false);
  assert.equal(call.streamClosed, true);
  assert.equal(stack.db.aiMessageEvidence.length, 1);
});

test('düzen beklerken geri alınan yetki başarılı ve başarısız düzende kalıcı kanıta ulaşamaz', async (t) => {
  for (const valid of [true, false]) await t.test(valid ? 'geçerli düzen' : 'belirlenimci geri dönüş', async (inner) => {
    const stack = stackFor(inner);
    const logs = captureConsole(inner);
    stack.provider.enqueue(plan({ ...OVERDUE_LIST, filters: { deadline: 'overdue' } }), { type: 'deferred-stream' });
    const pending = sendTurn({ turnId: randomUUID(), message: 'Geciken görevleri göster.' });
    await stack.provider.waitForCalls(2);
    const call = stack.provider.calls[1];
    assert.ok(isCompositionCall(call), 'doğrulanmış sayfa sağlayıcıya ulaştı');
    stack.db.projectAccess = [];
    call.emit(valid ? JSON.stringify(coveringBlocks(compositionView(call))) : '{}');
    call.complete();
    const answer = doneOf(await pending).assistantMessage;
    assert.equal(stack.db.aiMessageEvidence.length, 0, 'yetkisiz kanıt teslimden önce de kaydedilmez');
    assert.equal(answer.finishReason, 'unavailable');
    assert.deepEqual(answer.evidence, []);
    assert.doesNotMatch(answer.content, /Okuma görevi bir|Haftalık durum toplantısı|Radar test planı/);
    const saved = stack.db.aiConversationMessages.filter((row) => row.Role === 'assistant');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].Content, answer.content);
    assert.equal(turnLines(logs)[0].context.presentation.reason, 'AUTHORIZATION');
  });
});

test('düzen yaşam döngüsü yalnızca başlayan turdan sonra yetki yeniler; teslim koruması her durumda kalır', async (t) => {
  const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
  const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
  const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
  for (const variant of ['composed', 'disabled', 'single', 'budget', 'revoked']) await t.test(variant, async (inner) => {
    const stack = stackFor(inner);
    const logs = captureConsole(inner);
    const context = { ...createToolTurnContext({ sicil: AYSE, now: NOW }) };
    let checks = 0;
    const recheck = context.revalidateAuthorization;
    context.revalidateAuthorization = async (...args) => {
      checks += 1;
      if (variant === 'revoked') stack.db.projectAccess = [];
      return recheck(...args);
    };
    const request = variant === 'single' ? { operation: 'value', metrics: ['tasks.total'], reasoning: 'synthesis', population: { tool: 'rota_task_search' }, filters: { deadline: 'overdue', assignee: 'me' } }
      : { ...OVERDUE_LIST, reasoning: 'synthesis', filters: { deadline: 'overdue' } };
    let rounds = 0;
    const session = { signal: new AbortController().signal, profile: 'chat.tools', model: STANDARD.model,
      remainingMs: () => variant === 'budget' ? 0 : 120000,
      round: async (input) => {
        rounds += 1;
        if (rounds === 1) return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'plan', name: 'rota_plan', arguments: JSON.stringify({ intent: 'rota', language: 'tr', request }) }] };
        if (!isCompositionCall(input)) return { text: JSON.stringify({ kind: 'rota', facts: variant === 'single' ? ['R1:totalCount']
          : ['R1:totalCount', 'R1:data.tasks.*.title', 'R1:data.tasks.*.targetFinish', 'R1:data.tasks.*.overdueDays'] }), toolCalls: [], finishReason: 'stop' };
        assert.equal(input.resend, false);
        return { text: JSON.stringify(coveringBlocks(compositionView(input))), toolCalls: [], finishReason: 'stop' };
      } };
    const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: QUESTION, now: NOW }).messages,
      catalog: toolCatalogForModel(), context, onText: async () => {}, composeAnswers: variant !== 'disabled' });
    assert.equal(rounds, variant === 'composed' ? 3 : variant === 'revoked' ? 1 : 2);
    assert.equal(checks, variant === 'composed' ? 3 : variant === 'revoked' ? 1 : 2, 'yalnızca gerçek düzen ek yetki okuması yapar');
    if (variant === 'revoked') {
      assert.equal(result.outcome, 'unavailable');
      assert.deepEqual(result.evidenceRows, []);
      assert.equal(turnLines(logs)[0].context.presentation, null);
      assert.equal(aiTelemetrySnapshot().grounding.presentation.narrative, 0);
    } else {
      assert.equal(result.outcome, 'grounded');
      const before = checks;
      assert.equal(await result.guardDisclosure(), true);
      assert.equal(checks, before + 1, 'son teslim koruması korunur');
    }
  });
});

test('olgu sayfası bağlantı hatasında yeniden gönderilmez', async (t) => {
  const stack = stackFor(t);
  const logs = captureConsole(t);
  stack.provider.enqueue(plan(), { type: 'network', code: 'ECONNREFUSED' }, composer());
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.equal(stack.provider.calls.length, 2);
  assert.equal(stack.provider.pendingCount, 1, 'ikinci olgu sayfası gönderimi yapılmaz');
  assert.equal(aiTelemetrySnapshot().retries, 0);
  assert.equal(turnLines(logs)[0].context.presentation.reason, 'PROVIDER');
});

test('son metin sınırı kapsam notunu da içerir; doğrulanmış geri dönüş kesilmez veya yeniden düzenlenmez', async () => {
  const { finalGroundedDisclosure } = await import('../src/server/ai/assistant/groundedAnswer.js');
  const { ASSISTANT_LIMITS } = await import('../src/domain/ai/assistantContract.js');
  const summaries = (ids) => ids.map((id) => ({ id, partial: true }));
  const fallback = { kind: 'grounded', normalized: 'Doğrulanmış yanıt', citedIds: ['R1'] };
  const composed = { ...fallback, normalized: 'x'.repeat(ASSISTANT_LIMITS.maxAnswerChars) };
  const result = finalGroundedDisclosure(composed, { fallback, summaries });
  assert.equal(result.overflow, true, 'yalnızca kapsam notu sınırı aştırır');
  assert.equal(result.verdict, fallback);
  assert.ok(result.disclosure.text.startsWith(fallback.normalized));
  assert.ok(result.disclosure.text.length < ASSISTANT_LIMITS.maxAnswerChars);
  const unavailable = finalGroundedDisclosure(composed, { fallback: composed, summaries });
  assert.equal(unavailable.verdict.kind, 'unavailable');
  assert.deepEqual(unavailable.verdict.citedIds, []);
});
