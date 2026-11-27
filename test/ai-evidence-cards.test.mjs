/**
 * Bilgin etkileşimli kanıt kartları (ICE-1) · alan, sunucu, güvenlik ve yaşam döngüsü.
 *
 * Sınananlar: olgu → kanıt bağının belirlenimci kurulması (aynı sayının farklı nüfusları, aynı kanıtı paylaşan
 * olgular), işaretlerin sökülmesi ve kapalı ret, katkıda bulunan nüfus ve kısmi önizleme, kart izdüşümünün gizli ve
 * korumalı alanları taşımaması, tanımlayıcının katı doğrulaması (sahte, bozuk, aşırı büyük), tarayıcıdaki geçici yaşam
 * döngüsü (yalnızca canlı yanıt, süre, en yeni yanıtlar, oturum hatası) ve kalın düğüm sırasının çizimle aynılığı.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { findElement } from './helpers/clientComponentHarness.mjs';

registerServerOnlyShim();

const cardsDomain = await import('../src/domain/ai/evidenceCards.js');
const { EVIDENCE_CARD_LIMITS, bindingMark, hasBindingMarks, normalizeEvidenceCards, resolveBindingAnchors, stripBindingMarks, evidenceCardsExpired } = cardsDomain;
const { countProposition, fluentParagraph, taskCountLead } = await import('../src/domain/ai/groundedPropositions.js');
const { renderComposition } = await import('../src/domain/ai/groundedComposition.js');
const { escapedFactText } = await import('../src/domain/ai/evidenceFacts.js');
const { strongTexts, blockStrongStarts } = await import('../src/features/ai/assistant/evidenceCardAnchors.js');
const { parseAssistantMarkdown } = await import('../src/features/ai/assistant/assistantMarkdown.js');
const { buildEvidenceCards, settleEvidenceBindings } = await import('../src/server/ai/assistant/evidenceCards.js');
const { createAssistantController, pruneEvidenceCards, turnsFromMessages } = await import('../src/features/ai/assistant/assistantController.js');
const { createAssistantStreamDecoder } = await import('../src/features/ai/assistant/assistantClient.js');
const { renderBlock } = await import('../src/features/ai/assistant/AssistantMarkdown.jsx');
const { EvidenceReference } = await import('../src/features/ai/assistant/EvidenceCard.jsx');

const GENERATED_AT = '2026-11-27T08:00:00.000Z';
const PROJECT_A = '11000000-0000-4000-8000-000000000001';
const PROJECT_B = '11000000-0000-4000-8000-000000000002';
const taskId = (n) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function taskRow(n, overrides = {}) {
  return {
    taskId: taskId(n), title: `Görev ${n}`, project: { projectId: PROJECT_A, name: 'Altyapı', code: 'ALT' }, status: 'in_progress', statusLabel: 'Devam ediyor',
    priority: 'high', overdue: true, overdueDays: 30 - n, targetFinish: '2026-11-10', progressPercent: 40, access: 'FULL',
    assignees: [{ name: 'Ayşe Demir', sicil: 900100 + (n % 3) }], assignment: 'visible', description: 'GİZLİ NOT METNİ', keyword: 'anahtar', ...overrides
  };
}

const entry = (id, rows, { totalCount = rows.length, complete = rows.length === totalCount, tool = 'rota_task_search' } = {}) => ({
  id, tool, args: {}, round: 1,
  payload: { tool, data: { tasks: rows, filters: { deadline: 'overdue' } }, complete, truncated: false, returnedCount: rows.length, totalCount }
});
const summary = (id, partial = false) => ({ id, kind: 'task-list', label: 'Görev listesi', generatedAt: GENERATED_AT, complete: true, truncated: false, partial, counts: { returned: 1, total: 1 }, highlights: [] });

/** Sunucunun işaretli metninden bağları çıkarır (yanıt düzeninin yaptığı gibi). */
function bound(markedText, bindings) {
  const settled = settleEvidenceBindings({ normalized: markedText }, bindings);
  return { text: settled.normalized, evidenceBindings: settled.evidenceBindings };
}

/* ── Belirlenimci bağ ───────────────────────────────────────── */

