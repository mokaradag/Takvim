/**
 * Rota AI · Aşama 4D kanıta bağlı anlatım, temiz Derin yeniden planlama ve kısa işletim günlüğü (sözleşme).
 *
 * Sunucu NEYİN DOĞRU olduğunu belirler: önermeleri (sayım, en büyük/en küçük, çoğunluk, toplam, döküm)
 * doğrulanmış olgulardan belirlenimci olarak türetir ve yazar; ilişki ancak önkoşulu sağlanınca vardır.
 * Model doğrulanmış önermelerin İNSANA NASIL anlatılacağını seçer: hangi önerme, hangi sırayla, hangi
 * paragrafta, hangi tabloya/grafiğe yönlendirmeyle. Doğrulama yapısaldır; dil, sözcük ya da kalıp yoktur.
 * Geçersiz anlatım belirlenimci anlatıma döner. Zayıf modelin reddedilen planı ya da anlatımı Derin
 * bağlamına girmez; devir turda en fazla bir kezdir.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { captureConsole, createAiStack, sendTurn } from './helpers/aiStack.mjs';
import { AYSE, NOW, PROJECTS, TASKS, callRotaTool, callRotaTools, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer, isCompositionCall } from './helpers/compositionScenario.mjs';
import { declared, nativeDeclaration } from './helpers/evidenceScenario.mjs';
import { verifyRequested } from './helpers/requestScenario.mjs';

const { buildComposition, hasCompositionChoice, renderComposition, validateComposition, COMPOSITION_LIMITS } = await import('../src/domain/ai/groundedComposition.js');
const { tablePropositions, sharePercent, majorityPercent, populationProposition, titleCandidate, countProposition } = await import('../src/domain/ai/groundedPropositions.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const { runGroundedTurn, restartNote, NARRATION_ESCALATION } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { buildGroundedContext, compositionSystemPrompt, groundedSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');
const { typedPlanningTool } = await import('../src/server/ai/tools/executionSet.js');
const { requestSchema } = await import('../src/server/ai/tools/requestDeclaration.js');
const { groundedTurnSummary, aiTelemetrySnapshot } = await import('../src/server/ai/aiTelemetry.js');
const { consoleLogFormat, logEvent } = await import('../src/server/observability/structuredLogger.js');
const { parseAssistantMarkdown, assistantMarkdownText } = await import('../src/features/ai/assistant/assistantMarkdown.js');
const { escapedFactText } = await import('../src/domain/ai/evidenceFacts.js');

const STANDARD = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools'];
const DEEP = DEFAULT_AI_MODEL_REGISTRY.profiles['chat.tools.reasoning'];
const OVERDUE_FACTS = ['totalCount', 'data.tasks.*.title', 'data.tasks.*.targetFinish', 'data.tasks.*.overdueDays'];
const OVERDUE_LIST = { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'], filters: { deadline: 'overdue', assignee: 'me' } };
const OVERDUE_REQUEST = { ...OVERDUE_LIST, population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto' };
const STATUS_REQUEST = { operation: 'list', metrics: ['tasks.total'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'status' }, layout: 'auto', filters: { assignee: 'me' } };
const QUESTION_A = 'Kaç gecikmiş görevim var ve hangileri?';
const QUESTION_B = 'görevlerimin dağılımını göster';

const stackFor = (t, env = {}) => createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', ...env }, seed: rotaToolSeed() });
const issue = (result) => (result.ok ? null : result.issues[0]);
const doneOf = (response) => response.events.find((event) => event.event === 'done')?.data;
const turnLines = (logs) => logs.filter((line) => line.includes('"operation":"ai.grounded.turn"')).map((line) => JSON.parse(line.slice(line.indexOf('{'))));

async function overdueSheet(t, { locale = 'tr' } = {}) {
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { deadline: 'overdue', assignee: 'me' });
  const verdict = verifyRequested(ledger, OVERDUE_FACTS, OVERDUE_LIST, { locale });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  return buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], locale, question: QUESTION_A });
}

async function statusSheet(t, { locale = 'tr' } = {}) {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_task_analytics', { assignee: 'me', groupBy: 'status' }]]);
  const verdict = verifyRequested(ledger, ['data.groups.*.label', 'data.groups.*.count'], STATUS_REQUEST, { locale });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  return buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], locale, question: QUESTION_B });
}

/** Yapay tablo: doğrulanmış olgu biçiminde satırlar; önerme türetimini kanıt aracından bağımsız sınar. */
function syntheticTable(values, { titles = values.map((_, index) => `Kayıt ${index + 1}`), total = values.length, complete = true, groupBy = null, metric = groupBy ? 'tasks.total' : 'task.overdueDays',
  filters = { assignee: 'me' }, projects = null } = {}) {
  const rows = values.map((value, index) => {
    const project = projects?.[index] || null;
    const fact = { field: `data.x.${index}.v`, value, semantic: { complete, metric, unit: null, measure: groupBy ? 'tasks' : 'days', groupBy, filters,
      row: { collectionSize: values.length, ...(project ? { project: project.name, projectId: project.id } : {}) } } };
    return { title: titles[index], entries: [{ rel: 'v', fact }], cells: [[fact]], context: project ? { project: project.name } : {} };
  });
  const group = { evidenceId: 'R1', tool: groupBy ? 'rota_task_analytics' : 'rota_task_search', envelope: groupBy ? [] : [{ field: 'totalCount', value: total, semantic: { complete: true } }] };
  return { group, described: { rows, columns: [{ key: 'v', label: groupBy ? 'Kayıt sayısı' : 'Gecikme (gün)', numeric: true }] } };
}

/* ── Sunucunun önermeleri ─────────────────────────────────────────────── */

test('Örnek A: sayım ve en uzun/en kısa gecikme sunucunun önermeleridir; değer, ad ve ilişki modelden gelmez', async (t) => {
  const composition = await overdueSheet(t);
  // Analist paragrafının bütün malzemesi sunucudandır: sayım, uçlar, ortalama, bir hafta eşiği ve proje yoğunlaşması.
  assert.deepEqual(composition.view.propositions.map(({ id, kind, tone, text }) => [id, kind, tone ?? 'info', text]), [
    ['P1', 'count', 'warning', 'Şu anda 3 gecikmiş göreviniz var.'],
    ['P2', 'maximum', 'warning', 'En uzun süredir geciken görev Haftalık durum toplantısı (23 gün).'],
    ['P3', 'minimum', 'info', 'En kısa süredir geciken görev Kısmi kendi görevim (1 gün).'],
    ['P4', 'average', 'info', 'Gecikmelerin ortalaması 11,3 gün.'],
    ['P5', 'threshold', 'warning', "3 görevin 2'si bir haftadan uzun süredir gecikmiş."],
    ['P6', 'concentration', 'info', "3 görevin 2'si RDR · Radar Modernizasyonu projesinde."]
  ]);
  assert.deepEqual(composition.view.titles, [{ id: 'H1', part: 1, text: 'Gecikmiş görevleriniz' }]);
  assert.equal(hasCompositionChoice(composition), true, 'önerme ve tablo birlikteyse anlatım modelin seçimidir');
  const english = await overdueSheet(t, { locale: 'en' });
  assert.deepEqual(english.view.propositions.map((item) => item.text), [
    'You currently have 3 overdue tasks.', 'The longest-overdue task is Haftalık durum toplantısı (23 days).', 'The shortest-overdue task is Kısmi kendi görevim (1 day).',
    'The average delay is 11.3 days.', '2 of the 3 tasks are more than a week overdue.', '2 of the 3 tasks are in the RDR · Radar Modernizasyonu project.'
  ]);
  assert.deepEqual(english.view.titles.map((item) => item.text), ['Your overdue tasks']);
});

test('ortalama ve bir hafta eşiği sunucunun sabit hesabıdır; ton modelin değil sunucunun seçimidir', () => {
  const derived = (values, options) => tablePropositions({ ...syntheticTable(values, options), distribution: false, locale: 'tr' })
    .filter((item) => ['average', 'threshold'].includes(item.kind)).map((item) => [item.kind, item.tone, item.plain]);
  assert.deepEqual(derived([9, 7, 3, 2]), [['average', 'info', 'Gecikmelerin ortalaması 5,3 gün.'], ['threshold', 'warning', "4 görevin 1'i bir haftadan uzun süredir gecikmiş."]]);
  // Tam yedi gün bir haftayı aşmaz.
  assert.deepEqual(derived([7, 2, 1]), [['average', 'info', 'Gecikmelerin ortalaması 3,3 gün.'], ['threshold', 'success', 'Hiçbir görevin gecikmesi bir haftayı aşmıyor.']]);
  assert.deepEqual(derived([9, 8]), [['threshold', 'warning', 'Bu görevlerin tamamı bir haftadan uzun süredir gecikmiş.']], 'iki satırda ortalama sunulmaz');
  assert.deepEqual(derived([9, 7], { total: 4 }), [], 'nüfusun bir kısmında eşik ya da ortalama iddiası yoktur');
});

