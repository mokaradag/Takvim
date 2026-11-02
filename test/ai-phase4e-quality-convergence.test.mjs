/**
 * Aşama 4E kalite yakınsaması — kök neden sınamaları.
 *
 * 1) Anlatım: model paragrafı kendisi yazar, olgular yalnızca sunucu önermesinin yuvasıyla girer (groundedProse.js).
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

const { checkProse, renderProse, propositionClause } = await import('../src/domain/ai/groundedProse.js');
const { preferredChart } = await import('../src/domain/ai/groundedComposition.js');
const { expandAnalysis, parseAnalysis, resolveAnalysisBrief } = await import('../src/server/ai/tools/analysisPlan.js');

const turnLine = (logs) => logs.map((row) => (row.includes('"operation":"ai.grounded.turn"') ? JSON.parse(row.slice(row.indexOf('{'))) : null)).filter(Boolean).at(-1);
const OPENERS = ['Genel tabloya bakınca', 'Bunun yanında', 'Öte yandan', 'Ayrıca', 'Buna ek olarak', 'Son olarak'];

/** Modelin yapacağı gibi yuvalı düzyazı: her bölüm bir paragraf, her cümle bir önerme; çekinceler her zaman söylenir. */
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

test('düzyazı denetimi: modelin sözcükleri olgu taşıyamaz (rakam, kayıt adı, özel ad biçimi, işaretleme, sahte yuva)', () => {
  const known = (id) => ['P1', 'P2', 'T1', 'G1'].includes(id);
  const names = ['Radar Modernizasyonu', 'Zeynep Kaya'];
  const ok = checkProse('Genel tabloya bakınca {P1}; asıl baskı ise gecikmelerde, çünkü {P2}. {T1}', { known, names });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.ids, ['P1', 'P2', 'T1']);
  const cases = [
    ['rakam', 'Toplam 5 iş var: {P1}.', 'PROSE_CHARACTER'],
    ['Arap-Hint rakamı', 'Toplam ٣ iş: {P1}.', 'PROSE_CHARACTER'],
    ['yüzde', 'Yüzde elli civarı % oranında: {P1}.', 'PROSE_CHARACTER'],
    ['kayıt adı (küçük harfle de)', 'radar modernizasyonu tarafında {P1}.', 'PROSE_NAME'],
    ['cümle başında kayıt adı', 'Zeynep Kaya üzerinde {P1}.', 'PROSE_NAME'],
    ['uydurma özel ad', 'Bu iş Ahmet üzerinde: {P1}, ve Mehmet de.', 'PROSE_NAME'],
    ['işaretleme', 'Bu <<çok önemli>>: {P1}.', 'PROSE_CHARACTER'],
    ['HTML', '<b>dikkat</b> {P1}.', 'PROSE_CHARACTER'],
    ['bağlantı', 'Ayrıntı için https://ornek.test adresine bakın: {P1}.', 'PROSE_CHARACTER'],
    ['sahte yuva', 'Toplam {F1} görev: {P1}.', 'PROSE_SLOT'],
    ['bilinmeyen önerme', 'Durum şu: {P9}.', 'UNKNOWN_PROPOSITION'],
    ['görünmez karakter', 'Durum‮ şu: {P1}.', 'PROSE_CHARACTER'],
    ['yalnızca dayanaksız cümleler', 'Her şey yolunda. Ekip harika. Çok iyi gidiyor.', 'PROSE_UNGROUNDED'],
    ['cümle içinde yönlendirme', 'Ayrıntılar için {T1} incelenebilir.', 'PROSE_POINTER']
  ];
  // Tek cümlelik paragrafta ihlal paragrafı düşürür (çizilecek cümle kalmaz) ve ihlalin koduyla reddedilir.
  for (const [name, text, issue] of cases) assert.equal(checkProse(text, { known, names }).issue, issue, name);
  // İhlal taşıyan cümle düşürülür (çizilmez); tutulan cümleler çoğunluktaysa paragraf kabul edilir. Düşürme olgu eklemez.
  const dropped = checkProse('Kısaca durum şöyle. {P1}. Toplam 5 iş var: {P2}. {T1}', { known, names });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.dropped, 2);
  assert.deepEqual(dropped.ids, ['P1', 'T1'], 'rakamlı cümle yuvasıyla birlikte düşer');
  // Yuvasız çerçeve cümleleri temiz düşer; kalan cümle kendi başına kanıta bağlıdır (paragraf reddedilmez).
  const framing = checkProse('Her şey yolunda. Ekip harika. Çok iyi gidiyor. {P1}.', { known, names });
  assert.deepEqual([framing.ok, framing.ids, framing.dropped], [true, ['P1'], 3]);
  // Noktalamasız ardışık iki yuva iki ayrı önerme cümlesidir.
  for (const text of ['{P1} {P2}.', '{P1}{P2}']) {
    const adjacent = checkProse(text, { known, names });
    assert.deepEqual([adjacent.ok, adjacent.sentences.length, adjacent.ids], [true, 2, ['P1', 'P2']], text);
  }
  // Yinelenen yuvayı taşıyan cümle düşer (aynı olgu iki kez söylenmez).
  const repeated = checkProse('Önce {P1}. Sonra yine {P1}.', { known, names });
  assert.deepEqual([repeated.ok, repeated.ids, repeated.issues], [true, ['P1'], ['DUPLICATE_PROPOSITION']]);
  // Önerme kendi noktasıyla biter: noktasız yuvadan sonra büyük harfle başlayan sözcük yeni cümledir.
  const implicit = checkProse('{P1} Buna ek olarak {P2}.', { known, names });
  assert.deepEqual([implicit.ok, implicit.sentences.length, implicit.ids], [true, 2, ['P1', 'P2']]);
  // Son yuvadan sonraki model yorumu çizilmez (yalnızca bitiş noktalaması kalır).
  const trailing = checkProse('Baskı artıyor: {P1}, bu da işlerin kontrolden çıktığını gösteriyor.', { known, names });
  assert.equal(JSON.stringify(trailing.sentences).includes('kontrolden'), false);
  // Vurgu işaretleri kaldırılır (modelin kendi vurgusu olmaz; kalın değer yalnızca sunucudan gelir).
  const emphasis = checkProse('Bu **çok önemli**: {P1}.', { known, names });
  assert.equal(emphasis.ok, true);
  assert.equal(JSON.stringify(emphasis.sentences).includes('*'), false);
  // Kayıt adı ancak aynı cümledeki yuvanın kendi önermesinde geçiyorsa yazılabilir (çapraz eşleme olamaz).
  const slotText = (id) => (id === 'P1' ? 'Radar Modernizasyonu projesinde 3 gecikmiş görev var.' : 'Başka bir olgu.');
  assert.equal(checkProse('Radar Modernizasyonu tarafında tablo ağır: {P1}.', { known, names, slotText }).ok, true);
  assert.equal(checkProse('Radar Modernizasyonu tarafında tablo ağır: {P2}.', { known, names, slotText }).issue, 'PROSE_NAME', 'ad başka önermeye bağlanamaz');
});