test('aynı sayı farklı nüfuslarda ayrı ve doğru kartlara bağlanır', () => {
  const groupA = { tool: 'rota_task_search', evidenceId: 'R1', envelope: [] };
  const groupB = { tool: 'rota_task_search', evidenceId: 'R2', envelope: [] };
  const fact = (projectId, project, deadline) => ({ field: 'totalCount', value: 10, semantic: { complete: true, filters: { projectId, project, ...(deadline ? { deadline } : { statuses: ['done'] }) } } });
  const left = countProposition(groupA, fact(PROJECT_A, 'Proje A', null), 'tr', null);
  const right = countProposition(groupB, fact(PROJECT_B, 'Proje B', 'overdue'), 'tr', null);
  // Varsayılan çizim (model ve doğrulayıcı) işaretsizdir; bağ yalnızca parçada taşınır.
  assert.equal(hasBindingMarks(left.markdown + right.markdown + left.plain + right.plain), false);
  const bindings = [];
  const mark = (spec) => { const text = bindingMark(bindings.length + 1); bindings.push(spec); return text; };
  const text = fluentParagraph([{ proposition: left }, { proposition: right }], 'tr', null, null, mark);
  assert.equal(stripBindingMarks(text), fluentParagraph([{ proposition: left }, { proposition: right }], 'tr'));
  const { text: clean, evidenceBindings } = bound(text, bindings);
  const strong = strongTexts(clean);
  const tens = strong.map((value, index) => (value === '10' ? index : -1)).filter((index) => index >= 0);
  assert.equal(tens.length, 2, clean);
  const byStrong = new Map(evidenceBindings.anchors.map((anchor) => [anchor.strong, evidenceBindings.bindings[anchor.key - 1]]));
  assert.equal(byStrong.get(tens[0]).evidenceId, 'R1');
  assert.equal(byStrong.get(tens[0]).tone, 'done');
  assert.equal(byStrong.get(tens[1]).evidenceId, 'R2');
  assert.equal(byStrong.get(tens[1]).tone, 'overdue');
  // Kartlar kendi kanıtlarının satırlarıyla kurulur; satırlar karışmaz.
  const rowsA = Array.from({ length: 10 }, (_, index) => taskRow(index + 1, { status: 'done', overdue: false, overdueDays: undefined, actualFinish: '2026-11-01' }));
  const rowsB = Array.from({ length: 4 }, (_, index) => taskRow(index + 20));
  const built = buildEvidenceCards({ evidenceBindings, finalText: clean, entries: [entry('R1', rowsA), entry('R2', rowsB, { totalCount: 10, complete: false })],
    summaries: [summary('R1'), summary('R2')], citedIds: ['R1', 'R2'] });
  const cards = built.descriptor;
  const cardAt = (strongIndex) => cards.cards.find((card) => card.id === cards.anchors.find((anchor) => anchor.strong === strongIndex).card);
  assert.deepEqual(cardAt(tens[0]).items.map((item) => item.id), rowsA.map((row) => row.taskId));
  assert.deepEqual(cardAt(tens[1]).items.map((item) => item.id), rowsB.map((row) => row.taskId));
  assert.equal(cardAt(tens[1]).total, 10, 'kısmi önizlemenin toplamı iddia edilen sayıdır');
});

test('aynı kanıtı paylaşan sayım ve tekil görev olguları ayrı kart türlerine bağlanır', () => {
  const rows = [taskRow(1), taskRow(2)];
  const bindings = [{ type: 'tasks', evidenceId: 'R1', count: 2, title: 'Gecikmiş görevleriniz', tone: 'overdue' }, { type: 'task', evidenceId: 'R1', taskId: rows[0].taskId }];
  const { text, evidenceBindings } = bound(`Şu anda **${bindingMark(1)}2** gecikmiş göreviniz var; en uzun süredir geciken görev **${bindingMark(2)}Görev 1** (**29 gün**).`, bindings);
  const built = buildEvidenceCards({ evidenceBindings, finalText: text, entries: [entry('R1', rows)], summaries: [summary('R1')], citedIds: ['R1'] });
  assert.deepEqual(built.descriptor.cards.map((card) => [card.kind, card.items.length, card.total]), [['tasks', 2, 2], ['task', 1, 1]]);
  assert.deepEqual(built.descriptor.anchors.map((anchor) => anchor.text), ['2', 'Görev 1']);
});

