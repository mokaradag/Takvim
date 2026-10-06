/**
 * Rota AI · araç kapsam sınırı.
 *
 * Arama metni ilk turda da yalnızca kullanıcının iletisinden gelir; takip
 * çağrıları normalize bağımsız değişkenlerle karşılaştırılır (harf, aksan,
 * noktalama, kimlik biçimi ve varsayılan değerler), meşru daraltma ve
 * sayfalama serbest, ilgisiz genişleme kapalıdır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { AYSE, NOW, PROJECTS, TASKS, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { declared } from './helpers/evidenceScenario.mjs';

const { createToolScope, containmentText } = await import('../src/server/ai/tools/toolScope.js');
const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');

const ok = (data = {}) => ({ content: JSON.stringify({ ok: true, data }) });
const established = (scope, name, args, data) => scope.establish([{ name, arguments: JSON.stringify(args) }], [ok(data)]);
const results = (input) => input.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));

test('containment text ignores case, diacritics, dotless i and punctuation', () => {
  assert.equal(containmentText('Ayşe YILMAZ’ın'), containmentText('ayse yilmaz in'));
  assert.equal(containmentText('Radar-Modernizasyonu'), 'radar modernizasyonu');
  assert.equal(containmentText('  İŞ  YÜKÜ '), 'is yuku');
});

test('the first round may search only text from the current user message', () => {
  const scope = createToolScope({ today: '2026-09-30', userText: 'Ayşe Yılmaz’ın Radar-Modernizasyonu görevleri' });
  for (const text of ['Ayşe Yılmaz', 'ayse yilmaz', 'Radar Modernizasyonu', 'RADAR']) {
    assert.doesNotThrow(() => scope.validate('rota_person_search', { text }), text);
  }
  for (const [name, args] of [['rota_project_search', { text: 'Gizli Proje' }], ['rota_task_search', { text: 'maaş' }], ['rota_person_search', { text: 'Mehmet' }]]) {
    assert.throws(() => scope.validate(name, args), { code: 'UNSUPPORTED_SCOPE' }, JSON.stringify(args));
  }
  assert.doesNotThrow(() => scope.validate('rota_task_analytics', { deadline: 'overdue' }), 'searches without text are unaffected');
});

test('an invented first-round search is refused end to end and the model must stay within the question', async (t) => {
  createAiStack(t, { sicil: AYSE, seed: rotaToolSeed() });
  const steps = [
    { text: declared({ operation: 'value', metrics: ['tasks.total'], filters: { text: 'radar test planı' } }),
      toolCalls: [{ id: 'a', name: 'rota_task_search', arguments: '{"text":"Gizli görev"}' }] },
    (input) => {
      assert.equal(results(input)[0].error.code, 'UNSUPPORTED_SCOPE');
      return { text: '', toolCalls: [{ id: 'b', name: 'rota_task_search', arguments: '{"text":"radar test planı"}' }] };
    }
  ];
  const result = await runGroundedTurn({ signal: new AbortController().signal, round: async (input) => {
    const step = steps.shift();
    return typeof step === 'function' ? step(input) : step;
  } }, { messages: buildGroundedContext({ userContent: 'Radar test planı görevi nerede?', now: NOW }).messages,
    catalog: toolCatalogForModel(), context: createToolTurnContext({ sicil: AYSE, now: NOW }), onText: async () => {} });
  assert.equal(result.outcome, 'grounded');
  assert.equal(steps.length, 0);
});

test('same-tool follow-ups compare normalized arguments: casing, ids and defaults do not count as widening', () => {
  const scope = createToolScope({ today: '2026-09-30', userText: 'radar görevleri' });
  established(scope, 'rota_task_search', { projectId: PROJECTS.FULL.toUpperCase(), text: 'Radar', status: ['todo', 'in_progress'] }, { tasks: [] });
  assert.doesNotThrow(() => scope.validate('rota_task_search', { projectId: PROJECTS.FULL, text: 'RADAR', status: ['in_progress', 'todo'], limit: 5 }));
  assert.doesNotThrow(() => scope.validate('rota_task_search', { projectId: PROJECTS.FULL, text: 'radar', status: ['todo'], sort: 'priority' }));
  assert.throws(() => scope.validate('rota_task_search', { projectId: PROJECTS.FULL, text: 'radar', status: ['todo', 'done'] }), { code: 'UNSUPPORTED_SCOPE' });
  assert.throws(() => scope.validate('rota_task_search', { projectId: PROJECTS.READ, text: 'radar' }), { code: 'UNSUPPORTED_SCOPE' });
  const wbs = createToolScope({ today: '2026-09-30' });
  established(wbs, 'rota_project_detail', { projectId: PROJECTS.FULL }, { project: { projectId: PROJECTS.FULL } });
  established(wbs, 'rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 2 }, { nodes: [] });
  assert.doesNotThrow(() => wbs.validate('rota_wbs_inspect', { projectId: PROJECTS.FULL, depth: 4, limit: 10 }), 'display depth is presentation, not population');
  const portfolio = createToolScope({ today: '2026-09-30' });
  established(portfolio, 'rota_portfolio_summary', { source: 'all', includeEmpty: true }, { totals: {} });
  assert.doesNotThrow(() => portfolio.validate('rota_portfolio_summary', {}));
});

test('a user-typed narrower search may replace the root text, but data-derived text may not', () => {
  const scope = createToolScope({ today: '2026-09-30', userText: 'Ali Veli’nin iş yükü' });
  established(scope, 'rota_person_search', { text: 'Ali' }, { people: [], resolution: 'none' });
  assert.doesNotThrow(() => scope.validate('rota_person_search', { text: 'Ali Veli' }));
  assert.throws(() => scope.validate('rota_person_search', { text: 'Uzman' }), { code: 'UNSUPPORTED_SCOPE' });
});

test('legitimate drill-downs are open while unrelated expansion stays closed', () => {
  const scope = createToolScope({ today: '2026-09-30', userText: 'Radar test planı' });
  established(scope, 'rota_task_search', { text: 'Radar test planı' }, { titleResolution: 'unique', resolvedTask: { taskId: TASKS.OVERDUE },
    tasks: [{ taskId: TASKS.OVERDUE, project: { projectId: PROJECTS.FULL } }] });
  for (const [name, args] of [['rota_task_detail', { taskId: TASKS.OVERDUE }], ['rota_outlook_status', { taskId: TASKS.OVERDUE }],
    ['rota_dependency_inspect', { taskId: TASKS.OVERDUE }], ['rota_activity_search', { taskId: TASKS.OVERDUE }]]) {
    assert.doesNotThrow(() => scope.validate(name, args), name);
  }
  for (const [name, args] of [['rota_task_detail', { taskId: TASKS.DUE_SOON }], ['rota_project_detail', { projectId: PROJECTS.FULL }],
    ['rota_outlook_status', {}], ['rota_portfolio_summary', {}], ['rota_task_analytics', { projectId: PROJECTS.HIDDEN }]]) {
    assert.throws(() => scope.validate(name, args), { code: 'UNSUPPORTED_SCOPE' }, name);
  }
});

test('a project the portfolio itself returned is a trusted identity for the next detail call', () => {
  const scope = createToolScope({ today: '2026-09-30', userText: 'Hangi projede en çok gecikme var, ayrıntısını göster' });
  established(scope, 'rota_portfolio_summary', {}, { projects: [{ projectId: PROJECTS.FULL, tasks: { overdue: 3 } }, { projectId: PROJECTS.READ, tasks: { overdue: 1 } }] });
  for (const [name, args] of [['rota_project_detail', { projectId: PROJECTS.FULL }], ['rota_task_analytics', { projectId: PROJECTS.READ }]]) {
    assert.doesNotThrow(() => scope.validate(name, args), name);
  }
  // Portföyde dönmeyen proje kimliği hâlâ kullanıcının yazdığı kimlik olmalıdır.
  assert.throws(() => scope.validate('rota_project_detail', { projectId: PROJECTS.HIDDEN }), { code: 'UNSUPPORTED_SCOPE' });
});
