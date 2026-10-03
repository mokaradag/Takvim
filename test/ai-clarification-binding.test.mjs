/**
 * Rota AI · ad çözümü ve açıklama seçimi.
 *
 * Tek kesin eşleşme kimliktir; tek kısmi ya da birden çok eşleşme aday olarak
 * kalır. Açıklamadaki adaylar sunucuda tutulur ve kullanıcının numaralı yanıtı
 * ("2", "ikincisi", "evet") modele bırakılmadan kayıtlı kimliğe bağlanır.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAiStack, sendTurn } from './helpers/aiStack.mjs';
import { ALI_1, ALI_2, AYSE, PROJECTS, TASKS, callRotaTool, rotaToolSeed } from './helpers/aiToolFixtures.mjs';

const { selectedCandidateOrdinal, clarificationReferences } = await import('../src/domain/ai/clarification.js');

const done = (response) => response.events.find((event) => event.event === 'done')?.data;
const deltas = (response) => response.events.filter((event) => event.event === 'delta').map((event) => event.data.text).join('');
const toolResults = (call) => call.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
const SECOND_RADAR_TASK = '20000000-0000-4000-8000-000000000777';

function stackFor(t) {
  const seed = rotaToolSeed();
  seed.tasks.push({ TaskId: SECOND_RADAR_TASK, ProjectId: PROJECTS.FULL, Title: 'Radar test planı ikinci', Status: 'planned', Priority: 'medium', CreatedBySicil: null, TargetFinish: '2026-11-02' });
  return createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed });
}

test('numbered replies select a candidate deterministically; anything else is not a selection', () => {
  const selections = {
    2: 1, '2.': 1, '#2': 1, '2’yi': 1, "2'si": 1, ikincisi: 1, 'İkinci': 1, 'ikinciyi seçiyorum': 1, 'ikinci projenin görevleri': 1,
    ilki: 0, 'ilk aday': 0, birincisi: 0, '1 numaralı aday': 0, 'üçüncüsü': 2, ucuncu: 2, sonuncusu: 2, 'the second one': 1, 'option 3': 2
  };
  for (const [reply, expected] of Object.entries(selections)) assert.equal(selectedCandidateOrdinal(reply, 3), expected, reply);
  for (const reply of ['4', 'dördüncü', '0', '2 görevim var mı?', 'ilk iki', 'ikisi de', '1 ve 2', 'ikinci değil birinci', 'Kalite birimindeki',
    'evet', '', 'x'.repeat(200), 'hepsi']) {
    assert.equal(selectedCandidateOrdinal(reply, 3), null, reply);
  }
  assert.equal(selectedCandidateOrdinal('evet', 1), 0);
  assert.equal(selectedCandidateOrdinal('Evet, o', 1), 0);
  assert.equal(selectedCandidateOrdinal('2', 11), null, 'en fazla on aday');
  assert.deepEqual(clarificationReferences([{ ordinal: 1, personSicil: '910005', name: 'INJECT' }, { ordinal: 1, projectId: PROJECTS.FULL }, { ordinal: 12, taskId: TASKS.OVERDUE }, { ordinal: 0, projectId: 'x' }]),
    [{ ordinal: 1, personSicil: 910005 }]);
});

test('exact identity resolution: Sicil and full name resolve a person, a partial or shared name never does', async (t) => {
  const stack = stackFor(t);
  const bySicil = await callRotaTool(stack, AYSE, 'rota_person_search', { text: String(ALI_2) });
  assert.equal(bySicil.result.data.resolution, 'unique');
  assert.deepEqual(bySicil.result.data.resolvedPerson, { sicil: ALI_2, name: 'Ali Veli' });
  const shared = await callRotaTool(stack, AYSE, 'rota_person_search', { text: 'Ali Veli', limit: 1 });
  assert.equal(shared.result.data.resolution, 'ambiguous');
  assert.equal(shared.result.data.people.length, 1, 'page limit applies to the listed rows');
  assert.deepEqual(shared.result.data.candidates.map((person) => person.sicil).sort(), [ALI_1, ALI_2], 'candidate set is independent of the page limit');
  const partial = await callRotaTool(stack, AYSE, 'rota_person_search', { text: 'Zeynep' });
  assert.equal(partial.result.data.resolution, 'partial');
  assert.equal(partial.result.data.resolvedPerson, undefined);
  const exactProject = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'rdr', limit: 1 });
  assert.equal(exactProject.result.data.resolution, 'unique');
  assert.equal(exactProject.result.data.resolvedProject.projectId, PROJECTS.FULL);
  const fuzzyProject = await callRotaTool(stack, AYSE, 'rota_project_search', { text: 'Proje', limit: 1 });
  assert.equal(fuzzyProject.result.data.resolution, 'ambiguous');
  assert.ok(fuzzyProject.result.data.candidates.length >= 2);
  const fuzzyTask = await callRotaTool(stack, AYSE, 'rota_task_search', { text: 'Radar test', limit: 1 });
  assert.equal(fuzzyTask.result.data.titleResolution, 'ambiguous');
  assert.equal(fuzzyTask.result.data.tasks.length, 1);
  assert.deepEqual(fuzzyTask.result.data.candidates.map((task) => task.taskId).sort(), [TASKS.OVERDUE, SECOND_RADAR_TASK].sort());
  const loneTask = await callRotaTool(stack, AYSE, 'rota_task_search', { text: 'kalibrasyon' });
  assert.equal(loneTask.result.data.titleResolution, 'partial');
  assert.equal(loneTask.result.data.resolvedTask, undefined);
});

async function askAboutAli(stack) {
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_person_search', arguments: { text: 'Ali Veli' } }] },
    { type: 'answer', text: '{"kind":"clarification","evidence":"R1"}' });
  const first = done(await sendTurn({ turnId: randomUUID(), message: 'Ali Veli’nin iş yükünü göster' }));
  assert.equal(first.assistantMessage.finishReason, 'clarification');
  return first;
}

for (const reply of ['2', 'ikincisi']) {
  test(`the reply "${reply}" binds the stored second candidate's Sicil before any identity-dependent tool runs`, async (t) => {
    const stack = stackFor(t);
    const first = await askAboutAli(stack);
    assert.match(first.assistantMessage.content, /^1\. \*\*Ali Veli\*\* — Uzman/m);
    assert.match(first.assistantMessage.content, /^2\. \*\*Ali Veli\*\* — Mühendis/m);
    const stored = JSON.parse(stack.db.aiMessageEvidence.at(-1).EvidenceJson).clarificationContext;
    assert.deepEqual(stored, [{ ordinal: 0, personSicil: ALI_1 }, { ordinal: 1, personSicil: ALI_2 }]);
    stack.provider.enqueue({ type: 'script', respond: (call) => {
      assert.match(call.messages[0].content, new RegExp(`SUNUCU SEÇİMİ: Kullanıcı önceki açıklamadaki 2\\. adayı seçti; sunucu bu seçimi personSicil=${ALI_2}`));
      return { type: 'tool-calls', calls: [{ name: 'rota_workload_summary', arguments: { personSicil: ALI_1 } }, { name: 'rota_workload_summary', arguments: { personSicil: ALI_2 } }] };
    } }, { type: 'script', respond: (call) => {
      const [wrong, bound] = toolResults(call);
      assert.equal(wrong.error.code, 'UNSUPPORTED_SCOPE', 'the other stored candidate is not an identity in this turn');
      assert.equal(bound.ok, true);
      return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${bound.evidenceId}:data.openTaskCount`] }) };
    } });
    const second = done(await sendTurn({ conversationId: first.conversation.id, turnId: randomUUID(), message: reply }));
    assert.equal(second.assistantMessage.finishReason, 'stop');
  });
}

test('a non-numbered reply does not let the model translate a candidate into an identity', async (t) => {
  const stack = stackFor(t);
  const first = await askAboutAli(stack);
  stack.provider.enqueue({ type: 'script', respond: (call) => {
    assert.match(call.messages[0].content, /Kullanıcının yanıtı önceki açıklamadaki adaylardan birini numarasıyla seçmiyor/);
    return { type: 'tool-calls', calls: [{ name: 'rota_workload_summary', arguments: { personSicil: ALI_2 } }] };
  } }, { type: 'script', respond: (call) => {
    assert.equal(toolResults(call)[0].error.code, 'UNSUPPORTED_SCOPE');
    // Önceki sorudaki ad bu turda da güvenilir arama metnidir.
    return { type: 'tool-calls', calls: [{ name: 'rota_person_search', arguments: { text: 'Ali Veli' } }] };
  } }, { type: 'script', respond: (call) => {
    assert.equal(toolResults(call).at(-1).data.resolution, 'ambiguous');
    return { type: 'answer', text: '{"kind":"clarification"}' };
  } });
  const second = done(await sendTurn({ conversationId: first.conversation.id, turnId: randomUUID(), message: 'Tasarım birimindeki' }));
  assert.equal(second.assistantMessage.finishReason, 'clarification');
});

test('a single partial match asks for confirmation and "evet" binds that project', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_project_search', arguments: { text: 'Radar' } }] }, { type: 'script', respond: (call) => {
    assert.equal(toolResults(call)[0].data.resolution, 'partial');
    return { type: 'tool-calls', calls: [{ name: 'rota_project_detail', arguments: { projectId: PROJECTS.FULL } }] };
  } }, { type: 'script', respond: (call) => {
    assert.equal(toolResults(call).at(-1).error.code, 'UNSUPPORTED_SCOPE');
    return { type: 'answer', text: '{"kind":"clarification","evidence":"R1"}' };
  } });
  const first = done(await sendTurn({ turnId: randomUUID(), message: 'Radar projesinin durumu nedir?' }));
  assert.equal(first.assistantMessage.finishReason, 'clarification');
  assert.match(first.assistantMessage.content, /Bunu mu kastettiniz\? Onaylamak için \*\*1\*\* yazın\./);
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_project_detail', arguments: { projectId: PROJECTS.FULL } }] }, { type: 'script', respond: (call) => {
    const detail = toolResults(call)[0];
    assert.equal(detail.ok, true);
    return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: ['R1:data.project.name', 'R1:data.visibleTasks.total'] }) };
  } });
  const second = await sendTurn({ conversationId: first.conversation.id, turnId: randomUUID(), message: 'Evet' });
  assert.equal(done(second).assistantMessage.finishReason, 'stop');
  assert.match(deltas(second), /\*\*Radar Modernizasyonu\*\*/);
});