test('sayım giriş cümlesi işaretli biçimde varsayılan cümleyle birebir aynıdır', () => {
  const group = { tool: 'rota_task_search', evidenceId: 'R3', envelope: [{ field: 'totalCount', value: 4, semantic: { complete: true, filters: { assignee: 'me', deadline: 'overdue' } } }] };
  const plain = taskCountLead(group, 'tr');
  const marked = taskCountLead(group, 'tr', { mark: () => bindingMark(1) });
  assert.notEqual(marked, plain);
  assert.equal(stripBindingMarks(marked), plain);
  assert.match(plain, /\*\*4\*\*/);
});

test('işaretli çizim yalnızca açıkça istendiğinde üretilir; varsayılan düzen çizimi değişmez', () => {
  // Boş düzen: bağ seçeneği olmadan sonuçta bağ alanı ve işaret yoktur.
  const composition = { render: { locale: 'tr', propositions: new Map(), details: new Map(), tables: new Map(), charts: new Map(), titles: new Map() } };
  const plain = renderComposition(composition, { blocks: [] });
  assert.equal(plain.bindings, undefined);
  assert.equal(hasBindingMarks(plain.text), false);
});

/* ── İşaret sökme ve kapalı ret ─────────────────────────────── */

test('işaretler kalın düğüm sırasına çevrilir ve metinden tamamen sökülür', () => {
  const marked = `**Not:** Şu anda **${bindingMark(1)}5** görev var; **3** kişi ve **${bindingMark(2)}İş ğüşıöç**.`;
  const resolved = resolveBindingAnchors(marked, strongTexts);
  assert.equal(resolved.rejected, null);
  assert.equal(hasBindingMarks(resolved.text), false);
  assert.deepEqual(resolved.anchors, [{ key: 1, strong: 1, text: '5' }, { key: 2, strong: 3, text: 'İş ğüşıöç' }]);
});

test('bozuk, yinelenen, kalın dışı ya da artık işaret bütün bağları düşürür; metin yine işaretsizdir', () => {
  const cases = [
    `Şu anda **${bindingMark(1)}5** ve **${bindingMark(1)}6**.`,
    `Şu anda ${bindingMark(1)}5 görev var.`,
    `Şu anda **${bindingMark(1)}5** \u001e görev var.`,
    `Şu anda **5${bindingMark(1)}** görev var.`,
    `\`kod ${bindingMark(1)}\` ve **5**`
  ];
  for (const text of cases) {
    const resolved = resolveBindingAnchors(text, strongTexts);
    assert.notEqual(resolved.rejected, null, text);
    assert.deepEqual(resolved.anchors, []);
    assert.equal(hasBindingMarks(resolved.text), false);
  }
});

test('veri metni işaret taklit edemez: kaçış denetim karakterlerini boşluğa çevirir', () => {
  const forged = `Kötü\u001e1\u001fAd **x** <script>alert(1)</script>`;
  const escaped = escapedFactText(forged);
  assert.equal(hasBindingMarks(escaped), false);
  assert.equal(resolveBindingAnchors(`**${escaped}**`, strongTexts).anchors.length, 0);
});

test('Markdown sınırları ve Türkçe karakterler kalın düğüm sırasını bozmaz', () => {
  const text = '#### Başlık **a**\n\n- **b** ve **ç**\n\n| Görev | Değer |\n| --- | --- |\n| **Şık** | 2 |\n\n> [!warning]\n> **Dikkat:** **Ğ**\n\n```rota-chart\n{"x":"**y**"}\n```';
  assert.deepEqual(strongTexts(text), ['a', 'b', 'ç', 'Şık', 'Dikkat:', 'Ğ']);
  const blocks = parseAssistantMarkdown(text, { rotaData: true });
  assert.deepEqual(blockStrongStarts(blocks), [0, 1, 3, 4, 6]);
});

