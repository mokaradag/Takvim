/**
 * Aşama 4E kalite yakınsaması — kök neden sınamaları.
 *
 * 1) Anlatım: model yalnızca önerme yuvalarının sırasını ve paragraflarını seçer; yuva dışı metni çizilmez, cümleleri
 *    sunucu doğrulanmış bağlarla kurar (groundedProse.js, groundedPropositions.js § fluentParagraph).
 * 2) Ayrıntı: Ayrıntılı, Dengeli ile aynı soruda daha geniş okuma ve daha zengin sayfa üretir (yalnızca sayı sınırı değil).
 * 3) Takip: kısa takip önceki yönleri, ufku, görsel isteği ve grafik türünü korur; konuşma eylemi sunuma taşınır;
 *    açıklama seçimi özgün analitik niyeti model turu olmadan yeniden yürütür; her tur güncel yetkiyle okunur.
 * 4) Grafik: istenen tür bütün bölümlerde aranır; gösterge kartları veri grafiğinin yerine geçmez.
 * 5) Rol matrisi: yönetici (admin) ekip lideri sayılmaz; ekip lideri + yönetici ekip kapsamını kullanır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureConsole } from './helpers/aiStack.mjs';
import { ADMIN, ALI_1, ALI_2, AYSE, LEAD, OUTSIDER, TASKS, ZEYNEP, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer } from './helpers/compositionScenario.mjs';
import { phase4eConversation, populationReads } from './helpers/phase4eScenario.mjs';
import { ANSWER_DETAIL_CONTRACT, normalizeAnswerDetail } from '../src/domain/ai/answerDetail.js';

const { checkProse } = await import('../src/domain/ai/groundedProse.js');
const { fluentParagraph } = await import('../src/domain/ai/groundedPropositions.js');
const { preferredChart } = await import('../src/domain/ai/groundedComposition.js');
const { expandAnalysis, parseAnalysis, resolveAnalysisBrief } = await import('../src/server/ai/tools/analysisPlan.js');

const turnLine = (logs) => logs.map((row) => (row.includes('"operation":"ai.grounded.turn"') ? JSON.parse(row.slice(row.indexOf('{'))) : null)).filter(Boolean).at(-1);
const OPENERS = ['Genel tabloya bakınca', 'Bunun yanında', 'Öte yandan', 'Ayrıca', 'Buna ek olarak', 'Son olarak'];

/**
 * Eski sözleşmeye göre yazan modelin yuvalı düzyazısı: her bölüm bir paragraf, her önermenin önünde bir bağlaç; çekinceler
 * her zaman söylenir. Bağlaçlar artık çizilmez (yalnızca yuva sırası kullanılır).
 */
function proseLayout(view, { skipRequired = false } = {}) {
  const props = view.propositions;
  const parts = [...new Set([...props, ...view.tables, ...view.details].map((item) => item.part))].sort((left, right) => left - right);
  const max = ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(view.detail)].maxNarrated;
  const blocks = [];
  for (const part of parts) {
    const own = props.filter((item) => item.part === part && (!skipRequired || !item.required));
    const required = own.filter((item) => item.required);
    const said = [...required, ...own.filter((item) => !item.required)].slice(0, Math.max(max, required.length));
    if (said.length) blocks.push({ type: 'say', text: said.map((item, index) => `${OPENERS[index % OPENERS.length]} {${item.id}}.`).join(' ') });
    for (const table of view.tables.filter((item) => item.part === part)) blocks.push({ type: 'rows', source: table.id });
  }
  if (view.visual && view.charts.length) {
    const chart = (view.chart && view.charts.find((item) => item.types.includes(view.chart))) || view.charts[0];
    blocks.push({ type: 'chart', source: chart.id, style: view.chart && chart.types.includes(view.chart) ? view.chart : chart.types[0] });
  }
  return { blocks };
}

/* ── 1. Kanıta bağlı düzyazı ─────────────────────────────────────────── */

test('kapalı anlatım sözleşmesi: yuva dışı model metni (bağlaç dahil) çizim yapısına hiç girmez; bilinmeyen ve yinelenen yuva reddedilir', () => {
  const known = (id) => ['P1', 'P2', 'T1'].includes(id);
  const valid = checkProse('Genel tabloya bakınca {P1}. Ayrıca {P2}. {T1}', { known });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.ids, ['P1', 'P2', 'T1']);
  assert.deepEqual(valid.sentences, [[{ slot: 'P1' }], [{ slot: 'P2' }], [{ slot: 'T1' }]], 'eski bağlaç da çizilmez');
  for (const text of ['There are fifty overdue tasks: {P1}.', 'Çoğu tamamlandı: {P1}.', 'Kasım ayının ilk günü {P1}.',
    'Öncekinin iki katı: {P1}.', '大多数任务完成了 {P1}.', 'أغلب المهام اكتملت {P1}.', '{P1} ama bu doğru değil.',
    'İK için {P1}.', 'xx üzerinde {P1}.', 'Radar **Modernizasyonu**: {P1}.', '{P1} ve bunların hepsi bir projede: {P2}.']) {
    const checked = checkProse(text, { known });
    // Serbest olgu kabul edilmez: modelin hiçbir sözcüğü çizilecek cümlelere taşınmaz; yalnızca yuva sırası kalır.
    assert.equal(checked.ok, true, text);
    assert.ok(checked.sentences.flat().every((token) => Object.keys(token).join() === 'slot'), text);
    assert.ok(checked.dropped >= 1, `atılan model metni sayılır: ${text}`);
  }
  assert.equal(checkProse('{P9}.', { known }).issue, 'UNKNOWN_PROPOSITION');
  assert.equal(checkProse('{P1}. {P1}.', { known }).issue, 'DUPLICATE_PROPOSITION');
  assert.equal(checkProse('Yalnızca yorum, olgu yok.', { known }).issue, 'PROSE_UNGROUNDED');
});

