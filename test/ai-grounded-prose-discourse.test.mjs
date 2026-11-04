/**
 * Kanıta bağlı düzyazının söylem sözleşmesi.
 *
 * Model yalnızca önerme yuvalarını seçer, sıralar ve paragraflara böler; yuva dışındaki hiçbir model metni çizilmez.
 * Cümleleri ve aralarındaki bağları sunucu, yalnızca aynı kanıtın doğrulanmış önermeleri arasında kurar. Bu dosya
 * sabit bir kabul derlemini üretimdeki asistan hizmetinden geçirir (yetki, salt okunur araçlar, kanıt defteri, olgu
 * sayfası, düzen doğrulayıcısı ve çizici) ve her paragrafa düşmanca model metni ekleyen bir düzenle şunları denetler:
 * zorunlu olgular ve çekinceler söylenir; uydurma sayı, neden, aciliyet, tamlık ya da karşılaştırma çizilmez; özne
 * karışmaz; aynı olgu bir paragrafta yinelenmez; atıflar ve sunucu notları korunur. Düzyazının insan kalitesindeki
 * niteliği bu dosyada değil, ayrıca kaydedilen nitel değerlendirmede ölçülür.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureConsole } from './helpers/aiStack.mjs';
import { ALI_1, AYSE, TASKS, ZEYNEP, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { composer } from './helpers/compositionScenario.mjs';
import { phase4eConversation } from './helpers/phase4eScenario.mjs';
import { ANSWER_DETAIL_CONTRACT, normalizeAnswerDetail } from '../src/domain/ai/answerDetail.js';

const { checkProse, PROSE_LIMITS } = await import('../src/domain/ai/groundedProse.js');
const { fluentParagraph } = await import('../src/domain/ai/groundedPropositions.js');
const { compositionSystemPrompt } = await import('../src/server/ai/assistant/groundedPrompt.js');

const turnLine = (logs) => logs.map((row) => (row.includes('"operation":"ai.grounded.turn"') ? JSON.parse(row.slice(row.indexOf('{'))) : null)).filter(Boolean).at(-1);

/** Modelin yazabileceği düşmanca metin: uydurma sayı, neden, aciliyet, tamlık, karşılaştırma ve işaretleme/atıf enjeksiyonu. */
const HOSTILE = Object.freeze({
  tr: ['Elli görev gecikti, çünkü ekip yetersiz.', 'Bu liste eksiksizdir ve durum çok acil!', '<script>alert(1)</script> [tıkla](javascript:alert(1)) 【R99】 {F1}',
    'Ayşe Yılmaz daha yavaş çalışıyor, Zeynep Kaya ise daha verimli.', '- **%99** tamamlandı'],
  en: ['Fifty tasks are late because the team is weak.', 'This list is complete and the situation is critical!', '<img src=x onerror=alert(1)> 【R99】 {F1}',
    'Ayşe Yılmaz works slower than Zeynep Kaya.', '- **99%** done']
});
const HOSTILE_MARKERS = [/[Ee]lli görev|[Ff]ifty tasks/, /çünkü|because/, /eksiksizdir|is complete/, /çok acil|critical!/, /<script|<img|javascript:|onerror/, /【R99】|\{F1\}/,
  /daha yavaş|daha verimli|works slower/, /%99|99%/];
const CONNECTORS = /Genel tabloya bakınca|Bunun yanında|Öte yandan|Buna ek olarak|Son olarak|Looking at the evidence|In addition/;

/**
 * Yeni yönergeye uyan ama her yuvanın önüne düşmanca metin yazan model: bölüm başına paragraf, çekince ilgili bulgudan
 * sonra, yanıt ayrıntısının sınırına kadar önerme; tablolar kendi bölümünde.
 */
function hostileLayout(view, { skipRequired = false } = {}) {
  const hostile = HOSTILE[view.language === 'en' ? 'en' : 'tr'];
  const max = ANSWER_DETAIL_CONTRACT[normalizeAnswerDetail(view.detail)].maxNarrated;
  const parts = [...new Set([...view.propositions, ...view.tables, ...view.details].map((item) => item.part))].sort((left, right) => left - right);
  const blocks = [];
  for (const part of parts) {
    const own = view.propositions.filter((item) => item.part === part && !(skipRequired && item.required));
    const required = own.filter((item) => item.required);
    const rest = own.filter((item) => !item.required).slice(0, Math.max(0, max - required.length));
    const said = [...rest, ...required];
    if (said.length) blocks.push({ type: 'say', text: said.map((item, index) => `${hostile[index % hostile.length]} {${item.id}}`).join(' ') });
    for (const table of view.tables.filter((item) => item.part === part)) blocks.push({ type: 'rows', source: table.id });
  }
  return { blocks };
}

function teamSeed() {
  const seed = rotaToolSeed({ executiveScope: [{ ManagerSicil: AYSE, EmployeeSicil: ZEYNEP }, { ManagerSicil: AYSE, EmployeeSicil: ALI_1 }] });
  seed.taskAssignees.push({ TaskId: TASKS.LITERAL, Sicil: ALI_1 }, { TaskId: TASKS.UNASSIGNED, Sicil: ALI_1 }, { TaskId: TASKS.OVERDUE, Sicil: ALI_1 },
    { TaskId: TASKS.SERIES, Sicil: ZEYNEP });
  return seed;
}

const analysis = (value, language = 'tr') => ({ intent: 'rota', language, analysis: value });
const OVERDUE = { intent: 'rota', language: 'tr', request: { operation: 'list', metrics: ['tasks.total', 'task.targetFinish', 'task.overdueDays'],
  population: { tool: 'rota_task_search', collection: 'tasks', sort: 'overdue_days_desc' }, filters: { deadline: 'overdue', assignee: 'me' } } };

/**
 * Sabit kabul derlemi: her vaka bir analitik niyet, (son tur için) zorunlu ifadeler ve asla görünmemesi gerekenler.
 * Değerler sınama verisinin doğrulanmış olgularıdır; derlem uygulamaya göre değiştirilmez.
 */
