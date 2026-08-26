/**
 * Kod incelemesindeki P0–P3 bulgularının gerileme sınamaları.
 *
 * Her sınama, giderilen bulgunun DAVRANIŞINI sabitler: kod bir sonraki
 * düzenlemede eski hâline dönerse burada kırılır.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPersonLookup, resolveAvatarEntries } from '../src/components/avatarIdentity.js';
import { maskDateDraft, parseDisplayDate } from '../src/components/dateInputFormat.js';
import { restoreActualSnapshotIds } from '../src/data/api/createApiRepository.js';
import { migrateLegacyTaskSchedule } from '../src/data/migrations/legacyTaskSchedule.js';
import { normalizePriorityId, resolvePriority } from '../src/domain/constants/index.js';
import {
  htmlToPlainText,
  renderReminderEmail,
  sanitizeReminderHtml
} from '../src/domain/reminders/reminderTemplate.js';
import {
  selectWbsRollupIndex,
  selectWbsTaskRollup
} from '../src/domain/selectors/wbsSelectors.js';
import { safeExportName } from '../src/lib/exportProjectData.js';
import { createTaskPatchCoalescer } from '../src/state/persistence.js';
import { prepareProjectUpdateChanges } from '../src/state/projectCreation.js';
import { resolveTaskWbsMoveAccess } from '../src/state/projectWritePolicy.js';
import { selectWorkspacePeople } from '../src/state/selectors/workspaceSelectors.js';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

/* ── İstemci veri katmanı ───────────────────────────────────────── */

test('takma ad geri yüklemesi olmayan `deps` alanını UYDURMAZ', () => {
  const aliases = new Map([['server-1', 'task-1']]);
  const restored = restoreActualSnapshotIds({
    tasks: [{ id: 'server-1', projectId: 'p1' }, { id: 'server-2', projectId: 'p1', deps: [] }]
  }, aliases);

  // Alan yoksa eklenmez: `deps: []` "bağımlılık yok", eksik alan "bilgi
  // taşınmadı" demektir ve aynı yanıt iki farklı biçime çözülüyordu.
  assert.equal('deps' in restored.tasks[0], false);
  assert.deepEqual(restored.tasks[1].deps, []);
});

test('eski tarih alanı, kanonik alan boşken devralınır', () => {
  assert.equal(
    migrateLegacyTaskSchedule({ plannedStart: undefined, baslangicTarihi: '2026-03-02' }).plannedStart,
    '2026-03-02'
  );
  assert.equal(
    migrateLegacyTaskSchedule({ plannedStart: '2026-04-01', baslangicTarihi: '2026-03-02' }).plannedStart,
    '2026-04-01'
  );
  assert.equal('baslangicTarihi' in migrateLegacyTaskSchedule({ baslangicTarihi: '2026-03-02' }), false);
});

/* ── Kalıcılaştırma ─────────────────────────────────────────────── */

test('reddedilen yama, kuyrukta bekleyen bir kayıt varken de korunur', async () => {
  let failNext = true;
  const seen = [];
  const coalescer = createTaskPatchCoalescer((taskId, patch) => {
    seen.push(patch);
    if (failNext) {
      failNext = false;
      return Promise.resolve({ ok: false, error: { code: 'MUTATION_FAILED' } });
    }
    return Promise.resolve({ ok: true, value: null });
  }, { delayMs: 1 });

  // 1) İlk yama gönderilir ve REDDEDİLİR.
  await coalescer.schedule('t1', { task: 'ilk' });
  // 2) Kullanıcı yazmaya devam eder: saklanan yama yeni yamanın ALTINA serilir.
  await coalescer.schedule('t1', { description: 'ikinci' });

  assert.deepEqual(seen[0], { task: 'ilk' });
  assert.deepEqual(seen[1], { task: 'ilk', description: 'ikinci' });
  assert.equal(coalescer.hasUnsavedChanges(), false);
  coalescer.dispose();
});

/* ── WBS toplulaştırma ──────────────────────────────────────────── */