test('en büyük/en küçük ilişkisi yalnızca bütün nüfus kanıttaysa ve sahibi tekilse adla vardır', () => {
  const ranked = (values, options) => tablePropositions({ ...syntheticTable(values, options), distribution: false, locale: 'tr' })
    .filter((item) => ['maximum', 'minimum'].includes(item.kind)).map((item) => [item.kind, item.plain]);
  assert.deepEqual(ranked([9, 7, 3, 2]), [['maximum', 'En uzun süredir geciken görev Kayıt 1 (9 gün).'], ['minimum', 'En kısa süredir geciken görev Kayıt 4 (2 gün).']]);
  // Eşit en büyük değer: değer doğrudur, tek bir kayıt adı değildir.
  assert.deepEqual(ranked([9, 9, 3]), [['maximum', 'En uzun gecikme 9 gün.'], ['minimum', 'En kısa süredir geciken görev Kayıt 3 (3 gün).']]);
  // Ekran görüntüsündeki aynı adlı görevler: ad tekil değilse yalnızca değer söylenir.
  assert.deepEqual(ranked([9, 7, 3, 2], { titles: ['Bütçe planlama', 'Bütçe planlama', 'Kronik', 'Bütçe planlama'] }),
    [['maximum', 'En uzun gecikme 9 gün.'], ['minimum', 'En kısa gecikme 2 gün.']]);
  // Nüfusun bir kısmı (sayfa ya da sıralamanın başı) en büyük/en küçük iddiası taşıyamaz.
  assert.deepEqual(ranked([9, 7], { total: 4 }), []);
  assert.deepEqual(ranked([9, 7, 3], { complete: false }), []);
  assert.deepEqual(ranked([5, 5, 5]), [], 'hepsi eşitse uç yoktur');
});

test('Örnek C: "büyük bölümü" yalnızca birbirini dışlayan tam dağılımda pay yarıyı aşınca; aksi hâlde düz ifade', () => {
  const distribution = (values, options = {}) => tablePropositions({ ...syntheticTable(values, { groupBy: 'status', titles: ['Tamamlandı', 'Yapılacak', 'Devam ediyor'].slice(0, values.length), ...options }), distribution: true, locale: 'tr' })
    .map((item) => [item.kind, item.plain]);
  assert.deepEqual(distribution([114, 47, 4]), [
    ['total', 'Toplam 165 göreviniz var.'],
    ['majority', 'Görevlerinizin büyük bölümü (%69) Tamamlandı durumunda.'],
    ['breakdown', 'Durumlara göre: Tamamlandı 114, Yapılacak 47, Devam ediyor 4.']
  ]);
  assert.deepEqual(distribution([40, 35, 25]).map(([kind]) => kind), ['total', 'largest', 'breakdown']);
  assert.equal(distribution([40, 35, 25])[1][1], 'En büyük grup Tamamlandı: 40 görev (%40).');
  assert.deepEqual(distribution([50, 50]).map(([kind]) => kind), ['total', 'breakdown'], 'eşit en büyük grup ne çoğunluk ne en büyük gruptur');
  assert.deepEqual(distribution([114, 47, 4], { groupBy: 'assignee' }), [], 'kişi grupları birbirini dışlamaz');
  assert.deepEqual(distribution([114, 47, 4], { complete: false }), [], 'eksik dağılımda ilişki yoktur');
  assert.equal(sharePercent(1, 1000), 1, 'sıfır olmayan pay yuvarlamayla sıfır görünmez');
  assert.equal(sharePercent(999, 1000), 99, 'tamamı olmayan pay yüz görünmez');
});

test('nüfusun doğal betimi süzgeçlerin tamamını ifade edemiyorsa belirlenimci ölçütlü cümleye döner', async (t) => {
  const stack = stackFor(t);
  const sheet = async (args, request, facts = ['totalCount', 'data.tasks.*.title', 'data.tasks.*.targetFinish']) => {
    const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', args);
    const verdict = verifyRequested(ledger, facts, request);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    return buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], question: 'x' });
  };
  const project = await sheet({ projectId: PROJECTS.FULL }, { operation: 'list', metrics: ['tasks.total', 'task.title', 'task.targetFinish'], entities: [{ type: 'project', id: PROJECTS.FULL }] });
  assert.match(project.view.propositions[0].text, /^Radar Modernizasyonu projesinde \d+ görev var\.$/);
  const text = await sheet({ text: 'Radar', assignee: 'me' }, { operation: 'list', metrics: ['tasks.total', 'task.title', 'task.targetFinish'], layout: 'table', filters: { text: 'Radar', assignee: 'me' } });
  // Başlık araması doğal betimde yoktur: önerme, sunucunun ölçütlü belirlenimci cümlesidir.
  assert.match(text.view.propositions[0].text, /^Eşleşen \d+ görev bulundu \(ölçüt: Arama metni: "Radar"; Sorumlu: Ben\)\.$/);
});

/* ── Yapısal doğrulama ve güvenli geri dönüş ──────────────────────────── */

test('Örnek D: türetilmemiş ilişki, serbest metin ya da bozuk düzen yapısal olarak reddedilir', async (t) => {
  const composition = await overdueSheet(t);
  const rows = { type: 'rows', source: 'T1', style: 'table' };
  const cases = [
    ['türetilmemiş önerme', { blocks: [{ type: 'say', items: ['P1', 'P9'] }, rows] }, 'UNKNOWN_PROPOSITION'],
    ['önerme yerine cümle', { blocks: [{ type: 'say', items: ['Şu anda 5 kritik göreviniz var.'] }, rows] }, 'UNKNOWN_PROPOSITION'],
    ['önermeye eklenen metin', { blocks: [{ type: 'say', items: ['P1'], text: 'en kısa gecikme 23 gün' }, rows] }, 'BLOCK_INVALID'],
    ['eski serbest paragraf', { blocks: [{ type: 'paragraph', text: 'P1' }, rows] }, 'BLOCK_INVALID'],
    ['yinelenen önerme', { blocks: [{ type: 'say', items: ['P1'] }, { type: 'say', items: ['P1'] }, rows] }, 'DUPLICATE_PROPOSITION'],
    ['yönlendirme sonra gelmeyen tabloya', { blocks: [rows, { type: 'say', items: ['P1', 'T1'] }] }, 'POINTER_TARGET'],
    ['yönlendirme çizilmeyen grafiğe', { blocks: [{ type: 'say', items: ['P1', 'G1'] }, rows] }, 'POINTER_TARGET'],
    ['yinelenen yönlendirme', { blocks: [{ type: 'say', items: ['T1'] }, { type: 'say', items: ['T1'] }, rows] }, 'DUPLICATE_POINTER'],
    ['boş paragraf', { blocks: [{ type: 'say', items: [] }, rows] }, 'SAY_INVALID'],
    ['metin olmayan kimlik', { blocks: [{ type: 'say', items: [{ id: 'P1' }] }, rows] }, 'SAY_INVALID'],
    ['seyrek kimlikler', { blocks: [{ type: 'say', items: ['P1', , 'P2'] }, rows] }, 'SAY_INVALID'],
    ['aşırı uzun paragraf', { blocks: [{ type: 'say', items: Array(COMPOSITION_LIMITS.maxSayItems + 1).fill('P1') }, rows] }, 'SAY_INVALID'],
    ['tablo eksik', { blocks: [{ type: 'say', items: ['P1', 'P2'] }] }, 'COVERAGE_INCOMPLETE']
  ];
  for (const [name, response, expected] of cases) assert.equal(issue(validateComposition(composition, response)), expected, name);
  const tooMany = { blocks: [...Array.from({ length: COMPOSITION_LIMITS.maxSayBlocks + 1 }, () => ({ type: 'say', items: ['T1'] })), rows] };
  assert.ok(['SAY_INVALID', 'DUPLICATE_POINTER'].includes(issue(validateComposition(composition, tooMany))));
});