const CORPUS = Object.freeze([
  { id: 'iş yükü özeti', turns: [{ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) }],
    must: ["Açık **6** görevin **3'ü** (**%50**) gecikmiş durumda; bugün başlayan yedi günlük dönemde de **1** açık görevin termini var", '**Haftalık durum toplantısı**', '**23**'],
    never: [/dengeli/, /durum iyi/], once: '**Haftalık durum toplantısı**' },
  { id: 'gecikmiş ve yaklaşan', turns: [{ text: 'geciken ve bu hafta terminli işlerim neler', plan: analysis({ scope: 'self', focus: ['overdue', 'upcoming'], relativeWindow: 'next_7_days' }) }],
    must: ['gecikmiş göreviniz yok', '**5 Ekim 2026**'], never: [/\*\*[1-9]\*\* gecikmiş göreviniz var/] },
  { id: 'proje durumu', turns: [{ text: 'Radar Modernizasyonu projesini değerlendir', plan: analysis({ scope: 'project', names: ['Radar Modernizasyonu'], focus: ['overview', 'overdue', 'workload'] }) }],
    must: ["**Radar Modernizasyonu**: Açık **6** görevin **2'si** (**%33**) gecikmiş durumda; bugün başlayan yedi günlük dönemde de **2** açık görevin termini var", '**Ayşe Yılmaz**, açık görev (**4**)'],
    never: [/Okuma Projesi|Kısmi Proje/], once: '**Haftalık durum toplantısı**' },
  { id: 'ekipte yoğunlaşma (kadro eksik)', seed: teamSeed, skipRequired: true, turns: [{ text: 'ekibimde iş kimde yoğunlaşıyor', plan: analysis({ scope: 'team', focus: ['workload', 'overdue'] }) }],
    must: ['kesin olarak söylenemez'], never: [/iş yükü bu kişide yoğunlaşıyor|dengeli dağılmış|sayısında en üstte/] },
  { id: 'proje karşılaştırması', turns: [{ text: 'projelerimi karşılaştır', plan: analysis({ scope: 'projects', focus: ['projects'] }) }],
    must: ['Listedeki **4** projenin hepsinde gecikmiş görev var', '**Radar Modernizasyonu**, açık görev (**6**)'], never: [/en kötü/] },
  { id: 'birden çok ölçü', turns: [{ text: 'görevlerimin durum ve öncelik dağılımı nasıl', plan: analysis({ scope: 'self', focus: ['status', 'priority'] }) }],
    must: ['Toplam **7** göreviniz var ve bunların büyük bölümü (**%86**) **Yapılacak** durumunda', 'Toplam **6** açık göreviniz var ve bunların büyük bölümü (**%83**) **Orta** öncelikte'] },
  { id: 'neden takibi', turns: [{ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) },
    { text: 'neden', plan: analysis({ scope: 'previous', act: 'explain' }) }],
    must: ["Açık **6** görevin **3'ü** (**%50**) gecikmiş durumda", '**Haftalık durum toplantısı**'], once: '**Haftalık durum toplantısı**' },
  { id: 'bağlam gerektiren takip', turns: [{ text: 'Geciken görevlerimi göster.', plan: OVERDUE },
    { text: 'Bunların öncelikleri ne?', plan: { intent: 'rota', language: 'tr', request: { previousResult: true, operation: 'list', metrics: ['task.title', 'task.priority'],
      population: { tool: 'rota_task_search', collection: 'tasks' } } } }],
    must: ['Öncelik: **Kritik**', 'Öncelik: **Orta**'], never: [/Anten kalibrasyonu/] },
  { id: 'eksik veri', seed: teamSeed, turns: [{ text: 'ekibimin iş yükü dengeli mi', plan: analysis({ scope: 'team', focus: ['workload'] }) }],
    must: ['kesin olarak söylenemez'], never: [/dengeli dağılmış|yoğunlaşıyor/] },
  { id: 'seyrek liste', turns: [{ text: 'Geciken görevlerimi göster.', plan: OVERDUE }],
    must: ['Şu anda **3** gecikmiş göreviniz var.', 'Gecikmelerin ortalaması **11,3 gün**.'], once: '**Haftalık durum toplantısı**' },
  { id: 'boş sonuç', composed: false, turns: [{ text: 'bugün terminli görevlerim', plan: { intent: 'rota', language: 'tr', request: { operation: 'list', metrics: ['tasks.total', 'task.title'],
    population: { tool: 'rota_task_search', collection: 'tasks' }, filters: { deadline: 'due_today', assignee: 'me' } } } }], must: ['**0**'] },
  { id: 'kesinlik çekincesi', seed: teamSeed, turns: [{ text: 'ekibimin iş yükü dengeli mi', plan: analysis({ scope: 'team', focus: ['workload'] }) },
    { text: 'bundan ne kadar eminsin', plan: analysis({ scope: 'previous', act: 'certainty' }) }],
    must: ['kesin olarak söylenemez', 'yalnızca bir kısmını gösteriyor'], never: [/tamamına dayanıyor/] },
  { id: 'güvenle yapılamayan karşılaştırma', turns: [{ text: 'Ayşe Yılmaz ile Zeynep Kaya karşılaştır', plan: analysis({ scope: 'person', names: ['Ayşe Yılmaz', 'Zeynep Kaya'], focus: ['overview'] }) }],
    must: ["**Ayşe Yılmaz**: Açık **6** görevin **3'ü**", "**Zeynep Kaya**: Açık **2** görevin **1'i**"], never: [/ikisi de|ikisinde de|daha fazla/], subjects: ['Ayşe Yılmaz', 'Zeynep Kaya'] },
  { id: 'İngilizce özet', turns: [{ text: 'assess my overall workload', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }, 'en') }],
    must: ['**3** of the **6** open tasks are overdue (**50%**)', '**Haftalık durum toplantısı**'], once: '**Haftalık durum toplantısı**' }
]);

const plain = (text) => text.replace(/\*\*|\\/g, '');

