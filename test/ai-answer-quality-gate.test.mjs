/**
 * Aşama F — yanıt metni kalite kapısı (belirlenimci; model çağrısı ve arayüz yok).
 *
 * Kıyas kümesinin altın planlı her sorusu Kısa, Dengeli ve Ayrıntılı ayrıntıda, planlayıcı kıyasının çok istekli türlü
 * örnekleri Dengeli ayrıntıda üretim yolundan geçer; yalnızca METİN ölçülür (`test/helpers/answerQuality.mjs`).
 * Eşikler:
 *   - çok bölümlü analitik özet: açılış %100, kapanış %100, cümlesiz tablo 0;
 *   - çok bölümlü türlü yanıt: açılış %100 (kapanış zorunlu değil: olgu listesi dolguyla kapatılmaz);
 *   - bütün yanıtlar: mekanik kalıp 0, yinelenen cümle 0;
 *   - etiketli ölçüt satırı ("_Ölçüt: …_") yanıt başına ortalama Kısa ≤ 0,5; Dengeli ve Ayrıntılı ≤ 0,3.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { phase4eConversation } from './helpers/phase4eScenario.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from './helpers/analysisBenchmarkSeed.mjs';
import { NOW } from './helpers/aiToolFixtures.mjs';
import { answerQuality } from './helpers/answerQuality.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bilgin-analysis-benchmark.json', import.meta.url), 'utf8'));
const planner = JSON.parse(readFileSync(new URL('./fixtures/ai-planner-benchmark.json', import.meta.url), 'utf8'));
const TODAY = '2026-09-30';
const resolvePlan = (plan) => JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${new Date(Date.parse(`${TODAY}T00:00:00Z`) + Number(offset) * 86400000).toISOString().slice(0, 10)}"`));
const CAPTION_LIMITS = Object.freeze({ short: 0.5, balanced: 0.3, detailed: 0.3 });
const measured = [];

function check(kind, detail, id, content) {
  const quality = answerQuality(content);
  measured.push({ kind, detail, id, quality });
  assert.deepEqual(quality.mechanical, [], `mekanik kalıp:\n${content}`);
  assert.equal(quality.duplicates, 0, `yinelenen cümle:\n${content}`);
  if (!quality.multi) return;
  assert.ok(quality.opening, `açılış cümle değil:\n${content}`);
  if (kind === 'analytical') {
    assert.ok(quality.ending, `kapanış yok:\n${content}`);
    assert.equal(quality.bareTables, 0, `cümlesiz tablo:\n${content}`);
  }
}

for (const detail of ['short', 'balanced', 'detailed']) {
  for (const item of fixture.original.filter((entry) => entry.plan)) {
    test(`kalite kapısı: kıyas ${item.id} (${detail})`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const seed = analysisBenchmarkSeed();
      t.mock.timers.reset();
      const { ask } = phase4eConversation(t, { sicil: BENCH_PROFILES[item.profile || 'B'], seed });
      const { answer } = await ask({ text: item.text, plan: resolvePlan(item.plan) }, { detail });
      assert.equal(answer.finishReason, 'stop', answer.content);
      check(item.plan.analysis ? 'analytical' : 'typed', detail, item.id, answer.content);
    });
  }
}

for (const item of [...planner.cases, ...(planner.supplementary || [])].filter((entry) => entry.example?.additionalRequests)) {
  test(`kalite kapısı: türlü çok istekli ${item.case}`, async (t) => {
    const { ask } = phase4eConversation(t);
    const { answer } = await ask({ text: 'soru', plan: { intent: 'rota', language: item.language || 'tr', ...item.example } }, { detail: 'balanced' });
    // Örnek planın verisi sınama kümesinde yoksa doğrulanamaz; dil kapısı yalnızca teslim edilen yanıtı ölçer.
    if (answer.finishReason === 'stop') check('typed', 'balanced', item.case, answer.content);
  });
}

test('kalite kapısı eşikleri: açılış ve kapanış oranı, ölçüt satırı ortalaması', () => {
  const analytical = measured.filter((row) => row.kind === 'analytical' && row.quality.multi);
  assert.ok(analytical.length >= 80, `ölçülen çok bölümlü analitik yanıt sayısı: ${analytical.length}`);
  assert.equal(analytical.filter((row) => row.quality.opening && row.quality.ending).length, analytical.length);
  assert.ok(measured.filter((row) => row.kind === 'typed' && row.quality.multi).length >= 3, 'türlü çok bölümlü yanıt ölçülmeli');
  for (const [detail, limit] of Object.entries(CAPTION_LIMITS)) {
    const rows = measured.filter((row) => row.detail === detail);
    const average = rows.reduce((sum, row) => sum + row.quality.captions, 0) / rows.length;
    assert.ok(average <= limit, `${detail}: etiketli ölçüt satırı ortalaması ${average.toFixed(2)} > ${limit}`);
  }
});
