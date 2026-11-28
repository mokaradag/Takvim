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
import { phase4eConversation, turnViolations } from './helpers/phase4eScenario.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from './helpers/analysisBenchmarkSeed.mjs';
import { executiveBenchmarkSeed, EXEC_PROFILES } from './helpers/executiveBenchmarkSeed.mjs';
import { temporalBenchmarkSeed, TEMPORAL_PROFILES } from './helpers/temporalBenchmarkSeed.mjs';
import { NOW } from './helpers/aiToolFixtures.mjs';
import { businessDate } from '../src/domain/calendar/businessDate.js';
import { uiRunDay } from '../scripts/ui-acceptance/uiSeed.mjs';
import { temporalViolations, temporalPopulationViolations, resolveDays } from './helpers/temporalScenario.mjs';
import { accountAnswer, claimCategory, claimNumber, claimPercent, descriptorProblems, fixtureTaskExpectation, incorrectBinding, selectEvidenceCases } from './helpers/evidenceCoverage.mjs';

const { normalizeEvidenceCards, hasBindingMarks } = await import('../src/domain/ai/evidenceCards.js');
const { strongTexts } = await import('../src/features/ai/assistant/evidenceCardAnchors.js');

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const analysis = load('bilgin-analysis-benchmark.json');
const executive = load('bilgin-executive-benchmark.json');
const temporal = load('bilgin-temporal-benchmark.json');
const analysisToday = process.env.UI_RUN_DAY ? uiRunDay() : businessDate(NOW);
const resolver = (today) => (plan) => JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${new Date(Date.parse(`${today}T00:00:00Z`) + Number(offset) * 86400000).toISOString().slice(0, 10)}"`));

const SCENARIOS = [
  ...analysis.original.filter((item) => item.plan).map((item) => ({ set: 'analiz', item, seed: () => analysisBenchmarkSeed(analysisToday), today: analysisToday, sicil: BENCH_PROFILES[item.profile], resolve: resolver(analysisToday) })),
  ...executive.scenarios.filter((item) => item.plan).map((item) => ({ set: 'yönetici', item, seed: () => executiveBenchmarkSeed(executive.today), today: executive.today, sicil: EXEC_PROFILES[item.profile], resolve: resolver(executive.today) })),
  ...[...temporal.targeted, ...temporal.adversarial].filter((item) => item.plan).map((item) => ({ set: 'dönemsel', item, seed: () => temporalBenchmarkSeed(temporal.today), today: temporal.today, sicil: TEMPORAL_PROFILES[item.profile], resolve: resolveDays }))
];

const report = [];

