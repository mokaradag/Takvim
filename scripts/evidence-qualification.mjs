/**
 * Bilgin ICE-2 — canlı kanıt kartı nitelendirmesi (geliştirme aracı; `npm test` bu dosyayı çalıştırmaz).
 *
 *   PLANNER_CLAUDE_MODEL=claude-haiku-5-5 PLANNER_CLAUDE_EFFORT=low PLANNER_CLAUDE_THINKING=allow \
 *   PLANNER_CLAUDE_LOG=cagri.jsonl PLANNER_CLAUDE_MAX_CALLS=60 PLANNER_CLAUDE_MAX_UNCACHED=250000 \
 *   EVIDENCE_QUALIFICATION_OUT=rapor.json EVIDENCE_QUALIFICATION_RECORD=kayit.json node --test scripts/evidence-qualification.mjs
 *
 * Planlayıcı ve yanıt düzeni modeldir (uçtan uca, sentetik veri ve vakanın profili). Her canlı yanıtın kanıt kartı kapsamı
 * belirlenimci sınamayla aynı kurallarla ölçülür (test/helpers/evidenceCoverage.mjs): yanlış bağ ve gerekçesiz bağsız görev
 * sayısı sıfır olmalıdır. Model çağrısı, belirteç ve düşünme bağdaştırıcının kaydından (PLANNER_CLAUDE_LOG) okunur. Derin
 * modele devir modele gitmez ve başarısızlık sayılır. EVIDENCE_QUALIFICATION_CASES=id,… alt küme seçer. Kayıt dosyası canlı
 * yanıtları (yalnızca sentetik veri) görsel kabul ve gerileme için yeniden oynatmaya saklar; depoya eklenmez.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { captureConsole } from '../test/helpers/aiStack.mjs';
import { NOW } from '../test/helpers/aiToolFixtures.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from '../test/helpers/analysisBenchmarkSeed.mjs';
import { executiveBenchmarkSeed, EXEC_PROFILES } from '../test/helpers/executiveBenchmarkSeed.mjs';
import { temporalBenchmarkSeed, TEMPORAL_PROFILES } from '../test/helpers/temporalBenchmarkSeed.mjs';
import { accountAnswer } from '../test/helpers/evidenceCoverage.mjs';
import { phase4eConversation } from '../test/helpers/phase4eScenario.mjs';
import { qualificationProvider } from './answer-composition-qualification.mjs';

const { normalizeEvidenceCards } = await import('../src/domain/ai/evidenceCards.js');

const load = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
const analysis = load('bilgin-analysis-benchmark.json');
const executive = load('bilgin-executive-benchmark.json');
const temporal = load('bilgin-temporal-benchmark.json');

const SEEDS = Object.freeze({
  analysis: { seed: () => analysisBenchmarkSeed(), profiles: BENCH_PROFILES },
  executive: { seed: () => executiveBenchmarkSeed(), profiles: EXEC_PROFILES },
  temporal: { seed: () => temporalBenchmarkSeed(temporal.today), profiles: TEMPORAL_PROFILES }
});

/**
 * Katmanlı, risk odaklı seçim (16 soru): karmaşık çok bölümlü analiz, kişi ve proje kanıtı, oran, dönem karşılaştırması,
 * eğilim, teslim ufku, kilometre taşı, İngilizce yanıt ve iki basit temel soru. Basit sorular sahibinin kümesinde yoktur; kısa
 * ve açık oldukları için burada tanımlanır (sentetik veri, B profili).
 */
const pick = (list, id) => list.find((item) => item.id === id);
export const LIVE_CASES = Object.freeze([
  ...['o01', 'o02', 'o11', 'o19'].map((id) => ({ id, data: 'analysis', ...pick(analysis.original, id) })),
  ...['g01', 'g09', 'g31', 'g45'].map((id) => ({ id, data: 'executive', ...pick(executive.scenarios, id) })),
  ...['t12', 't13', 't14', 't24', 't36', 't53'].map((id) => ({ id, data: 'temporal', ...pick(temporal.targeted, id) })),
  { id: 's01', data: 'executive', profile: 'B', text: 'Kaç gecikmiş görevim var?' },
  { id: 's02', data: 'executive', profile: 'B', text: 'Ekibimde kaç tamamlanmış görev var?' }
]);

