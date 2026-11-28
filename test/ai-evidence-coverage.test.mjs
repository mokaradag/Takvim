/**
 * Bilgin ICE-2 — kanıt kartı kapsamı: sahibinin soru kümesi üzerinde belirlenimci uçtan uca muhasebe (model çağrısı yok).
 *
 * Kıyas kümelerinin (yönetim analizi, yönetici zekâsı, dönemsel/tarihsel zekâ ve saldırgan dönem soruları) altın planları
 * ÜRETİMDEKİ asistan hizmetinden (yetki, araçlar, canlı nüfus kaydı, sunucu düzeni, son yetki doğrulaması, teslim) sentetik
 * veriyle geçer. Teslim edilen yanıtın her kalın iddiası uygulamadan bağımsız kurallarla sınıflanır (bkz.
 * test/helpers/evidenceCoverage.mjs). Kabul ölçütleri:
 *   - yanlış bağlı iddia: 0 (sayı/yüzde/ad kartla aynı; "gecikmiş/tamamlanan/açık" nitelemesi kart satırlarıyla çelişmez),
 *   - beklenmedik bağsız görev sayısı: 0 (her bağsız görev sayısının gerekçesi vardır),
 *   - her tanımlayıcı istemcinin katı doğrulamasından geçer ve her bağ teslim edilen metnin aynı kalın düğümündedir.
 * Rapor için: EVIDENCE_COVERAGE_OUT=rapor.json node --test test/ai-evidence-coverage.test.mjs (rapor içerik özeti taşır;
 * yalnızca sentetik veridir, depoya eklenmez).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { phase4eConversation } from './helpers/phase4eScenario.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from './helpers/analysisBenchmarkSeed.mjs';
import { executiveBenchmarkSeed, EXEC_PROFILES } from './helpers/executiveBenchmarkSeed.mjs';
import { temporalBenchmarkSeed, TEMPORAL_PROFILES } from './helpers/temporalBenchmarkSeed.mjs';
import { NOW } from './helpers/aiToolFixtures.mjs';
import { accountAnswer } from './helpers/evidenceCoverage.mjs';

const { normalizeEvidenceCards, hasBindingMarks } = await import('../src/domain/ai/evidenceCards.js');
const { strongTexts } = await import('../src/features/ai/assistant/evidenceCardAnchors.js');

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const analysis = load('bilgin-analysis-benchmark.json');
const executive = load('bilgin-executive-benchmark.json');
const temporal = load('bilgin-temporal-benchmark.json');
const resolver = (today) => (plan) => JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${new Date(Date.parse(`${today}T00:00:00Z`) + Number(offset) * 86400000).toISOString().slice(0, 10)}"`));

const SCENARIOS = [
  ...analysis.original.filter((item) => item.plan).map((item) => ({ set: 'analiz', item, seed: () => analysisBenchmarkSeed(), sicil: BENCH_PROFILES[item.profile], resolve: resolver('2026-09-30') })),
  ...executive.scenarios.filter((item) => item.plan).map((item) => ({ set: 'yönetici', item, seed: () => executiveBenchmarkSeed(), sicil: EXEC_PROFILES[item.profile], resolve: resolver(executive.today) })),
  ...[...temporal.targeted, ...temporal.adversarial].filter((item) => item.plan).map((item) => ({ set: 'dönemsel', item, seed: () => temporalBenchmarkSeed(temporal.today), sicil: TEMPORAL_PROFILES[item.profile], resolve: resolver(temporal.today) }))
];

const report = [];

for (const scenario of SCENARIOS) {
  const { item } = scenario;
  test(`kanıt kapsamı ${scenario.set}:${item.id} — her görev sayısı doğru bağlı ya da gerekçeli bağsız, yanlış bağ yok`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = scenario.seed();
    t.mock.timers.reset();
    const names = new Set([...seed.people.map((person) => person.DisplayName), ...seed.projects.map((project) => project.ProjectName)].filter(Boolean));
    const { ask } = phase4eConversation(t, { sicil: scenario.sicil, seed });
    const detail = item.detail || item.expect?.detail || null;
    const result = await ask({ text: item.text, plan: scenario.resolve(item.plan) }, { ...(detail ? { detail } : {}), includeText: item.includeText === true });
    const content = String(result.answer.content || '');
    assert.equal(hasBindingMarks(content), false, 'teslim edilen metin işaret taşımaz');
    const cards = result.done.evidenceCards ? normalizeEvidenceCards(result.done.evidenceCards) : null;
    if (result.done.evidenceCards) assert.ok(cards, 'tanımlayıcı istemcinin katı doğrulamasından geçmeli');
    const strong = strongTexts(content);
    for (const anchor of cards?.anchors || []) assert.equal(strong[anchor.strong], anchor.text, 'bağ aynı kalın düğüme işaret etmeli');
    const claims = accountAnswer({ content, cards, finish: result.answer.finishReason, names });
    report.push({ id: `${scenario.set}:${item.id}`, finish: result.answer.finishReason, cards: cards?.cards.length || 0, ...(process.env.EVIDENCE_COVERAGE_TEXT ? { content } : {}),
      claims: claims.map(({ text, category, bound, card, result: outcome, reason, sentence }) => ({ text, category, bound, ...(card ? { card } : {}), result: outcome, ...(reason ? { reason } : {}), ...(process.env.EVIDENCE_COVERAGE_TEXT ? { sentence } : {}) })) });
    const wrong = claims.filter((claim) => claim.result === 'yanlış-bağlı');
    assert.deepEqual(wrong.map((claim) => `${claim.text}: ${claim.reason} — ${claim.sentence}`), [], 'yanlış bağlı iddia olmamalı');
    const missing = claims.filter((claim) => claim.result === 'beklenmedik-bağsız');
    assert.deepEqual(missing.map((claim) => `${claim.text} — ${claim.sentence}`), [], 'gerekçesiz bağsız görev sayısı olmamalı');
  });
}

test.after(() => {
  const totals = {};
  for (const entry of report) for (const claim of entry.claims) {
    const key = `${claim.category}|${claim.result}`;
    totals[key] = (totals[key] || 0) + 1;
  }
  const reasons = {};
  for (const entry of report) for (const claim of entry.claims.filter((item) => item.reason && item.result === 'gerekçeli-bağsız')) reasons[claim.reason] = (reasons[claim.reason] || 0) + 1;
  if (process.env.EVIDENCE_COVERAGE_OUT) writeFileSync(process.env.EVIDENCE_COVERAGE_OUT, JSON.stringify({ scenarios: report.length, totals, reasons, report }, null, 1));
});