test('adlı ya da gömülü yuva bağımsız model iddiası taşıyamaz: adlar ve işaretler yuva dışında kalır ve çizilmez', () => {
  const known = (id) => ['P1', 'P2'].includes(id);
  for (const name of ['x', 'xx', 'xxxxxxxx', 'İK', '[Ad](https://ornek.test)', '【R99】', 'A_B']) {
    const result = checkProse(`${name} için çoğu görev tamamlandı: {P1}.`, { known });
    assert.deepEqual(result.ids, ['P1'], name);
    assert.deepEqual(result.sentences, [[{ slot: 'P1' }]], `çizim yapısında ad ya da işaret yok: ${name}`);
  }
  assert.deepEqual(checkProse('{P1}{P2}', { known }).ids, ['P1', 'P2']);
});

test('düzyazı çizimi: cümleleri sunucu kurar; modelin sırası korunur, kayıt adıyla başlayan önerme değişmez', () => {
  const proposition = { id: 'P1', kind: 'count', evidenceId: 'R1', parts: ['şu anda ', { value: '4', strong: true }, ' gecikmiş göreviniz var.'], markdown: 'Şu anda **4** gecikmiş göreviniz var.' };
  const named = { id: 'P2', kind: 'leader', evidenceId: 'R2', parts: [{ value: 'Radar Modernizasyonu', strong: true }, ', açık görev sayısında en üstte.'],
    markdown: '**Radar Modernizasyonu**, açık görev sayısında en üstte.' };
  const { sentences } = checkProse('Genel tabloya bakınca {P2}. Ayrıca {P1}.', { known: () => true });
  const byId = { P1: proposition, P2: named };
  const text = fluentParagraph(sentences.flat().map((token) => ({ proposition: byId[token.slot] })), 'tr');
  assert.equal(text, '**Radar Modernizasyonu**, açık görev sayısında en üstte. Şu anda **4** gecikmiş göreviniz var.');
});

test('doğal analist yanıtı: eski bağlaçlı model düzeni de çizilir; bağlaç atılır, olgular sunucu bağlarıyla birleşir ve atıflıdır', async (t) => {
  const logs = captureConsole(t);
  let page = null;
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return proseLayout(view); }) });
  const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } } });
  assert.equal(result.answer.finishReason, 'stop');
  const presentation = turnLine(logs).context.presentation;
  assert.equal(presentation.mode, 'composed');
  assert.notEqual(presentation.server, true, JSON.stringify(presentation));
  assert.ok(presentation.prose.dropped >= 1, 'atılan bağlaç gözlemde sayılır');
  const content = result.answer.content;
  for (const opener of OPENERS) assert.doesNotMatch(content, new RegExp(opener), `model bağlacı çizilmez: ${opener}`);
  assert.match(content, /gecikmiş durumda; bugün başlayan yedi günlük dönemde de \*\*1\*\* açık görevin termini var/, 'aynı kanıtın önermeleri sunucu bağıyla birleşir');
  assert.doesNotMatch(content, /\{P\d+\}/, 'yuva kalmaz');
  assert.match(content, /【R\d+】/, 'paragraf kanıta atıflıdır');
  assert.ok(page.propositions.length >= 4, 'sayfa birden çok önerme taşır');
  // Her kalın değer sunucunun sayfasındandır (önerme, ayrıntı ya da tablo): sayfada olmayan bir sayı yanıtta görünmez.
  const pageText = JSON.stringify(page);
  const plain = (text) => text.replace(/\*\*|\\/g, '');
  const prose = content.split('\n\n').filter((paragraph) => page.propositions.some((item) => plain(paragraph).includes(item.text.slice(0, 18)))).join('\n');
  assert.ok(prose, 'modelin paragrafları yanıtta');
  const strong = [...prose.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]).filter((value) => /^\d/.test(value));
  for (const value of strong) assert.ok(pageText.includes(value.replace(/\\/g, '').match(/\d+(?:,\d+)?/)[0]), `sayfada olmayan değer: ${value}`);
});

test('zorunlu çekince: tamlığı kanıtlanmamış ekip iş yükünde çekince her yanıtta söylenir', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload', 'overdue'] } };
  // Aşama G: kadro okunur; tamlığı kanıtlanamayan ekip için yönetim kapsamında dizin kaydı çözülemeyen bir üye vardır.
  const seed = rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP }, { ManagerSicil: AYSE, EmployeeSicil: ALI_1 }, { ManagerSicil: AYSE, EmployeeSicil: 919999 }] });
  seed.taskAssignees.push({ TaskId: TASKS.LITERAL, Sicil: ALI_1 }, { TaskId: TASKS.UNASSIGNED, Sicil: ALI_1 }, { TaskId: TASKS.OVERDUE, Sicil: ALI_1 },
    { TaskId: TASKS.SERIES, Sicil: ZEYNEP });
  await t.test('çekinceyi atlayan düzyazıya sunucu çekinceyi ekler', async (t) => {
    const logs = captureConsole(t);
    const { ask } = phase4eConversation(t, { seed, compose: () => composer((view) => proseLayout(view, { skipRequired: true })) });
    const result = await ask({ text: 'ekibimin iş yükü dengeli mi', plan });
    assert.equal(result.answer.finishReason, 'stop');
    const presentation = turnLine(logs).context.presentation;
    assert.notEqual(presentation.server, true, `modelin düzyazısı korunur: ${JSON.stringify(presentation)}`);
    assert.match(result.answer.content, /Ekibinizde şu anda \*\*3\*\* gecikmiş görev var/, 'modelin paragrafı çizilir');
    assert.ok(presentation.prose.supplemented >= 1, 'eksik çekinceyi sunucu tamamlar');
    assert.match(result.answer.content, /kesin olarak söylenemez/, 'sunucu çekinceyi ekler');
  });
  await t.test('çekinceli düzen kabul edilir; denge ya da lider önermesi yoktur', async (t) => {
    let page = null;
    const { ask } = phase4eConversation(t, { seed, compose: () => composer((view) => { page = view; return proseLayout(view); }) });
    const result = await ask({ text: 'ekibimin iş yükü dengeli mi', plan });
    assert.ok(page.propositions.some((item) => item.required && item.kind === 'completeness'));
    assert.equal(page.propositions.some((item) => ['balance', 'leader'].includes(item.kind) || /yoğunlaşıyor/.test(item.text)), false, 'eksik nüfustan denge/lider/kişi yoğunlaşması çıkarılmaz');
    assert.match(result.answer.content, /kesin olarak söylenemez/);
  });
});