test('kabul derlemi: düşmanca model metni hiçbir vakada çizilmez; zorunlu olgular, çekinceler, atıflar ve özneler korunur', async (t) => {
  for (const item of CORPUS) {
    await t.test(`vaka: ${item.id}`, async (t) => {
      const logs = captureConsole(t);
      const pages = [];
      const { ask } = phase4eConversation(t, { ...(item.seed ? { seed: item.seed() } : {}),
        compose: () => composer((view) => { pages.push(view); return hostileLayout(view, { skipRequired: item.skipRequired }); }) });
      let result = null;
      for (const turn of item.turns) result = await ask(turn);
      const content = result.answer.content;
      const presentation = turnLine(logs).context.presentation;
      assert.equal(result.answer.finishReason, 'stop');
      if (item.composed !== false) {
        assert.equal(presentation.mode, 'composed', JSON.stringify(presentation));
        assert.notEqual(presentation.server, true, `modelin düzeni kullanılır, sunucu geri dönüşü gizlenmez: ${JSON.stringify(presentation)}`);
        assert.ok(presentation.prose?.dropped >= 1, 'atılan model metni gözlemde sayılır');
      }
      for (const value of item.must) assert.ok(content.includes(value), `zorunlu ifade yok: ${value}\n${content}`);
      for (const pattern of [...HOSTILE_MARKERS, CONNECTORS, ...(item.never || [])]) assert.doesNotMatch(content, pattern);
      assert.doesNotMatch(content, /\{[PTG]\d+\}/, 'çözülmemiş yuva');
      assert.doesNotMatch(content, /(【R\d+】)\1/, 'yinelenen atıf');
      assert.match(content, /Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar|This answer covers only records|ölçüt:/, 'sunucu kapsam notu ya da ölçütü korunur');
      const page = pages.at(-1);
      if (!page) return;
      const paragraphs = content.split('\n\n');
      // Anlatım paragrafı: bir sunucu önermesinin başını taşıyan düz paragraf (tablo, liste, not, grafik ve sunucu ayrıntısı değil).
      const prose = paragraphs.filter((paragraph) => !/^[|_>`-]/.test(paragraph)
        && page.propositions.some((proposition) => plain(paragraph).includes(proposition.text.slice(0, 28))));
      assert.ok(prose.length, 'modelin seçtiği önermeler çizilir');
      const pageText = JSON.stringify(page);
      for (const paragraph of prose) {
        assert.match(paragraph, /【R\d+】$/, `her paragraf kendi kanıtına atıflıdır: ${paragraph}`);
        // Kalın her sayı sunucunun sayfasındandır: modelin yazdığı sayı yanıta girmez.
        for (const [, value] of paragraph.matchAll(/\*\*([^*]+)\*\*/g)) {
          const number = value.replace(/\\/g, '').match(/\d+(?:[,.]\d+)?/)?.[0];
          if (number) assert.ok(pageText.includes(number), `sayfada olmayan değer: ${value}`);
        }
        const sentences = paragraph.replace(/\s*【R\d+】+$/, '').split(/(?<=\.)\s+(?=[\p{Lu}*])/u);
        assert.equal(new Set(sentences).size, sentences.length, `paragrafta yinelenen cümle: ${paragraph}`);
        if (item.once) assert.ok(paragraph.split(item.once).length <= 2, `aynı olgu paragrafta iki kez söylenir: ${paragraph}`);
      }
      // Kişi karşılaştırmasında her cümle tek özneye aittir: bir kişinin ek cümlesi ötekinin cümlesine eklenmez.
      for (const subject of item.subjects || []) {
        const sentence = prose.join(' ').split(/(?<=\.)\s+/).find((text) => text.startsWith(`**${subject}**`));
        assert.ok(sentence, `öznenin cümlesi yok: ${subject}`);
        for (const other of item.subjects.filter((name) => name !== subject)) assert.ok(!sentence.includes(other), `özne karışması: ${sentence}`);
      }
    });
  }
});

/**
 * Gerçek Haiku 4.5 (düşünme kapalı) düzen çıktısı, değişiklikten önceki sözleşmede: model kendi yorum cümlelerini yazdı
 * ("Bu durum öncelikle dikkat gerektiriyor", "bu da iş yüküne dair bir ipucu veriyor"), her paragraf reddedildi ve tur
 * Derin devre ya da sunucu düzenine düştü. Kanıt sayfası sınama verisidir; içerik yalnızca kimlik ve modelin sözcükleridir.
 */
const HAIKU_LAYOUT = '```json\n{"blocks":[{"type":"say","text":"{P2} Bu durum öncelikle dikkat gerektiriyor. {P3} Ayrıca {P1} var."},'
  + '{"type":"chart","source":"G1","style":"kpi"},{"type":"say","text":"Gecikmelere bakınca {P4}. {P8} ve {P7}. Buna ek olarak {P9}, bu da iş yüküne dair bir ipucu veriyor."},'
  + '{"type":"rows","source":"T1"},{"type":"chart","source":"G2","style":"bar"},{"type":"note","items":["P5","P6"]}]}\n```';

test('gerçek zayıf model düzeni: yorum sözcükleri atılır, karışık bölümlü paragraf bölüm sınırında bölünür, düzen modelin seçimiyle çizilir', async (t) => {
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { compose: () => composer(() => HAIKU_LAYOUT) });
  const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) });
  const presentation = turnLine(logs).context.presentation;
  assert.equal(presentation.mode, 'composed');
  assert.notEqual(presentation.server, true, JSON.stringify(presentation));
  assert.equal(turnLine(logs).context.escalation ?? null, null, 'Derin devir yok');
  assert.ok(presentation.prose.dropped >= 4, JSON.stringify(presentation.prose));
  const content = result.answer.content;
  assert.doesNotMatch(content, /dikkat gerektiriyor|ipucu|Gecikmelere bakınca|Buna ek olarak|Ayrıca/);
  const paragraphs = content.split('\n\n');
  // P2, P3 (genel görünüm, R1) ile P1 (gecikmiş liste, R2) ayrı bölümlerdir: tek paragraf iki bölüme bölünür, her biri kendi atfıyla.
  const first = paragraphs.findIndex((paragraph) => paragraph.startsWith("Açık **6** görevin **3'ü**"));
  assert.ok(first >= 0, content);
  assert.match(paragraphs[first], /de \*\*1\*\* açık görevin termini var\. 【R1】$/);
  assert.equal(paragraphs[first + 1], 'Şu anda **3** gecikmiş göreviniz var. 【R2】');
});

/** Gerçek Haiku 4.5 düzeni, yeni sözleşmede: model yalnızca yuva yazdı ve aynı bölümü iki paragrafa böldü (öneri ile en uzun gecikme ayrı paragrafta). */
const HAIKU_SPLIT_LAYOUT = '```json\n{"blocks":[{"type":"say","text":"{P2} {P3} {P1} {P4}"},{"type":"say","text":"{P5} {P7} {P8} {P9} {P6}"},'
  + '{"type":"rows","source":"T1"},{"type":"chart","source":"G2","style":"bar"}]}\n```';

test('gerçek zayıf model düzeni: önceki paragrafın söylediği en uzun gecikme sonraki paragrafta yinelenmez; diğer olgular kalır', async (t) => {
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { compose: () => composer(() => HAIKU_SPLIT_LAYOUT) });
  const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) });
  const presentation = turnLine(logs).context.presentation;
  assert.equal(presentation.server, false, JSON.stringify(presentation));
  assert.equal(presentation.said, 8, 'seçilen dokuz önermeden yinelenen uç çizilmez; sekiz önerme görünür');
  const content = result.answer.content;
  const narrative = content.split('\n\n').filter((paragraph) => /【R2】$/.test(paragraph) && !paragraph.startsWith('_'));
  assert.equal(narrative.join(' ').split('23').length - 1, 1, `en uzun gecikme bir kez söylenir: ${narrative.join(' | ')}`);
  assert.match(content, /İlk ele alınabilecek iş \*\*Haftalık durum toplantısı\*\* görünüyor: \*\*23\*\* gündür gecikmiş ve en uzun gecikme onda/);
  for (const value of ['ortalaması **11,3 gün**', '**Kısmi kendi görevim** (**1 gün**)', "**3** görevin **2**'si bir haftadan uzun"]) assert.ok(content.includes(value), value);
});

test('kimlik paragrafında karışık bölüm önceki gibi reddedilir; bölme yalnızca modelin düzyazısına uygulanır', async (t) => {
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { compose: () => composer((view) => {
    const [a, b] = [view.propositions.find((item) => item.part === 1), view.propositions.find((item) => item.part === 2)];
    return { blocks: [{ type: 'say', items: [a.id, b.id] }, ...view.tables.map((table) => ({ type: 'rows', source: table.id }))] };
  }) });
  await ask({ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) });
  const presentation = turnLine(logs).context.presentation;
  assert.equal(presentation.server, true);
  assert.equal(presentation.rejected ?? presentation.issue, 'PART_MIXED');
});