test('WBS toplulaştırma indeksi ile tekil toplulaştırma AYNI kenarları izler', () => {
  // `p2/child`, ebeveyni başka projede olduğu için ağaçta ayrı bir köktür.
  const wbs = [
    { id: 'p2-child', projectId: 'p2', parentId: 'p1-root', code: '2', name: 'Çapraz', sortOrder: 1 },
    { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'Kök', sortOrder: 1 },
    { id: 'p1-leaf', projectId: 'p1', parentId: 'p1-root', code: '1.1', name: 'Yaprak', sortOrder: 2 }
  ];
  const tasks = [
    { id: 'a', wbsId: 'p1-leaf', status: 'done', progress: 100, plannedDurationDays: 1 },
    { id: 'b', wbsId: 'p2-child', status: 'todo', progress: 0, plannedDurationDays: 1 }
  ];

  const index = selectWbsRollupIndex(wbs, tasks);
  for (const node of wbs) {
    assert.deepEqual(
      [index.get(node.id).taskCount, index.get(node.id).progress],
      [selectWbsTaskRollup(wbs, tasks, node.id).taskCount, selectWbsTaskRollup(wbs, tasks, node.id).progress],
      node.id
    );
  }
  // Çapraz proje kenarı KULLANILMAZ: kök yalnızca kendi projesini toplar.
  assert.equal(index.get('p1-root').taskCount, 1);
  assert.equal(index.get('p2-child').taskCount, 1);
});

/* ── Durum katmanı ──────────────────────────────────────────────── */

test('proje ekibi kimlikleri METİN olarak karşılaştırır', () => {
  const state = {
    workspaceMode: 'project',
    selectedProjectId: 'p1',
    projects: [{ id: 'p1', name: 'Proje', leadId: 7 }],
    people: [{ id: 7, name: 'Lider' }, { id: 12, name: 'Sorumlu' }, { id: 99, name: 'İlgisiz' }],
    tasks: [{ id: 't1', projectId: 'p1', assigneeIds: ['12'] }]
  };
  assert.deepEqual(selectWorkspacePeople(state).map((person) => person.id), [7, 12]);
});

test('görev WBS taşıması sayısal/metin kimlik karışımında reddedilmez', () => {
  const state = {
    projects: [{ id: 1, name: 'Proje', accessLevel: 'FULL' }],
    wbs: [{ id: 'w1', projectId: '1' }],
    tasks: [{ id: 't1', projectId: 1, wbsId: 'w1' }]
  };
  assert.equal(resolveTaskWbsMoveAccess(state, ['t1'], 'w1').ok, true);
});

test('katalogda bulunmayan etiket yeniden adlandırması SESSİZCE düşmez', () => {
  const context = {
    projects: [{
      id: 'p1',
      name: 'Proje',
      code: 'P1',
      color: 'blue',
      leadId: 'u1',
      calendarId: 'cal-1',
      accessLevel: 'FULL',
      tags: [{ name: 'Eski' }]
    }],
    people: [{ id: 'u1', name: 'Lider' }],
    calendars: [{ id: 'cal-1', name: 'Takvim' }],
    wbs: []
  };
  const result = prepareProjectUpdateChanges('p1', {
    tags: [{ name: 'Eski' }],
    tagRenames: [{ from: 'Eski', to: 'Yeni' }]
  }, context);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROJECT_TAG_RENAME_TARGET_MISSING');
});

/* ── Bileşenler ─────────────────────────────────────────────────── */

test('aynı adı taşıyan ikinci sorumlu avatar yığınından DÜŞMEZ', () => {
  const lookup = createPersonLookup([{ id: '1', name: 'Ali Veli' }, { id: '2', name: 'Ali Veli' }]);
  // Yalnızca biri kimlikle çözülür; ötekisi ad üzerinden gelir. Ad KÜMESİYLE
  // eleme yapıldığında ikinci sorumlu yığından tümüyle kayboluyordu.
  const entries = resolveAvatarEntries({ personIds: ['1'], names: ['Ali Veli', 'Ali Veli'], lookup });
  assert.equal(entries.length, 2);

  // Tek sorumlu iki kez sayılmaz.
  const single = resolveAvatarEntries({ personIds: ['1'], names: ['Ali Veli'], lookup });
  assert.equal(single.length, 1);
});

test('kullanıcının yazdığı ayraç tarih grubunu KAPATIR', () => {
  assert.equal(maskDateDraft('1/2/2026'), '01/02/2026');
  assert.equal(parseDisplayDate(maskDateDraft('1/2/2026')), '2026-02-01');
  // Rakamla yazılan giriş eskisi gibi çalışır.
  assert.equal(maskDateDraft('18082026'), '18/08/2026');
});

test('öncelik araması `Object.prototype` anahtarlarına takılmaz', () => {
  assert.equal(normalizePriorityId('constructor'), 'medium');
  assert.equal(normalizePriorityId('toString'), 'medium');
  assert.equal(typeof resolvePriority('constructor').color, 'string');
});

test('dışa aktarma adı Türkçe harfleri bozmaz', () => {
  assert.equal(safeExportName('Ağustos Raporu'), 'Ağustos_Raporu');
  assert.equal(safeExportName('İstanbul'), 'İstanbul');
});