const ONLY = (process.env.EVIDENCE_QUALIFICATION_CASES || '').split(',').map((item) => item.trim()).filter(Boolean);
const summary = { model: process.env.PLANNER_CLAUDE_MODEL || null, effort: process.env.PLANNER_CLAUDE_EFFORT || null, cases: 0, rounds: 0, escalations: 0, results: [] };
const recorded = [];

for (const item of LIVE_CASES.filter((entry) => !ONLY.length || ONLY.includes(entry.id))) {
  test(`canlı kanıt kapsamı ${item.id}: ${item.text.slice(0, 70)}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const seed = SEEDS[item.data].seed();
    t.mock.timers.reset();
    const names = new Set([...seed.people.map((person) => person.DisplayName), ...seed.projects.map((project) => project.ProjectName)].filter(Boolean));
    const rounds = [];
    const routing = { planner: true, dry: false, escalations: 0 };
    const provider = qualificationProvider(rounds, { provider: 'claude', routing, expectedModel: summary.model });
    captureConsole(t);
    const { ask } = phase4eConversation(t, { sicil: SEEDS[item.data].profiles[item.profile], seed, provider });
    const result = await ask({ text: item.text }, { ...(item.detail ? { detail: item.detail } : {}), includeText: item.includeText === true });
    const content = String(result.answer.content || '');
    const cards = result.done.evidenceCards ? normalizeEvidenceCards(result.done.evidenceCards) : null;
    const claims = accountAnswer({ content, cards, finish: result.answer.finishReason, names });
    const count = (outcome, category = null) => claims.filter((claim) => claim.result === outcome && (!category || claim.category === category)).length;
    const entry = { id: item.id, finish: result.answer.finishReason, rounds: rounds.map((round) => ({ purpose: round.purpose, finish: round.finish ?? null, thinking: round.usage?.thinking ?? null,
      infrastructure: round.infrastructure || null })), escalations: routing.escalations, cards: cards?.cards.length || 0, anchors: cards?.anchors.length || 0,
      taskCounts: { bound: count('doğru-bağlı', 'taskCount'), justified: count('gerekçeli-bağsız', 'taskCount'), missing: count('beklenmedik-bağsız', 'taskCount') },
      wrong: claims.filter((claim) => claim.result === 'yanlış-bağlı').map((claim) => ({ text: claim.text, reason: claim.reason })),
      missing: claims.filter((claim) => claim.result === 'beklenmedik-bağsız').map((claim) => ({ text: claim.text, sentence: claim.sentence })),
      reasons: claims.filter((claim) => claim.reason && claim.result === 'gerekçeli-bağsız').map((claim) => claim.reason),
      categories: Object.fromEntries(['taskCount', 'entityCount', 'percent', 'name'].map((category) => [category, { bound: claims.filter((claim) => claim.category === category && claim.bound).length,
        total: claims.filter((claim) => claim.category === category).length }])) };
    summary.cases += 1;
    summary.rounds += rounds.length;
    summary.escalations += routing.escalations;
    summary.results.push(entry);
    // Yeniden oynatma kaydı: soru, profil, canlı yanıt ve kart tanımlayıcısı (sentetik veri).
    recorded.push({ id: item.id, data: item.data, profile: item.profile, text: item.text, content, finish: result.answer.finishReason, evidenceCards: result.done.evidenceCards || null });
    assert.equal(rounds.some((round) => round.infrastructure), false, `altyapı: ${JSON.stringify(entry.rounds)}`);
    assert.equal(routing.escalations, 0, 'Derin modele devir nitelendirmeye girmez');
    assert.deepEqual(entry.wrong, [], 'yanlış bağlı iddia olmamalı');
    assert.deepEqual(entry.missing, [], 'gerekçesiz bağsız görev sayısı olmamalı');
  });
}

test.after(() => {
  if (process.env.EVIDENCE_QUALIFICATION_OUT) writeFileSync(process.env.EVIDENCE_QUALIFICATION_OUT, JSON.stringify(summary, null, 1));
  if (process.env.EVIDENCE_QUALIFICATION_RECORD) writeFileSync(process.env.EVIDENCE_QUALIFICATION_RECORD, JSON.stringify(recorded, null, 1));
});