/* ── 2. Ayrıntı ayarı ────────────────────────────────────────────────── */

test('Ayrıntılı, Dengeli ile aynı soruda daha geniş okuma, daha çok önerme ve daha büyük anlatım bütçesi üretir', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } };
  const pages = {};
  const reads = {};
  for (const detail of ['balanced', 'detailed']) {
    await t.test(`yanıt ayrıntısı: ${detail}`, async (t) => {
      const { ask, stack } = phase4eConversation(t, { compose: () => composer((view) => { pages[detail] = view; return proseLayout(view); }) });
      const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan }, { detail });
      assert.equal(result.answer.finishReason, 'stop');
      reads[detail] = (stack.db.aiToolLog || []).length;
      const compose = stack.provider.calls.find((call) => String(call.messages.at(-1).content).startsWith('OLGU SAYFASI'));
      pages[`${detail}Budget`] = compose.maxOutputTokens;
    });
  }
  assert.equal(pages.balanced.detail, 'balanced');
  assert.equal(pages.detailed.detail, 'detailed');
  assert.ok(reads.detailed > reads.balanced, `Ayrıntılı bütünleyici bir okuma daha yapar (${reads.balanced} → ${reads.detailed})`);
  assert.ok(pages.detailed.parts > pages.balanced.parts, 'Ayrıntılı sayfa daha çok bölüm taşır');
  assert.ok(pages.detailed.propositions.length > pages.balanced.propositions.length, 'Ayrıntılı sayfa daha çok doğrulanmış önerme taşır');
  assert.ok(pages.detailedBudget > pages.balancedBudget, 'Ayrıntılı anlatımın çıktı bütçesi daha büyüktür');
  assert.ok(ANSWER_DETAIL_CONTRACT.detailed.minNarrated > ANSWER_DETAIL_CONTRACT.balanced.minNarrated);
});

/* ── 3. Takip bağlamı ────────────────────────────────────────────────── */

test('takip özeti: yazılmayan yön ve ufuk önceki analizden sürer; satır göndergesi anlamsız yönü düşürür', () => {
  const previous = { v: 1, scope: 'self', subjects: [], focus: ['overdue', 'upcoming'], dateFrom: '2026-10-01', dateTo: '2026-10-07', rows: [{ type: 'project', id: '10000000-0000-4000-8000-000000000001' }] };
  const resolved = resolveAnalysisBrief(parseAnalysis({ scope: 'previous', act: 'explain' }), { previous });
  assert.deepEqual([...resolved.focus], ['overdue', 'upcoming']);
  assert.deepEqual([resolved.dateFrom, resolved.dateTo], ['2026-10-01', '2026-10-07']);
  const narrowed = resolveAnalysisBrief(parseAnalysis({ scope: 'previous', dateFrom: '2026-10-02', dateTo: '2026-10-03' }), { previous });
  assert.deepEqual([narrowed.dateFrom, narrowed.dateTo], ['2026-10-02', '2026-10-03'], 'yeni ufuk öncekinin yerine geçer');
  const portfolio = { ...previous, scope: 'projects', focus: ['projects', 'overdue'] };
  assert.deepEqual([...resolveAnalysisBrief(parseAnalysis({ scope: 'row', rows: [1] }), { previous: portfolio }).focus], ['overdue'], 'satırdaki projede anlamlı gecikme yönü korunur');
  assert.throws(() => parseAnalysis({ scope: 'self' }), (error) => error.details.includes('$.analysis.focus:required'), 'ilk analizde yön zorunludur');
  assert.equal(expandAnalysis(parseAnalysis({ scope: 'previous' }), { previous, today: '2026-09-30' }).length, 2, 'önceki iki yön yeniden okunur');
});