test('bozuk, aşırı uzun ya da yalnızca yorum taşıyan model yanıtı sunucunun doğrulanmış düzenine düşer; yorum çizilmez', async (t) => {
  const cases = [
    ['geçersiz JSON', () => 'Durum çok kötü, elli görev gecikti.'],
    ['yanıt sınırını aşan metin', () => JSON.stringify({ blocks: [{ type: 'say', text: `${'x'.repeat(17000)} {P1}` }] })],
    ['paragraf sınırını aşan metin', () => ({ blocks: [{ type: 'say', text: `${'Elli görev gecikti. '.repeat(Math.ceil(PROSE_LIMITS.maxChars / 20))}{P1}` }] })],
    ['yalnızca yorum', () => ({ blocks: [{ type: 'say', text: 'Elli görev gecikti, çünkü ekip yetersiz.' }] })],
    ['bilinmeyen yuva', () => ({ blocks: [{ type: 'say', text: 'Elli görev gecikti {P99}' }] })]
  ];
  for (const [name, build] of cases) {
    await t.test(name, async (t) => {
      const logs = captureConsole(t);
      const { ask } = phase4eConversation(t, { compose: () => composer(build) });
      const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) });
      assert.equal(result.answer.finishReason, 'stop');
      const presentation = turnLine(logs).context.presentation;
      assert.equal(presentation.server, true, `geri dönüş açıkça raporlanır: ${JSON.stringify(presentation)}`);
      assert.doesNotMatch(result.answer.content, /[Ee]lli görev|çok kötü|yetersiz|xxxx/);
      assert.match(result.answer.content, /gecikmiş durumda; bugün başlayan yedi günlük dönemde de/, 'sunucu düzeni de doğrulanmış akıcı anlatımdır');
    });
  }
});

test('model nitelendirmesi analitik yanıtta "composed" kipindeki sunucu geri dönüşünü başarı saymaz', async (t) => {
  const { runCase, finalizeCompositionQualification } = await import('../scripts/answer-composition-qualification.mjs');
  const model = 'claude-haiku-4-5-20251001';
  const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens_details: { thinking_tokens: 0 } };
  const report = { cases: 0, passed: 0, calls: 0, composed: 0, narrative: 0, escalations: 0, charts: 0, reasons: {}, issues: {},
    usage: { input: 0, output: 0, thinking: 0, cacheCreate: 0, cacheRead: 0 }, results: [] };
  const item = { id: 'analitik-geri-dönüş', requiresComposition: true, stage: 'targeted',
    turns: [{ question: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) }] };
  await runCase(t, item, { report, providerOptions: { provider: 'claude', expectedModel: model,
    completeRound: () => ({ text: 'Durum kötü.', toolCalls: [], models: [model], thinking: 'off', finishReason: 'end_turn', usage }) } });
  assert.equal(report.results[0].mode, 'composed', 'üründe analitik geri dönüş sunucu düzenidir');
  assert.ok(report.results[0].failures.includes('SERVER_FALLBACK'), JSON.stringify(report.results[0].failures));
  assert.throws(() => finalizeCompositionQualification(report), /COMPOSITION_CHECKS_FAILED/);
});

test('nitelendirme doğrulanmış yinelenen ucu eksik anlatım saymaz; görünür önerme sayısı değişmez', async (t) => {
  const { runCase, finalizeCompositionQualification } = await import('../scripts/answer-composition-qualification.mjs');
  const { compositionView } = await import('./helpers/compositionScenario.mjs');
  for (const noted of [false, true]) await t.test(noted ? 'yinelenen uç notta' : 'yinelenen uç paragrafta', async (t) => {
    const report = { cases: 0, passed: 0, calls: 0, composed: 0, narrative: 0, escalations: 0, charts: 0, reasons: {}, issues: {},
      usage: { input: 0, output: 0, thinking: 0, cacheCreate: 0, cacheRead: 0 }, results: [] };
    const model = 'claude-haiku-4-5-20251001';
    const item = { id: noted ? 'notta-yinelenen-uç' : 'paragrafta-yinelenen-uç', requiresComposition: true, stage: 'targeted',
      turns: [{ question: 'Gecikmelerimi değerlendir.', plan: analysis({ scope: 'self', focus: ['overdue'] }), say: true, expect: ['Haftalık durum toplantısı', '1 gün'] }] };
    await runCase(t, item, { report, providerOptions: { provider: 'claude', expectedModel: model, completeRound: input => {
      const view = compositionView(input);
      const ids = ['attention', 'minimum', 'maximum'].map(kind => view.propositions.find(proposition => proposition.kind === kind)?.id);
      assert.ok(ids.every(Boolean), 'üç doğrulanmış önerme sayfada bulunur');
      const blocks = [{ type: 'say', text: (noted ? ids.slice(0, 2) : ids).map(id => `{${id}}`).join(' ') },
        ...(noted ? [{ type: 'note', items: ids.slice(2) }] : []), ...view.tables.map(table => ({ type: 'rows', source: table.id }))];
      return { text: JSON.stringify({ blocks }), toolCalls: [], models: [model], thinking: 'off', finishReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens_details: { thinking_tokens: 0 } } };
    } } });
    assert.deepEqual(report.results[0].failures, [], 'doğrulanmış üç önerme nitelendirme alt sınırını karşılar');
    assert.deepEqual([report.results[0].said, report.results[0].suppressed, report.results[0].notes], [2, 1, 0], 'iki görünür önerme ve bir yinelenen olgu ayrı sayılır');
    assert.equal(report.calls, 1, 'yalnızca belirlenimci sağlayıcı çağrılır');
    assert.doesNotThrow(() => finalizeCompositionQualification(report));
  });
});

/* ── Doğrulanmış söylem bağları (fluentParagraph) ───────────────────── */

const longest = (evidenceId, title, days) => ({ kind: 'maximum', evidenceId, table: 'T1', column: 0, markdown: `En uzun süredir geciken görev **${title}** (**${days} gün**).`,
  parts: ['en uzun süredir geciken görev ', { value: title, strong: true }, ' (', { value: `${days} gün`, strong: true }, ').'],
  fluent: { pair: { role: 'maximum', tail: ['en uzun süredir geciken ise ', { value: title, strong: true }] }, names: title, days } });
const attention = (evidenceId, title, days) => ({ kind: 'attention', evidenceId, markdown: `İlk ele alınabilecek iş **${title}** görünüyor: **${days}** gündür gecikmiş ve en uzun gecikme onda.`,
  parts: ['ilk ele alınabilecek iş ', { value: title, strong: true }, ' görünüyor: ', { value: String(days), strong: true }, ' gündür gecikmiş ve en uzun gecikme onda.'],
  fluent: { refers: { title, days, short: ['en uzun süredir beklediği için ilk ele alınabilecek iş ', { value: title, strong: true }, ' görünüyor'] } } });
const paragraph = (...items) => fluentParagraph(items.map((proposition) => ({ proposition })), 'tr');

