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
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAiStack, sendTurn } from '../test/helpers/aiStack.mjs';
import { createFakeAiProvider } from '../test/helpers/fakeAiProvider.mjs';
import { ALI_2, AYSE, MEHMET, NOW, TASKS, ZEYNEP, rotaToolSeed } from '../test/helpers/aiToolFixtures.mjs';
import { verifyCompletion } from './planner-evaluation.mjs';
import { MODEL_CLEANUP_TIMEOUT_MS, spawnModelCommand, terminateModelCommand } from './planner-claude-model.mjs';
import { AI_ERROR_CODES } from '../src/domain/ai/aiErrorCatalog.js';

const { AiError } = await import('../src/server/ai/aiErrors.js');

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'planner-claude-model.mjs');
const OUT = process.env.PLANNER_FOLLOWUP_OUT || null;
const EXPECTED_MODEL = process.env.PLANNER_CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const summary = { chains: 0, turns: 0, passed: 0, failed: [], modelCalls: 0, escalations: 0, models: new Set() };

function complete(input, signal) {
  return new Promise((resolve, reject) => {
    const raw = String(process.env.PLANNER_MODEL_TIMEOUT_MS || '120000').trim();
    const timeoutMs = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 600000) return reject(new Error('MODEL_INFRASTRUCTURE PLANNER_LIMIT_INVALID'));
    if (signal?.aborted) return reject(signal.reason instanceof AiError ? signal.reason : new AiError(AI_ERROR_CODES.AI_CANCELLED));
    const child = spawnModelCommand(process.execPath, [ADAPTER], { stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PLANNER_MODEL_TIMEOUT_MS: String(timeoutMs) } });
    let out = '';
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminateSignal); process.off('SIGHUP', hangup);
      try { await terminateModelCommand(child); } catch (cleanupError) {
        const failure = new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_CLEANUP_ERROR', { cause: cleanupError });
        if (error) error.cause = failure;
        else error = failure;
      }
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(signal?.reason instanceof AiError ? signal.reason : new AiError(AI_ERROR_CODES.AI_CANCELLED));
    const interrupt = () => cancel().finally(() => process.exit(130));
    const terminateSignal = () => cancel().finally(() => process.exit(143));
    const hangup = () => cancel().finally(() => process.exit(129));
    // Bağdaştırıcı kilidi ve modeli ayrı ayrı bu bütçeyle sınırlar; üst süre ikisini de kapsar.
    const timer = setTimeout(() => finish(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_TIMEOUT')), 2 * timeoutMs + 2 * MODEL_CLEANUP_TIMEOUT_MS + 1000);
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminateSignal); process.once('SIGHUP', hangup);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => finish(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_ERROR')));
    child.stdin.on('error', () => finish(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_ERROR')));
    child.on('command-close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_ERROR'));
      let reply;
      try { reply = JSON.parse(out); } catch { return finish(new Error('ADAPTER_OUTPUT_INVALID')); }
      finish(null, reply);
    });
    child.on('close', () => { if (!settled) finish(new Error('MODEL_INFRASTRUCTURE MODEL_COMMAND_ERROR')); });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    child.stdin.end(JSON.stringify(input));
  });
}