test('doğrulayıcı dili anlamaya çalışmaz: kimlik ve yapı dışında hiçbir metni okumaz', async (t) => {
  // Aynı yapısal yanıt iki dilde aynı sonucu verir; kayıt adlarındaki doğal sözcükler (bir, one) denetlenmez.
  for (const locale of ['tr', 'en']) {
    const composition = await overdueSheet(t, { locale });
    assert.equal(validateComposition(composition, { blocks: [{ type: 'say', items: ['P1', 'P2', 'P3', 'T1'] }, { type: 'rows', source: 'T1' }] }).ok, true, locale);
  }
  const source = validateComposition.toString();
  for (const forbidden of [/\.test\(/, /\.match\(/, /\.exec\(/, /new RegExp/, /\.search\(/, /normalize\(/, /toLocale(Lower|Upper)Case/]) {
    assert.doesNotMatch(source, forbidden, `yapısal doğrulayıcıda metin deseni yok: ${forbidden}`);
  }
});

test('başlık ve not kutusu yalnızca sunucu kimlikleridir; ton sunucunundur, model rengi seçemez', async (t) => {
  const composition = await overdueSheet(t);
  const rows = { type: 'rows', source: 'T1', style: 'table' };
  const cases = [
    ['bilinmeyen başlık', { blocks: [{ type: 'title', source: 'H9' }, rows] }, 'UNKNOWN_SOURCE'],
    ['başlığa metin', { blocks: [{ type: 'title', source: 'H1', text: 'Kritik durum' }, rows] }, 'BLOCK_INVALID'],
    ['yinelenen başlık', { blocks: [{ type: 'title', source: 'H1' }, { type: 'title', source: 'H1' }, rows] }, 'DUPLICATE_SOURCE'],
    ['başlık sonda', { blocks: [rows, { type: 'title', source: 'H1' }] }, 'LEAD_REQUIRED'],
    ['not başta', { blocks: [{ type: 'note', items: ['P5'] }, rows] }, 'LEAD_REQUIRED'],
    ['notta yönlendirme', { blocks: [{ type: 'say', items: ['P1'] }, { type: 'note', items: ['T1'] }, rows] }, 'UNKNOWN_PROPOSITION'],
    ['nota ton', { blocks: [{ type: 'say', items: ['P1'] }, rows, { type: 'note', items: ['P5'], tone: 'success' }] }, 'BLOCK_INVALID'],
    ['iki notta aynı önerme', { blocks: [{ type: 'say', items: ['P1'] }, rows, { type: 'note', items: ['P5'] }, { type: 'note', items: ['P5'] }] }, 'DUPLICATE_PROPOSITION'],
    ['notta vurgulanıp sonra söylenen önerme', { blocks: [{ type: 'say', items: ['P1'] }, rows, { type: 'note', items: ['P5'] }, { type: 'say', items: ['P5'] }] }, 'DUPLICATE_PROPOSITION'],
    ['boş not', { blocks: [{ type: 'say', items: ['P1'] }, rows, { type: 'note', items: [] }] }, 'NOTE_INVALID'],
    ['fazla not', { blocks: [{ type: 'say', items: ['P1'] }, rows, { type: 'note', items: ['P2'] }, { type: 'note', items: ['P3'] }, { type: 'note', items: ['P5'] }] }, 'NOTE_INVALID']
  ];
  for (const [name, response, expected] of cases) assert.equal(issue(validateComposition(composition, response)), expected, name);
  const validated = validateComposition(composition, { blocks: [{ type: 'title', source: 'H1' }, { type: 'say', items: ['P1', 'P2', 'P4', 'P6', 'T1'] }, rows,
    { type: 'note', items: ['P5'] }] });
  assert.equal(validated.ok, true);
  const rendered = renderComposition(composition, validated);
  assert.ok(rendered.text.startsWith('#### Gecikmiş görevleriniz\n\nŞu anda **3** gecikmiş göreviniz var. En uzun süredir geciken görev **Haftalık durum toplantısı** (**23 gün**). Gecikmelerin ortalaması **11,3 gün**.'), rendered.text);
  assert.ok(rendered.text.endsWith("> [!warning]\n> **Dikkat:** **3** görevin **2**'si bir haftadan uzun süredir gecikmiş. 【R1】"), rendered.text);
  assert.equal(rendered.said, 5);
  // Zayıf modelin gözlenen düzeni: vurgulanan önerme paragrafta da söylenmiş. Önerme yalnızca kutuda kalır, cümle yinelenmez.
  const emphasized = validateComposition(composition, { blocks: [{ type: 'title', source: 'H1' }, { type: 'say', items: ['P1', 'P2', 'P5', 'P4', 'T1'] }, rows,
    { type: 'chart', source: 'G1', style: 'bar' }, { type: 'note', items: ['P5'] }] });
  assert.equal(emphasized.ok, true);
  assert.deepEqual(emphasized.blocks[1].items, ['P1', 'P2', 'P4', 'T1']);
  const once = renderComposition(composition, emphasized).text;
  assert.equal(once.split("bir haftadan uzun süredir gecikmiş").length - 1, 1, once);
  // Farklı tonlu önermeler aynı kutuda nötr görünür; model tonu yükseltemez.
  const mixed = renderComposition(composition, validateComposition(composition, { blocks: [{ type: 'say', items: ['P1'] }, rows, { type: 'note', items: ['P3', 'P5'] }] }));
  assert.match(mixed.text, /> \[!info\]\n> \*\*Öne çıkan:\*\* /);
  // İstemci not kutusu işaretini tona çevirir; işaret ne görünür ne kopyalanır.
  const blocks = parseAssistantMarkdown(rendered.text);
  const callout = blocks.find((block) => block.type === 'quote');
  assert.equal(callout.tone, 'warning');
  assert.equal(JSON.stringify(callout.children).includes('[!warning]'), false);
  assert.equal(blocks[0].type, 'heading');
  const copied = assistantMarkdownText(rendered.text, { evidenceIds: new Set(['R1']) });
  assert.equal(copied.includes('[!warning]'), false);
  assert.match(copied, /Dikkat: 3 görevin 2'si bir haftadan uzun süredir gecikmiş\./);
});

test('kayıt adındaki not kutusu ya da başlık sözdizimi veridir; sunucu kaçışı biçimi açamaz', () => {
  const forged = escapedFactText('[!warning]');
  assert.equal(parseAssistantMarkdown(`> ${forged}\n> metin`)[0].tone, undefined, 'kaçışlı kayıt adı ton işareti olamaz');
  assert.equal(parseAssistantMarkdown(`> [!success]\n> metin`)[0].tone, 'success');
  assert.equal(parseAssistantMarkdown(`> [!danger]\n> metin`)[0].tone, undefined, 'bilinmeyen ton düz alıntıdır');
  const title = escapedFactText('#### Sahte başlık');
  assert.notEqual(parseAssistantMarkdown(title)[0].type, 'heading');
});

test('Örnek A çizimi: model yalnızca seçer; cümle, değer, yönlendirme, ölçüt ve kaynak sunucunundur, ayrıntı yinelenmez', async (t) => {
  const composition = await overdueSheet(t);
  const validated = validateComposition(composition, { blocks: [{ type: 'say', items: ['P1', 'P2', 'P3', 'T1'] }, { type: 'rows', source: 'T1', style: 'table' }] });
  assert.equal(validated.ok, true);
  const rendered = renderComposition(composition, validated);
  assert.ok(rendered.text.startsWith('Şu anda **3** gecikmiş göreviniz var. En uzun süredir geciken görev **Haftalık durum toplantısı** (**23 gün**). En kısa süredir geciken görev **Kısmi kendi görevim** (**1 gün**). Ayrıntıları aşağıdaki tabloda görebilirsiniz. 【R1】\n\n_Ölçüt: Termin: Gecikmiş; Sorumlu: Ben_\n\n| Görev |'), rendered.text);
  assert.equal(rendered.text.includes('Eşleşen'), false, 'söylenen sayım önermesi ayrıntısının yerine geçer');
  assert.deepEqual([rendered.said, rendered.tables, rendered.citedIds], [3, 1, ['R1']]);
  // Önerme söylenmezse sunucunun ayrıntısı eksiksiz eklenir.
  const plain = renderComposition(composition, validateComposition(composition, { blocks: [{ type: 'say', items: ['P2', 'P3', 'P4'] }, { type: 'rows', source: 'T1', style: 'list' }] }));
  assert.equal((plain.text.match(/Eşleşen \*\*3\*\* görev bulundu/g) || []).length, 1);
});

test('sıralamanın başı nüfusun tamamı değildir: sayım kalır, en büyük/en küçük önerilmez', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { deadline: 'overdue', assignee: 'me', sort: 'overdue_days_desc', limit: 2 });
  const verdict = verifyRequested(ledger, ['totalCount', 'data.tasks.*.title', 'data.tasks.*.overdueDays'],
    { operation: 'rank', metrics: ['tasks.total', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 2 }, filters: { deadline: 'overdue', assignee: 'me' } });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const composition = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], question: 'En çok geciken iki görevim?' });
  assert.deepEqual(composition.view.propositions.map((item) => item.kind), ['count']);
  const rendered = renderComposition(composition, validateComposition(composition, { blocks: [{ type: 'say', items: ['P1', 'T1'] }, { type: 'rows', source: 'T1' }] }));
  assert.match(rendered.text, /^Şu anda \*\*3\*\* gecikmiş göreviniz var\. Ayrıntılar aşağıda listeleniyor\. 【R1】/);
});

test('Örnek C çizimi: dağılım önermeleri, grafik yönlendirmesi ve halka grafik doğrulanmış kanıttan', async (t) => {
  const composition = await statusSheet(t);
  assert.deepEqual(composition.view.propositions.map(({ kind, text }) => [kind, text]), [
    ['total', 'Toplam 7 göreviniz var.'],
    ['majority', 'Görevlerinizin büyük bölümü (%86) Yapılacak durumunda.'],
    ['completion', "Görevlerinizin %14'ü tamamlandı; 6 görev hâlâ açık."],
    ['breakdown', 'Durumlara göre: Yapılacak 6, Tamamlandı 1.']
  ]);
  const validated = validateComposition(composition, { blocks: [{ type: 'title', source: 'H1' }, { type: 'say', items: ['P2', 'P3', 'P4', 'G1'] }, { type: 'chart', source: 'G1', style: 'donut' },
    { type: 'rows', source: 'T1', style: 'table' }] });
  assert.equal(validated.ok, true);
  const rendered = renderComposition(composition, validated);
  assert.ok(rendered.text.startsWith("#### Görevlerinizin durum dağılımı\n\nGörevlerinizin büyük bölümü (**%86**) **Yapılacak** durumunda. Görevlerinizin **%14**'ü tamamlandı; **6** görev hâlâ açık. Durumlara göre: Yapılacak **6**, Tamamlandı **1**. Dağılımı aşağıdaki grafikte görebilirsiniz. 【R1】\n\n```rota-chart"), rendered.text);
  assert.deepEqual([rendered.chart, rendered.charts, rendered.said], ['donut', 1, 3]);
});

/* ── Uçtan uca: zayıf model, anlatım devri ve temiz yeniden planlama ───── */

const planCall = (request, { language = 'tr' } = {}) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language, request } }] });

