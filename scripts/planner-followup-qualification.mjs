/**
 * Rota AI takip sürekliliği — gerçek model çok turlu nitelendirmesi (Aşama 4C). Geliştirme aracıdır; `npm test`
 * bu dosyayı çalıştırmaz (adı `*.test.mjs` değildir).
 *
 *   PLANNER_CLAUDE_LOG=cagri.jsonl node --test scripts/planner-followup-qualification.mjs
 *
 * Sohbetler ÜRETİMDEKİ asistan hizmetinden geçer (konuşma kaydı, önceki sonuç kapsamı, açıklama seçimi, sunucu
 * doğrulayıcıları, salt okunur araçlar, kalıcı kanıt) ve sınama veri kümesini okur; yalnızca model turları
 * `scripts/planner-claude-model.mjs` komutuyla gerçek modele gider. Her tur, kaydedilen doğrulanmış kanıttan
 * denetlenir; Derin devri sayılır ve sıfır olmalıdır.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAiStack, sendTurn } from '../test/helpers/aiStack.mjs';
import { createFakeAiProvider } from '../test/helpers/fakeAiProvider.mjs';
import { ALI_2, AYSE, MEHMET, NOW, TASKS, ZEYNEP, rotaToolSeed } from '../test/helpers/aiToolFixtures.mjs';

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'planner-claude-model.mjs');
const OUT = process.env.PLANNER_FOLLOWUP_OUT || null;
const summary = { chains: 0, turns: 0, passed: 0, failed: [], modelCalls: 0, escalations: 0, models: new Set() };

function complete(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADAPTER], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('ADAPTER_OUTPUT_INVALID')); } });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Sınama sağlayıcısının gerçek akış biçimi; davranışı her araçlı turda gerçek model belirler. */
function realModelProvider() {
  const fake = createFakeAiProvider({ semanticQueue: false });
  let standard = null;
  return { ...fake, async streamToolCompletion(input) {
    standard ??= input.model;
    if (input.model !== standard) summary.escalations += 1;
    summary.modelCalls += 1;
    const reply = await complete({ messages: input.messages, tools: input.tools, toolChoice: input.toolChoice });
    if (reply.error) throw new Error(`MODEL_INFRASTRUCTURE ${reply.error}`);
    reply.models.forEach((model) => summary.models.add(model));
    fake.enqueue(reply.toolCalls.length ? { type: 'tool-calls', calls: reply.toolCalls, preface: reply.text ? [reply.text] : [] } : { type: 'answer', text: reply.text });
    return fake.streamToolCompletion(input);
  } };
}

const evidenceOf = (stack, from) => (stack.db.aiMessageEvidence || []).slice(from).map((row) => ({ tool: row.ToolName, ...JSON.parse(row.EvidenceJson) }));
const taskIds = (rows, tool = 'rota_task_search') => rows.filter((row) => row.tool === tool).flatMap((row) => (row.data?.tasks || []).map((task) => task.taskId));
const mentions = (rows, value) => JSON.stringify(rows).includes(String(value));

async function chain(t, name, turns) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const stack = createAiStack(t, { sicil: AYSE, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true' }, seed: rotaToolSeed(), provider: realModelProvider() });
  summary.chains += 1;
  let conversationId = null;
  let sequence = 0;
  const history = [];
  for (const [message, check] of turns) {
    const from = (stack.db.aiMessageEvidence || []).length;
    const response = await sendTurn({ turnId: randomUUID(), ...(conversationId ? { conversationId, expectedSequence: sequence } : {}), message });
    const done = response.events?.find((event) => event.event === 'done')?.data;
    summary.turns += 1;
    let verdict = 'ok';
    try {
      assert.ok(done, `yanıt yok: ${response.status}`);
      const rows = evidenceOf(stack, from);
      check({ done, rows, finish: done.assistantMessage.finishReason, history });
      history.push({ message, rows });
      summary.passed += 1;
    } catch (error) {
      verdict = String(error.message).slice(0, 300);
      summary.failed.push({ chain: name, message, finish: done?.assistantMessage?.finishReason ?? null, reason: verdict });
      if (done) history.push({ message, rows: evidenceOf(stack, from) });
    }
    if (done) { conversationId = done.conversation.id; sequence += 2; }
    process.stderr.write(`[${name}] ${message} → ${done?.assistantMessage?.finishReason ?? response.status} ${verdict}\n`);
  }
}

test.after(() => {
  const result = { ...summary, models: [...summary.models] };
  process.stderr.write(`${JSON.stringify(result)}\n`);
  if (OUT) appendFileSync(OUT, `${JSON.stringify(result)}\n`);
});

test('takip zinciri: kişi değişimi, "bunlardan", "ilk görev", "onun"', async (t) => {
  await chain(t, 'A', [
    ['Görevlerimi listele.', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      assert.ok(taskIds(rows).includes(TASKS.OVERDUE));
    }],
    ["Peki Zeynep'inkiler?", ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      const ids = taskIds(rows);
      assert.ok(ids.includes(TASKS.DUE_SOON), 'Zeynep\'in görevleri okunur');
      assert.ok(!ids.includes(TASKS.OVERDUE), 'önceki kişinin kümesi sızmaz');
    }],
    ['Bunlardan bu hafta bitecek olanlar?', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      assert.deepEqual(taskIds(rows), [TASKS.DUE_SOON]);
    }],
    ['İlk görevin öncülü var mı?', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      const inspected = rows.filter((row) => row.tool === 'rota_dependency_inspect');
      assert.ok(inspected.length && inspected.every((row) => row.entity?.id === TASKS.DUE_SOON), 'önceki listenin ilk görevi');
    }],
    ['Onun termin tarihi ne?', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      assert.ok(mentions(rows, TASKS.DUE_SOON) && mentions(rows, '2026-10-02'), 'önceki yanıtın görevi ve termini');
    }]
  ]);
});

test('açıklama ve devam: seçilen kişi bağlanır, sonraki kişi eski seçimi devralmaz', async (t) => {
  await chain(t, 'B', [
    ["Ali Veli'nin görevleri neler?", ({ finish }) => assert.equal(finish, 'clarification')],
    ['2', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      assert.ok(mentions(rows, ALI_2), 'seçilen aday');
    }],
    ["Peki Mehmet'in açık görevleri?", ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      assert.ok(mentions(rows, MEHMET) && !mentions(rows, ALI_2), 'yeni kişi; eski seçim yok');
    }]
  ]);
});

test('göndergesiz zamir sorusu veri okumadan açıklama ister', async (t) => {
  await chain(t, 'C', [
    ['Onun termini ne zaman?', ({ finish, rows }) => {
      assert.equal(finish, 'clarification');
      assert.deepEqual(rows, []);
    }]
  ]);
});

test('önceki sonucu süzgeçle daraltma', async (t) => {
  await chain(t, 'D', [
    ['Gecikmiş görevlerim neler?', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      assert.ok(taskIds(rows).includes(TASKS.OVERDUE));
    }],
    ['Bunlardan kritik öncelikli olanlar hangileri?', ({ finish, rows, history }) => {
      assert.equal(finish, 'stop');
      const before = new Set(taskIds(history.at(-1).rows));
      const ids = taskIds(rows);
      assert.ok(ids.length && ids.every((id) => before.has(id)), 'yalnızca önceki kümenin görevleri');
      assert.ok(rows.filter((row) => row.tool === 'rota_task_search').flatMap((row) => row.data.tasks).every((task) => task.priority === 'critical'));
    }]
  ]);
});