test('a numbered task selection binds the task identity for detail and Outlook follow-ups', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: { text: 'Radar test', limit: 1 } }] },
    { type: 'answer', text: '{"kind":"clarification","evidence":"R1"}' });
  const first = done(await sendTurn({ turnId: randomUUID(), message: 'Radar test görevi Outlook’a eklendi mi?' }));
  const rows = first.assistantMessage.content.split('\n').filter((line) => /^\d+\. /.test(line));
  assert.equal(rows.length, 2, 'both candidates are shown although the page limit was one');
  const context = JSON.parse(stack.db.aiMessageEvidence.at(-1).EvidenceJson).clarificationContext;
  const chosen = context.find((item) => item.ordinal === 0).taskId;
  const other = context.find((item) => item.ordinal === 1).taskId;
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_outlook_status', arguments: { taskId: other } }, { name: 'rota_outlook_status', arguments: { taskId: chosen } }] },
    { type: 'script', respond: (call) => {
      const [blocked, allowed] = toolResults(call);
      assert.equal(blocked.error.code, 'UNSUPPORTED_SCOPE');
      assert.equal(allowed.ok, true);
      return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${allowed.evidenceId}:data.task.title`, `${allowed.evidenceId}:data.activeSubscriptions`] }) };
    } });
  const second = done(await sendTurn({ conversationId: first.conversation.id, turnId: randomUUID(), message: '1' }));
  assert.equal(second.assistantMessage.finishReason, 'stop');
});

test('task-name resolution reaches Outlook status in a later round', async (t) => {
  const stack = stackFor(t);
  stack.provider.enqueue({ type: 'tool-calls', calls: [{ name: 'rota_task_search', arguments: { text: 'Anten kalibrasyonu' } }] }, { type: 'script', respond: (call) => {
    assert.ok(call.tools.some((tool) => tool.name === 'rota_outlook_status'));
    const [found] = toolResults(call);
    assert.equal(found.data.titleResolution, 'unique');
    return { type: 'tool-calls', calls: [{ name: 'rota_outlook_status', arguments: { taskId: found.data.resolvedTask.taskId } }] };
  } }, { type: 'script', respond: (call) => {
    const outlook = toolResults(call).at(-1);
    assert.equal(outlook.ok, true);
    return { type: 'answer', text: JSON.stringify({ kind: 'rota', facts: [`${outlook.evidenceId}:data.items.0.state`] }) };
  } });
  const response = done(await sendTurn({ turnId: randomUUID(), message: 'Anten kalibrasyonu görevi Outlook’a gönderildi mi?' }));
  assert.equal(response.assistantMessage.finishReason, 'stop');
});
