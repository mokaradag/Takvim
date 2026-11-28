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
import { businessDate } from '../src/domain/calendar/businessDate.js';
import { uiRunDay } from './ui-acceptance/uiSeed.mjs';
import { NOW } from '../test/helpers/aiToolFixtures.mjs';
import { analysisBenchmarkSeed, BENCH_PROFILES } from '../test/helpers/analysisBenchmarkSeed.mjs';
import { executiveBenchmarkSeed, EXEC_PROFILES } from '../test/helpers/executiveBenchmarkSeed.mjs';
import { temporalBenchmarkSeed, TEMPORAL_PROFILES } from '../test/helpers/temporalBenchmarkSeed.mjs';
import { accountAnswer, claimNumber, descriptorProblems, fixtureTaskExpectation, selectEvidenceCases } from '../test/helpers/evidenceCoverage.mjs';
import { temporalViolations, temporalPopulationViolations } from '../test/helpers/temporalScenario.mjs';
import { phase4eConversation, turnViolations } from '../test/helpers/phase4eScenario.mjs';
import { qualificationProvider } from './answer-composition-qualification.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
const analysis = load('bilgin-analysis-benchmark.json');
const executive = load('bilgin-executive-benchmark.json');
const temporal = load('bilgin-temporal-benchmark.json');

const SEEDS = Object.freeze({
  analysis: { seed: analysisBenchmarkSeed, profiles: BENCH_PROFILES },
  executive: { seed: executiveBenchmarkSeed, profiles: EXEC_PROFILES },
  temporal: { seed: temporalBenchmarkSeed, profiles: TEMPORAL_PROFILES }
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
  { id: 's01', data: 'executive', profile: 'B', direct: 'own-overdue', text: 'Kaç gecikmiş görevim var?' },
  { id: 's02', data: 'executive', profile: 'B', direct: 'team-done', text: 'Ekibimde kaç tamamlanmış görev var?' }
]);

const selected = selectEvidenceCases(LIVE_CASES, process.env.EVIDENCE_QUALIFICATION_CASES);
const summary = { model: process.env.PLANNER_CLAUDE_MODEL || null, effort: process.env.PLANNER_CLAUDE_EFFORT || null,
  thinkingAllowed: process.env.PLANNER_CLAUDE_THINKING === 'allow',
  expected: selected.length, attempted: 0, passed: 0, failed: 0, skipped: 0, rounds: 0, escalations: 0,
  results: selected.map(item => ({ id: item.id, status: 'koşulmadı' })) };
const recorded = [];

/** Basit sorularda beklenen üyelik, araç çıktısına başvurmadan sentetik veri üzerinden kurulur. */
function directPopulation(item, seed, sicil, today) {
  if (!item.direct) return null;
  const people = new Set(item.direct === 'own-overdue' ? [sicil] : seed.executiveScope
    .filter(row => row.ManagerSicil === sicil && row.EmployeeSicil !== sicil).map(row => row.EmployeeSicil));
  const assigned = new Set(seed.taskAssignees.filter(row => people.has(row.Sicil)).map(row => row.TaskId));
  return seed.tasks.filter(task => assigned.has(task.TaskId) && (item.direct === 'own-overdue'
    ? task.Status !== 'done' && task.TargetFinish && String(task.TargetFinish).slice(0, 10) < today
    : task.Status === 'done')).map(task => task.TaskId);
}