/** Sınama sağlayıcısının gerçek akış biçimi; davranışı her araçlı turda gerçek model belirler. */
export function realModelProvider({ completeRound = complete } = {}) {
  const fake = createFakeAiProvider({ semanticQueue: false,
    respond: call => ['embeddings', 'rerank'].includes(call.kind) ? { type: 'status', status: 503 } : null });
  let standard = null;
  return { ...fake, async streamToolCompletion(input) {
    standard ??= input.model;
    // Derin devir nitelendirmede yasaktır: devredilen tur modele gitmez, tur başarısız sayılır.
    if (input.model !== standard) {
      summary.escalations += 1;
      throw new Error('DEEP_ESCALATION');
    }
    summary.modelCalls += 1;
    const reply = await completeRound({ messages: input.messages, tools: input.tools, toolChoice: input.toolChoice }, input.signal);
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) || typeof reply.text !== 'string' || !Array.isArray(reply.toolCalls)
      || reply.toolCalls.some(call => !call || typeof call !== 'object' || Array.isArray(call) || typeof call.name !== 'string'
        || !(typeof call.arguments === 'string' || call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)))
      || reply.error != null && typeof reply.error !== 'string'
      || !reply.error && !Array.isArray(reply.models)) throw new Error('MODEL_INFRASTRUCTURE ADAPTER_OUTPUT_INVALID');
    if (reply.error) throw new Error(`MODEL_INFRASTRUCTURE ${reply.error}`);
    if (!reply.models?.length || reply.models.some((model) => model !== EXPECTED_MODEL) || reply.thinking !== 'off') throw new Error('MODEL_INFRASTRUCTURE PLANNER_MODEL_UNVERIFIED');
    reply.models.forEach((model) => summary.models.add(model));
    // Sağlayıcının bitiş nedeni korunur: çıktı sınırında kesilen yanıt üretimdeki kesilme yolundan geçer.
    verifyCompletion(reply.finishReason);
    const finishReason = reply.finishReason;
    fake.enqueue(reply.toolCalls.length ? { type: 'tool-calls', calls: reply.toolCalls, preface: reply.text ? [reply.text] : [], finishReason }
      : { type: 'answer', text: reply.text, finishReason });
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
      check({ done, rows, finish: done.assistantMessage.finishReason, content: String(done.assistantMessage.content || ''), history });
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

/** Tanı raporu yazıldıktan sonra başarısız nitelendirme komutu da başarısız olur. */
export function finalizeQualification(result) {
  process.stderr.write(`${JSON.stringify(result)}\n`);
  if (OUT) appendFileSync(OUT, `${JSON.stringify(result)}\n`);
  assert.equal(result.failed.length, 0, 'FOLLOWUP_QUALIFICATION_FAILED');
  assert.equal(result.escalations, 0, 'FOLLOWUP_ESCALATION_FORBIDDEN');
}

const direct = (() => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (direct) {
test.after(() => finalizeQualification({ ...summary, models: [...summary.models] }));

test('takip zinciri: kişi değişimi, "bunlardan", "ilk görev", "onun"', async (t) => {
  await chain(t, 'A', [
    ['Görevlerimi listele.', ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      // Yedi görünür atama 50 satırlık mevcut liste sınırının altındadır; arşiv ve başka kişiler dışarıda kalır.
      assert.deepEqual([...new Set(taskIds(rows))].sort(), [TASKS.OVERDUE, TASKS.LITERAL, TASKS.SERIES,
        TASKS.OCCURRENCE_DONE, TASKS.OCCURRENCE_OPEN, TASKS.PARTIAL_OWN, TASKS.PARTIAL_SHARED].sort());
    }],
    ["Peki Zeynep'inkiler?", ({ finish, rows }) => {
      assert.equal(finish, 'stop');
      const ids = taskIds(rows);
      assert.ok(ids.includes(TASKS.DUE_SOON), 'Zeynep\'in görevleri okunur');
      assert.ok(!ids.includes(TASKS.OVERDUE), 'önceki kişinin kümesi sızmaz');
    }],
    ['Bunlardan bu hafta bitecek olanlar?', ({ finish, rows, content }) => {
      assert.equal(finish, 'stop');
      assert.deepEqual(taskIds(rows), [TASKS.DUE_SOON]);
      assert.match(content, /Anten kalibrasyonu/);
    }],
    ['İlk görevin öncülü var mı?', ({ finish, rows, content }) => {
      assert.equal(finish, 'stop');
      assert.match(content, /Radar test planı/, 'yanıt öncülü söyler');
      const inspected = rows.filter((row) => row.tool === 'rota_dependency_inspect');
      assert.ok(inspected.length && inspected.every((row) => row.entity?.id === TASKS.DUE_SOON), 'önceki listenin ilk görevi');
    }],
    ['Onun termin tarihi ne?', ({ finish, rows, content }) => {
      assert.equal(finish, 'stop');
      assert.ok(mentions(rows, TASKS.DUE_SOON) && mentions(rows, '2026-10-02'), 'önceki yanıtın görevi ve termini');
      assert.match(content, /Anten kalibrasyonu/, 'yanıt doğru görevi söyler');
      assert.match(content, /2026-10-02|0?2[./]10[./]2026|2 Ekim 2026/, 'yanıt kanıttaki termini söyler');
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
}