test('öneri ile en uzun gecikme aynı görevi ve günü söylüyorsa uç cümlesi yinelenmez; eşleşme kanıt, ad ve günle birebirdir', () => {
  assert.equal(paragraph(attention('R2', 'Haftalık', 23), longest('R2', 'Haftalık', 23)),
    'İlk ele alınabilecek iş **Haftalık** görünüyor: **23** gündür gecikmiş ve en uzun gecikme onda.');
  // Başka gün, başka görev ya da başka kanıt: iki olgu da söylenir (yalnızca birebir aynı olgu düşer).
  for (const other of [longest('R2', 'Haftalık', 22), longest('R2', 'Başka', 23), longest('R3', 'Haftalık', 23)]) {
    assert.match(paragraph(attention('R2', 'Haftalık', 23), other), /En uzun süredir geciken görev/);
  }
  // Ters sırada öneri kısa biçimdedir; kısa biçim de aynı kanıt ve aynı günle sınırlıdır.
  assert.match(paragraph(longest('R2', 'Haftalık', 23), attention('R2', 'Haftalık', 23)), /En uzun süredir beklediği için ilk ele alınabilecek iş/);
  assert.match(paragraph(longest('R3', 'Haftalık', 23), attention('R2', 'Haftalık', 23)), /İlk ele alınabilecek iş \*\*Haftalık\*\* görünüyor: \*\*23\*\* gündür/);
});