/* ── Katkıda bulunan nüfus ve izdüşüm ──────────────────────── */

function single(count, rows, options = {}) {
  const bindings = [{ type: 'tasks', evidenceId: 'R1', count, title: 'Görevler', tone: 'neutral' }];
  const { text, evidenceBindings } = bound(`Toplam **${bindingMark(1)}${count}** görev var.`, bindings);
  return buildEvidenceCards({ evidenceBindings, finalText: options.finalText ?? text, entries: options.entries ?? [entry('R1', rows, options)],
    summaries: options.summaries ?? [summary('R1', options.partial)], citedIds: options.citedIds ?? ['R1'] });
}

test('kısmi önizleme kesin toplamla bildirilir; tutarsız sayı kart üretmez', () => {
  const rows = Array.from({ length: 20 }, (_, index) => taskRow(index + 1));
  const partial = single(47, rows, { totalCount: 47, complete: false });
  assert.equal(partial.descriptor.cards[0].total, 47);
  assert.equal(partial.descriptor.cards[0].items.length, 20);
  assert.equal(single(47, rows, { totalCount: 46, complete: false }), null, 'kanıtın toplamı sayıyla aynı değil');
  assert.equal(single(10, rows, { totalCount: 20 }), null, 'satırlar sayıdan fazla');
  assert.equal(single(20, rows, { totalCount: null, complete: false }), null, 'kesin toplam yok ve kanıt tam değil');
  assert.equal(single(0, [], { totalCount: 0 }), null, 'boş nüfusun kartı yok');
  assert.equal(single(20, rows, { tool: 'rota_task_analytics' }), null, 'satırsız toplu araç kart üretmez');
});

test('kart satırları otuzla sınırlıdır ve toplam yine iddia edilen sayıdır', () => {
  const rows = Array.from({ length: 40 }, (_, index) => taskRow(index + 1, { overdueDays: 50 - index }));
  const built = single(40, rows);
  assert.equal(built.descriptor.cards[0].items.length, EVIDENCE_CARD_LIMITS.maxItemsPerCard);
  assert.equal(built.descriptor.cards[0].total, 40);
});

test('izdüşüm korumalı ve gizli alanları taşımaz; farklı sorumlular Sicil ile ayrılır', () => {
  const rows = [
    taskRow(1, { assignees: [{ name: 'Ali Kaya', sicil: 1 }, { name: 'Gizli Eş', identityHidden: true }] }),
    taskRow(2, { assignees: [{ name: 'Ali Kaya', sicil: 2 }] }),
    taskRow(3, { assignees: [{ name: 'Ali Kaya', sicil: 1 }, { name: 'Zeynep Ak', sicil: 3 }] }),
    taskRow(4, { assignees: [], assignment: 'unassigned' }),
    taskRow(5, { assignees: [{ name: 'Gizli', identityHidden: true }], assignment: 'undisclosed' })
  ];
  const card = single(5, rows).descriptor.cards[0];
  const serialized = JSON.stringify(card);
  for (const forbidden of ['GİZLİ NOT METNİ', 'anahtar', 'sicil', 'Gizli Eş', '"Gizli"', 'FULL', 'access']) assert.equal(serialized.includes(forbidden), false, forbidden);
  // Aynı adlı iki farklı kişi ayrı; aynı kişi bir kez ve görev sayısıyla.
  assert.deepEqual(card.people, [{ name: 'Ali Kaya', tasks: 2 }, { name: 'Ali Kaya', tasks: 1 }, { name: 'Zeynep Ak', tasks: 1 }]);
  assert.equal(card.unassigned, 1);
  assert.equal(card.undisclosed, 1);
  assert.equal(card.items[0].hiddenAssignees, 1);
});

test('kötü niyetli görev adı metin olarak kalır; denetim ve yön karakterleri temizlenir', () => {
  const card = single(1, [taskRow(1, { title: '<img src=x onerror=alert(1)> ‮ters\u001e1\u001f' })]).descriptor.cards[0];
  assert.equal(card.items[0].title, '<img src=x onerror=alert(1)> ters 1');
});

