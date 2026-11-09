/**
 * Aşama F — Bilgin yönetim analizi kıyas kümesinin belirlenimci regresyonu (model çağrısı yok).
 *
 * Özgün 40 Windows VM sorusunun SENTETİK karşılıkları (`test/fixtures/bilgin-analysis-benchmark.json`) özgün sırasıyla
 * korunur. Aşama F'de tam ya da gerekçeli kısmi yanıtı beklenen her vakanın altın planı ÜRETİMDEKİ asistan hizmetinden
 * (yetki, salt okunur araçlar, kanıt, sunucu düzeni) sentetik veriyle geçer; yanıtın bitişi, istenen grafik türleri, bölümler
 * arası bulgular, zorunlu çekinceler ve gelecek dönemde gecikmenin bugüne göre okunması denetlenir. Sonraki aşamaya bağlı
 * vakalar açık bağımlılıkla kaydedilir. Bu sınama gerçek model kabulü DEĞİLDİR (bkz. scripts/analysis-qualification.mjs).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { benchmarkExpectation } from '../scripts/analysis-qualification.mjs';
import { answerQuality } from './helpers/answerQuality.mjs';
import { phase4eConversation, turnViolations, renderedCharts } from './helpers/phase4eScenario.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from './helpers/analysisBenchmarkSeed.mjs';
import { NOW } from './helpers/aiToolFixtures.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bilgin-analysis-benchmark.json', import.meta.url), 'utf8'));
const TODAY = '2026-09-30';
const FAILED = [2, 3, 5, 7, 11, 16, 19, 24, 27, 30, 34, 35, 36, 38, 39, 40];

/** Altın plandaki `T+n` göreli günleri sınamanın sabit gününe çevrilir. */
function resolvePlan(plan) {
  const shift = (offset) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  return JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${shift(Number(offset))}"`));
}

/** Sentetik veri sabit saatte kurulur; konuşma aynı saatle yürür. */
function conversation(t, profile) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  return phase4eConversation(t, { sicil: BENCH_PROFILES[profile], seed });
}

const FINDING_TEXT = Object.freeze({
  attentionLeader: /yönetim dikkatini en çok/,
  overdueConcentration: /\(\*\*%\d+\*\*\) (?:bu projede|.+ projesinde) toplanıyor/,
  windowPressure: /arasında teslimatı olan \*\*\d+\*\* projenin/,
  subjectComparison: /arasındaki en belirgin fark|sayıları birbirine yakın|görev sayıları iki (?:kişide|projede) aynı/
});

test('kıyas kümesi özgün 40 sorunun sırasını, gözlenen sonucunu ve sınıflarını korur; ayrık küme en az 20 vakadır', () => {
  assert.equal(fixture.original.length, 40);
  assert.deepEqual(fixture.original.map((item) => item.order), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.deepEqual(fixture.original.filter((item) => item.observed === 'failed').map((item) => item.order), FAILED);
  assert.equal(fixture.original.filter((item) => item.observed === 'mechanical').length, 24);
  assert.ok(fixture.holdout.length >= 20);
  assert.equal(new Set([...fixture.original, ...fixture.holdout].map((item) => item.id)).size, 64);
  for (const item of fixture.original) {
    assert.ok(['full', 'partial', 'limitation'].includes(item.handling), item.id);
    // Sınırlı ya da kısmi yanıtın bağımlı olduğu aşama açıkça yazılır; tam yanıtın bağımlılığı yoktur.
    assert.equal(Boolean(item.dependsOn), item.handling !== 'full', item.id);
    assert.equal(item.plan == null, item.handling === 'limitation', item.id);
  }
});

test('kıyas verisi tamamen sentetiktir: sorulardaki bütün kişi ve proje adları sentetik veri kümesinde tanımlıdır', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  const known = new Set([...seed.people.map((person) => person.DisplayName), ...seed.projects.map((project) => project.ProjectName)]);
  for (const item of [...fixture.original, ...fixture.holdout]) {
    assert.ok(Array.isArray(item.textEntities), `${item.id}: soru varlıkları bildirilmemiş`);
    assert.deepEqual(item.textEntities, [...known].filter((name) => item.text.includes(name)), `${item.id}: soru metnindeki varlıklar`);
    for (const name of [...item.textEntities, ...(item.plan?.analysis?.names || []), ...(item.expect?.names || [])]) {
      assert.ok(known.has(name), `${item.id}: ${name}`);
      assert.ok(item.text.includes(name), `${item.id}: varlık soru metninde yok: ${name}`);
    }
  }
});