for (const [index, item] of selected.entries()) {
  test(`canlı kanıt kapsamı ${item.id}: ${item.text.slice(0, 70)}`, async (t) => {
    const entry = summary.results[index];
    entry.status = 'denendi';
    summary.attempted += 1;
    const rounds = [];
    const routing = { planner: true, dry: false, escalations: 0 };
    try {
      const today = item.data === 'temporal' ? temporal.today : item.data === 'executive' ? executive.today : process.env.UI_RUN_DAY ? uiRunDay() : businessDate(NOW);
      const seed = SEEDS[item.data].seed(today);
      const sicil = SEEDS[item.data].profiles[item.profile];
      const names = new Set([...seed.people.map(person => person.DisplayName), ...seed.projects.map(project => project.ProjectName), ...seed.tasks.map(task => task.Title)].filter(Boolean));
      const expectedIds = directPopulation(item, seed, sicil, today);
      const provider = qualificationProvider(rounds, { provider: 'claude', routing, expectedModel: summary.model });
      const consoleLines = captureConsole(t);
      const { ask } = phase4eConversation(t, { sicil, seed, provider, now: new Date(`${today}T09:00:00Z`) });
      const result = await ask({ text: item.text }, { ...(item.detail ? { detail: item.detail } : {}), includeText: item.includeText === true });
      const content = String(result.answer.content || '');
      const finish = result.answer.finishReason;
      const cards = result.done.evidenceCards || null;
      const expected = item.expect || {};
      const analysisPlan = item.plan?.analysis;
      const problems = descriptorProblems(content, cards);
      if (item.data === 'temporal') problems.push(...temporalViolations(result, expected, { includeText: item.includeText === true }),
        ...temporalPopulationViolations(result, analysisPlan, seed, expected));
      else {
        const layers = analysisPlan && [analysisPlan, ...(analysisPlan.also || [])].flatMap(layer => {
          const focus = layer.focus || analysisPlan.focus || [];
          if (!['person', 'project'].includes(layer.scope)) return [{ scope: layer.scope, level: layer.level, focus }];
          return (layer.names || []).map(name => {
            const sicil = layer.scope === 'person' ? seed.people.find(person => person.DisplayName === name)?.Sicil : null;
            const projectId = layer.scope === 'project' ? seed.projects.find(project => project.ProjectName === name)?.ProjectId : null;
            if (!sicil && !projectId) problems.push('beklenen kişi veya proje kimliği bulunamadı');
            return { scope: layer.scope, names: [name], ...(sicil ? { sicil } : { projectId }), focus };
          });
        });
        problems.push(...turnViolations(result, { ...(layers?.length && finish === 'stop' ? { layers } : {}), ...expected }, { live: true }));
      }
      if (item.direct && finish === 'stop') {
        const wanted = item.direct === 'own-overdue' ? 'me' : 'team';
        const reads = result.evidence.filter(row => ['rota_task_analytics', 'rota_task_search'].includes(row.tool));
        if (!reads.length || reads.some(row => row.data?.filters?.assignee !== wanted
          || row.data.filters.projectId || row.data.filters.personSicil || row.data.filters.dateFrom || row.data.filters.dateTo)) {
          problems.push('doğrudan sorunun sorumlu kapsamı tutulmadı');
        }
      }
      const directClaim = claim => expectedIds && claim.category === 'taskCount'
        && (item.direct === 'own-overdue' ? /gecikmiş/i : /tamamlanmış|tamamlandı/i).test(`${claim.before}${claim.after}`);
      const fromFixture = fixtureTaskExpectation({ evidence: result.evidence, tasks: seed.tasks, today });
      const claims = accountAnswer({ content, cards, finish, names,
        expectedClaim: claim => directClaim(claim) && expectedIds.length ? { kind: 'tasks', taskIds: expectedIds } : fromFixture(claim) });
      if (expectedIds && !claims.some(claim => directClaim(claim) && claimNumber(claim.text) === expectedIds.length
        && (expectedIds.length === 0 ? !claim.bound : claim.bound))) problems.push('istenen görev sayısı ve üyeliği doğrulanmadı');
      if (finish === 'stop' && (!content.trim() || !result.evidence.length || !/【R\d+】/u.test(content))) problems.push('kanıtlı yanıt yok');
      if (finish === 'stop' && !claims.some(claim => ['taskCount', 'entityCount', 'percent'].includes(claim.category))) problems.push('beklenen sayısal iddia eksik');
      const trace = consoleLines.map(line => { try { return JSON.parse(line); } catch { return null; } })
        .findLast(row => row?.code === 'AI_GROUNDED_TURN')?.context;
      const composed = trace?.presentation?.mode === 'composed';
      const presentation = finish !== 'stop' ? 'başarısız veya kapsam dışı' : composed && !trace.presentation.server
        ? 'model düzeni kabul edildi' : 'sunucu anlatımı';
      Object.assign(entry, { finish, presentation, compositionRejected: Boolean(trace?.presentation?.rejected?.length
        || trace?.presentation?.reason === 'MODEL_LAYOUT_REPLACED' || rounds.some(round => round.purpose === 'compose' && round.infrastructure)),
      cards: cards?.cards.length || 0, anchors: cards?.anchors.length || 0, problems,
      taskCounts: { identityVerified: claims.filter(claim => claim.category === 'taskCount' && claim.identityVerified).length, bound: claims.filter(claim => claim.category === 'taskCount' && ['doğru-bağlı', 'biçim-doğrulandı'].includes(claim.result)).length,
        shapeOnly: claims.filter(claim => claim.category === 'taskCount' && claim.result === 'biçim-doğrulandı').length,
        justified: claims.filter(claim => claim.category === 'taskCount' && claim.result === 'gerekçeli-bağsız').length,
        missing: claims.filter(claim => claim.category === 'taskCount' && claim.result === 'beklenmedik-bağsız').length },
      wrong: claims.filter(claim => claim.result === 'yanlış-bağlı').map(({ text, reason }) => ({ text, reason })),
      missing: claims.filter(claim => claim.result === 'beklenmedik-bağsız').map(({ text, sentence }) => ({ text, sentence })) });
      recorded.push({ id: item.id, data: item.data, profile: item.profile, text: item.text, content, finish, evidenceCards: cards });
      assert.equal(rounds.some(round => round.infrastructure && round.purpose !== 'compose'), false, 'planlayıcı altyapı hatası');
      assert.equal(routing.escalations, 0, 'derin modele devir nitelendirmeye girmez');
      assert.equal(finish, expected.finish || 'stop', 'vaka beklenen biçimde tamamlanmalı');
      assert.deepEqual(entry.problems, [], 'sorunun kapsamı ve beklenen ölçüler doğrulanmalı');
      assert.deepEqual(entry.wrong, [], 'yanlış bağlı iddia olmamalı');
      assert.deepEqual(entry.missing, [], 'gerekçesiz bağsız görev sayısı olmamalı');
      entry.status = 'geçti';
    } catch (error) {
      entry.status = 'kaldı';
      entry.error = error.code || error.name;
      throw error;
    } finally {
      entry.rounds = rounds.map(round => ({ purpose: round.purpose, finish: round.finish ?? null, thinking: round.usage?.thinking ?? null,
        infrastructure: round.infrastructure || null }));
      entry.escalations = routing.escalations;
      summary.rounds += rounds.length;
      summary.escalations += routing.escalations;
    }
  });
}