test('yuvayı ad öbeği gibi kullanan cümle düşmez, yuvada kısaltılır; sıralama bağlacı yeni yan cümle açar', () => {
  const known = (id) => /^P\d+$/.test(id);
  const names = ['Altyapı Yenileme', 'Yük testi'];
  const plain = (result) => result.sentences.map((sentence) => sentence.map((token) => (token.slot ? `{${token.slot}}` : token.text)).join('')).join(' ').trim();
  // Önceki yuva varsa cümle orada biter; gömülü yuvanın ardındaki model sözcükleri çizilmez.
  const chained = checkProse('{P3}; ayrıca {P4}, bunu {P5} serisinde diğer görevler izliyor.', { known, names });
  assert.deepEqual([chained.ok, chained.cut, chained.ids], [true, 1, ['P3', 'P4']]);
  assert.equal(plain(chained), '{P3}; ayrıca {P4}.');
  // Önceki yuva yoksa gömülü yuva tek başına kalır; çerçeve sözcükle bitiyorsa (yuvayı niteliyorsa) çerçeve de düşer —
  // çerçevedeki rakam ve kayıt adı böylece hiç çizilmez.
  const embedded = checkProse('Kasım ayının ilk otuz günü içinde {P2} görev terminlenecek. Bu görev aynı zamanda {P4} olduğundan, (Yük testi) iki katı.', { known, names });
  assert.deepEqual([embedded.ok, embedded.ids, plain(embedded)], [true, ['P2', 'P4'], '{P2}. {P4}.']);
  // Noktalamayla ayrılmış çerçeve yuvayı niteleyemez: korunur.
  const framed = checkProse('Proje düzeyinde bakınca, {P9} şekilde yayılmış görünse de, {P10} olduğundan Altyapı Yenileme acil.', { known, names });
  assert.equal(plain(framed), 'Proje düzeyinde bakınca, {P9}.');
  // Sıralama bağlacı ("ve") yan cümleyi değiştirmez: ardındaki çerçeve bir sonraki yuvaya aittir.
  const joined = checkProse('{P1} ve bunların hepsi tek bir projede yoğunlaşmış durumda: {P6}.', { known, names });
  assert.deepEqual([joined.ok, joined.cut, joined.ids], [true, 0, ['P1', 'P6']]);
  // Bağlaçtan sonra yuva gelmezse kuyruk çizilmez (olgu sonrası yorum ve olumsuzlama yazılamaz).
  const tail = checkProse('{P1} ama bu doğru değil.', { known, names });
  assert.equal(plain(tail), '{P1}.');
  assert.equal(checkProse('{P1} değil.', { known, names }).sentences.flat().some((token) => /değil/u.test(token.text || '')), false, 'olumsuzlama çizilmez');
});