test('kısa takip ("neden?" eylemi) önceki özneyi, yönleri, ufku, görsel isteği ve grafik türünü korur', async (t) => {
  const pages = [];
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => { pages.push(view); return proseLayout(view); }) });
  const first = await ask({ text: 'gecikme ve yaklaşan işlerimi değerlendir, çubuk grafikle göster',
    plan: { intent: 'rota', language: 'tr', visual: true, chart: 'bar', analysis: { scope: 'self', focus: ['overdue', 'upcoming'] } } });
  assert.equal(first.answer.finishReason, 'stop');
  const firstReads = populationReads(first.log).length;
  const second = await ask({ text: 'neden', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', act: 'explain' } } });
  assert.equal(second.answer.finishReason, 'stop', second.answer.content);
  const page = pages.at(-1);
  assert.equal(page.visual, true, 'görsel istek sürer');
  assert.equal(page.chart, 'bar', 'grafik türü sürer');
  assert.deepEqual(page.followUp, { act: 'explain' }, 'konuşma eylemi anlatıma taşınır');
  assert.equal(page.previousQuestion, 'gecikme ve yaklaşan işlerimi değerlendir, çubuk grafikle göster', 'önceki kullanıcı sorusu bağlamdır');
  assert.equal(populationReads(second.log).length, firstReads, 'aynı yönler yeniden (güncel yetkiyle) okunur');
  assert.ok(populationReads(second.log).every(({ params }) => params.assigneeMode === 'me'), 'özne kendi işleridir');
  assert.match(second.answer.content, /```rota-chart/, 'grafik yeniden çizilir');
  const third = await ask({ text: 'daha ayrıntılı anlat', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', act: 'expand' } } });
  assert.equal(third.answer.finishReason, 'stop');
  assert.equal(pages.at(-1).detail, 'detailed', 'genişletme takibi bu turu Ayrıntılı sunar');
  const fourth = await ask({ text: 'grafik olmadan', plan: { intent: 'rota', language: 'tr', visual: false, analysis: { scope: 'previous' } } });
  assert.equal(fourth.answer.finishReason, 'stop');
  assert.notEqual(pages.at(-1).visual, true, 'görsel istek açıkça kapatılabilir');
});

test('açıklama seçimi özgün analitik niyeti (iş yükü + grafik) model turu açmadan yeniden yürütür', async (t) => {
  const seed = rotaToolSeed();
  seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: ALI_1 }, { TaskId: TASKS.LITERAL, Sicil: ALI_1 }, { TaskId: TASKS.UNASSIGNED, Sicil: ALI_2 });
  const pages = [];
  const { ask } = phase4eConversation(t, { seed, compose: () => composer((view) => { pages.push(view); return proseLayout(view); }) });
  const first = await ask({ text: 'Ali Veli iş yükünü değerlendir ve grafikle göster',
    plan: { intent: 'rota', language: 'tr', visual: true, chart: ['bar', 'donut'], analysis: { scope: 'person', names: ['Ali Veli'], focus: ['workload', 'status'] } } });
  assert.equal(first.answer.finishReason, 'clarification', first.answer.content);
  assert.equal(populationReads(first.log).length, 0, 'belirsiz adla görev verisi okunmaz');
  const selected = await ask({ text: '1' });
  assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
  assert.equal(selected.inputs.length, 0, 'planlayıcı modeli yeniden çağrılmaz: kabul edilmiş plan yeniden yürür');
  const reads = populationReads(selected.log);
  assert.ok(reads.length, 'seçilen kişi için okuma yapılır');
  const people = new Set(reads.map(({ params }) => params.personSicil).filter(Boolean));
  assert.equal(people.size, 1, 'tek bir seçilmiş kişi');
  assert.equal([...people][0], ALI_1, 'birinci adayın tam kimliği okunur');
  assert.ok(reads.some(({ params }) => params.withAssignees === 1 && params.personSicil === ALI_1), 'kabul edilmiş iş yükü yönü seçilen kişi için yeniden okunur');
  assert.equal(pages.at(-1).visual, true, 'grafik isteği açıklamadan sonra korunur');
  assert.deepEqual(pages.at(-1).chartTypes, ['bar', 'donut']);
  for (const type of ['bar', 'donut']) assert.ok(selected.answer.content.includes(`"type":"${type}"`), selected.answer.content);
});

test('takipte yetki kaybı eski kapsamı korumaz: ekip bağlamı güncel yönetim kapsamıyla yeniden okunur', async (t) => {
  const { ask, stack } = phase4eConversation(t, { compose: () => composer((view) => proseLayout(view)) });
  const first = await ask({ text: 'ekibimin iş yükünü değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload', 'overdue'] } } });
  assert.equal(first.answer.finishReason, 'stop');
  stack.db.executiveScope = [];
  const second = await ask({ text: 'neden', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', act: 'explain' } } });
  assert.notEqual(second.answer.finishReason, 'stop');
  assert.match(second.answer.content, /yönetim kapsam/i);
  assert.doesNotMatch(second.answer.content, /Zeynep|Anten kalibrasyonu/, 'önceki ekip verisi sızmaz');
});

/* ── 4. Grafik seçimi ────────────────────────────────────────────────── */

test('istenen grafik türü bütün bölümlerde aranır; gösterge kartı veri grafiğinin yerine geçmez', () => {
  const charts = new Map([['G1', { id: 'G1', part: 1, types: ['kpi'], table: null }], ['G2', { id: 'G2', part: 2, types: ['bar', 'donut'], table: 'T1' }]]);
  assert.deepEqual(preferredChart({ charts, chartType: 'donut' }), { id: 'G2', style: 'donut' }, 'halka ikinci bölümde de bulunur');
  assert.deepEqual(preferredChart({ charts }), { id: 'G2', style: 'donut' }, 'tür söylenmediyse veri grafiği gösterge kartından önce');
  assert.deepEqual(preferredChart({ charts: new Map([['G1', charts.get('G1')]]) }), { id: 'G1', style: 'kpi' }, 'yalnızca gösterge kartı varsa o çizilir');
});

test('grafik türü uçtan uca: istenen tür çizilir; kanıtın desteklemediği tür sessizce değiştirilmez, açıklanır', async (t) => {
  const chartOf = (content) => {
    const fence = content.match(/```rota-chart\n([\s\S]*?)\n```/);
    return fence ? JSON.parse(fence[1]) : null;
  };
  await t.test('halka (model başka tür seçse de istenen tür eklenir)', async (t) => {
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
      const layout = proseLayout({ ...view, visual: false });
      const bar = view.charts.find((item) => item.types.includes('bar'));
      return { blocks: [...layout.blocks, { type: 'chart', source: bar.id, style: 'bar' }] };
    }) });
    const result = await ask({ text: 'görevlerimin durumlarını halka grafikle göster',
      plan: { intent: 'rota', language: 'tr', visual: true, chart: 'donut', analysis: { scope: 'self', focus: ['status'] } } });
    assert.equal(result.answer.finishReason, 'stop');
    const charts = [...result.answer.content.matchAll(/```rota-chart\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]).type);
    assert.ok(charts.includes('donut'), `istenen halka çizildi: ${charts}`);
  });
  await t.test('zaman çizelgesi yalnızca tarihli satırlarla; dağılımda açıklanır', async (t) => {
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => proseLayout(view)) });
    const result = await ask({ text: 'durumlarımı zaman çizelgesinde göster',
      plan: { intent: 'rota', language: 'tr', visual: true, chart: 'timeline', analysis: { scope: 'self', focus: ['status'] } } });
    assert.equal(result.answer.finishReason, 'stop');
    assert.match(result.answer.content, /Zaman çizelgesi için tarihli görev satırları gerekir/);
    const chart = chartOf(result.answer.content);
    assert.ok(chart && chart.type !== 'timeline' && chart.items.length >= 2, 'en uygun başka grafik çizilir ve adı söylenir');
  });
  await t.test('zaman çizelgesi yaklaşan işlerde çizilir', async (t) => {
    const seed = rotaToolSeed();
    seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: AYSE }, { TaskId: TASKS.OCCURRENCE_OPEN, Sicil: AYSE });
    const { ask } = phase4eConversation(t, { seed, compose: () => composer((view) => proseLayout(view)) });
    const result = await ask({ text: 'yaklaşan teslimlerimi zaman çizelgesiyle göster',
      plan: { intent: 'rota', language: 'tr', visual: true, chart: 'timeline', analysis: { scope: 'self', focus: ['upcoming'], dateFrom: '2026-09-30', dateTo: '2026-10-31' } } });
    assert.equal(result.answer.finishReason, 'stop', result.answer.content);
    const chart = chartOf(result.answer.content);
    assert.equal(chart?.type, 'timeline', result.answer.content);
    assert.ok(chart.items.every((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.label));
  });
});