test('"bunların" göndergesi yalnızca hemen önceki aynı kanıtın cümlesine bağlanır; araya başka kanıt ya da not girerse tam biçim söylenir', () => {
  const count = { kind: 'count', evidenceId: 'R1', markdown: 'Şu anda **3** gecikmiş göreviniz var.', parts: ['şu anda ', { value: '3', strong: true }, ' gecikmiş göreviniz var.'], fluent: { count: 3 } };
  const share = { kind: 'threshold', evidenceId: 'R1', markdown: '**3** görevin **2**\'si bir haftadan uzun süredir gecikmiş.',
    parts: [{ value: '3', strong: true }, ' görevin ', { value: '2', strong: true }, '\'si bir haftadan uzun süredir gecikmiş.'],
    fluent: { share: { base: 3, full: [{ value: '3', strong: true }, ' görevin ', { value: '2', strong: true }, '\'si gecikmiş'], intro: ['bunların ', { value: '2', strong: true }, '\'si gecikmiş'], also: [] } } };
  const other = { kind: 'count', evidenceId: 'R2', markdown: 'Ekibinizde **5** görev var.', parts: ['ekibinizde ', { value: '5', strong: true }, ' görev var.'] };
  assert.match(paragraph(count, share), /Bunların \*\*2\*\*'si/);
  assert.doesNotMatch(paragraph(count, other, share), /[Bb]unların/);
  assert.doesNotMatch(fluentParagraph([{ proposition: count }, { text: 'Yalnızca ilk kayıtlar gösteriliyor.' }, { proposition: share }], 'tr'), /[Bb]unların/);
});

test('özneli analist cümlesi yalnızca aynı öznenin (aynı kanıtın) cümlesine eklenir; özneler arası birleşme olmaz', async () => {
  const { analystPropositions } = await import('../src/domain/ai/groundedPropositions.js');
  const totals = (evidenceId, person, open, overdue, soon) => ['open', 'overdue', 'dueNext7Days'].map((metric, index) => ({ evidenceId,
    fact: { field: `data.totals.${metric}`, value: [open, overdue, soon][index], semantic: { metric: `tasks.${metric}`, complete: true, provenance: { tool: 'rota_task_analytics' },
      filters: { personSicil: person === 'Ayşe' ? AYSE : ZEYNEP, person } } } }));
  const propositions = analystPropositions([{ index: 0, presentation: { facts: [...totals('R1', 'Ayşe', 6, 3, 1), ...totals('R2', 'Zeynep', 2, 1, 1)] } }], 'tr')
    .map((item) => item.proposition);
  const find = (evidenceId, kind) => propositions.find((item) => item.evidenceId === evidenceId && item.kind === kind);
  const same = paragraph(find('R1', 'pressure'), find('R1', 'urgency'), find('R2', 'pressure'), find('R2', 'urgency'));
  assert.equal(same.split('**Ayşe**:').length - 1, 1, same);
  assert.equal(same.split('**Zeynep**:').length - 1, 1, same);
  assert.match(same, /\*\*Ayşe\*\*: Açık \*\*6\*\* görevin [^.]*; bugün başlayan yedi günlük dönemde de \*\*1\*\*/);
  // Sıra özneleri karıştırırsa ek cümle başka öznenin cümlesine eklenmez; kendi öznesiyle tek başına söylenir.
  const crossed = paragraph(find('R1', 'pressure'), find('R2', 'urgency'), find('R2', 'pressure'), find('R1', 'urgency'));
  assert.equal(crossed.split(/(?<=\.)\s+/).length, 4, crossed);
  for (const sentence of crossed.split(/(?<=\.)\s+/)) assert.match(sentence, /^\*\*(Ayşe|Zeynep)\*\*: /, `öznesiz cümle: ${sentence}`);
});

test('düzen yönergesi bayt bayt sabittir, veri taşımaz ve modelden bağlaç ya da yorum istemez', () => {
  const prompt = compositionSystemPrompt();
  assert.equal(prompt, compositionSystemPrompt());
  assert.doesNotMatch(prompt, CONNECTORS);
  assert.match(prompt, /YALNIZCA yuvalardır/);
  assert.match(prompt, /yuva dışındaki metin kullanıcıya hiç gösterilmez/);
  assert.doesNotMatch(prompt, /\d{4}-\d{2}-\d{2}/, 'tarih gibi değişken veri önek önbelleğini bozar');
});

test('yuva ayrıştırması sınırlıdır: aşırı uzun, boş ya da yuvasız metin reddedilir; sınırın üstünde yuva sayısı kabul edilmez', () => {
  const known = () => true;
  assert.equal(checkProse('x'.repeat(PROSE_LIMITS.maxChars + 1), { known }).issue, 'PROSE_INVALID');
  assert.equal(checkProse('   ', { known }).issue, 'PROSE_INVALID');
  assert.equal(checkProse(42, { known }).issue, 'PROSE_INVALID');
  assert.equal(checkProse(Array.from({ length: PROSE_LIMITS.maxSentences + 1 }, (_, index) => `{P${index + 1}}`).join(' '), { known }).issue, 'PROSE_LENGTH');
  assert.equal(checkProse('{P1} {P2}', { known, used: new Set(['P2']) }).issue, 'DUPLICATE_PROPOSITION');
  assert.equal(checkProse('{P1}, {P2}; {P3}.', { known }).dropped, 0, 'yalnızca ayırıcı noktalama atılan metin sayılmaz');
});

const counted = (evidenceId = 'R1', table = null) => ({ kind: 'count', evidenceId, table, markdown: 'Şu anda **3** gecikmiş göreviniz var.',
  parts: ['şu anda ', { value: '3', strong: true }, ' gecikmiş göreviniz var.'], fluent: { count: 3 } });
const average = (evidenceId = 'R1', value = '11,3') => ({ kind: 'average', evidenceId, markdown: `Gecikmelerin ortalaması **${value} gün**.`,
  parts: ['gecikmelerin ortalaması ', { value: `${value} gün`, strong: true }, '.'], fluent: { stat: [' ve ortalama gecikme ', { value: `${value} gün`, strong: true }] } });
const minimum = () => ({ kind: 'minimum', evidenceId: 'R1', table: 'T1', column: 0, markdown: 'En kısa süredir geciken görev **Kısa** (**1 gün**).',
  parts: ['en kısa süredir geciken görev ', { value: 'Kısa', strong: true }, ' (', { value: '1 gün', strong: true }, ').'],
  fluent: { pair: { role: 'minimum', tail: ['en kısa süredir geciken ise ', { value: 'Kısa', strong: true }, ' (', { value: '1 gün', strong: true }, ')'] } } });

test('gönderge sayımı önceki görünür birime ait olmalıdır; aynı kanıtın araya giren dökümü eski sayımı sürdüremez', () => {
  const total = { ...counted(), kind: 'total', table: 'T1' };
  const breakdown = { kind: 'breakdown', evidenceId: 'R1', markdown: 'Durumlara göre: Yapılacak **2**, Tamamlandı **1**.' };
  const majority = { kind: 'majority', evidenceId: 'R1', table: 'T1', markdown: 'Görevlerinizin büyük bölümü yapılacak durumunda.',
    fluent: { anaphor: { count: 3, join: [' ve bunların büyük bölümü yapılacak durumunda'], lead: ['bunların büyük bölümü yapılacak durumunda'] } } };
  const share = { kind: 'threshold', evidenceId: 'R1', table: 'T1', markdown: '**3** görevin **2**\'si bir haftadan uzun süredir gecikmiş.',
    fluent: { share: { base: 3, full: [{ value: '3', strong: true }, ' görevin ', { value: '2', strong: true }, "'si bir haftadan uzun süredir gecikmiş"],
      intro: ['bunların ', { value: '2', strong: true }, "'si bir haftadan uzun süredir gecikmiş"], also: ['ikisi de gecikmiş'] } } };
  for (const proposition of [majority, share]) {
    assert.match(paragraph(total, proposition), /bunların/i);
    for (const entry of [{ proposition: breakdown }, { proposition: counted('R2') }, { text: 'Yalnızca görünür kayıtlar gösteriliyor.' }]) {
      const output = fluentParagraph([{ proposition: total }, entry, { proposition }]);
      assert.doesNotMatch(output, /bunların/i, output);
      assert.ok(output.endsWith(proposition.markdown), output);
    }
    assert.doesNotMatch(paragraph({ ...total, table: 'T2' }, proposition), /bunların/i, 'aynı sayı başka tablo nüfusunu tanıtamaz');
    assert.doesNotMatch(paragraph(total, majority, proposition === majority ? share : majority), /\. Bunların/i, 'birleşmiş önceki cümle eski sayımı gönderge yapamaz');
  }
  const memory = { named: new Map(), attended: new Map() };
  fluentParagraph([{ proposition: attention('R1', 'Uzun', 23) }], 'tr', memory);
  const suppressed = fluentParagraph([{ proposition: total }, { proposition: breakdown }, { proposition: longest('R1', 'Uzun', 23) }, { proposition: majority }], 'tr', memory);
  assert.doesNotMatch(suppressed, /bunların/i, 'bastırılan önceki önerme dökümün öncesindeki sayımı canlandıramaz');
});

test('ortalama yalnızca hemen önceki uyumlu sayıma eklenir; uç, not ve başka özne seçilen sırayı korur', () => {
  const count = counted();
  const avg = average();
  assert.equal(paragraph(count, avg), 'Şu anda **3** gecikmiş göreviniz var ve ortalama gecikme **11,3 gün**.');
  const max = longest('R1', 'Uzun', 23);
  assert.equal(paragraph(count, max, avg), `${count.markdown} ${max.markdown} ${avg.markdown}`);
  assert.equal(fluentParagraph([{ proposition: count }, { text: 'Sunucunun kapsam notu.' }, { proposition: avg }]), `${count.markdown} Sunucunun kapsam notu. ${avg.markdown}`);
  assert.equal(paragraph(count, average('R2')), `${count.markdown} ${avg.markdown}`);
  assert.equal(paragraph(count, avg, average('R1', '12')), 'Şu anda **3** gecikmiş göreviniz var ve ortalama gecikme **11,3 gün** ve ortalama gecikme **12 gün**.');
});

test('yinelenen en uzun gecikme uç eşleştirmesinden önce elenir; minimum ve farklı olgular korunur', () => {
  const alert = attention('R1', 'Uzun', 23);
  const min = minimum();
  const max = longest('R1', 'Uzun', 23);
  for (const sequence of [[alert, min, max], [min, alert, max], [alert, max, min]]) {
    const emitted = [];
    const output = fluentParagraph(sequence.map(proposition => ({ proposition })), 'tr', null, emitted);
    assert.equal(output.split('**Uzun**').length - 1, 1, output);
    assert.ok(output.includes(min.markdown), output);
    assert.deepEqual(emitted, sequence.filter(item => item !== max));
  }
  assert.match(paragraph(min, max), /en uzun süredir geciken ise/, 'öneri yoksa iki uç birlikte çizilir');
  for (const other of [longest('R1', 'Başka', 23), longest('R1', 'Uzun', 22), longest('R2', 'Uzun', 23)]) {
    assert.ok(paragraph(alert, min, other).includes(other.fluent.pair.tail[0]) || paragraph(alert, min, other).includes(other.markdown));
  }
  const memory = { named: new Map(), attended: new Map() };
  fluentParagraph([{ proposition: alert }], 'tr', memory);
  assert.equal(fluentParagraph([{ proposition: min }, { proposition: max }], 'tr', memory), min.markdown);
});

test('görünür önerme sayısı ve atıflar yalnızca çizilen olguları izler; boşalan paragraf sayılmaz', async () => {
  const { renderComposition } = await import('../src/domain/ai/groundedComposition.js');
  const props = [attention('R1', 'Uzun', 23), longest('R1', 'Uzun', 23), counted('R2'), average('R2')]
    .map((item, index) => ({ ...item, id: `P${index + 1}`, part: 1 }));
  const composition = { render: { locale: 'tr', propositions: new Map(props.map(item => [item.id, item])),
    tables: new Map(), charts: new Map(), details: new Map(), titles: new Map() } };
  const blocks = items => ({ type: 'say', items });
  const empty = renderComposition(composition, { blocks: [blocks(['P1']), blocks(['P2'])] });
  assert.equal(empty.said, 1);
  assert.equal(empty.suppressed, 1, 'yinelenen önerme görünür anlatımdan ayrı sayılır');
  assert.equal(empty.text, `${props[0].markdown} 【R1】`);
  assert.deepEqual(empty.citedIds, ['R1']);
  const mixed = renderComposition(composition, { blocks: [blocks(['P1']), blocks(['P2', 'P3', 'P4'])] });
  assert.equal(mixed.said, 3, 'bastırılan uç sayılmaz, birleşen iki önerme ayrı ayrı temsil edilir');
  assert.equal(mixed.suppressed, 1);
  assert.equal(mixed.text, `${props[0].markdown} 【R1】\n\nŞu anda **3** gecikmiş göreviniz var ve ortalama gecikme **11,3 gün**. 【R2】`);
  assert.deepEqual(mixed.citedIds, ['R1', 'R2']);
  const noted = renderComposition(composition, { blocks: [{ type: 'note', items: ['P1', 'P2'] }] });
  assert.equal(noted.said, 1);
  assert.equal(noted.notes, 1);
  assert.deepEqual(noted.citedIds, ['R1']);
  assert.equal(noted.text.split('**Uzun**').length - 1, 1);
  const emitted = [];
  assert.equal(fluentParagraph([{ proposition: props[2] }, { proposition: props[3] }], 'tr', null, emitted), mixed.text.split('\n\n')[1].replace(' 【R2】', ''));
  assert.deepEqual(emitted, [props[2], props[3]]);
});

test('noktalama ve boşluk atılan sözcük sayılmaz; normal sözcükler sayılır ve yuva sınırları korunur', () => {
  for (const separator of ['!', '?', '   ', '…', '—', '“”', '、。！？', '\n\t']) {
    assert.equal(checkProse(`{P1}${separator}`, { known: () => true }).dropped, 0, separator);
  }
  for (const wording of ['ayrıca', 'yanlış 42', '説明']) assert.equal(checkProse(`{P1} ${wording}!`, { known: () => true }).dropped, 1, wording);
  assert.equal(checkProse('{P1}! {P9}', { known: id => id === 'P1' }).issue, 'UNKNOWN_PROPOSITION');
  assert.equal(checkProse('{P1}…{P1}', { known: () => true }).issue, 'DUPLICATE_PROPOSITION');
});

test('Ayrıntılı yanıtta yalnız tablo ya da grafik yönlendiren paragraf kendi bölüm başlığının altında kalır', async (t) => {
  const logs = captureConsole(t);
  let page;
  const { ask } = phase4eConversation(t, { compose: () => composer(view => {
    page = view;
    return { blocks: [{ type: 'say', text: view.propositions.filter(item => item.part === 1).map(item => `{${item.id}}`).join(' ') },
      { type: 'rows', source: 'T1' }, { type: 'say', text: '{T2}' }, { type: 'rows', source: 'T2', style: 'table' },
      { type: 'say', text: view.propositions.filter(item => item.part === 2).map(item => `{${item.id}}`).join(' ') },
      { type: 'say', text: '{G2}' }, { type: 'chart', source: 'G2', style: 'bar' }] };
  }) });
  const result = await ask({ text: 'görevlerimin durum ve öncelik dağılımını değerlendir', plan: analysis({ scope: 'self', focus: ['status', 'priority'] }) }, { detail: 'detailed' });
  assert.equal(turnLine(logs).context.presentation.server, false);
  const content = result.answer.content;
  const title = `#### ${page.titles.find(item => item.part === 2).text}`;
  const pointer = 'Ayrıntıları aşağıdaki tabloda görebilirsiniz.';
  assert.ok(content.indexOf(title) >= 0 && content.indexOf(title) < content.indexOf(pointer), content);
  assert.ok(content.indexOf(pointer) < content.indexOf('**Orta**'), content);
  assert.ok(content.indexOf('Dağılımı aşağıdaki grafikte görebilirsiniz.') < content.indexOf('```rota-chart'), content);
});

test('bölüm bölme ve sunucu tamamlama sonrasında toplam blok sınırı korunur; sınırdaki geçerli düzen kabul edilir', async () => {
  const { compositionLimits, validateComposition } = await import('../src/domain/ai/groundedComposition.js');
  const propositions = new Map(Array.from({ length: 6 }, (_, index) => {
    const id = `P${index + 1}`;
    return [id, { ...counted(`R${index % 3 + 1}`), id, part: index % 3 + 1 }];
  }));
  const tables = new Map(Array.from({ length: 6 }, (_, index) => {
    const id = `T${index + 1}`;
    return [id, { id, part: index % 3 + 1, rows: 2, columns: [{ id: 'C1' }] }];
  }));
  const details = new Map(Array.from({ length: 6 }, (_, index) => {
    const id = `D${index + 1}`;
    return [id, { id, part: index % 3 + 1, text: 'Sunucu ayrıntısı.' }];
  }));
  const render = { locale: 'tr', detail: 'balanced', limits: compositionLimits('balanced'), propositions, tables, details, charts: new Map(), titles: new Map() };
  for (const ids of [['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], ['P1', 'P2', 'P3', 'P4']]) {
    const blocks = [{ type: 'say', text: ids.map(id => `{${id}}`).join(' ') },
      ...[...tables.keys()].map(source => ({ type: 'rows', source })), ...[...details.keys()].map(source => ({ type: 'details', source }))];
    assert.ok(blocks.length < render.limits.maxBlocks);
    const boundary = { view: { language: 'tr' }, render: { ...render, limits: { ...render.limits, maxBlocks: 18 } } };
    const accepted = validateComposition(boundary, { blocks });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
    assert.equal(accepted.blocks.length, 18);
    assert.equal(accepted.prose.supplemented, 6 - ids.length);
    const rejected = validateComposition({ view: boundary.view, render }, { blocks });
    assert.equal(rejected.ok, false, 'ham girdi sınıra sığsa da genişleyen düzen sığmaz');
    assert.equal(rejected.issues[0], 'BLOCK_COUNT');
  }
});

test('bölümlere ayrılan paragraf kapasiteyi aşarsa bütünü düşer; önceki düzen, kimlikler ve sonraki yönlendirmeler korunur', async () => {
  const { validateComposition } = await import('../src/domain/ai/groundedComposition.js');
  const propositions = new Map(Array.from({ length: 8 }, (_, index) => {
    const id = `P${index + 1}`;
    const part = index < 4 ? 1 : 2;
    return [id, { ...counted(`R${part}`), id, part, ...([3, 6].includes(index) ? { required: true } : {}) }];
  }));
  const tables = new Map([1, 2].map(part => [`T${part}`, { id: `T${part}`, part, rows: 2, columns: [{ id: 'C1' }] }]));
  const composition = { view: { language: 'tr' }, render: { locale: 'tr', propositions, tables, charts: new Map(), details: new Map(), titles: new Map() } };
  const lead = { type: 'say', text: '{P1} {P2} {P3}' };
  const oversized = { type: 'say', text: '{P4} {T2} {T1} {P5} {P8}' };
  const tail = [{ type: 'say', text: '{P4} {T1}' }, { type: 'rows', source: 'T1' },
    { type: 'say', text: '{P5} {P6} {P7} {T2}' }, { type: 'rows', source: 'T2' }];
  const baseline = validateComposition(composition, { blocks: [lead, ...tail] });
  assert.equal(baseline.ok, true, JSON.stringify(baseline.issues));
  const checked = validateComposition(composition, { blocks: [lead, oversized, ...tail] });
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.deepEqual(checked.blocks, baseline.blocks, 'reddedilen paragrafın hiçbir parçası ya da durum etkisi kalmaz');
  assert.equal(checked.prose.rejected, 1);
  assert.equal(checked.prose.supplemented, 0, 'sonraki paragraflar önerme ve yönlendirme kimliklerini yeniden kullanır');
  assert.ok(!checked.blocks.some(block => block.items?.includes('P8')), 'reddedilen isteğe bağlı önerme tüketilmez');

  const split = validateComposition(composition, { blocks: [{ type: 'say', text: '{P1} {P2}' }, { type: 'say', text: '{P3} {P5} {P6} {P7} {P4}' },
    { type: 'rows', source: 'T1' }, { type: 'rows', source: 'T2' }] });
  assert.equal(split.ok, true, JSON.stringify(split.issues));
  assert.deepEqual(split.blocks.filter(block => block.type === 'say').map(block => block.items),
    [['P1', 'P2'], ['P3'], ['P5', 'P6', 'P7'], ['P4']], 'sınıra sığan dönüşümlü bölümler seçilen sırada ve kendi kapsamlarında kalır');

  const supplemented = validateComposition(composition, { blocks: [lead, oversized] });
  assert.equal(supplemented.ok, true, JSON.stringify(supplemented.issues));
  const supplementedIds = supplemented.blocks.flatMap(block => block.items || []);
  for (const id of ['P4', 'P7']) assert.ok(supplementedIds.includes(id), `zorunlu çekince sunucu tarafından tamamlanır: ${id}`);
  assert.deepEqual(supplemented.blocks.filter(block => block.type === 'rows').map(block => block.source), ['T1', 'T2']);
  const bounded = validateComposition({ ...composition, render: { ...composition.render, limits: { maxBlocks: 3, maxSayBlocks: 4 } } }, { blocks: [lead, oversized] });
  assert.deepEqual(bounded, { ok: false, issues: ['BLOCK_COUNT'] }, 'sunucu tamamlama son blok sınırını aşamaz');
  const allRejected = validateComposition(composition, { blocks: [{ type: 'say', text: '{P1} {P5} {P2} {P6} {P3}' }] });
  assert.deepEqual(allRejected, { ok: false, issues: ['SAY_INVALID'] }, 'bütün düzyazı düşerse model düzeni başarılı sayılmaz');
  const malformed = validateComposition(composition, { blocks: [lead, oversized, { type: 'rows', source: 'T1', text: 'İzinsiz alan.' }] });
  assert.deepEqual(malformed, { ok: false, issues: ['BLOCK_INVALID'] }, 'bozuk diğer bloklar tüm düzeni reddetmeye devam eder');
  const identity = validateComposition(composition, { blocks: Array.from({ length: 5 }, (_, index) => ({ type: 'say', items: [`P${index + 1}`] })) });
  assert.deepEqual(identity, { ok: false, issues: ['SAY_INVALID'] }, 'kimlik paragraflarının katı kapasite reddi korunur');
});

test('notlar önceki görünür olguları paylaşır; yinelenen uç düşer, farklı olguların tonu, sayımı ve atıfları kalır', async () => {
  const { renderComposition } = await import('../src/domain/ai/groundedComposition.js');
  const props = [attention('R1', 'Uzun', 23), longest('R1', 'Uzun', 23), counted('R2'), average('R2')]
    .map((item, index) => ({ ...item, id: `P${index + 1}`, part: 1 }));
  const composition = { render: { locale: 'tr', propositions: new Map(props.map(item => [item.id, item])),
    tables: new Map(), charts: new Map(), details: new Map(), titles: new Map() } };
  const say = items => ({ type: 'say', items });
  const note = items => ({ type: 'note', items });
  const empty = renderComposition(composition, { blocks: [say(['P1']), note(['P2'])] });
  assert.equal(empty.text, `${props[0].markdown} 【R1】`);
  assert.equal(empty.suppressed, 1, 'boşalan notun doğrulanmış yinelenen önermesi ayrı sayılır');
  assert.deepEqual([empty.said, empty.notes, empty.citedIds], [1, 0, ['R1']], 'boşalan not işaretleme, sayaç ya da atıf eklemez');
  const mixed = renderComposition(composition, { blocks: [say(['P1']), note(['P2', 'P3', 'P4'])] });
  assert.equal(mixed.text, `${props[0].markdown} 【R1】\n\n> [!info]\n> **Öne çıkan:** Şu anda **3** gecikmiş göreviniz var ve ortalama gecikme **11,3 gün**. 【R2】`);
  assert.deepEqual([mixed.said, mixed.notes, mixed.citedIds], [3, 1, ['R1', 'R2']]);
  const before = renderComposition(composition, { blocks: [say(['P3']), note(['P2']), say(['P1'])] });
  assert.ok(before.text.indexOf(props[1].markdown) < before.text.indexOf('En uzun süredir beklediği için'), before.text);
  assert.match(before.text, /> \*\*Öne çıkan:\*\* En uzun süredir geciken görev \*\*Uzun\*\* \(\*\*23 gün\*\*\)\. 【R1】/);
  assert.deepEqual([before.said, before.notes], [3, 1], 'sonraki öneri önceki notu bastıramaz; kendi kısa biçimini kullanır');
  const earlierNote = renderComposition(composition, { blocks: [say(['P3']), note(['P1']), say(['P2'])] });
  assert.deepEqual([earlierNote.said, earlierNote.notes], [2, 1], 'önceki notun söylediği olgu sonraki paragrafta yinelenmez');
  assert.equal(earlierNote.text.split('**Uzun**').length - 1, 1);
  for (const other of [longest('R2', 'Uzun', 23), longest('R1', 'Başka', 23), longest('R1', 'Uzun', 22)]) {
    const changed = { ...composition, render: { ...composition.render, propositions: new Map([...composition.render.propositions, ['P2', { ...other, id: 'P2', part: 1, tone: 'warning' }]]) } };
    const distinct = renderComposition(changed, { blocks: [say(['P1']), note(['P2'])] });
    assert.ok(distinct.text.includes(other.markdown), distinct.text);
    assert.match(distinct.text, /> \[!warning\]\n> \*\*Dikkat:\*\*/);
    assert.deepEqual([distinct.said, distinct.notes], [2, 1], 'farklı kanıt, görev ya da değer bastırılmaz');
  }
});

test('üretim düzeninde sonraki notun yinelediği en uzun gecikme bir kez anlatılır; model düzeni ve sunucu kapsamı korunur', async (t) => {
  const logs = captureConsole(t);
  const { ask } = phase4eConversation(t, { compose: () => composer(view => {
    const max = view.propositions.find(item => item.kind === 'maximum' && item.text.includes('23'));
    assert.ok(max, 'gecikme ucunun sunucu önermesi vardır');
    const layout = hostileLayout(view);
    for (const block of layout.blocks) if (block.text) block.text = block.text.replace(`{${max.id}}`, '');
    layout.blocks.push({ type: 'note', items: [max.id] });
    return layout;
  }) });
  const result = await ask({ text: 'işlerimin genel durumunu değerlendir', plan: analysis({ scope: 'self', focus: ['overview', 'overdue', 'upcoming'] }) });
  const presentation = turnLine(logs).context.presentation;
  assert.equal(presentation.server, false, JSON.stringify(presentation));
  assert.equal(presentation.mode, 'composed');
  assert.equal(presentation.notes, 0, result.answer.content);
  const narrative = result.answer.content.split('\n\n').filter(paragraph => !/^[|_`-]/.test(paragraph)).join('\n\n');
  assert.equal(narrative.split('23').length - 1, 1, 'görev tablosu dışında gecikme anlatımda bir kez yer alır');
  assert.doesNotMatch(result.answer.content, /> \[!/);
  assert.match(result.answer.content, /Bu yanıt yalnızca görüntüleme yetkiniz bulunan kayıtları kapsar/);
});