test('düzyazı çizimi: model sözcükleri düz metin, her değer sunucunun vurgulu yan cümlesi; cümle içi yuva küçük harfle başlar', () => {
  const proposition = { id: 'P1', parts: ['şu anda ', { value: '4', strong: true }, ' gecikmiş göreviniz var.'], markdown: 'Şu anda **4** gecikmiş göreviniz var.' };
  const named = { id: 'P2', parts: [{ value: 'Radar Modernizasyonu', strong: true }, ', açık görev sayısında en üstte.'] };
  const escape = (value) => String(value);
  assert.equal(propositionClause(proposition, { initial: true, locale: 'tr', escape }), 'Şu anda **4** gecikmiş göreviniz var');
  assert.equal(propositionClause(proposition, { initial: false, locale: 'tr', escape }), 'şu anda **4** gecikmiş göreviniz var');
  assert.equal(propositionClause(named, { initial: false, locale: 'tr', escape }), '**Radar Modernizasyonu**, açık görev sayısında en üstte', 'kayıt adı değişmez');
  const { sentences } = checkProse('Genel tabloya bakınca {P1}. {P2}.', { known: () => true });
  const text = renderProse(sentences, { proposition: (id) => ({ P1: proposition, P2: named })[id], pointer: () => null, locale: 'tr', escape });
  assert.equal(text, 'Genel tabloya bakınca şu anda **4** gecikmiş göreviniz var. **Radar Modernizasyonu**, açık görev sayısında en üstte.');
});

test('doğal analist yanıtı: modelin bağlaçlı düzyazısı uçtan uca çizilir, olgular kanıta bağlı ve atıflıdır', async (t) => {
  const logs = captureConsole(t);
  let page = null;
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return proseLayout(view); }) });
  const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } } });
  assert.equal(result.answer.finishReason, 'stop');
  const presentation = turnLine(logs).context.presentation;
  assert.equal(presentation.mode, 'composed');
  assert.notEqual(presentation.server, true, JSON.stringify(presentation));
  const content = result.answer.content;
  assert.match(content, /Genel tabloya bakınca /, 'modelin bağlacı çizilir');
  assert.match(content, /Bunun yanında /);
  assert.doesNotMatch(content, /\{P\d+\}/, 'yuva kalmaz');
  assert.match(content, /【R\d+】/, 'paragraf kanıta atıflıdır');
  assert.ok(page.propositions.length >= 4, 'sayfa birden çok önerme taşır');
  // Her kalın değer sunucunun sayfasındandır (önerme, ayrıntı ya da tablo): sayfada olmayan bir sayı yanıtta görünmez.
  const pageText = JSON.stringify(page);
  const prose = content.split('\n\n').filter((paragraph) => OPENERS.some((opener) => paragraph.startsWith(opener))).join('\n');
  assert.ok(prose, 'modelin paragrafları yanıtta');
  const strong = [...prose.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]).filter((value) => /^\d/.test(value));
  for (const value of strong) assert.ok(pageText.includes(value.replace(/\\/g, '').match(/\d+(?:,\d+)?/)[0]), `sayfada olmayan değer: ${value}`);
});