for (const item of fixture.original.filter((entry) => entry.plan)) {
  test(`kıyas ${item.id} (${item.observed}, ${item.handling}): ${item.capabilities.join(', ')}`, async (t) => {
    const { ask } = conversation(t, item.profile);
    const result = await ask({ text: item.text, plan: resolvePlan(item.plan) }, { detail: item.expect.detail || null });
    const content = String(result.answer.content || '');
    const finish = result.answer.finishReason;
    assert.equal(finish, 'stop', content);
    assert.ok(content.trim() && /【R\d+】/.test(content), 'kısmi yanıt da kanıtlı ve dolu olmalı');
    assert.deepEqual(turnViolations(result, benchmarkExpectation({ ...item, plan: resolvePlan(item.plan) })), [], content);
    if (answerQuality(content).multi) {
      assert.ok(answerQuality(content).opening, content);
      assert.ok(answerQuality(content).ending, content);
    }
    assert.doesNotMatch(content, /yanıt doğrulanamadı/);
    for (const type of item.expect.chartTypes || []) assert.ok(renderedCharts(content).some((chart) => chart.type === type), `${type} grafiği yok:\n${content}`);
    if (item.expect.chart) assert.ok(content.includes('```rota-chart'), `grafik yok:\n${content}`);
    for (const kind of item.expect.findings || []) assert.match(content, FINDING_TEXT[kind], `${kind} bulgusu yok:\n${content}`);
    if (item.expect.caveat) assert.match(content, /kesin olarak söylenemez/, 'eksik kadronun zorunlu çekincesi');
    // Sonuç, numaralı öncelik listesidir (bölümlü yanıtta kendi başlığıyla).
    if (item.expect.conclusion) assert.match(content, /(?:\*\*|#### )Öncelikli konular(?:\*\*)?\n\n1\. .+\n2\. /);
    if (item.expect.overdueUnwindowed) {
      // Gecikme bugüne göre ölçülür: gelecek dönem gecikmiş iş okumasını boşaltmaz.
      assert.doesNotMatch(content, /terminli gecikmiş görev yok/);
      assert.match(content, /\*\*\d+\*\* gecikmiş görev var/);
    }
  });
}

test('sonraki aşamaya bağlı vakalar açık bağımlılıkla kayıtlıdır (sınırlılık başarı sayılmaz)', () => {
  const limited = fixture.original.filter((item) => item.handling === 'limitation');
  assert.deepEqual(limited.map((item) => [item.order, item.dependsOn]), [[7, 'H'], [19, 'G'], [27, 'H']]);
});

test('proje durum kıyası her projenin teslim edilen sayılarını ve doğru atfını gerektirir', async (t) => {
  const item = fixture.original.find((entry) => entry.id === 'o33');
  const { ask } = conversation(t, item.profile);
  const result = await ask({ text: item.text, plan: resolvePlan(item.plan) });
  const expect = benchmarkExpectation(item);
  assert.deepEqual(turnViolations(result, expect), [], result.answer.content);
  const status = result.evidence.filter((row) => row.data?.groupBy === 'status');
  assert.equal(status.length, 2);
  const [first, second] = status.map((row) => row.data.filters.project);
  const swappedNames = result.answer.content.replaceAll(first, '__proje__').replaceAll(second, first).replaceAll('__proje__', second);
  assert.ok(turnViolations({ ...result, answer: { ...result.answer, content: swappedNames } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  for (const row of status) {
    const content = result.answer.content.replaceAll(`【${row.evidenceId}】`, '【R999】').replaceAll(`"${row.evidenceId}"`, '"R999"');
    assert.ok(turnViolations({ ...result, answer: { ...result.answer, content } }, expect).includes('durum dağılımı yanıtta eksik'));
  }
  const chart = { ...renderedCharts(result.answer.content)[0], items: [{ label: 'Yüksek', value: 3 }, { label: 'Düşük', value: 2 }] };
  const content = `Öncelik dağılımı.\n\n\`\`\`rota-chart\n${JSON.stringify(chart)}\n\`\`\``;
  assert.ok(turnViolations({ ...result, answer: { ...result.answer, content } }, expect).includes('durum dağılımı yanıtta eksik'));
  const missing = { ...result, evidence: result.evidence.filter((row) => row !== status[1]) };
  assert.ok(turnViolations(missing, expect).includes('projenin durum grubu kanıtı yok'));
});

for (const format of ['liste', 'tablo', 'grafik']) test(`eşit durum sayıları proje adı ile kanıtın yer değiştirmesini gizleyemez: ${format}`, () => {
  const names = ['Radar', 'Radar Genişletme'];
  const projectIds = ['p1', 'p2'];
  const groups = [{ label: 'Yapılacak', count: 3 }, { label: 'Tamamlandı', count: 2 }];
  const evidence = names.map((project, index) => ({ tool: 'rota_task_analytics', evidenceId: `R${index + 1}`,
    data: { groupBy: 'status', filters: { projectId: projectIds[index], project }, groups } }));
  const section = (project, id) => {
    const body = format === 'liste' ? groups.map((group) => `- ${group.label} — ${group.count} görev 【${id}】`).join('\n')
      : format === 'tablo' ? `| Grup | Kayıt sayısı |\n| --- | ---: |\n| Yapılacak | 3 |\n| Tamamlandı | 2 |\n\n_Kaynak:_ 【${id}】`
        : `\`\`\`rota-chart\n${JSON.stringify({ version: 1, type: 'donut', locale: 'tr', title: 'Durum dağılımı', unit: 'count', evidence: [id], items: groups.map((group) => ({ label: group.label, value: group.count })) })}\n\`\`\``;
    return `#### ${project}\n\n${body}`;
  };
  const content = names.map((name, index) => section(name, `R${index + 1}`)).join('\n\n');
  const result = { locale: 'tr', answer: { content }, evidence, analysisContext: { scope: 'project', focus: ['status'] },
    log: projectIds.map((projectId) => ({ query: 'task-facts', params: { projectId } })) };
  const expect = { scope: 'project', focus: ['status'], projectIds };
  assert.deepEqual(turnViolations(result, expect), [], content);
  const nested = content.replaceAll(/^(#### [^\n]+)$/gm, '$1\n\n##### Durum dağılımı');
  assert.deepEqual(turnViolations({ ...result, answer: { content: nested } }, expect), [], nested);
  const outside = nested.replace('##### Durum dağılımı', '### Genel sonuç');
  assert.ok(turnViolations({ ...result, answer: { content: outside } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  const nestedSwapped = nested.replaceAll('R1', '__kanıt__').replaceAll('R2', 'R1').replaceAll('__kanıt__', 'R2');
  assert.ok(turnViolations({ ...result, answer: { content: nestedSwapped } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  const swappedIds = content.replaceAll('R1', '__kanıt__').replaceAll('R2', 'R1').replaceAll('__kanıt__', 'R2');
  assert.ok(turnViolations({ ...result, answer: { content: swappedIds } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  const swappedNames = names.map((_, index) => section(names[1 - index], `R${index + 1}`)).join('\n\n');
  assert.ok(turnViolations({ ...result, answer: { content: swappedNames } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  if (format === 'liste') {
    const wrongHeading = content.replace('#### Radar\n', '#### Radar Genişletme\n').replace('- Yapılacak', '- Radar: Yapılacak');
    assert.ok(turnViolations({ ...result, answer: { content: wrongHeading } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  }
  if (format === 'grafik') {
    const wrongTitle = content.replace('"title":"Durum dağılımı"', `"title":"${names[1]}"`);
    assert.ok(turnViolations({ ...result, answer: { content: wrongTitle } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
    const repeated = `${section(names[1], 'R1')}\n\n${content}`;
    assert.ok(turnViolations({ ...result, answer: { content: repeated } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
    const explicitTitle = content.replace('"title":"Durum dağılımı"', '"title":"Radar"');
    assert.deepEqual(turnViolations({ ...result, answer: { content: explicitTitle } }, expect), []);
    const wrongHeading = explicitTitle.replace('#### Radar\n', '#### Radar Genişletme\n');
    assert.ok(turnViolations({ ...result, answer: { content: wrongHeading } }, expect).includes('durum dağılımında proje atfı uyuşmuyor'));
  }
});

for (const composition of [true, false]) for (const locale of ['tr', 'en']) test(`çoklu ufuk vakası dağılımı birikimli dönem kıyası sanmaz: ${composition ? 'model' : 'sunucu'}, ${locale === 'tr' ? 'Türkçe' : 'İngilizce'}`, async (t) => {
  const item = fixture.original.find((row) => row.id === 'o30');
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const seed = analysisBenchmarkSeed();
  t.mock.timers.reset();
  const { ask } = phase4eConversation(t, { seed, sicil: BENCH_PROFILES[item.profile], composition });
  const result = await ask({ text: item.text, plan: { ...item.plan, language: locale } });
  const expect = { ...benchmarkExpectation(item), horizonLimitation: true };
  assert.deepEqual(turnViolations(result, expect), [], result.answer.content);
  const content = result.answer.content.split('\n').filter((line) => !/birikimli teslimat|cumulative delivery/.test(line)).join('\n');
  assert.ok(turnViolations({ ...result, answer: { ...result.answer, content } }, expect).includes('çoklu ufuk sınırlılığı açıklanmadı'));
});