test.after(() => {
  summary.passed = summary.results.filter(row => row.status === 'geçti').length;
  summary.skipped = summary.results.filter(row => row.status === 'koşulmadı').length;
  summary.failed = summary.expected - summary.passed - summary.skipped;
  summary.presentation = {};
  for (const row of summary.results) {
    const key = row.presentation || 'tamamlanmadı';
    const group = summary.presentation[key] ||= { cases: 0, bound: 0, shapeOnly: 0, missing: 0, wrong: 0 };
    group.cases += 1;
    group.bound += row.taskCounts?.bound || 0;
    group.shapeOnly += row.taskCounts?.shapeOnly || 0;
    group.missing += row.taskCounts?.missing || 0;
    group.wrong += row.wrong?.length || 0;
  }
  if (process.env.EVIDENCE_QUALIFICATION_OUT) writeFileSync(process.env.EVIDENCE_QUALIFICATION_OUT, JSON.stringify(summary, null, 1));
  if (process.env.EVIDENCE_QUALIFICATION_RECORD) writeFileSync(process.env.EVIDENCE_QUALIFICATION_RECORD, JSON.stringify(recorded, null, 1));
  assert.equal(summary.attempted, summary.expected, 'seçilen vakaların tamamı çalışmalı');
  assert.equal(summary.passed, summary.expected, 'seçilen vakaların tamamı geçmeli');
});