test('zorunlu çekince: tamlığı kanıtlanmamış ekip iş yükünde çekince her yanıtta söylenir', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'team', focus: ['workload', 'overdue'] } };
  const seed = rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP }, { ManagerSicil: AYSE, EmployeeSicil: ALI_1 }] });
  seed.taskAssignees.push({ TaskId: TASKS.LITERAL, Sicil: ALI_1 }, { TaskId: TASKS.UNASSIGNED, Sicil: ALI_1 }, { TaskId: TASKS.OVERDUE, Sicil: ALI_1 },
    { TaskId: TASKS.SERIES, Sicil: ZEYNEP });
  await t.test('çekinceyi atlayan düzyazıya sunucu çekinceyi ekler', async (t) => {
    const logs = captureConsole(t);
    const { ask } = phase4eConversation(t, { seed, compose: () => composer((view) => proseLayout(view, { skipRequired: true })) });
    const result = await ask({ text: 'ekibimin iş yükü dengeli mi', plan });
    assert.equal(result.answer.finishReason, 'stop');
    const presentation = turnLine(logs).context.presentation;
    assert.notEqual(presentation.server, true, `modelin düzyazısı korunur: ${JSON.stringify(presentation)}`);
    assert.match(result.answer.content, /Genel tabloya bakınca/, 'modelin paragrafı çizilir');
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
    await t.test(detail, async (t) => {
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
  assert.deepEqual([...resolveAnalysisBrief(parseAnalysis({ scope: 'row', rows: [1] }), { previous: portfolio }).focus], ['overview', 'overdue', 'upcoming'], 'satıra inme kaydın genel görünümüdür');
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
    plan: { intent: 'rota', language: 'tr', visual: true, analysis: { scope: 'person', names: ['Ali Veli'], focus: ['workload', 'overdue'] } } });
  assert.equal(first.answer.finishReason, 'clarification', first.answer.content);
  assert.equal(populationReads(first.log).length, 0, 'belirsiz adla görev verisi okunmaz');
  const selected = await ask({ text: '1' });
  assert.equal(selected.answer.finishReason, 'stop', selected.answer.content);
  assert.equal(selected.inputs.length, 0, 'planlayıcı modeli yeniden çağrılmaz: kabul edilmiş plan yeniden yürür');
  const reads = populationReads(selected.log);
  assert.ok(reads.length, 'seçilen kişi için okuma yapılır');
  const people = new Set(reads.map(({ params }) => params.personSicil).filter(Boolean));
  assert.equal(people.size, 1, 'tek bir seçilmiş kişi');
  assert.ok([ALI_1, ALI_2].includes([...people][0]));
  assert.equal(pages.at(-1).visual, true, 'grafik isteği açıklamadan sonra korunur');
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
  for (const [name, sicil, seed, allowed] of cases) await t.test(name, async (t) => {
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
  assert.ok(['stop', 'not_found'].includes(result.answer.finishReason), result.answer.content);
  if (page) assert.ok(page.propositions.length <= 4, 'seyrek kanıtta az önerme');
  assert.doesNotMatch(result.answer.content, /Zeynep|Radar test planı|Anten/, 'başkasının verisi görünmez');
  assert.equal(ZEYNEP > 0, true);
});

test('fazla yön (şema sınırı) onarımda yalnızca modelin kendi yönlerinin sıralı alt kümesine daraltılabilir', async (t) => {
  for (const [name, repaired, accepted] of [
    ['sıralı alt küme kabul edilir', ['overview', 'overdue', 'upcoming'], true],
    ['yeni yön eklenemez', ['overview', 'workload'], false],
    ['kapsam değişemez', null, false]
  ]) await t.test(name, async (t) => {
    const first = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'status', 'overdue', 'upcoming'] } };
    const second = repaired ? { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: repaired } } : { intent: 'rota', language: 'tr', analysis: { scope: 'all', focus: ['overview'] } };
    const plans = [first, second, { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } }];
    const { ask } = phase4eConversation(t, { planner: () => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plans.shift() }] }),
      compose: () => composer((view) => proseLayout(view)) });
    const result = await ask({ text: 'iş durumumu genel olarak değerlendir' });
    if (accepted) {
      assert.equal(result.answer.finishReason, 'stop', result.answer.content);
      assert.ok(populationReads(result.log).every(({ params }) => params.assigneeMode === 'me'));
    } else {
      assert.notEqual(result.answer.finishReason, 'stop');
      assert.equal(populationReads(result.log).length, 0, 'anlamı değişen onarım veri okuyamaz');
    }
  });
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
  assert.match(result.answer.content, /Genel tabloya bakınca/);
  assert.doesNotMatch(result.answer.content, /Toplam 5 iş/);
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