test('yetkisiz ya da atfedilmemiş kanıt ve son metinde kaymış bağ kart üretmez', () => {
  const rows = [taskRow(1)];
  assert.equal(single(1, rows, { citedIds: [] }), null, 'atfedilmemiş kanıt');
  assert.equal(single(1, rows, { entries: [] }), null, 'defterde (geçerli) olmayan kanıt');
  assert.equal(single(1, rows, { finalText: 'Başka **1** metin.' }), null, 'son metin düzen metniyle başlamıyor');
  assert.equal(single(1, rows, { summaries: [] }), null, 'kanıt künyesi yok');
});

test('kart tanımlayıcısı yanıt bütçesini aşarsa sondaki kartlar düşer', () => {
  const longTitle = 'Ş'.repeat(150);
  const bindings = Array.from({ length: 8 }, (_, index) => ({ type: 'tasks', evidenceId: `R${index + 1}`, count: 30, title: `Kart ${index}`, tone: 'neutral' }));
  const text = bindings.map((_, index) => `**${bindingMark(index + 1)}30**`).join(' ');
  const entries = bindings.map((bind, index) => entry(bind.evidenceId, Array.from({ length: 30 }, (__, row) => taskRow(index * 100 + row + 1, { title: longTitle }))));
  const { text: clean, evidenceBindings } = bound(text, bindings);
  const built = buildEvidenceCards({ evidenceBindings, finalText: clean, entries, summaries: bindings.map((bind) => summary(bind.evidenceId)), citedIds: bindings.map((bind) => bind.evidenceId) });
  assert.ok(built.descriptor.cards.length < 8);
  assert.ok(JSON.stringify(built.descriptor).length <= EVIDENCE_CARD_LIMITS.maxPayloadChars);
  assert.ok(built.descriptor.cards.reduce((sum, card) => sum + card.items.length, 0) <= EVIDENCE_CARD_LIMITS.maxTotalItems);
});

/* ── Tanımlayıcının katı doğrulaması ───────────────────────── */

const validDescriptor = () => single(2, [taskRow(1), taskRow(2)]).descriptor;

test('geçerli tanımlayıcı doğrulanır; her bozuk alan bütün tanımlayıcıyı düşürür', () => {
  const base = JSON.parse(JSON.stringify(validDescriptor()));
  assert.ok(normalizeEvidenceCards(base));
  const mutations = [
    (value) => { value.v = 2; },
    (value) => { value.anchors[0].card = 'c9'; },
    (value) => { value.anchors.push({ ...value.anchors[0] }); },
    (value) => { value.cards[0].items[0].id = 'R1'; },
    (value) => { value.cards[0].items[0].title = '<b>\u0000</b>'; },
    (value) => { value.cards[0].items[0].status = 'deleted'; },
    (value) => { value.cards[0].items[0].progress = 140; },
    (value) => { value.cards[0].items[0].due = '2026-02-30'; },
    (value) => { value.cards[0].total = 1; },
    (value) => { value.cards[0].items[1] = value.cards[0].items[0]; },
    (value) => { value.cards[0].kind = 'html'; },
    (value) => { value.cards[0].generatedAt = 'dün'; },
    (value) => { value.cards[0].items[0].assignees = ['a', 'b', 'c', 'd', 'e']; },
    (value) => { value.cards[0].items[0].overdue = false; },
    (value) => { value.anchors[0].strong = -1; },
    (value) => { value.cards[0].items = Array.from({ length: 31 }, () => value.cards[0].items[0]); },
    (value) => { value.cards[0].items[0].title = 'x'.repeat(161); }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const copy = JSON.parse(JSON.stringify(base));
    mutate(copy);
    assert.equal(normalizeEvidenceCards(copy), null, `bozulma ${index}`);
  }
  assert.equal(normalizeEvidenceCards(Object.assign(Object.create({ v: 1 }), base)), null, 'düz olmayan nesne');
  assert.equal(normalizeEvidenceCards('{"v":1}'), null);
});