/* ── 5. Rol matrisi ──────────────────────────────────────────────────── */

test('rol matrisi: yönetici (admin) ekip lideri sayılmaz; ekip lideri + yönetici ekibini görür; sıradan kullanıcı ekip kapsamı alamaz', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload', 'overdue'] } };
  const cases = [
    ['yönetim kapsamı olmayan sistem yöneticisi', ADMIN, rotaToolSeed(), false],
    ['ekip lideri ve sistem yöneticisi', AYSE, rotaToolSeed({ systemAdminSicils: [ADMIN, AYSE] }), true],
    ['yalnızca ekip lideri', AYSE, rotaToolSeed(), true],
    ['proje lideri (yönetim kapsamı yok)', LEAD, rotaToolSeed(), false],
    ['ilgisiz sıradan kullanıcı', OUTSIDER, rotaToolSeed(), false]
  ];
  for (const [name, sicil, seed, allowed] of cases) await t.test(`davranış: ${name}`, async (t) => {
    const { ask } = phase4eConversation(t, { sicil, seed, compose: () => composer((view) => proseLayout(view)) });
    const result = await ask({ text: 'ekibimin iş yükünü değerlendir', plan });
    if (allowed) {
      assert.equal(result.answer.finishReason, 'stop', result.answer.content);
      const reads = populationReads(result.log);
      assert.ok(reads.length && reads.every(({ params }) => params.assigneeMode === 'team'), 'okumalar yönetim kapsamıyla sınırlı');
      assert.match(result.answer.content, /Zeynep Kaya/);
    } else {
      assert.notEqual(result.answer.finishReason, 'stop');
      assert.match(result.answer.content, /yönetim kapsam/i, result.answer.content);
      assert.doesNotMatch(result.answer.content, /Zeynep|Mehmet|【R\d+】/, 'gizli kişi ya da görev varlığı sızmaz');
    }
  });
});

test('seyrek veri: görevi olmayan kullanıcıda düzyazı kısa ve dayanaklıdır; uydurma tablo ya da tavsiye yoktur', async (t) => {
  let page = null;
  const { ask } = phase4eConversation(t, { sicil: OUTSIDER, compose: () => composer((view) => { page = view; return proseLayout(view); }) });
  const result = await ask({ text: 'işlerimin durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(page && page.propositions.length <= 4, 'seyrek kanıtta sayfa kurulur ve az önerme taşır');
  assert.match(result.answer.content, /göreviniz yok|görev bulunmuyor|görev bulunamadı/u, 'boş nüfus görünür yanıtta açıkça söylenir');
  assert.doesNotMatch(result.answer.content, /Zeynep|Radar test planı|Anten/, 'başkasının verisi görünmez');
  assert.equal(ZEYNEP > 0, true);
});

test('fazla yön kullanıcı öncelik vermeden alt kümeye daraltılmaz ve veri okunmaz', async (t) => {
  const plans = [
    { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'status', 'overdue', 'upcoming', 'priority', 'schedule', 'critical'] } },
    { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } }
  ];
  const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }),
    compose: () => composer((view) => proseLayout(view)) });
  const result = await ask({ text: 'iş durumumu bütün yönleriyle değerlendir' });
  assert.equal(result.answer.finishReason, 'clarification', result.answer.content);
  assert.match(result.answer.content, /Hangi analiz yönlerine öncelik/);
  assert.equal(result.inputs.length, 1);
  assert.equal(plans.length, 1, 'modelden kapsamı daraltan bir onarım istenmez');
  assert.equal(result.log.length, 0);
});

test('kurala uymayan düzyazı paragrafı tek başına düşer; geçerli paragraflar ve sunucu tamamlaması kalır', async (t) => {
  let page = null;
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
    page = view;
    const layout = proseLayout(view);
    return { blocks: [...layout.blocks, { type: 'say', text: 'Toplam 5 iş: {P1}. Ve 3 tane daha: {P2}.' }] };
  }) });
  const logs = captureConsole(t);
  const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } } });
  assert.equal(result.answer.finishReason, 'stop');
  assert.ok(page);
  const presentation = turnLine(logs).context.presentation;
  assert.notEqual(presentation.server, true, JSON.stringify(presentation));
  assert.match(result.answer.content, /gecikmiş durumda; bugün başlayan yedi günlük dönemde de/, 'geçerli model paragrafı çizilir');
  assert.doesNotMatch(result.answer.content, /Toplam 5 iş|3 tane daha/);
});