test('Örnek A uçtan uca: tek araçsız düzen turu, insan anlatımı ve değişmeyen kalıcı kanıt; günlük içeriksizdir', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = stackFor(t, { MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true', MERGEN_ROTA_LOG_FORMAT: 'both' });
  const logs = captureConsole(t);
  let sheet;
  stack.provider.enqueue(planCall(OVERDUE_REQUEST), composer(() => ({ blocks: [{ type: 'say', items: ['P1', 'P2', 'P3', 'T1'] }, { type: 'rows', source: 'T1', style: 'table' }] }), (view) => { sheet = view; }));
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION_A })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.ok(answer.content.startsWith('Şu anda **3** gecikmiş göreviniz var. En uzun süredir geciken görev **Haftalık durum toplantısı** (**23 gün**). En kısa süredir geciken görev **Kısmi kendi görevim** (**1 gün**). Ayrıntıları aşağıdaki tabloda görebilirsiniz.'));
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD.model, STANDARD.model]);
  const compose = stack.provider.calls[1];
  assert.deepEqual(compose.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(compose.messages[0].content, compositionSystemPrompt());
  // Anlatıcının girdisi küçüktür: ham SQL, araç dökümü ya da kanıt yükü yoktur; yalnızca önerme sayfası.
  assert.ok(compose.messages[1].content.length < 2600, String(compose.messages[1].content.length));
  assert.deepEqual(Object.keys(sheet), ['language', 'today', 'question', 'parts', 'titles', 'propositions', 'tables', 'details', 'charts', 'missing']);
  assert.deepEqual(answer.evidence.map((item) => item.id), ['R1']);
  assert.equal(stack.db.aiMessageEvidence.length, 1);
  const [line] = turnLines(logs);
  assert.deepEqual([line.context.presentation.mode, line.context.presentation.said, line.context.presentation.tables], ['composed', 3, 1]);
  const summary = logs.find((text) => text.startsWith('[mergen-rota] AI '));
  assert.match(summary, /^\[mergen-rota\] AI OK grounded \d+\.\ds \| Qwen3-Next-80B-A3B-Instruct \| rounds 2: plan, compose \| tools 1 \| evidence 1 \| 4D composed \(say 3, table 1, \d+\.\ds\)/);
  for (const secret of [QUESTION_A, 'Haftalık durum toplantısı', 'gecikmiş göreviniz', String(AYSE)]) assert.equal(logs.some((text) => text.includes(secret)), false, secret);
});

test('sayım ölçüsü bildirilmemiş listede (zayıf modelin gözlenen planı) nüfus sayısı yalnızca nüfusun tamamı kanıttaysa önerme olur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = stackFor(t, { MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true' });
  // Haiku 4.5 nitelendirmesinde gözlenen plan: "kaç ... ve hangileri" sorusunda tasks.total ölçüsü yok.
  const observed = { operation: 'list', metrics: ['task.title', 'task.targetFinish', 'task.overdueDays'], population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' },
    layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } };
  let sheet;
  stack.provider.enqueue(planCall(observed), composer(() => ({ blocks: [{ type: 'say', items: ['P1', 'P2', 'P3', 'T1'] }, { type: 'rows', source: 'T1', style: 'table' }] }), (view) => { sheet = view; }));
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION_A })).assistantMessage;
  assert.deepEqual(sheet.propositions.map((item) => [item.kind, item.text]).slice(0, 3), [
    ['count', 'Şu anda 3 gecikmiş göreviniz var.'],
    ['maximum', 'En uzun süredir geciken görev Haftalık durum toplantısı (23 gün).'],
    ['minimum', 'En kısa süredir geciken görev Kısmi kendi görevim (1 gün).']
  ]);
  assert.ok(answer.content.startsWith('Şu anda **3** gecikmiş göreviniz var. En uzun süredir geciken görev **Haftalık durum toplantısı** (**23 gün**). En kısa süredir geciken görev **Kısmi kendi görevim** (**1 gün**). Ayrıntıları aşağıdaki tabloda görebilirsiniz. 【R1】'));
  assert.deepEqual(answer.evidence.map((item) => item.id), ['R1']);
  // Sayfanın bir kısmı: kanıtın kesin toplamı satır sayısından büyükse sayım ve uç önerilmez.
  const partial = createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true' }, seed: rotaToolSeed() });
  let partialSheet;
  partial.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr',
    request: { operation: 'rank', metrics: ['task.title', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 2 }, population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } } } }] },
  composer((view) => ({ blocks: view.tables.map((table) => ({ type: 'rows', source: table.id })) }), (view) => { partialSheet = view; }));
  const ranked = doneOf(await sendTurn({ turnId: randomUUID(), message: 'En çok geciken iki görevim hangisi?' }));
  assert.equal(ranked.assistantMessage.finishReason, 'stop');
  // Önce düzen turunun gerçekten çalıştığı doğrulanır: çalışmayan yol boş önerme listesi gibi görünemez.
  assert.ok(partialSheet, 'kısmi sıralama düzen sayfası göndermelidir');
  assert.deepEqual(partialSheet.propositions, []);
});

test('Örnek B: zayıf planlayıcı karar veremezse Derin temiz başlangıçtan planlar; reddedilen çıktı Derin bağlamına girmez', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = stackFor(t, { MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true' });
  const logs = captureConsole(t);
  const SENTINEL = 'ZAYIF_MODEL_DUZ_METIN_PLANI';
  const malformed = { type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', request: { operation: 'list', metrics: ['ZAYIF_MODEL_UYDURMA_OLCU'], population: { tool: 'rota_task_analytics' } } } }] };
  // Zayıf model: düz metin (karar değil) ve tek ucuz düzeltmeden sonra yine geçersiz plan → temiz Derin yeniden planlama.
  stack.provider.enqueue({ type: 'answer', native: true, text: `${SENTINEL}: dağılımı göstereceğim` }, malformed,
    planCall(STATUS_REQUEST), composer((view) => ({ blocks: [{ type: 'say', items: [...['majority', 'completion', 'breakdown'].map((kind) => view.propositions.find((item) => item.kind === kind).id), 'G1'] },
      { type: 'chart', source: 'G1', style: 'donut' }, { type: 'rows', source: 'T1', style: 'table' }] })));
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: QUESTION_B })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /^Görevlerinizin büyük bölümü \(\*\*%86\*\*\) \*\*Yapılacak\*\* durumunda\. .* Dağılımı aşağıdaki grafikte görebilirsiniz\./);
  const models = stack.provider.calls.map((call) => call.model);
  assert.deepEqual(models, [STANDARD.model, STANDARD.model, DEEP.model, DEEP.model]);
  const deepPlan = stack.provider.calls[2];
  const serialized = JSON.stringify(deepPlan.messages);
  for (const contamination of [SENTINEL, 'ZAYIF_MODEL_UYDURMA_OLCU', 'dağılımı göstereceğim', 'SUNUCU DOĞRULAMASI']) assert.equal(serialized.includes(contamination), false, contamination);
  // Derin yalnızca kanonik başlangıcı ve tek neden notunu görür: soru son kullanıcı iletisidir, ardında asistan/araç iletisi yoktur.
  const lastUser = deepPlan.messages.findLastIndex((message) => message.role === 'user');
  assert.equal(deepPlan.messages[lastUser].content, QUESTION_B);
  assert.deepEqual(deepPlan.messages.slice(lastUser + 1), [{ role: 'system', content: restartNote('REQUEST_DECLARATION') }]);
  assert.equal(deepPlan.messages[0].content, groundedSystemPrompt(NOW));
  const [line] = turnLines(logs);
  assert.deepEqual([line.context.escalation.kind, line.context.escalation.reason, line.context.escalation.toolsReused, line.context.escalation.outcome], ['plan', 'REQUEST_DECLARATION', false, 'grounded']);
  assert.deepEqual([line.context.presentation.mode, line.context.presentation.chart], ['composed', 'donut']);
});