test('akış çözücüsü bozuk kart tanımlayıcısını atar, yanıtı korur', () => {
  const conversation = { id: '6f1c2d3e-4a5b-4c6d-8e7f-001122334455', title: 'D', createdAt: GENERATED_AT, updatedAt: GENERATED_AT, messageCount: 2 };
  const user = { id: '11111111-2222-4333-8444-555555555555', sequence: 1, role: 'user', content: 'Soru', turnId: '0a1b2c3d-4e5f-4a6b-9c7d-8e9fa0b1c2d3', replyToId: null, mode: 'standard', finishReason: null, createdAt: GENERATED_AT, length: 4 };
  const answer = { id: '99999999-8888-4777-8666-555555555555', sequence: 2, role: 'assistant', turnId: null, replyToId: user.id, mode: 'standard', finishReason: 'stop', createdAt: 'x', length: 5, content: 'Metin', rotaData: true };
  for (const [cards, kept] of [[validDescriptor(), true], [{ v: 1, cards: [], anchors: [] }, false], [{ ...validDescriptor(), anchors: [{ strong: 0, text: '2', card: 'c5' }] }, false]]) {
    const decoder = createAssistantStreamDecoder({ turnId: user.turnId });
    const frames = `event: accepted\ndata: ${JSON.stringify({ v: 1, conversation, userMessage: user, mode: 'standard', replay: false, context: {} })}\n\n`
      + `event: done\ndata: ${JSON.stringify({ conversation, assistantMessage: answer, replayed: false, evidenceCards: cards })}\n\n`;
    const events = decoder.push(frames);
    const done = events.find((event) => event.type === 'done');
    assert.equal(done.data.assistantMessage.content, 'Metin');
    assert.equal(Boolean(done.data.evidenceCards), kept);
  }
});

/* ── Tarayıcıdaki geçici yaşam döngüsü ─────────────────────── */

test('kayıtlı iletilerden kurulan turlar hiçbir zaman kart taşımaz', () => {
  const turns = turnsFromMessages([
    { id: 'u', sequence: 1, role: 'user', content: 'Soru', turnId: 't' },
    { id: 'a', sequence: 2, role: 'assistant', content: 'Yanıt', replyToId: 'u', rotaData: true, evidence: [], evidenceCards: validDescriptor() }
  ]);
  assert.equal(turns[0].answer.evidenceCards, undefined);
});

test('kartlar yalnızca en yeni yanıtlarda ve süresi dolmadan tutulur', () => {
  const now = Date.parse(GENERATED_AT);
  const turn = (key, receivedAt) => ({ key, answer: { status: 'complete', content: 'x', evidenceCards: { value: {}, receivedAt } } });
  const turns = Array.from({ length: 9 }, (_, index) => turn(`t${index}`, now - index * 1000));
  turns.push(turn('expired', now - EVIDENCE_CARD_LIMITS.ttlMs - 1));
  const pruned = pruneEvidenceCards(turns, now);
  assert.equal(pruned.filter((item) => item.answer.evidenceCards).length, EVIDENCE_CARD_LIMITS.maxLiveAnswers);
  assert.equal(pruned.at(-1).answer.evidenceCards, undefined, 'süresi dolan kart silinir');
  assert.equal(pruned[0].answer.evidenceCards, undefined, 'en eski yanıtın kartı silinir');
  assert.ok(pruned.at(-2).answer.evidenceCards, 'en yeni yanıtın kartı kalır');
  assert.equal(evidenceCardsExpired(now, now + EVIDENCE_CARD_LIMITS.ttlMs), true);
  assert.equal(evidenceCardsExpired(now, now + 1000), false);
  assert.equal(evidenceCardsExpired(now + 3600000, now), true, 'gelecekten gelen zaman damgası geçersizdir');
});

function fakeRuns() {
  const turns = [];
  return {
    turns,
    api: {
      loadAssistantReadinessRequest: async () => ({ ok: true, assistant: { available: true, reason: null, modes: [{ id: 'standard', label: 'Standart', available: true }],
        limits: { maxMessageChars: 8000, maxConversationMessages: 100 } } }),
      listAssistantConversationsRequest: async () => ({ ok: true, conversations: [], nextCursor: null }),
      loadAssistantConversationRequest: async (id) => ({ ok: true, conversation: { id, title: 'Konuşma' }, messages: [] }),
      deleteAssistantConversationRequest: async () => ({ ok: true, deleted: true }),
      streamAssistantTurnRequest(input) {
        return new Promise((resolve) => turns.push({ input, resolve, onEvent: (event) => input.onEvent(event) }));
      }
    }
  };
}