test('özetin içine yazılan grafik türü ve tablo plan düzeyine taşınır; görselin yeri onarımda anlam değişikliği sayılmaz', async (t) => {
  const { unpackTypedPlan } = await import('../src/server/ai/tools/executionSet.js');
  const result = (plan) => ({ toolCalls: [{ id: 'c1', name: 'rota_plan', arguments: JSON.stringify(plan) }] });
  const unpacked = unpackTypedPlan(result({ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['schedule'], visual: true, chart: 'line', table: true } }), { today: '2026-09-30' });
  assert.deepEqual([unpacked.plan.visual, unpacked.plan.chart, unpacked.plan.table, Object.hasOwn(unpacked.plan.analysis, 'chart')], [true, 'line', true, false]);
  await t.test('görselin yeri değişen onarım kabul edilir', async (t) => {
    const plans = [{ intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'status', 'overdue', 'upcoming'], visual: true } },
      { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } }];
    const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }),
      compose: () => composer((view) => proseLayout(view)) });
    const answer = await ask({ text: 'işlerimin durumunu grafikle değerlendir' });
    assert.equal(answer.answer.finishReason, 'stop', answer.answer.content);
  });
});

/* ── Ek soru sınıfları ───────────────────────────────────────────────── */

test('kişi ile kendini karşılaştırma: iki özne aynı ölçülerle okunur; kendi özne güvenilir oturumdur', () => {
  const parts = expandAnalysis(parseAnalysis({ scope: 'person', names: ['Zeynep Kaya'], withSelf: true, focus: ['workload', 'overdue', 'upcoming'] }), { today: '2026-09-30' });
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].entities, [{ type: 'person', text: 'Zeynep Kaya' }]);
  assert.equal(parts[1].filters.assignee, 'me');
  assert.deepEqual(parts[0].metrics, parts[1].metrics);
  assert.throws(() => parseAnalysis({ scope: 'self', withSelf: true, focus: ['overview'] }), (error) => error.details.includes('$.analysis.withSelf:scope'));
});

test('dönemli durum dağılımı: geçmiş dönemin tamamlanma görünümü o dönemde terminli işlerden okunur', () => {
  const [status] = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['status'], dateFrom: '2026-09-01', dateTo: '2026-09-30' }), { today: '2026-09-30' });
  assert.deepEqual([status.population.groupBy, status.filters.dateFrom, status.filters.dateTo, status.filters.status], ['status', '2026-09-01', '2026-09-30', undefined]);
});

test('ayrıntılı istekle listelenen görevler satır-yalnız bağlam yazar: satırın projesi incelenir, önceki özne genişletilemez', async (t) => {
  const list = { intent: 'rota', language: 'tr', request: { operation: 'list', metrics: ['tasks.total', 'task.title', 'task.overdueDays'],
    population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, layout: 'auto', filters: { deadline: 'overdue', assignee: 'me' } } };
  await t.test('önceki özne genişletilemez', async (t) => {
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => proseLayout(view)) });
    await ask({ text: 'gecikmiş görevlerim', plan: list });
    const broadened = await ask({ text: 'bunları genel olarak', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overview'] } } });
    assert.equal(broadened.answer.finishReason, 'clarification', 'görev kümesi önceki özne olarak genişletilemez');
  });
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => proseLayout(view)) });
  const first = await ask({ text: 'gecikmiş görevlerim', plan: list });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const project = await ask({ text: 'ikinci satırdaki görevin projesi', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'row', rows: [2], focus: ['overview', 'overdue'] } } });
  assert.equal(project.answer.finishReason, 'stop', project.answer.content);
  const reads = populationReads(project.log);
  assert.ok(reads.length && reads.every(({ params }) => params.projectId), 'okumalar satırın projesiyle sınırlı');
});

test('kesinlik takibi: tabloların tamlığı sunucu önermesidir; model kapsam iddia etmez', async (t) => {
  const pages = [];
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => { pages.push(view); return proseLayout(view); }) });
  await ask({ text: 'işlerimin genel durumu', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } } });
  const result = await ask({ text: 'hangi sonuçlardan eminsin', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', act: 'certainty' } } });
  assert.equal(result.answer.finishReason, 'stop');
  const page = pages.at(-1);
  assert.deepEqual(page.followUp, { act: 'certainty' });
  assert.ok(page.propositions.some((item) => item.kind === 'certainty'), 'her tablonun tamlık önermesi sayfada');
  // Tablo bölümünün adıyla anılır ("… tablosu"); ilk sütun adı ("Görev") nüfusu adlandırmaz.
  const certainty = page.propositions.filter((item) => item.kind === 'certainty');
  assert.ok(certainty.every((item) => /tablosu |^Bu tablo /u.test(item.text)), JSON.stringify(certainty));
  assert.equal(certainty.some((item) => /^Görev /u.test(item.text)), false);
  for (const item of certainty) assert.ok(result.answer.content.replace(/\\/gu, '').toLocaleLowerCase('tr-TR').includes(item.text.toLocaleLowerCase('tr-TR')), 'kesinlik yalnızca sayfada değil görünür yanıtta söylenir');
});