for (const scenario of SCENARIOS) {
  const { item } = scenario;
  test(`kanıt kapsamı ${scenario.set}:${item.id} — her görev sayısı doğru bağlı ya da gerekçeli bağsız, yanlış bağ yok`, async (t) => {
    const seed = scenario.seed();
    const names = new Set([...seed.people.map((person) => person.DisplayName), ...seed.projects.map((project) => project.ProjectName), ...seed.tasks.map((task) => task.Title)].filter(Boolean));
    const { ask } = phase4eConversation(t, { sicil: scenario.sicil, seed, now: new Date(`${scenario.today}T09:00:00Z`) });
    const detail = item.detail || item.expect?.detail || null;
    const result = await ask({ text: item.text, plan: scenario.resolve(item.plan) }, { ...(detail ? { detail } : {}), includeText: item.includeText === true });
    const content = String(result.answer.content || '');
    assert.equal(hasBindingMarks(content), false, 'teslim edilen metin işaret taşımaz');
    const cards = result.done.evidenceCards ? normalizeEvidenceCards(result.done.evidenceCards) : null;
    if (result.done.evidenceCards) assert.ok(cards, 'tanımlayıcı istemcinin katı doğrulamasından geçmeli');
    const strong = strongTexts(content);
    for (const anchor of cards?.anchors || []) assert.equal(strong[anchor.strong], anchor.text, 'bağ aynı kalın düğüme işaret etmeli');
    const lateMilestone = item.id === 'g45' ? seed.tasks.filter(task => task.IsMilestone && task.Status !== 'done'
      && task.TargetFinish && String(task.TargetFinish).slice(0, 10) < scenario.today
      && seed.projects.some(project => project.ProjectId === task.ProjectId && project.ProjectName === 'Mevzuat Uyum')).map(task => task.TaskId) : null;
    const fromFixture = fixtureTaskExpectation({ evidence: result.evidence, tasks: seed.tasks, today: scenario.today });
    const expectedClaim = claim => lateMilestone && claimNumber(claim.text) === lateMilestone.length
      && claim.before.endsWith('kilometre taşından ') && /^ gecikmiş/u.test(claim.after) ? { kind: 'tasks', taskIds: lateMilestone } : fromFixture(claim);
    const claims = accountAnswer({ content, cards, finish: result.answer.finishReason, names, expectedClaim });
    if (lateMilestone) assert.ok(claims.some(claim => claim.identityVerified), 'gecikmiş kilometre taşı kimlikleri bağımsız olarak doğrulanmalı');
    const expect = item.expect || {};
    const finish = expect.finish || (expect.finishNot === 'stop' ? null : 'stop');
    const problems = descriptorProblems(content, result.done.evidenceCards);
    if (finish && result.answer.finishReason !== finish) problems.push(`beklenen bitiş: ${finish}`);
    if (expect.finishNot && result.answer.finishReason === expect.finishNot) problems.push(`yasak bitiş: ${expect.finishNot}`);
    if (!content.trim()) problems.push('yanıt boş');
    if (scenario.set === 'dönemsel') {
      problems.push(...temporalViolations(result, expect, { includeText: item.includeText === true }),
        ...temporalPopulationViolations(result, item.plan.analysis, seed, expect));
    } else {
      problems.push(...turnViolations(result, expect));
    }
    if (result.answer.finishReason === 'stop' && (!result.evidence.length || !/【R\d+】/u.test(content))) problems.push('kanıtlı yanıt yok');
    report.push({ id: `${scenario.set}:${item.id}`, finish: result.answer.finishReason, problems, cards: cards?.cards.length || 0, ...(process.env.EVIDENCE_COVERAGE_TEXT ? { content } : {}),
      claims: claims.map(({ text, category, bound, card, result: outcome, reason, sentence, identityVerified }) => ({ text, category, bound, ...(identityVerified ? { identityVerified } : {}), ...(card ? { card } : {}), result: outcome, ...(reason ? { reason } : {}), ...(process.env.EVIDENCE_COVERAGE_TEXT ? { sentence } : {}) })) });
    assert.deepEqual(problems, [], 'vakanın beklenen sonucu ve kapsamı doğrulanmalı');
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
  if (process.env.EVIDENCE_COVERAGE_OUT) writeFileSync(process.env.EVIDENCE_COVERAGE_OUT, JSON.stringify({ expected: SCENARIOS.length, scenarios: report.length, exactIdentityChecks: report.flatMap(row => row.claims).filter(claim => claim.identityVerified && claim.category === 'taskCount').length, totals, reasons, report }, null, 1));
});

test('görev nüfusu aynı büyüklükteki başka kimlikleri reddeder', () => {
  const claim = { category: 'taskCount', text: '2', before: '', after: ' gecikmiş görev' };
  const card = { kind: 'tasks', total: 2, items: [{ id: 'a', overdue: true }, { id: 'b', overdue: true }] };
  assert.equal(incorrectBinding(claim, card, { kind: 'tasks', taskIds: ['a', 'b'] }), null);
  assert.match(incorrectBinding(claim, card, { kind: 'tasks', taskIds: ['c', 'd'] }), /kimlikleri/);
  assert.match(incorrectBinding(claim, { ...card, items: [{ id: 'a', overdue: false }, card.items[1]] }), /gecikmiş/);
});

test('yüzde ve varlık sınıflandırması Türkçe ve İngilizce binlik ayırıcılarını korur', () => {
  assert.equal(claimPercent('%1.250,5'), 1250.5);
  assert.equal(claimPercent('1,250.5%'), 1250.5);
  assert.equal(claimNumber("1.250'si"), 1250);
  assert.equal(claimNumber('1,250'), 1250);
  assert.equal(claimCategory({ text: '12', before: 'Gecikmiş görevi olan proje sayısı ', after: '.' }), 'entityCount');
});

test('boş ve geçersiz açık nitelendirme seçimleri reddedilir', () => {
  const cases = [{ id: 'ilk' }, { id: 'ikinci' }];
  assert.deepEqual(selectEvidenceCases(cases, undefined), cases);
  assert.deepEqual(selectEvidenceCases(cases, 'ikinci'), [cases[1]]);
  for (const input of ['', ' , ', 'ilk,yanlış']) assert.throws(() => selectEvidenceCases(cases, input), /Geçersiz kanıt/);
});

test('hesap sonucu doğru yazılsa bile çelişkili işlenenler reddedilir', () => {
  const claim = { category: 'percent', text: '%30', before: '', after: '' };
  const card = (denominator) => ({ kind: 'calc', result: '%30',
    metrics: [{ value: '12' }, { value: String(denominator) }], formula: `12 / ${denominator} × 100 = %30` });
  assert.equal(incorrectBinding(claim, card(40)), null);
  assert.match(incorrectBinding(claim, card(50)), /işlenenlerden/);
  assert.match(incorrectBinding(claim, card(0)), /formülü/);
  assert.match(incorrectBinding(claim, { ...card(40), formula: '12 / 40 × 100 = %35' }), /formüldeki/);
});