test('okunan kanıtın karşılamadığı zayıf plan atılır: Derin yeni defterle, araç dökümü olmadan temiz planlar; ikinci devir yoktur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = stackFor(t);
  const template = stack.db.tasks.find((task) => task.TaskId === TASKS.OVERDUE);
  stack.db.tasks = Array.from({ length: 180 }, (_, index) => ({ ...template, TaskId: `20000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}` }));
  const logs = captureConsole(t);
  const weakRequest = { operation: 'list', metrics: ['task.title'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'auto', entities: [{ type: 'project', id: PROJECTS.FULL }] };
  const weakSelect = { type: 'script', respond: (call) => {
    const id = call.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content)).find((body) => body.evidenceId)?.evidenceId;
    return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${id}:data.tasks.*.title`] }) };
  } };
  const deepRequest = { operation: 'value', metrics: ['tasks.total'], population: { tool: 'rota_task_search' }, layout: 'auto', entities: [{ type: 'project', id: PROJECTS.FULL }] };
  let deepSaw = null;
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: { intent: 'rota', language: 'tr', request: weakRequest } },
    { name: 'rota_task_search', arguments: { projectId: PROJECTS.FULL, limit: 1 } }] }, weakSelect, weakSelect,
  { type: 'script', respond: (call) => { deepSaw = call.messages; return planCall(deepRequest); } });
  const answer = doneOf(await sendTurn({ turnId: randomUUID(), message: `Bu projedeki bütün görevler ${PROJECTS.FULL}` })).assistantMessage;
  assert.equal(answer.finishReason, 'stop');
  assert.match(answer.content, /\*\*180\*\* görev/);
  assert.deepEqual(stack.provider.calls.map((call) => call.model), [STANDARD.model, STANDARD.model, STANDARD.model, DEEP.model]);
  assert.equal(deepSaw.some((message) => message.role === 'tool' || message.role === 'assistant'), false, 'atılan denemenin araç alışverişi yoktur');
  assert.equal(JSON.stringify(deepSaw).includes('"limit":1'), false, 'zayıf modelin çağrı bağımsız değişkenleri taşınmaz');
  assert.deepEqual(deepSaw.at(-1), { role: 'system', content: restartNote('VERIFICATION_FAILED') });
  // Yalnızca Derin planın kanıtı kalıcıdır; atılan okumanın kanıtı açıklanmaz.
  assert.deepEqual(answer.evidence.map((item) => item.id), ['R1']);
  assert.equal(stack.db.aiMessageEvidence.length, 1);
  const [line] = turnLines(logs);
  assert.deepEqual([line.context.escalation.kind, line.context.escalation.reason, line.context.escalation.toolsReused], ['plan', 'VERIFICATION_FAILED', false]);
  assert.ok(line.context.toolCalls >= 2, 'atılan denemenin işi de ölçülür');
  assert.equal(aiTelemetrySnapshot().grounding.escalations.total, 1);
});

test('anlatım devri bütçe ve kip kapısından geçer; Derin kipte ya da süre azken ikinci model turu yoktur', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = stackFor(t);
  const run = async ({ remainingMs, escalation }) => {
    const rounds = [];
    const session = { profile: 'chat.tools', model: STANDARD.model, signal: new AbortController().signal, remainingMs: () => remainingMs, round: async (input) => {
      rounds.push(input);
      if (rounds.length === 1) return nativeDeclaration({ text: declared(OVERDUE_REQUEST), toolCalls: [], finishReason: 'tool_calls' });
      return { text: JSON.stringify({ blocks: [{ type: 'say', items: ['P99'] }, { type: 'rows', source: 'T1' }] }), toolCalls: [], finishReason: 'stop' };
    } };
    const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: QUESTION_A, now: NOW }).messages, catalog: toolCatalogForModel(),
      context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {}, escalation, composeAnswers: true });
    return { result, rounds };
  };
  const allowed = await run({ remainingMs: NARRATION_ESCALATION.minRemainingMs + 60000, escalation: true });
  assert.deepEqual([allowed.result.outcome, allowed.result.kind, allowed.result.reason], ['escalate', 'narrate', 'NARRATION_FAILED']);
  assert.equal(allowed.result.queueTimeoutMs, NARRATION_ESCALATION.queueTimeoutMs, 'Derin kuyruğu kısa beklenir');
  // Derin oturumu açılamazsa doğrulanmış belirlenimci anlatım teslim edilir.
  const fallback = await allowed.result.fallback(async () => {});
  assert.equal(fallback.outcome, 'grounded');
  assert.match(fallback.text, /^Eşleşen \*\*3\*\* görev bulundu/);
  for (const options of [{ remainingMs: NARRATION_ESCALATION.minRemainingMs - 1000, escalation: true }, { remainingMs: 120000, escalation: false }]) {
    const { result, rounds } = await run(options);
    assert.equal(result.outcome, 'grounded', JSON.stringify(options));
    assert.equal(rounds.length, 2);
    assert.match(result.text, /^Eşleşen \*\*3\*\* görev bulundu/);
  }
  assert.ok(stack);
});

/* ── Zayıf model için dar planlama şeması ─────────────────────────────── */

test('modele gösterilen plan şeması ölçü listesini bir kez taşır; doğrulama tam şemayla değişmez', () => {
  const tool = typedPlanningTool(toolCatalogForModel());
  const request = tool.parameters.properties.request;
  assert.ok(Array.isArray(request.properties.metrics.items.enum) && request.properties.metrics.items.enum.length > 20);
  for (const key of ['fields', 'bindings', 'rank']) {
    const metric = key === 'rank' ? request.properties.rank.properties.metric : request.properties[key].items.properties.metric;
    assert.equal(metric.enum, undefined, key);
  }
  assert.ok(JSON.stringify(tool).length < 32000, String(JSON.stringify(tool).length));
  assert.ok(requestSchema().properties.rank.properties.metric.enum.length > 20, 'sunucunun doğrulama şeması kapalı listeyi korur');
});

/* ── İşletim günlüğü ──────────────────────────────────────────────────── */

test('tur özeti tek bakışta sonucu, modelleri, devri, araçları, kanıtı ve 4D anlatımını söyler; içerik taşımaz', () => {
  const round = (purpose, profile, model) => ({ purpose, profile, model, configuredModel: model });
  const qwen = STANDARD.model;
  const gemma = DEEP.model;
  assert.equal(groundedTurnSummary({ outcome: 'grounded', rounds: [round('plan', 'chat.tools', qwen), round('compose', 'chat.tools', qwen)], toolCalls: 1, toolFailures: 0, evidence: 1,
    presentation: { mode: 'composed', titled: true, said: 4, tables: 1, notes: 1, chart: 'bar', ms: 700 }, usage: { input: 9100, completion: 140 } }, 2950),
  `AI OK grounded 3.0s | ${qwen} | rounds 2: plan, compose | tools 1 | evidence 1 | 4D composed (title, say 4, table 1, note 1, chart bar, 0.7s) | tokens 9100 in/140 out`);
  assert.equal(groundedTurnSummary({ outcome: 'grounded', escalation: { kind: 'plan', reason: 'EMPTY_COMPLETION', outcome: 'grounded' },
    rounds: [round('plan', 'chat.tools', qwen), round('declaration', 'chat.tools', qwen), round('retry', 'chat.tools', qwen), round('plan', 'chat.tools.reasoning', gemma), round('compose', 'chat.tools.reasoning', gemma)],
    toolCalls: 1, evidence: 1, presentation: { mode: 'composed', said: 1, tables: 1, chart: null, ms: 661 } }, 18369),
  `AI OK grounded 18.4s | ${qwen} -> ${gemma} (plan: EMPTY_COMPLETION) | rounds 5: plan, declaration, retry, -> plan, compose | tools 1 | evidence 1 | 4D composed (say 1, table 1, 0.7s)`);
  assert.equal(groundedTurnSummary({ outcome: 'failed', rounds: [round('plan', 'chat.tools', qwen), round('declaration', 'chat.tools', qwen), round('declaration', 'chat.tools', qwen), round('select', 'chat.tools', qwen), round('repair', 'chat.tools', qwen)],
    toolCalls: 1, evidence: 0, presentation: null }, 7065),
  `AI FAIL failed 7.1s | ${qwen} | rounds 5: plan, declaration x2, select, repair | tools 1 | evidence 0 | 4D -`);
  assert.match(groundedTurnSummary({ outcome: 'grounded', rounds: [round('plan', 'chat.tools', qwen), round('compose', 'chat.tools', qwen)], toolCalls: 1, evidence: 1,
    presentation: { mode: 'narrative', reason: 'INVALID', issue: 'UNKNOWN_PROPOSITION' } }, 3100), /4D fallback narrative \(INVALID: UNKNOWN_PROPOSITION\)$/);
  assert.match(groundedTurnSummary({ outcome: 'grounded', rounds: [round('plan', 'chat.tools', qwen)], toolCalls: 1, evidence: 1, presentation: { mode: 'narrative', reason: 'NO_CHOICE' } }, 900),
    /4D narrative \(no choice\)$/);
});

test('konsol biçimi ayrılabilir: json, summary ve both; ayarsız terminalde özet, yönlendirilmiş çıktıda JSON', (t) => {
  assert.equal(consoleLogFormat({}, { isTTY: true }), 'summary');
  assert.equal(consoleLogFormat({}, { isTTY: false }), 'json');
  assert.equal(consoleLogFormat({ MERGEN_ROTA_LOG_FORMAT: 'BOTH' }, { isTTY: false }), 'both');
  assert.equal(consoleLogFormat({ MERGEN_ROTA_LOG_FORMAT: 'pretty' }, { isTTY: false }), 'json', 'geçersiz değer güvenle varsayılana döner');
  const previous = process.env.MERGEN_ROTA_LOG_FORMAT;
  t.after(() => { if (previous == null) delete process.env.MERGEN_ROTA_LOG_FORMAT; else process.env.MERGEN_ROTA_LOG_FORMAT = previous; });
  const event = { component: 'AI', operation: 'ai.grounded.turn', code: 'AI_GROUNDED_TURN', message: 'x', summary: 'AI OK grounded 1.0s', context: { outcome: 'grounded' } };
  for (const [format, expected] of [['json', ['json']], ['summary', ['summary']], ['both', ['summary', 'json']]]) {
    process.env.MERGEN_ROTA_LOG_FORMAT = format;
    const logs = captureConsole(t);
    const record = logEvent(event);
    assert.equal(record.context.outcome, 'grounded', 'kayıt her biçimde aynıdır');
    assert.deepEqual(logs.map((line) => (line.includes('{"timestamp"') ? 'json' : 'summary')), expected, format);
  }
  process.env.MERGEN_ROTA_LOG_FORMAT = 'summary';
  const logs = captureConsole(t);
  logEvent({ component: 'AI', operation: 'ai.other', message: 'özetsiz olay' });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('"operation":"ai.other"'), 'özeti olmayan olay JSON kalır');
});

/* ── Yakınsama: kapsam, payda, kimlik, kaynak bağı ve bölüm sahipliği ────── */

test('dağılım önermeleri yalnızca bütün görevleri sayan sütundan (tasks.total); alt küme ölçüsü bütün görevlerin paydası olamaz', async (t) => {
  const kinds = (values, options) => tablePropositions({ ...syntheticTable(values, { groupBy: 'priority', titles: ['Yüksek', 'Orta'], ...options }), distribution: true, locale: 'tr' }).map((item) => item.kind);
  assert.deepEqual(kinds([3, 1]), ['total', 'majority', 'breakdown']);
  for (const metric of ['tasks.open', 'tasks.overdue', 'tasks.done']) assert.deepEqual(kinds([3, 1], { metric }), [], metric);
  // Gerçek araç yolu: öncelik gruplarının yalnızca açık görev sayısı seçilmiş.
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_task_analytics', { assignee: 'me', groupBy: 'priority' }]]);
  const verdict = verifyRequested(ledger, ['data.groups.*.label', 'data.groups.*.open'],
    { operation: 'list', metrics: ['tasks.open'], population: { tool: 'rota_task_analytics', collection: 'groups', groupBy: 'priority' }, layout: 'auto', filters: { assignee: 'me' } });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], question: 'Açık görevlerim önceliğe göre' });
  assert.deepEqual(sheet.view.propositions.filter((item) => ['total', 'majority', 'largest', 'completion', 'breakdown'].includes(item.kind)), []);
});

test('tek görevlik tam nüfus sayılır, tek gruplu tam dağılım özetlenir; birden çok gözlem isteyen istatistik kendi koşulunu korur', () => {
  const single = syntheticTable([9], { total: 1 });
  assert.deepEqual(tablePropositions({ ...single, distribution: false, locale: 'tr' }), [], 'tek satırda uç, ortalama, eşik ya da yoğunlaşma yoktur');
  const count = populationProposition({ group: single.group, described: single.described, size: 1, locale: 'tr' });
  assert.equal(count?.plain, '1 göreviniz var.');
  assert.equal(populationProposition({ ...single, size: 1, locale: 'en' })?.plain, 'You have 1 task.');
  const oneGroup = tablePropositions({ ...syntheticTable([6], { groupBy: 'status', titles: ['Yapılacak'] }), distribution: true, locale: 'tr' }).map((item) => [item.kind, item.plain]);
  assert.deepEqual(oneGroup, [['total', 'Toplam 6 göreviniz var.'], ['breakdown', 'Durumlara göre: Yapılacak 6.']], 'tek dolu grup çoğunluk ("büyük bölümü %100") değildir');
});

test('kesin çoğunluk %50 görünmez; en büyük grup dalına da kaymaz', () => {
  assert.equal(majorityPercent(1001, 2000, 'tr'), '50,05');
  assert.equal(majorityPercent(1001, 2000, 'en'), '50.05');
  assert.equal(majorityPercent(2001, 4000, 'tr'), '50,02', 'aşağı kesilir: gösterilen pay kesin paydan büyük değildir');
  assert.equal(majorityPercent(69, 100, 'tr'), '69');
  const [, majority] = tablePropositions({ ...syntheticTable([1001, 999], { groupBy: 'status', titles: ['Yapılacak', 'Tamamlandı'] }), distribution: true, locale: 'tr' });
  assert.deepEqual([majority.kind, majority.plain], ['majority', 'Görevlerinizin büyük bölümü (%50,05) Yapılacak durumunda.']);
});

test('sayım kapsamı korunur: kilometre taşı süzgeci (false dahil) doğal cümlede düşmez, ölçütlü belirlenimci cümleye döner', async (t) => {
  const group = { tool: 'rota_task_search', evidenceId: 'R1' };
  const fallback = { markdown: 'ÖLÇÜTLÜ', plain: 'ÖLÇÜTLÜ' };
  for (const milestone of [false, true]) {
    const fact = { value: 2, semantic: { filters: { assignee: 'me', milestone } } };
    assert.equal(countProposition(group, fact, 'tr', fallback).plain, 'ÖLÇÜTLÜ', String(milestone));
  }
  assert.equal(countProposition(group, { value: 2, semantic: { filters: { assignee: 'me', milestone: null } } }, 'tr', fallback).plain, '2 göreviniz var.');
  assert.equal(titleCandidate({ tool: 'rota_task_search', filters: { assignee: 'me', milestone: false }, locale: 'tr' }), null, 'başlık nüfusu genişletemez');
  // Gerçek yol: sayım ölçüsü bildirilmemiş tam liste; nüfus sayımı aynı süzgeçlerin ölçütlü cümlesidir.
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { assignee: 'me', milestone: false });
  const list = { operation: 'list', metrics: ['task.title', 'task.targetFinish'], population: { tool: 'rota_task_search', collection: 'tasks' }, layout: 'auto', filters: { assignee: 'me', milestone: false } };
  const verdict = verifyRequested(ledger, ['data.tasks.*.title', 'data.tasks.*.targetFinish'], list);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const size = JSON.parse(ledger.payloads()[0].payload).totalCount;
  const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], question: 'x', populations: new Map([['R1', size]]) });
  const counted = sheet.view.propositions.find((item) => item.kind === 'count');
  assert.ok(counted, 'tam nüfusun sayımı vardır');
  assert.match(counted.text, new RegExp(`^Eşleşen ${size} görev bulundu \\(ölçüt: .*Kilometre taşı: Hayır`));
  assert.deepEqual(sheet.view.titles, []);
});

test('tarih aralığı başlığı nüfusu genişletmez: tek uçlu ve gruplanmış aralık başlıkta kalır', () => {
  const title = (filters, groupBy = null, locale = 'tr') => titleCandidate({ tool: 'rota_task_analytics', filters: { assignee: 'me', dateField: 'targetFinish', ...filters }, groupBy, locale });
  assert.equal(title({ dateFrom: '2026-11-01' }, 'status'), 'Görevlerinizin durum dağılımı (1 Kasım 2026 ve sonrasında terminli)');
  assert.equal(title({ dateTo: '2026-11-30' }), 'Görevleriniz (30 Kasım 2026 ve öncesinde terminli)');
  assert.equal(title({ dateFrom: '2026-11-01', dateTo: '2026-11-30' }, 'status'), 'Görevlerinizin durum dağılımı (1 Kasım 2026 – 30 Kasım 2026)');
  assert.equal(title({ dateFrom: '2026-11-01' }, 'status', 'en'), 'Status distribution of your tasks (due on or after 1 November 2026)');
  assert.equal(title({}, 'status'), 'Görevlerinizin durum dağılımı');
});

test('proje yoğunlaşması yalnızca görev koleksiyonunda ve doğrulanmış proje kimliğiyle; aynı ad bir proje değildir', () => {
  const concentration = (projects, { tool = 'rota_task_search', collection = 'data.tasks' } = {}) => {
    const table = syntheticTable([9, 7, 3], { projects });
    return tablePropositions({ ...table, group: { ...table.group, tool }, distribution: false, locale: 'tr', collection }).find((item) => item.kind === 'concentration')?.plain ?? null;
  };
  const a = { id: 'p-a', name: 'RDR · Radar' };
  const b = { id: 'p-b', name: 'RDR · Radar' };
  const c = { id: 'p-c', name: 'PRT · Kısmi' };
  assert.equal(concentration([a, a, a]), 'Bu görevlerin tamamı RDR · Radar projesinde.');
  assert.equal(concentration([a, b, a]), 'Görevler 2 projeye dağılmış.', 'aynı adlı iki proje tek proje sayılmaz ve adla öne çıkarılmaz');
  assert.equal(concentration([a, c, a]), "3 görevin 2'si RDR · Radar projesinde.");
  assert.equal(concentration([{ name: 'RDR · Radar' }, { name: 'RDR · Radar' }, { name: 'RDR · Radar' }]), null, 'kimliksiz satırda iddia yoktur');
  assert.equal(concentration([a, a, a], { tool: 'rota_workflow_requests', collection: 'data.requests' }), null, 'görev olmayan kayıt "bu görevler" değildir');
  assert.equal(concentration([a, a, a], { collection: 'data.successors' }), null);
});

test('yönlendirme paragrafın hemen ardındaki kanıt bloğunadır; araya başka bir tablo giremez', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { deadline: 'overdue', assignee: 'me' });
  const verdict = verifyRequested(ledger, OVERDUE_FACTS, OVERDUE_LIST);
  const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }, { index: 1, presentation: verdict.presentation }], question: QUESTION_A });
  assert.deepEqual(sheet.view.titles, [], 'başlığı olmayan bölüm varken başlık sunulmaz');
  const own = sheet.view.propositions.filter((item) => item.part === 1).slice(0, 3).map((item) => item.id);
  const say = { type: 'say', items: [...own, 'T1'] };
  assert.equal(issue(validateComposition(sheet, { blocks: [say, { type: 'rows', source: 'T2' }, { type: 'rows', source: 'T1' }] })), 'POINTER_TARGET');
  assert.equal(validateComposition(sheet, { blocks: [say, { type: 'rows', source: 'T1' }, { type: 'rows', source: 'T2' }] }).ok, true);
  // İki yönlendirme: ardından gelen ilk iki kanıt bloğu (sıra serbest).
  assert.equal(validateComposition(sheet, { blocks: [{ type: 'say', items: [...own, 'G1', 'T1'] }, { type: 'rows', source: 'T1' }, { type: 'chart', source: 'G1' }, { type: 'rows', source: 'T2' }] }).ok, true);
  assert.equal(issue(validateComposition(sheet, { blocks: [{ type: 'say', items: [...own, 'G1', 'T1'] }, { type: 'rows', source: 'T1' }, { type: 'rows', source: 'T2' }, { type: 'chart', source: 'G1' }] })), 'POINTER_TARGET');
});

test('grafik yönlendirmesi yalnızca önermenin sütununu gösteren grafiğe olur (kaynak bağı); başka ölçünün grafiği reddedilir', async (t) => {
  const stack = stackFor(t);
  for (const [id, progress] of [[TASKS.OVERDUE, 20], [TASKS.SERIES, 60], [TASKS.PARTIAL_OWN, 90]]) stack.db.tasks.find((row) => row.TaskId === id).Progress = progress;
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { deadline: 'overdue', assignee: 'me' });
  const verdict = verifyRequested(ledger, [...OVERDUE_FACTS, 'data.tasks.*.progressPercent'], { ...OVERDUE_LIST, metrics: [...OVERDUE_LIST.metrics, 'task.progressPercent'] });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  const sheet = buildComposition({ parts: [{ index: 0, presentation: verdict.presentation }], question: QUESTION_A });
  const columnOf = (label) => sheet.view.tables[0].columns.find((column) => column.label === label).id;
  const overdueChart = sheet.view.charts.find((chart) => chart.column === columnOf('Gecikme (gün)'));
  const progressChart = sheet.view.charts.find((chart) => chart.column === columnOf('İlerleme (%)'));
  assert.ok(overdueChart && progressChart, JSON.stringify(sheet.view.charts));
  const overdue = sheet.view.propositions.filter((item) => item.column === columnOf('Gecikme (gün)')).slice(0, 3).map((item) => item.id);
  assert.equal(overdue.length, 3, 'gecikme önermeleri sütunlarıyla sayfadadır');
  const blocks = (chart) => [{ type: 'say', items: [...overdue, chart.id] }, { type: 'chart', source: chart.id }, { type: 'rows', source: 'T1' }];
  assert.equal(issue(validateComposition(sheet, { blocks: blocks(progressChart) })), 'POINTER_PROVENANCE');
  assert.equal(validateComposition(sheet, { blocks: blocks(overdueChart) }).ok, true);
  // Tablo, kendi kanıtının bütün önermelerini destekler (zarf sayımı dahil).
  assert.equal(validateComposition(sheet, { blocks: [{ type: 'say', items: ['P1', ...overdue, 'T1'] }, { type: 'rows', source: 'T1' }] }).ok, true);
});

test('çok bölümlü yanıtta başlık, paragraf, not ve yönlendirme kendi bölümündedir; doğru olgu yanlış başlığa düşemez', async (t) => {
  const stack = stackFor(t);
  const { ledger } = await callRotaTools(stack, AYSE, [['rota_task_search', { deadline: 'overdue', assignee: 'me' }], ['rota_task_analytics', { assignee: 'me', groupBy: 'status' }]]);
  const overdue = verifyRequested(ledger, OVERDUE_FACTS.map((fact) => `R1:${fact}`), OVERDUE_LIST);
  const status = verifyRequested(ledger, ['R2:data.groups.*.label', 'R2:data.groups.*.count'], STATUS_REQUEST);
  assert.equal(overdue.ok && status.ok, true, JSON.stringify([overdue.issues, status.issues]));
  const sheet = buildComposition({ parts: [{ index: 0, presentation: overdue.presentation }, { index: 1, presentation: status.presentation }], question: 'Gecikenler ve durum dağılımı' });
  assert.deepEqual(sheet.view.titles.map((item) => [item.id, item.part]), [['H1', 1], ['H2', 2]]);
  const ids = (part) => sheet.view.propositions.filter((item) => item.part === part).slice(0, 3).map((item) => item.id);
  const [p1, p2] = [ids(1), ids(2)];
  const valid = [{ type: 'title', source: 'H1' }, { type: 'say', items: [...p1, 'T1'] }, { type: 'rows', source: 'T1' },
    { type: 'title', source: 'H2' }, { type: 'say', items: [...p2, 'T2'] }, { type: 'rows', source: 'T2' }];
  assert.equal(validateComposition(sheet, { blocks: valid }).ok, true);
  const cases = [
    ['ikinci bölüm birinci başlığın altında', [valid[0], valid[1], valid[2], valid[4], valid[5]], 'PART_SCOPE'],
    ['paragrafta iki bölüm', [valid[0], { type: 'say', items: [p1[0], p2[0], p1[1]] }, valid[2], valid[3], valid[5]], 'PART_MIXED'],
    ['başka bölümün tablosuna yönlendirme', [{ type: 'say', items: [...p1, 'T2'] }, valid[5], valid[2]], 'PART_MIXED'],
    ['başka bölümün notu', [...valid.slice(0, 3), { type: 'note', items: [p2[2]] }, ...valid.slice(3)], 'PART_SCOPE']
  ];
  for (const [name, blocks, expected] of cases) assert.equal(issue(validateComposition(sheet, { blocks })), expected, name);
});

test('zengin kanıt zengin anlatım ister: önerme varken yalnızca tablo ya da başlık 4D değildir; az önermede kısa anlatım geçerlidir', async (t) => {
  const composition = await overdueSheet(t);
  const rows = { type: 'rows', source: 'T1', style: 'table' };
  assert.equal(composition.view.propositions.length, 6);
  for (const [name, blocks] of [
    ['yalnızca tablo', [rows]],
    ['başlık ve tablo', [{ type: 'title', source: 'H1' }, rows]],
    ['yalnızca yönlendirme', [{ type: 'say', items: ['T1'] }, rows]],
    ['iki önerme (altı varken)', [{ type: 'say', items: ['P1', 'P2', 'T1'] }, rows]],
    ['paragrafsız not', [rows, { type: 'note', items: ['P5', 'P2', 'P1'] }]]
  ]) assert.equal(issue(validateComposition(composition, { blocks })), 'NARRATION_REQUIRED', name);
  assert.equal(validateComposition(composition, { blocks: [{ type: 'say', items: ['P1', 'P2', 'T1'] }, rows, { type: 'note', items: ['P5'] }] }).ok, true, 'not kutusu da anlatımdır');
  // Seyrek kanıt: sayfada tek önerme varsa tek cümle doğrudur; dolgu istenmez.
  const stack = stackFor(t);
  const { ledger } = await callRotaTool(stack, AYSE, 'rota_task_search', { deadline: 'overdue', assignee: 'me', sort: 'overdue_days_desc', limit: 2 });
  const ranked = verifyRequested(ledger, ['totalCount', 'data.tasks.*.title', 'data.tasks.*.overdueDays'],
    { operation: 'rank', metrics: ['tasks.total', 'task.overdueDays'], rank: { metric: 'task.overdueDays', order: 'desc', limit: 2 }, filters: { deadline: 'overdue', assignee: 'me' } });
  const sparse = buildComposition({ parts: [{ index: 0, presentation: ranked.presentation }], question: 'En çok geciken iki görevim?' });
  assert.equal(sparse.view.propositions.length, 1);
  assert.equal(validateComposition(sparse, { blocks: [{ type: 'say', items: ['P1', 'T1'] }, { type: 'rows', source: 'T1' }] }).ok, true);
});

test('paragraf sınırı kendi nedeniyle reddedilir (yinelenen yönlendirme gizlemez)', async (t) => {
  const composition = await overdueSheet(t);
  const distinct = Array.from({ length: COMPOSITION_LIMITS.maxSayBlocks + 1 }, (_, index) => ({ type: 'say', items: [`P${index + 1}`] }));
  assert.equal(issue(validateComposition(composition, { blocks: [...distinct, { type: 'rows', source: 'T1' }] })), 'SAY_INVALID');
  assert.equal(validateComposition(composition, { blocks: [...distinct.slice(0, COMPOSITION_LIMITS.maxSayBlocks), { type: 'rows', source: 'T1' }] }).ok, true, 'sınırdaki paragraf sayısı geçerlidir');
});

test('kayıt değeri gerçek çizim yolunda başlık ya da not kutusu açamaz: kayıt → önerme/başlık → düzen → istemci ayrıştırıcısı', async (t) => {
  const stack = stackFor(t);
  const project = stack.db.projects.find((row) => row.ProjectId === PROJECTS.FULL);
  // Araç katmanı denetim karakterlerini (satır sonu dahil) boşluğa çevirir; kayıt metni satır içi sözdizimi taşıyabilir.
  project.ProjectName = '#### Sahte proje başlığı > [!success] [proje](https://kotu.test)';
  stack.db.tasks.find((row) => row.Title === 'Haftalık durum toplantısı').Title = '> [!success] #### Sahte görev **kalın** [tıkla](https://kotu.test)';
  // Proje kapsamlı sayım: başlık adayı ve paragrafın ilk sözcüğü kayıt adıdır.
  const scoped = await callRotaTool(stack, AYSE, 'rota_task_search', { projectId: PROJECTS.FULL, deadline: 'overdue' });
  const projectVerdict = verifyRequested(scoped.ledger, OVERDUE_FACTS, { ...OVERDUE_LIST, filters: { deadline: 'overdue' }, entities: [{ type: 'project', id: PROJECTS.FULL }] });
  assert.equal(projectVerdict.ok, true, JSON.stringify(projectVerdict.issues));
  const sheet = buildComposition({ parts: [{ index: 0, presentation: projectVerdict.presentation }], question: 'x' });
  assert.ok(sheet.view.titles.length && sheet.view.titles[0].text.startsWith('#### Sahte proje'), JSON.stringify(sheet.view.titles));
  const maximum = sheet.view.propositions.find((item) => item.kind === 'maximum');
  const said = sheet.view.propositions.filter((item) => item.id !== maximum.id).slice(0, 3).map((item) => item.id);
  const validated = validateComposition(sheet, { blocks: [{ type: 'title', source: 'H1' }, { type: 'say', items: said }, { type: 'rows', source: 'T1' }, { type: 'note', items: [maximum.id] }] });
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  const rendered = renderComposition(sheet, validated);
  const blocks = parseAssistantMarkdown(rendered.text);
  const headings = blocks.filter((block) => block.type === 'heading');
  assert.equal(headings.length, 1, 'yalnızca sunucunun başlığı');
  assert.ok(JSON.stringify(headings[0]).includes('#### Sahte proje'), 'kayıt adı başlığın içinde düz metindir');
  const quotes = blocks.filter((block) => block.type === 'quote');
  assert.deepEqual(quotes.map((block) => block.tone), [maximum.tone || 'info'], 'not kutusunun tonu yalnızca sunucunun önerme tonudur');
  assert.ok(JSON.stringify(quotes[0].children).includes('[!success]'), 'kayıt adındaki işaret görünür veridir');
  // Paragraf kayıt adıyla başlasa da başlık açılmaz.
  assert.equal(blocks[1].type, 'paragraph');
  assert.ok(JSON.stringify(blocks[1]).includes('#### Sahte proje'));
  // Kayıt metni bağlantı ya da biçim açamaz: başlıkta, paragrafta ve not kutusunda düz metindir.
  const serialized = JSON.stringify(blocks);
  assert.equal(serialized.includes('"type":"link"'), false, 'kayıt adındaki bağlantı bağlantı olmaz');
  assert.ok(serialized.includes('[tıkla](https://kotu.test)') && serialized.includes('**kalın**'), 'sözdizimi görünür veridir');
  // Savunma derinliği: araç katmanını atlayan satır sonlu bir değer de önerme cümlesinde yapı açamaz.
  const forged = tablePropositions({ ...syntheticTable([9, 3], { titles: ['\n#### Sahte başlık\n> [!success] sahte', 'Diğer'] }), distribution: false, locale: 'tr' })
    .find((item) => item.kind === 'maximum');
  const parsed = parseAssistantMarkdown(`> [!warning]\n> **Dikkat:** ${forged.markdown}`);
  assert.deepEqual(parsed.map((block) => [block.type, block.tone]), [['quote', 'warning']]);
  assert.equal(parseAssistantMarkdown(forged.markdown).some((block) => ['heading', 'quote'].includes(block.type)), false);
});

test('Derin anlatımın ortak süresi dolsa da doğrulanmış belirlenimci yanıt taze yetki doğrulamasıyla teslim edilir', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  stackFor(t);
  const shared = createToolTurnContext({ sicil: AYSE, now: NOW });
  let authorizations = 0;
  const revalidate = shared.revalidateAuthorization || shared.authorization;
  const context = { ...shared, revalidateAuthorization: async (signal) => { authorizations += 1; return revalidate(signal); } };
  const weak = { profile: 'chat.tools', model: STANDARD.model, signal: new AbortController().signal, remainingMs: () => 120000, round: async (input) => {
    if (!input.messages.at(-1).content.startsWith('OLGU SAYFASI')) return nativeDeclaration({ text: declared(OVERDUE_REQUEST), toolCalls: [], finishReason: 'tool_calls' });
    return { text: JSON.stringify({ blocks: [{ type: 'say', items: ['P99'] }, { type: 'rows', source: 'T1' }] }), toolCalls: [], finishReason: 'stop' };
  } };
  const escalated = await runGroundedTurn(weak, { messages: buildGroundedContext({ userContent: QUESTION_A, now: NOW }).messages, catalog: toolCatalogForModel(),
    context, onText: async () => {}, escalation: true, composeAnswers: true });
  assert.equal(escalated.kind, 'narrate');
  // Derin oturumu açıldı ama ortak yaşam döngüsü süresi doldu: oturumun sinyali iptal edilmiştir.
  const expired = new AbortController();
  expired.abort(Object.assign(new Error('süre doldu'), { code: 'AI_TIMEOUT' }));
  const deep = { profile: 'chat.tools.reasoning', model: DEEP.model, signal: expired.signal, remainingMs: () => 0, round: async () => { throw expired.signal.reason; } };
  await assert.rejects(runGroundedTurn(deep, { resume: escalated.resume, catalog: toolCatalogForModel(), context, onText: async () => {}, composeAnswers: true }));
  const before = authorizations;
  const delivered = await escalated.fallback(async () => {}, new AbortController().signal);
  assert.equal(delivered.outcome, 'grounded');
  assert.match(delivered.text, /^Eşleşen \*\*3\*\* görev bulundu/);
  assert.ok(authorizations > before, 'teslimden önce güncel yetki yeniden doğrulanır');
  // İsteğin kendi iptali yine geçerlidir: süre uzatılmaz, iptal teslimi durdurur.
  const cancelled = new AbortController();
  cancelled.abort();
  const again = await runGroundedTurn(weak, { messages: buildGroundedContext({ userContent: QUESTION_A, now: NOW }).messages, catalog: toolCatalogForModel(),
    context, onText: async () => {}, escalation: true, composeAnswers: true });
  await assert.rejects(again.fallback(async () => {}, cancelled.signal));
});

test('konsol biçimi olayın yazıldığı akışa göre seçilir: stderr yönlendirilmişse uyarı JSON kalır', (t) => {
  const previous = { format: process.env.MERGEN_ROTA_LOG_FORMAT, out: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'), err: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY') };
  t.after(() => {
    if (previous.format == null) delete process.env.MERGEN_ROTA_LOG_FORMAT; else process.env.MERGEN_ROTA_LOG_FORMAT = previous.format;
    for (const [stream, descriptor] of [[process.stdout, previous.out], [process.stderr, previous.err]]) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else delete stream.isTTY;
    }
  });
  delete process.env.MERGEN_ROTA_LOG_FORMAT;
  const event = (severity) => ({ component: 'AI', operation: 'ai.grounded.turn', code: 'AI_GROUNDED_TURN', message: 'x', severity, summary: 'AI WARN grounded 1.0s', context: { outcome: 'grounded' } });
  const shape = (lines) => lines.map((line) => (line.includes('{"timestamp"') ? 'json' : 'summary'));
  for (const [stdoutTTY, stderrTTY, info, warning] of [[true, false, ['summary'], ['json']], [false, true, ['json'], ['summary']]]) {
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true, writable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: stderrTTY, configurable: true, writable: true });
    let logs = captureConsole(t);
    logEvent(event('INFO'));
    assert.deepEqual(shape(logs), info, `stdout ${stdoutTTY}`);
    logs = captureConsole(t);
    logEvent(event('WARNING'));
    assert.deepEqual(shape(logs), warning, `stderr ${stderrTTY}`);
  }
});

test('nitelendirme vaka süzgeci kapalı başarısız olur: bilinmeyen ya da boş seçim sınama kaydından önce reddedilir', async () => {
  const { selectQualificationCases, finalizeCompositionQualification } = await import('../scripts/answer-composition-qualification.mjs');
  assert.deepEqual(selectQualificationCases('phase4d', 'p4d-overdue, p4d-record').map((item) => item.id), ['p4d-overdue', 'p4d-record']);
  assert.equal(selectQualificationCases('phase4d', null).length, 8);
  assert.throws(() => selectQualificationCases('phase4d', 'p4d-overdu'), /bilinmeyen vaka: p4d-overdu/);
  assert.throws(() => selectQualificationCases('phase4d', 'p4d-overdue,p4d-nope'), /p4d-nope/);
  assert.throws(() => selectQualificationCases('phase4d', ' , '), /bilinmeyen vaka/);
  assert.throws(() => selectQualificationCases('smoke', 'p4d-overdue'), /bilinmeyen vaka/, 'başka aşamanın vakası seçilemez');
  const empty = { provider: 'dry', cases: 0, passed: 0, calls: 0, escalations: 0, usage: { thinking: 0 }, results: [] };
  assert.throws(() => finalizeCompositionQualification(empty), /COMPOSITION_NO_CASES/, 'sıfır vaka başarılı kapı değildir');
  assert.throws(() => finalizeCompositionQualification({ ...empty, cases: 1, passed: 1, selected: 2 }), /COMPOSITION_CASES_NOT_RUN/);
});