test('tek günlük termin aralığı aynı tarihi iki kez söylemez (önerme ve başlık)', async (t) => {
  const { ask } = phase4eConversation(t);
  const result = await ask({ text: 'bugün terminli işlerim', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['upcoming'], dateFrom: '2026-09-30', dateTo: '2026-09-30' } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  const content = result.answer.content.replace(/\\/gu, '');
  assert.match(content, /30 Eylül 2026\*\* tarihinde terminli/u, content);
  assert.equal(/30 Eylül 2026\W+(ile|–)\W+30 Eylül 2026/u.test(content), false, content);
});

test('yapısal özet normalleştirmesi: adlı portföy adlı proje, satırlı önceki satır kapsamıdır; yazım varyantı sözlüğe çevrilir', () => {
  assert.equal(parseAnalysis({ scope: 'projects', names: ['Radar', 'Okuma'], focus: ['overview'] }).scope, 'project');
  assert.equal(parseAnalysis({ scope: 'previous', rows: [2] }).scope, 'row');
  assert.deepEqual([...parseAnalysis({ scope: 'self', focus: ['deadline', 'overdue'] }).focus], ['deadlines', 'overdue']);
  assert.equal(Object.hasOwn(parseAnalysis({ scope: 'previous', act: 'visualize' }), 'act'), false, 'sözlük dışı eylem düşer');
});

test('adı verilen grafik türü gerektirdiği okumayı ekler (yığılmış → proje kırılımı, zaman çizelgesi → tarihli satırlar)', async () => {
  const { chartFocus } = await import('../src/server/ai/tools/analysisPlan.js');
  assert.equal(chartFocus({ scope: 'self' }, ['status'], 'stacked'), 'projects');
  assert.equal(chartFocus({ scope: 'self' }, ['projects'], 'stacked'), null);
  assert.equal(chartFocus({ scope: 'project' }, ['overview'], 'stacked'), null);
  assert.equal(chartFocus({ scope: 'self' }, ['overview'], 'timeline'), 'upcoming');
  assert.equal(chartFocus({ scope: 'self' }, ['overview'], 'bar'), null);
  const parts = expandAnalysis(parseAnalysis({ scope: 'self', focus: ['status'] }), { today: '2026-09-30', chart: 'stacked' });
  assert.ok(parts.some((part) => part.population.groupBy === 'project' && part.metrics.includes('tasks.open') && part.metrics.includes('tasks.done')));
});

// Aşama F: Dengeli ayrıntıda yalnızca üç ya da daha çok bölümlü ANALİTİK özet başlıklıdır (kullanıcı isteği: yapılandırılmış
// insan dili); iki bölümlü ve analitik olmayan Dengeli yanıt bütünleşik kalır. Ana hat (sections) yalnızca Ayrıntılı sayfadadır.
test('Ayrıntılı bölümlüdür: sayfa ana hat taşır, her bölüm sunucu başlığıyla açılır; Dengeli üç bölümlü özet de başlıklıdır', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } };
  const results = {};
  for (const detail of ['balanced', 'detailed']) await t.test(`yanıt ayrıntısı: ${detail}`, async (t) => {
    let page = null;
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return proseLayout(view); }) });
    const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan }, { detail });
    results[detail] = { content: result.answer.content, page };
  });
  assert.equal(results.balanced.page.sections, undefined);
  assert.ok(results.detailed.page.sections.length >= 3, 'ana hat her bölümü sıralar');
  const headings = (text) => (text.match(/^#### /gm) || []).length;
  assert.ok(headings(results.balanced.content) >= 3, `Dengeli üç bölümlü özet başlıklı:\n${results.balanced.content}`);
  assert.ok(headings(results.detailed.content) >= 3, `Ayrıntılı bölüm başlıklı:\n${results.detailed.content}`);
  assert.ok(results.detailed.page.propositions.length > results.balanced.page.propositions.length);
});

test('karşılaştırma takibi kanonik önceki kapsamı kullanır; satır numaraları görünen öznelerdir', async (t) => {
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => proseLayout(view)) });
  const first = await ask({ text: 'Radar Modernizasyonu ile Okuma Projesi projelerini karşılaştır',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', names: ['Radar Modernizasyonu', 'Okuma Projesi'], focus: ['overview', 'overdue'] } } });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const repeated = await ask({ text: 'sadece gecikmelere bakarsak', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', focus: ['overdue'] } } });
  assert.equal(repeated.answer.finishReason, 'stop', repeated.answer.content);
  assert.equal(repeated.inputs.length, 1, 'ek model turu açılmaz');
  const ranked = await ask({ text: 'hangisinde sorun daha ciddi', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'previous', rows: [1, 2], act: 'prioritize' } } });
  assert.equal(ranked.answer.finishReason, 'stop', ranked.answer.content);
});

