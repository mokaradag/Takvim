/**
 * Aşama F — yanıt metni kalite kapısı (belirlenimci; model çağrısı ve arayüz yok).
 *
 * Kıyas kümesinin altın planlı her sorusu Kısa, Dengeli ve Ayrıntılı ayrıntıda, planlayıcı kıyasının çok istekli türlü
 * örnekleri Dengeli ayrıntıda üretim yolundan geçer; yalnızca METİN ölçülür (`test/helpers/answerQuality.mjs`).
 * Eşikler:
 *   - her analitik özet: açılış %100, kapanış %100, cümlesiz tablo 0;
 *   - çok bölümlü türlü yanıt: açılış %100 (kapanış zorunlu değil: olgu listesi dolguyla kapatılmaz);
 *   - bütün yanıtlar: mekanik kalıp 0, yinelenen cümle 0;
 *   - etiketli ölçüt satırı ("_Ölçüt: …_") yanıt başına ortalama Kısa ≤ 0,5; Dengeli ve Ayrıntılı ≤ 0,3.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { phase4eConversation } from './helpers/phase4eScenario.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from './helpers/analysisBenchmarkSeed.mjs';
import { NOW, rotaToolSeed, TASKS, PROJECTS, AYSE } from './helpers/aiToolFixtures.mjs';
import { loadPlannerBenchmark, resolveExample } from '../scripts/planner-scoring.mjs';
import { answerQuality } from './helpers/answerQuality.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bilgin-analysis-benchmark.json', import.meta.url), 'utf8'));
const TODAY = '2026-09-30';
const planner = loadPlannerBenchmark({ referenceDate: TODAY });
const resolvePlan = (plan) => JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${new Date(Date.parse(`${TODAY}T00:00:00Z`) + Number(offset) * 86400000).toISOString().slice(0, 10)}"`));
const CAPTION_LIMITS = Object.freeze({ short: 0.5, balanced: 0.3, detailed: 0.3 });
const measured = [];

function check(kind, detail, id, content) {
  assert.ok(String(content || '').trim(), 'boş yanıt kalite ölçümü olamaz');
  const quality = answerQuality(content);
  measured.push({ kind, detail, id, quality });
  assert.deepEqual(quality.mechanical, [], `mekanik kalıp:\n${content}`);
  assert.equal(quality.duplicates, 0, `yinelenen cümle:\n${content}`);
  if (kind !== 'analytical' && !quality.multi) return;
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

for (const item of planner.cases.filter((entry) => entry.example?.additionalRequests)) {
  test(`kalite kapısı: türlü çok istekli ${item.id}`, async (t) => {
    const seed = rotaToolSeed();
    if (item.id === 'tr-091') {
      seed.tasks.find((task) => task.TaskId === TASKS.DUE_SOON).TargetFinish = '2026-10-01';
      seed.taskAssignees.push({ TaskId: TASKS.DUE_SOON, Sicil: AYSE });
    }
    if (item.id === 'tr-092') {
      seed.projects.find((project) => project.ProjectId === PROJECTS.FULL).ProjectName = 'Anten';
      // Bu dil örneği iki baz plan satırı ve ikisinin de bağımlı ayrıntısını mevcut dört turda okur.
      seed.taskBaselineSnapshots = seed.taskBaselineSnapshots.filter((row) => row.TaskId !== TASKS.DONE);
      for (const task of seed.tasks.filter((task) => task.ProjectId === PROJECTS.FULL && !seed.taskAssignees.some((row) => row.TaskId === task.TaskId))) {
        seed.taskAssignees.push({ TaskId: task.TaskId, Sicil: AYSE });
      }
    }
    const { ask } = phase4eConversation(t, { seed });
    const { answer } = await ask({ text: item.text, plan: { intent: 'rota', language: item.language || 'tr', ...resolveExample(item.example, TODAY) } }, { detail: 'balanced' });
    assert.equal(answer.finishReason, 'stop', `${item.id}: ${answer.content}`);
    check('typed', 'balanced', item.id, answer.content);
  });
}

test('kalite kapısı eşikleri: açılış ve kapanış oranı, ölçüt satırı ortalaması', () => {
  const analytical = measured.filter((row) => row.kind === 'analytical');
  assert.ok(analytical.length >= 80, `ölçülen çok bölümlü analitik yanıt sayısı: ${analytical.length}`);
  assert.equal(analytical.filter((row) => row.quality.opening && row.quality.ending).length, analytical.length);
  assert.ok(measured.filter((row) => row.kind === 'typed' && row.id && planner.cases.some((item) => item.id === row.id && item.example?.additionalRequests)).length === planner.cases.filter((item) => item.example?.additionalRequests).length, 'seçilen her türlü yanıt ölçülmeli');
  for (const [detail, limit] of Object.entries(CAPTION_LIMITS)) {
    const rows = measured.filter((row) => row.detail === detail);
    const average = rows.reduce((sum, row) => sum + row.quality.captions, 0) / rows.length;
    assert.ok(average <= limit, `${detail}: etiketli ölçüt satırı ortalaması ${average.toFixed(2)} > ${limit}`);
  }
});
