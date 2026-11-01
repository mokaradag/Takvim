/**
 * Aşama 4E senaryo koşucusu: konuşmayı ÜRETİMDEKİ asistan hizmetinden geçirir (konuşma kaydı, takip bağlamı, yetki,
 * salt okunur araçlar, kalıcı kanıt) ve her turun araç düzeyindeki kapsamını sınama veri kümesinin SQL günlüğünden
 * okur. Planlayıcı ve düzen turları çağıranın verdiği işlevlerle yanıtlanır: deterministik sınamada altın plan,
 * canlı nitelendirmede gerçek model.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAiStack, sendTurn } from './aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from './aiToolFixtures.mjs';
import { createFakeAiProvider } from './fakeAiProvider.mjs';
import { composer, coveringBlocks, isCompositionCall } from './compositionScenario.mjs';

const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });

/**
 * `planner(input, turn)` → model davranışı (sahte sağlayıcı biçimi) ya da `null` (davranış kuyrukta değil);
 * `compose(input)` → düzen davranışı. Varsayılan: altın plan ve sunucunun kapsayan düzeni.
 */
export function phase4eConversation(t, { sicil = AYSE, seed = rotaToolSeed(), env = {}, composition = true, planner = null, compose = null, now = NOW, provider: external = null } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const fake = createFakeAiProvider({ semanticQueue: false });
  let current = null;
  const inputs = [];
  // Dış sağlayıcı (canlı nitelendirme): planlayıcı ve düzen turlarını kendisi yanıtlar; altın plan kuyruğa konmaz.
  const recorded = external ? { ...external, get pendingCount() { return external.pendingCount; }, streamToolCompletion(input) {
    if (!isCompositionCall(input)) inputs.push(input);
    return external.streamToolCompletion(input);
  } } : null;
  const provider = recorded || { ...fake, get pendingCount() { return fake.pendingCount; }, streamToolCompletion(input) {
    if (!fake.pendingCount) {
      if (isCompositionCall(input)) fake.enqueue(compose ? compose(input) : composer(coveringBlocks));
      else if (planner) fake.enqueue(planner(input, current));
    }
    if (!isCompositionCall(input)) inputs.push(input);
    return fake.streamToolCompletion(input);
  } };
  const stack = createAiStack(t, { provider, sicil, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', ...(composition ? { MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true' } : {}), ...env } });
  const state = { id: null, turns: 0 };
  async function ask(turn, { detail = null } = {}) {
    current = turn;
    const before = (stack.db.aiToolLog || []).length;
    const inputBefore = inputs.length;
    if (!external && !planner && turn.plan) stack.provider.enqueue(planCall(turn.plan));
    if (external && turn.scripted && turn.plan) stack.provider.enqueue(planCall(turn.plan));
    const response = await sendTurn({ turnId: randomUUID(), message: turn.text, mode: 'standard', ...(detail ? { detail } : {}),
      ...(state.id ? { conversationId: state.id, expectedSequence: state.turns * 2 } : {}) });
    const done = response.events.find((event) => event.event === 'done')?.data;
    assert.ok(done, `done olayı yok: ${response.text}`);
    state.id = done.conversation.id;
    state.turns += 1;
    const log = (stack.db.aiToolLog || []).slice(before);
    return { done, answer: done.assistantMessage, log, inputs: inputs.slice(inputBefore) };
  }
  return { stack, ask };
}

/** Görev nüfusu okumaları (sayfa sorumlu okumaları değil). */
export const populationReads = (log) => log.filter((row) => row.query === 'task-facts' && !String(row.params.taskIds || ''));

/**
 * Turun araç düzeyindeki beklentileri; ihlal listesi döner (boş: geçti). `live`: canlı modelin seçtiği yön tek satırlık
 * kanıt verdiyse grafik adayı yoktur ve sunucunun kısa açıklaması kabul edilir (deterministik sınamada grafik zorunlu).
 */
export function turnViolations(result, expect, { live = false } = {}) {
  const problems = [];
  const reads = populationReads(result.log);
  const content = String(result.answer?.content || '');
  if (expect.finish && result.answer?.finishReason !== expect.finish) problems.push(`finish ${result.answer?.finishReason} ≠ ${expect.finish}`);
  // Kapsam beklentileri HER nüfus okumasında geçerlidir: bir bölüm kapsamı korurken başka bir bölümün genişlemesi kabul edilmez.
  const every = (predicate) => reads.length > 0 && reads.every(predicate);
  if (expect.assignee && !every((row) => row.params.assigneeMode === expect.assignee)) problems.push(`assignee ${expect.assignee} her okumada değil`);
  if (expect.notAssignee && reads.some((row) => row.params.assigneeMode === expect.notAssignee)) problems.push(`assignee ${expect.notAssignee} taşındı`);
  if (expect.project && !every((row) => row.params.projectId)) problems.push('proje kapsamı her okumada değil');
  if (expect.noProject && reads.some((row) => row.params.projectId)) problems.push('eski proje kapsamı taşındı');
  if (expect.person && !every((row) => row.params.personSicil != null && row.params.assigneeMode === 'person')) problems.push('kişi kapsamı her okumada değil');
  if (expect.workload && !reads.some((row) => Number(row.params.withAssignees) === 1)) problems.push('iş yükü okunmadı');
  if (expect.portfolio && !result.log.some((row) => row.query === 'portfolio')) problems.push('portföy okunmadı');
  // Ufuk: beklenen aralıkla örtüşen bir termin penceresi okunmuş olmalı (uçlarda en çok bir günlük yorum farkı kabul edilir).
  const day = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / 86400000;
  if (expect.window && !reads.some((row) => row.params.dateFrom && row.params.dateTo
    && Math.abs(day(row.params.dateFrom) - day(expect.window[0])) <= 1 && Math.abs(day(row.params.dateTo) - day(expect.window[1])) <= 1)) {
    problems.push(`ufuk ${expect.window.join('..')} okunmadı`);
  }
  if (expect.chart && !content.includes('```rota-chart') && !(live && /güvenle grafik çizilemedi|could not be drawn safely/.test(content))) problems.push('grafik yok');
  if (expect.scopeDenied && !/yönetim kapsamınız bulunmuyor|management scope/.test(content)) problems.push('kapsam reddi metni yok');
  // Veri okumayan tur hiçbir Rota sorgusu çalıştırmaz (görev kimliğiyle ya da portföy okuması dâhil; süzülmüş alt küme değil).
  if (expect.noData && result.log.length) problems.push(`veri okundu: ${[...new Set(result.log.map((row) => row.query))].join(',')}`);
  if (expect.finish === 'stop' && (!reads.length && !result.log.some((row) => row.query === 'portfolio'))) problems.push('araç okuması yok');
  return problems;
}
