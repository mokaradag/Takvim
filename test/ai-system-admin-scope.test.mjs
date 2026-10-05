/**
 * Rota AI · sistem yöneticisi kapsamı.
 *
 * Yöneticinin erişimi proje başına kanoniktir: her etkin proje FULL kayıttır,
 * açık proje kapılarından geçer ve yetki dönemine girer. Etkin olmayan ya da
 * var olmayan proje, yetkisiz projeyle aynı yanıtı alır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiStack } from './helpers/aiStack.mjs';
import { ADMIN, AYSE, NOW, PROJECTS, TASKS, WBS, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';
import { claimFor, declared, evidenceReply } from './helpers/evidenceScenario.mjs';

const { ACCESS_REASONS, deriveEffectiveAccess } = await import('../src/server/authorization/authorization.js');
const { buildRotaScope, projectAccess } = await import('../src/server/ai/tools/rota/rotaScope.js');
const { authorizationFingerprint } = await import('../src/server/ai/tools/evidenceAuthorization.js');
const { runGroundedTurn } = await import('../src/server/ai/assistant/groundedAnswer.js');
const { buildGroundedContext } = await import('../src/server/ai/assistant/groundedPrompt.js');
const { createToolTurnContext } = await import('../src/server/ai/tools/toolContext.js');
const { toolCatalogForModel } = await import('../src/server/ai/tools/toolRegistry.js');

const stackFor = (t, sicil = ADMIN) => createAiStack(t, { sicil, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed() });
const ACTIVE = [PROJECTS.FULL, PROJECTS.READ, PROJECTS.PARTIAL, PROJECTS.HIDDEN, PROJECTS.TEAM];

test('system administrator authorization uses a predicate without per-project access entries', () => {
  const effective = deriveEffectiveAccess({ isSystemAdmin: true, fullProjectIds: ACTIVE.map((id) => id.toUpperCase()) });
  assert.equal(effective.access.size, 0);
  assert.deepEqual([...effective.fullProjectIds].sort(), [...ACTIVE].sort());
  assert.equal(effective.partialTaskIds.size, 0);
  // Proje başına kayıt olmadan da her etkin proje FULL ve sistem yöneticisi nedeniyle açıklanır.
  const scope = buildRotaScope({ sicil: ADMIN, isSystemAdmin: true, effective });
  for (const projectId of ACTIVE) {
    const access = projectAccess(scope, projectId);
    assert.equal(access.accessLevel, 'FULL');
    assert.deepEqual(access.reasons, [ACCESS_REASONS.SYSTEM_ADMIN]);
  }
});

test('administrator scope does not copy a large project enumeration into its access map', () => {
  const auth = { sicil: ADMIN, isSystemAdmin: true, effective: { access: new Map(), fullProjectIds: new Set(ACTIVE), partialTaskIds: new Set() } };
  const scope = buildRotaScope(auth);
  assert.equal(scope.projects.size, 0);
  assert.equal(scope.projectTokens, '');
  assert.equal(scope.scopedTaskIds, '');
});

const PROJECT_GATED_CALLS = [
  ['rota_task_search', { projectId: PROJECTS.HIDDEN }],
  ['rota_task_analytics', { projectId: PROJECTS.PARTIAL }],
  ['rota_project_detail', { projectId: PROJECTS.HIDDEN }],
  ['rota_wbs_inspect', { projectId: PROJECTS.TEAM, wbsId: WBS.TEAM_BRANCH }],
  ['rota_baseline_compare', { projectId: PROJECTS.FULL }],
  ['rota_dependency_inspect', { projectId: PROJECTS.READ }],
  ['rota_recurrence_inspect', { projectId: PROJECTS.FULL }],
  ['rota_calendar_inspect', { projectId: PROJECTS.FULL }],
  ['rota_workload_summary', { projectId: PROJECTS.TEAM }],
  ['rota_data_quality', { projectId: PROJECTS.HIDDEN }],
  ['rota_activity_search', { projectId: PROJECTS.HIDDEN, period: 'last_7_days' }]
];

for (const [name, args] of PROJECT_GATED_CALLS) {
  test(`an administrator passes the explicit project gate of ${name}`, async (t) => {
    const stack = stackFor(t);
    const { result } = await callRotaTool(stack, ADMIN, name, args);
    assert.equal(result.ok, true, JSON.stringify(result.error));
  });
}

test('an archived or nonexistent project is indistinguishable from an unauthorized one, also for an administrator', async (t) => {
  const stack = stackFor(t);
  const envelopes = [];
  for (const projectId of [PROJECTS.ARCHIVED, randomUUID()]) {
    for (const name of ['rota_project_detail', 'rota_baseline_compare', 'rota_wbs_inspect']) {
      const { result } = await callRotaTool(stack, ADMIN, name, { projectId });
      assert.equal(result.ok, false, name);
      envelopes.push(JSON.stringify({ ...result, tool: null }));
    }
  }
  const unauthorized = await callRotaTool(stack, AYSE, 'rota_project_detail', { projectId: PROJECTS.HIDDEN });
  assert.equal(new Set([...envelopes, JSON.stringify({ ...unauthorized.result, tool: null })]).size, 1);
});

test('administrator project evidence is dropped when the project is archived before final delivery', async (t) => {
  const stack = stackFor(t);
  const steps = [
    { text: declared({ operation: 'value', metrics: ['project.name'], entities: [{ type: 'project', id: PROJECTS.HIDDEN }] }),
      toolCalls: [{ id: 'call', name: 'rota_project_detail', arguments: JSON.stringify({ projectId: PROJECTS.HIDDEN }) }] },
    (input) => {
      const result = JSON.parse(input.messages.findLast((message) => message.role === 'tool').content);
      stack.db.projects.find((project) => project.ProjectId === PROJECTS.HIDDEN).IsActive = 0;
      return { text: evidenceReply(claimFor(result, 'data.project.name')), toolCalls: [], finishReason: 'stop' };
    },
    { text: '{"kind":"unavailable"}', toolCalls: [], finishReason: 'stop' }
  ];
  const session = { signal: new AbortController().signal, round: async (input) => {
    const step = steps.shift();
    assert.ok(step, 'Beklenmeyen ek model turu');
    return typeof step === 'function' ? step(input) : step;
  } };
  const texts = [];
  const result = await runGroundedTurn(session, { messages: buildGroundedContext({ userContent: `Gizli Proje künyesini göster: ${PROJECTS.HIDDEN}`, now: NOW }).messages,
    catalog: toolCatalogForModel(), context: createToolTurnContext({ sicil: ADMIN, now: NOW }), allowedTextFields: [], onText: async (text) => texts.push(text) });
  assert.notEqual(result.outcome, 'grounded');
  assert.deepEqual(result.evidenceRows, []);
  assert.ok(!texts.join('').includes('Gizli Proje'));
});

test('an administrator sees every active task without per-task grants', async (t) => {
  const stack = stackFor(t);
  const { result } = await callRotaTool(stack, ADMIN, 'rota_task_detail', { taskId: TASKS.TEAM_HIDDEN });
  assert.equal(result.ok, true);
  assert.equal(result.data.task.access.level, 'FULL');
});