test('Ayrıntılı bölümlüdür: sayfa ana hat taşır, her bölüm sunucu başlığıyla açılır; Dengeli bütünleşik ve başlıksızdır', async (t) => {
  const plan = { intent: 'rota', language: 'tr', analysis: { scope: 'self', focus: ['overview', 'overdue', 'upcoming'] } };
  const results = {};
  for (const detail of ['balanced', 'detailed']) await t.test(detail, async (t) => {
    let page = null;
    const { ask } = phase4eConversation(t, { compose: () => composer((view) => { page = view; return proseLayout(view); }) });
    const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan }, { detail });
    results[detail] = { content: result.answer.content, page };
  });
  assert.equal(results.balanced.page.sections, undefined);
  assert.ok(results.detailed.page.sections.length >= 3, 'ana hat her bölümü sıralar');
  const headings = (text) => (text.match(/^#### /gm) || []).length;
  assert.equal(headings(results.balanced.content), 0, 'Dengeli başlıksız');
  assert.ok(headings(results.detailed.content) >= 3, `Ayrıntılı bölüm başlıklı:\n${results.detailed.content}`);
  assert.ok(results.detailed.page.propositions.length > results.balanced.page.propositions.length);
});

test('karşılaştırma takibi: yeniden yazılan özne adları önceki özneler sayılır; satır numaraları karşılaştırılan öznelerdir', async (t) => {
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => proseLayout(view)) });
  const first = await ask({ text: 'Radar Modernizasyonu ile Okuma Projesi projelerini karşılaştır',
    plan: { intent: 'rota', language: 'tr', analysis: { scope: 'projects', names: ['Radar Modernizasyonu', 'Okuma Projesi'], focus: ['overview', 'overdue'] } } });
  assert.equal(first.answer.finishReason, 'stop', first.answer.content);
  const repeated = await ask({ text: 'sadece gecikmelere bakarsak', plan: { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['Radar Modernizasyonu', 'Okuma Projesi'], focus: ['overdue'] } } });
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

test('Ayrıntılı düzyazıda başlığı sunucu koyar: modelin yanlış başlık kimliği yanıtı düşürmez; iç içe bölümlerde başlık konmaz', async (t) => {
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
    const headings = headingsOf(result.answer.content);
    assert.ok(headings.length >= 2, result.answer.content);
    // Başlıklar ana hattın bölüm sırasıyladır (modelin yazdığı kayık kimlik sırasıyla değil).
    const expected = page.sections.filter((section) => section.title).map((section) => `#### ${page.titles.find((title) => title.id === section.title).text}`);
    assert.deepEqual(headings, expected, 'başlıklar bölüm sırasıyla ve kendi bölümünün önünde');
  });
  // Bölümler iç içe yazılırsa (bir bölümün tablosu başka bölümün paragrafından sonra) başlık hiç konmaz.
  await t.test('iç içe bölümler', async (t) => {
    const interleaved = (view) => {
      const layout = proseLayout(view);
      return { blocks: [...layout.blocks.filter((block) => block.type === 'say'), ...layout.blocks.filter((block) => block.type === 'rows')] };
    };
    const { ask } = phase4eConversation(t, { compose: () => composer(interleaved) });
    const mixed = await ask({ text: 'projelerimi değerlendir', plan }, { detail: 'detailed' });
    assert.equal(mixed.answer.finishReason, 'stop');
    assert.equal(headingsOf(mixed.answer.content).length, 0, mixed.answer.content);
  });
});
