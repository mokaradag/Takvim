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
import { phase4eConversation } from './helpers/phase4eScenario.mjs';
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
  subjectComparison: /arasındaki en belirgin fark|sayıları birbirine yakın/
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
    for (const name of [...(item.plan?.analysis?.names || []), ...(item.expect?.names || [])]) assert.ok(known.has(name), `${item.id}: ${name}`);
  }
});

for (const item of fixture.original.filter((entry) => entry.plan)) {
  test(`kıyas ${item.id} (${item.observed}, ${item.handling}): ${item.capabilities.join(', ')}`, async (t) => {
    const { ask } = conversation(t, item.profile);
    const result = await ask({ text: item.text, plan: resolvePlan(item.plan) }, { detail: item.expect.detail || null });
    const content = String(result.answer.content || '');
    const finish = result.answer.finishReason;
    if (item.handling === 'full') assert.equal(finish, 'stop', content);
    else assert.ok(['stop', 'unavailable'].includes(finish), `${finish}: ${content}`);
    assert.doesNotMatch(content, /yanıt doğrulanamadı/);
    for (const type of item.expect.chartTypes || []) assert.ok(content.includes(`"type":"${type}"`), `${type} grafiği yok:\n${content}`);
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