test('portföy kapsamında yığılmış grafik proje başına açık/tamamlanan bölüntüsünü okur; Ayrıntılı portföy bölümleri başlıklıdır', async (t) => {
  const parts = expandAnalysis(parseAnalysis({ scope: 'projects', focus: ['overview', 'overdue'] }), { today: '2026-09-30', chart: 'stacked' });
  assert.ok(parts.some((part) => part.population.groupBy === 'project' && part.metrics.includes('tasks.done')), 'bölüntü okuması eklenir');
  assert.ok(parts.length <= 4);
  let page = null;
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return proseLayout(view); }) });
  const result = await ask({ text: 'projelerimi değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', focus: ['overview', 'overdue'] } } }, { detail: 'detailed' });
  assert.equal(result.answer.finishReason, 'stop');
  assert.ok(page.sections.every((section) => section.title), JSON.stringify(page.sections));
  assert.ok((result.answer.content.match(/^#### /gm) || []).length >= 2, result.answer.content);
});

test('yığılmış grafik isteği: aday sınırı tek sütunlu çubuklarla dolsa da yığılmış aday sayfadadır; modelin yanlış biçimi yanıtı düşürmez', async (t) => {
  const logs = captureConsole(t);
  let page = null;
  // Zayıf modelin gerçek hatası: düzyazı doğru, ama grafik bloğu yığılmış çizemeyen adaya "stacked" biçimi yazılmış.
  const wrongStyle = (view) => {
    page = view;
    const layout = proseLayout(view);
    const donut = view.charts.find((item) => !item.types.includes('stacked') && item.types.includes('donut'));
    return { blocks: [...layout.blocks.filter((block) => block.type !== 'chart'), { type: 'chart', source: donut.id, style: 'stacked' }] };
  };
  const { ask } = phase4eConversation(t, { compose: () => composer(wrongStyle) });
  const result = await ask({ text: 'projelerimin görev durumlarını yığılmış grafikle karşılaştır',
    plan: { intent: 'rota', language: 'tr', chart: 'stacked', analysis: { scope: 'projects', focus: ['overview', 'status'] } } });
  assert.equal(result.answer.finishReason, 'stop', result.answer.content);
  assert.ok(page.charts.length > 6, 'istenen tür için ayrılan yer');
  assert.ok(page.charts.some((item) => item.types.includes('stacked')), JSON.stringify(page.charts));
  const presentation = turnLine(logs).context.presentation;
  assert.notEqual(presentation.server, true, JSON.stringify(presentation));
  assert.equal(presentation.chart, 'stacked', JSON.stringify(presentation));
  assert.equal(presentation.prose.charts, 1, 'yalnızca yanlış biçimli grafik bloğu düştü');
  assert.match(result.answer.content, /```rota-chart/u);
});

test('Ayrıntılı düzyazıda başlığı sunucu koyar: modelin yanlış başlık kimliği yanıtı düşürmez; iç içe bölümler bölümlerine toplanır', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'projects', focus: ['overview', 'overdue'] } };
  const headingsOf = (content) => (content.match(/^#### .+$/gm) || []);
  // Zayıf modelin gerçek hatası: her bölümün önüne bir SONRAKİ bölümün başlık kimliği yazılmış.
  const shifted = (view) => {
    const layout = proseLayout(view);
    const blocks = [];
    let lastPart = null;
    for (const block of layout.blocks) {
      const part = block.type === 'say' ? view.propositions.find((item) => block.text.includes(`{${item.id}}`))?.part : view.tables.find((item) => item.id === block.source)?.part;
      if (part !== lastPart) {
        const wrong = view.titles.find((item) => item.part > part) || view.titles[0];
        if (wrong) blocks.push({ type: 'title', source: wrong.id });
        lastPart = part;
      }
      blocks.push(block);
    }
    return { blocks };
  };
  await t.test('kayık başlık kimlikleri', async (t) => {
    const logs = captureConsole(t);
    let page = null;
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return shifted(view); }) });
    const result = await ask({ text: 'projelerimi değerlendir', plan }, { detail: 'detailed' });
    assert.equal(turnLine(logs).context.presentation.server, false, JSON.stringify(turnLine(logs).context.presentation));
    assert.match(result.answer.content, /#### Öncelikli konular\n\n1\. [^\n]+(?:\n[2-9]\. [^\n]+)+(?:\n\n_Not:[^\n]+)?$/);
    const headings = headingsOf(result.answer.content);
    assert.ok(headings.length >= 2, result.answer.content);
    // Başlıklar ana hattın bölüm sırasıyladır (modelin yazdığı kayık kimlik sırasıyla değil).
    const expected = page.sections.filter((section) => section.title).map((section) => `#### ${page.titles.find((title) => title.id === section.title).text}`);
    // Aşama F: bölümlerden sonra sunucunun öncelik listesi kendi başlığıyla gelir.
    assert.deepEqual(headings.filter((heading) => heading !== '#### Öncelikli konular'), expected, 'başlıklar bölüm sırasıyla ve kendi bölümünün önünde');
  });
  // Bölümler iç içe yazılırsa (bir bölümün tablosu başka bölümün paragrafından sonra) başlık hiç konmaz.
  await t.test('iç içe bölümler', async (t) => {
    const interleaved = (view) => {
      const layout = proseLayout(view);
      return { blocks: [...layout.blocks.filter((block) => block.type === 'say'), ...layout.blocks.filter((block) => block.type === 'rows')] };
    };
    let page = null;
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return interleaved(view); }) });
    const mixed = await ask({ text: 'projelerimi değerlendir', plan }, { detail: 'detailed' });
    assert.equal(mixed.answer.finishReason, 'stop');
    // Aşama F: iç içe dizilen bölümler sunucuda bölümlerine toplanır (bölüm sırası ilk görünüş, bölüm içi sıra modelin) ve
    // her bölüm kendi başlığıyla açılır; tablo artık başka bölümün başlığı altına düşmez.
    const content = mixed.answer.content;
    assert.match(content, /#### Öncelikli konular\n\n1\. [^\n]+(?:\n[2-9]\. [^\n]+)+(?:\n\n_Not:[^\n]+)?$/);
    const headings = headingsOf(content).filter((heading) => heading !== '#### Öncelikli konular');
    const expected = page.sections.filter((section) => section.title).map((section) => `#### ${page.titles.find((title) => title.id === section.title).text}`);
    assert.deepEqual(headings, expected, content);
    for (const [index, heading] of headings.entries()) {
      const start = content.indexOf(heading);
      const end = index + 1 < headings.length ? content.indexOf(headings[index + 1]) : content.lastIndexOf('#### Öncelikli konular');
      assert.match(content.slice(start + heading.length, end), /【R\d+】/, `kanıtsız bölüm: ${heading}`);
      const section = page.sections.find((item) => page.titles.find((title) => title.id === item.title)?.text === heading.slice(5));
      const body = content.slice(start + heading.length, end).replaceAll('**', '').replaceAll('\\', '');
      assert.ok(section && section.propositions.some((id) => body.includes(page.propositions.find((item) => item.id === id).text.slice(0, 28))), `bölümün kendi olgusu yok: ${heading}`);
    }
  });
});