test('denetleyici kartı yalnızca bu üretimin başarılı yanıtına ekler; oturum hatası bütün kartları siler', async () => {
  const { api, turns } = fakeRuns();
  let counter = 0;
  const controller = createAssistantController({ api, createId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`, reconciliationDelaysMs: [], schedule: () => () => {} });
  await controller.activate();
  const conversation = { id: '6f1c2d3e-4a5b-4c6d-8e7f-001122334455', title: 'D', messageCount: 2 };
  controller.send('Soru');
  const [run] = turns;
  run.onEvent({ type: 'accepted', data: { conversation, userMessage: { id: 'u1', content: 'Soru', turnId: run.input.turnId }, context: {}, rotaData: true } });
  run.resolve({ ok: true, done: { conversation, evidenceCards: validDescriptor(), assistantMessage: { id: 'a1', content: 'Toplam **2** görev var.', rotaData: true, evidence: [] } } });
  await new Promise((resolve) => setImmediate(resolve));
  const answer = controller.getState().active.turns[0].answer;
  assert.ok(answer.evidenceCards?.value?.cards?.length, 'canlı yanıt kart taşır');
  assert.ok(Number.isFinite(answer.evidenceCards.receivedAt));
  // Rota verisi olmayan (genel) yanıt kart taşımaz.
  controller.send('İkinci');
  const second = turns[1];
  second.onEvent({ type: 'accepted', data: { conversation, userMessage: { id: 'u2', content: 'İkinci', turnId: second.input.turnId }, context: {} } });
  second.resolve({ ok: true, done: { conversation, evidenceCards: validDescriptor(), assistantMessage: { id: 'a2', content: 'Genel', rotaData: false } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().active.turns[1].answer.evidenceCards, undefined);
  // Gözlenen oturum hatası: panel hatası kurulur ve kartlar hemen silinir.
  controller.send('Üçüncü');
  const third = turns[2];
  third.resolve({ ok: false, code: 'UNAUTHORIZED', phase: 'request' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().active.turns.some((turn) => turn.answer?.evidenceCards), false);
  controller.dispose();
});

/* ── Çizimle aynı sıra ─────────────────────────────────────── */

test('çizim bağlı kalın düğümü tetikleyiciye sarar; metni uyuşmayan bağ olağan kalın metin kalır', () => {
  const text = '**Not:** Toplam **2** görev var ve **Görev 1** öne çıkıyor.';
  const descriptor = validDescriptor();
  const [block] = parseAssistantMarkdown(text, { rotaData: true });
  const bindingsFor = (anchors) => ({ anchors: new Map(anchors.map((anchor) => [anchor.strong, anchor])), cards: new Map(descriptor.cards.map((card) => [card.id, card])),
    receivedAt: Date.now(), counter: { next: 0 } });
  const element = renderBlock(block, 'b0', new Set(), bindingsFor([{ strong: 1, text: '2', card: 'c1' }]));
  const reference = findElement(element, (node) => node.type === EvidenceReference);
  assert.ok(reference, 'bağlı düğüm tetikleyiciye sarılmalı');
  assert.equal(reference.props.text, '2');
  assert.equal(findElement(reference.props.children, (node) => node.type === 'strong') !== null, true, 'metin kalın kalır');
  // Sıra doğru ama metin farklı (ör. kaymış bağ): sarılmaz.
  const mismatched = renderBlock(block, 'b0', new Set(), bindingsFor([{ strong: 2, text: '2', card: 'c1' }]));
  assert.equal(findElement(mismatched, (node) => node.type === EvidenceReference), null);
  // Kart yoksa çizim eskisiyle aynıdır.
  assert.equal(findElement(renderBlock(block, 'b0', new Set()), (node) => node.type === EvidenceReference), null);
});