/* ── Hatırlatma şablonu ─────────────────────────────────────────── */

test('yer tutucu değeri de stil/URL izin listesinden geçer', () => {
  const rendered = renderReminderEmail(
    { subject: 'x', body: '<p style="color: {{keyword}}">gövde</p>' },
    { keyword: 'red; background-image: url(https://tracker.example/p.gif)' }
  );
  assert.match(rendered.bodyHtml, /style="color: red"/);
  assert.doesNotMatch(rendered.bodyHtml, /background-image/);
  assert.doesNotMatch(rendered.bodyHtml, /tracker\.example/);
});

test('tırnak içindeki `>` etiketi bitirmez', () => {
  const html = sanitizeReminderHtml('<a href="https://x.example/?a=1" title="a > b">bağlantı</a>');
  assert.match(html, /href="https:\/\/x\.example\/\?a=1"/);
  assert.match(html, /bağlantı<\/a>/);
});

test('düz metin dönüşümü varlıkları TEK geçişte çözer', () => {
  // `&amp;lt;` HTML'de `&lt;` gösterir; iki geçişli çözüm bunu `<` yapıyordu.
  assert.equal(htmlToPlainText('<p>A &amp;lt; B</p>'), 'A &lt; B');
  assert.equal(htmlToPlainText('<p>A &lt; B</p>'), 'A < B');
});

/* ── Keycloak yapılandırması ────────────────────────────────────── */

test('adreste gömülü realm ile ayrı realm değeri ÇELİŞİRSE issuer üretilmez', async () => {
  registerServerOnlyShim();
  const { deriveIssuerUrl } = await import('../src/server/identity/keycloakConfig.js');
  assert.equal(deriveIssuerUrl('https://kimlik.example/realms/kurum', 'kurum'), 'https://kimlik.example/realms/kurum');
  // Yönetici bir realm yazmışken adres başka bir realm'e işaret ediyorsa bu bir
  // yapılandırma hatasıdır; realm değeri sessizce yok sayılmaz.
  assert.equal(deriveIssuerUrl('https://kimlik.example/realms/kurum', 'baska'), '');
  assert.equal(deriveIssuerUrl('https://kimlik.example', 'kurum'), 'https://kimlik.example/realms/kurum');
});

test('temel adres eksikken realm İKİNCİ bir eksik olarak bildirilmez', async () => {
  registerServerOnlyShim();
  const { keycloakConfigurationIssues } = await import('../src/server/identity/keycloakConfig.js');
  const issues = keycloakConfigurationIssues({
    baseUrl: '',
    issuerUrl: '',
    clientId: 'c',
    jwksUri: 'j',
    sessionSecret: 'x'.repeat(32),
    flow: 'authorization-code'
  });
  assert.deepEqual(issues, ['MERGEN_ROTA_KEYCLOAK_BASE_URL']);
});

/* ── SMTP oturumu ───────────────────────────────────────────────── */

test('zaman aşımına uğrayan bekleyici kuyruktan DÜŞÜRÜLÜR', async () => {
  registerServerOnlyShim();
  const { createSmtpDialogue } = await import('../src/server/mail/smtpClient.js');
  const { EventEmitter } = await import('node:events');

  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.write = () => {};
  const dialogue = createSmtpDialogue(socket, 5);

  await assert.rejects(() => dialogue.read(), /zamanında yanıt vermedi/);
  // Ölü kayıt kuyrukta kalsaydı bu satır ONA teslim edilir ve sonraki bütün
  // yanıtlar bir kayardı.
  const next = dialogue.read();
  socket.emit('data', '250 OK\r\n');
  assert.equal((await next).code, 250);
});

test('şifrelenmemiş kanalda kimlik bilgisi GÖNDERİLMEZ', async () => {
  registerServerOnlyShim();
  const { getSmtpConfig } = await import('../src/server/mail/smtpConfig.js');
  const previous = { ...process.env };
  try {
    process.env.SMTP_HOST = 'smtp.example.internal';
    process.env.SMTP_FROM = 'rota@example.internal';
    process.env.SMTP_USE_STARTTLS = 'false';
    delete process.env.SMTP_ALLOW_INSECURE_AUTH;
    const config = getSmtpConfig();
    assert.equal(config.useStartTls, false);
    assert.equal(config.allowInsecureAuth, false);

    // Geçersiz gönderen adresi YAPILANDIRMA anında yakalanır.
    process.env.SMTP_FROM = 'gecersiz-adres';
    assert.throws(() => getSmtpConfig(), /SMTP_FROM must be a valid email address/);
  } finally {
    for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USE_STARTTLS', 'SMTP_ALLOW_INSECURE_AUTH']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
