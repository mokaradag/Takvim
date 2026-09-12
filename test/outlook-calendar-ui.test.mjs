/**
 * Outlook takvim eyleminin arayüz davranışı.
 *
 * Gerçek bileşenler tarayıcı olmadan çalıştırılır: yükleme, eklendi, hata,
 * kaldırma ve toplu kısmi başarı durumları buradan sınanır. Ağ katmanı
 * enjekte edilir; hiçbir istek gerçekten gönderilmez.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';

const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');
const { OutlookCalendarAction } = await import('../src/features/outlook/OutlookCalendarAction.jsx');
const { OutlookBulkAction } = await import('../src/features/outlook/OutlookBulkAction.jsx');
const { ReadOnlyTaskDrawer } = await import('../src/features/task-detail/ReadOnlyTaskDrawer.jsx');
const { TaskDrawer } = await import('../src/features/task-detail/TaskDrawer.jsx');
const { SimpleTaskDrawer } = await import('../src/features/task-detail/SimpleTaskDrawer.jsx');
const store = await import('../src/features/outlook/outlookSubscriptionStore.js');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const TASK = Object.freeze({
  id: 'task-1',
  task: 'Teklif dosyasının hazırlanması',
  proje: 'İHA Projesi',
  projectCode: 'P4417041',
  targetFinish: '2026-09-15'
});

function state(overrides = {}) {
  return {
    enabled: true,
    mailConfigured: true,
    schemaReady: true,
    bulkLimit: 25,
    tasks: [],
    ...overrides
  };
}

async function prepareStore(response = state()) {
  store.resetOutlookStore();
  await store.ensureOutlookState({ load: async () => ({ ok: true, ...response }) });
}

/**
 * Gerçek Sistem veri kipini kurar.
 *
 * `await` ŞARTTIR: kip yalnızca `run()` sözü çözülünceye kadar açık kalmalıdır,
 * aksi hâlde ilk `await` sonrasında bileşen yeniden Demo Kipte çizilir.
 */
async function withActualDataMode(run) {
  const previous = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  try {
    return await run();
  } finally {
    DataModeContext._currentValue = previous;
  }
}

function buttonWithLabel(tree, text) {
  return findElement(tree, (node) => node.type === 'button'
    && JSON.stringify(node.props?.children ?? '').includes(text));
}

/* ── Tekil eylem ────────────────────────────────────────────────── */

test(`eklenmemiş görevde eylem "Outlook'a Ekle" olarak görünür ve etkindir`, async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    const view = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
    try {
      const button = buttonWithLabel(view.output, "Outlook'a Ekle");
      assert.ok(button, 'ekleme düğmesi görünmelidir');
      assert.equal(button.props.disabled, false);
      assert.match(button.props.title, /kendi Outlook takviminize/);
    } finally { view.unmount(); }
  });
});

test('ekleme başarılıysa bağlantı etkin görünür ve sıkışık menü açılır', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    const calls = [];
    const actions = {
      add: (taskId) => store.addTaskToOutlook(taskId, {
        request: async (id) => { calls.push(id); return { ok: true, status: 'ADDED', message: 'Outlook daveti gönderildi.' }; }
      }),
      resend: async () => ({ ok: true, message: 'Outlook daveti yeniden gönderildi.' }),
      remove: async () => ({ ok: true, message: 'Outlook bağlantısı kapatıldı.' })
    };
    const view = mountComponent(OutlookCalendarAction, { task: TASK, actions });
    try {
      await buttonWithLabel(view.output, "Outlook'a Ekle").props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();

      assert.deepEqual(calls, ['task-1']);
      const added = buttonWithLabel(view.output, 'Outlook bağlantısı etkin');
      assert.ok(added, 'eklendi durumu görünmelidir');
      assert.equal(added.props['aria-haspopup'], 'menu');
      assert.equal(added.props['aria-expanded'], false);
      // Başarı iletisi kullanıcıya gösterilir.
      assert.match(JSON.stringify(view.output), /Outlook daveti gönderildi/);

      added.props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();
      assert.ok(buttonWithLabel(view.output, 'yeniden gönder'), 'yeniden gönderme eylemi menüde olmalıdır');
      assert.ok(buttonWithLabel(view.output, 'kaldır'), 'kaldırma eylemi menüde olmalıdır');
    } finally { view.unmount(); }
  });
});

test('kaldırma aboneliği düşürür ve eylem yeniden "ekle" durumuna döner', async () => {
  await prepareStore(state({ tasks: [{ taskId: 'task-1', delivered: true }] }));
  await withActualDataMode(async () => {
    const actions = {
      add: async () => ({ ok: true }),
      resend: async () => ({ ok: true }),
      remove: (taskId) => store.removeTaskFromOutlook(taskId, {
        request: async () => ({ ok: true, status: 'REMOVED', message: 'Outlook bağlantısı kapatıldı.' })
      })
    };
    const view = mountComponent(OutlookCalendarAction, { task: TASK, actions });
    try {
      const added = buttonWithLabel(view.output, 'Outlook bağlantısı etkin');
      assert.ok(added, 'sunucudan gelen abonelik "eklendi" olarak çizilmelidir');
      added.props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();

      await buttonWithLabel(view.output, 'kaldır').props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();

      assert.ok(buttonWithLabel(view.output, "Outlook'a Ekle"));
      assert.match(JSON.stringify(view.output), /bağlantısı kapatıldı/);
    } finally { view.unmount(); }
  });
});

test('termini silinmiş görev takvimden yine de KALDIRILABİLİR', async () => {
  await prepareStore(state({ tasks: [{ taskId: 'task-1', delivered: true }] }));
  await withActualDataMode(async () => {
    let removed = 0;
    const actions = {
      add: async () => ({ ok: true }),
      resend: async () => ({ ok: true }),
      remove: (taskId) => store.removeTaskFromOutlook(taskId, {
        request: async () => { removed += 1; return { ok: true, subscribed: false, status: 'REMOVED', message: 'Outlook bağlantısı kapatıldı.' }; }
      })
    };
    // Termin kaldırılmıştır: ekleme kapalıdır ama randevu Outlook'ta durmaktadır.
    const view = mountComponent(OutlookCalendarAction, { task: { ...TASK, targetFinish: null }, actions });
    try {
      buttonWithLabel(view.output, 'Outlook bağlantısı etkin').props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();
      const resend = buttonWithLabel(view.output, 'yeniden gönder');
      assert.equal(resend.props.disabled, true, 'kapalı durumda yeniden gönderme yapılmaz');

      await buttonWithLabel(view.output, 'kaldır').props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();

      assert.equal(removed, 1);
      assert.ok(buttonWithLabel(view.output, "Outlook'a Ekle"));
    } finally { view.unmount(); }
  });
});

test('sunucu hatası kullanıcıya bildirilir ve durum "eklendi" olmaz', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    const actions = {
      add: (taskId) => store.addTaskToOutlook(taskId, {
        request: async () => ({ ok: false, code: 'SMTP_CONNECTION_FAILED', message: 'E-posta sunucusuna ulaşılamadı.' })
      }),
      resend: async () => ({ ok: true }),
      remove: async () => ({ ok: true })
    };
    const view = mountComponent(OutlookCalendarAction, { task: TASK, actions });
    try {
      await buttonWithLabel(view.output, "Outlook'a Ekle").props.onClick({ preventDefault() {}, stopPropagation() {} });
      view.render();

      assert.ok(buttonWithLabel(view.output, "Outlook'a Ekle"), 'başarısız istek "eklendi" göstermez');
      assert.match(JSON.stringify(view.output), /E-posta sunucusuna ulaşılamadı/);
    } finally { view.unmount(); }
  });
});

test('Demo Kipte, kapalı özellikte ve termini olmayan görevde eylem kapalıdır', async () => {
  await prepareStore();
  const demo = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
  try {
    const button = buttonWithLabel(demo.output, "Outlook'a Ekle");
    assert.equal(button.props.disabled, true);
    assert.match(button.props.title, /Gerçek Sistem/);
  } finally { demo.unmount(); }

  await withActualDataMode(async () => {
    const undated = mountComponent(OutlookCalendarAction, { task: { ...TASK, targetFinish: null }, actions: {} });
    try {
      assert.match(buttonWithLabel(undated.output, "Outlook'a Ekle").props.title, /termin/);
    } finally { undated.unmount(); }
  });

  await prepareStore(state({ enabled: false }));
  await withActualDataMode(async () => {
    const disabled = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
    try {
      const button = buttonWithLabel(disabled.output, "Outlook'a Ekle");
      assert.equal(button.props.disabled, true);
      assert.match(button.props.title, /kapalı/);
    } finally { disabled.unmount(); }
  });

  await prepareStore(state({ mailConfigured: false }));
  await withActualDataMode(async () => {
    const noMail = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
    try {
      // Arayüz "gönderildi" demez; nedeni açıkça yazar.
      assert.match(buttonWithLabel(noMail.output, "Outlook'a Ekle").props.title, /e-posta gönderimi yapılandırılmadığı/);
    } finally { noMail.unmount(); }
  });
});

test('kaydedilmemiş değişiklik varken eylem kapalıdır ve nedeni söylenir', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    const view = mountComponent(OutlookCalendarAction, {
      task: TASK,
      disabledReason: "Outlook'a eklemeden önce değişiklikleri Kaydet ile kaydedin.",
      actions: {}
    });
    try {
      const button = buttonWithLabel(view.output, "Outlook'a Ekle");
      assert.equal(button.props.disabled, true);
      assert.match(button.props.title, /Kaydet ile kaydedin/);
    } finally { view.unmount(); }
  });
});

/* ── Toplu eylem ────────────────────────────────────────────────── */

test('toplu eylem sonucu özetler ve yerelde atlanan görevlerin seçimini korur', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    let completed = null;
    const tasks = [TASK, { id: 'task-2', task: 'İkinci', targetFinish: '2026-09-20' }, { id: 'task-3', task: 'Terminsiz' }];
    const action = (ids) => store.addTasksToOutlook(ids, {
      request: async () => ({
        ok: true,
        summary: { added: 1, alreadyAdded: 1, failed: 0, total: 2 },
        results: [
          { taskId: 'task-1', status: 'ADDED' },
          { taskId: 'task-2', status: 'ALREADY_ADDED' }
        ]
      })
    });
    const view = mountComponent(OutlookBulkAction, { tasks, action, onCompleted: (value) => { completed = value; } });
    try {
      await buttonWithLabel(view.output, "Seçilenleri Outlook'a Ekle").props.onClick();
      view.render();

      const text = JSON.stringify(view.output);
      assert.match(text, /1 Outlook daveti gönderildi, 1 Outlook bağlantısı zaten günceldi\./);
      // Termini olmayan görev sessizce düşürülmez.
      assert.match(text, /1 görev termini olmadığı için atlandı/);
      assert.equal(completed, null, 'terminsiz görevlerin seçimi korunmalıdır');
    } finally { view.unmount(); }
  });
});

test('toplu ok yanıtı görev sonuçları olmadan seçimi temizlemez', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    let cleared = false;
    const view = mountComponent(OutlookBulkAction, {
      tasks: [TASK],
      onCompleted: () => { cleared = true; },
      action: async () => ({ ok: true, summary: { failed: 0, total: 1 } })
    });
    try {
      await buttonWithLabel(view.output, "Seçilenleri Outlook'a Ekle").props.onClick();
      assert.equal(cleared, false, 'tek tek başarı kanıtı yoksa seçim korunmalıdır');
    } finally { view.unmount(); }
  });
});

test('toplu eylem sunucu sınırını aşan seçimde kapalıdır', async () => {
  await prepareStore(state({ bulkLimit: 2 }));
  await withActualDataMode(async () => {
    const tasks = [1, 2, 3].map((index) => ({ id: `task-${index}`, task: `Görev ${index}`, targetFinish: '2026-09-15' }));
    const view = mountComponent(OutlookBulkAction, { tasks, action: async () => ({ ok: true }) });
    try {
      const button = buttonWithLabel(view.output, "Seçilenleri Outlook'a Ekle");
      assert.equal(button.props.disabled, true);
      assert.match(button.props.title, /en çok 2 görev/);
    } finally { view.unmount(); }
  });
});

test('termini olmayan görevlerden oluşan seçimde toplu eylem kapalıdır', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    const view = mountComponent(OutlookBulkAction, { tasks: [{ id: 'x', task: 'Terminsiz' }], action: async () => ({ ok: true }) });
    try {
      assert.match(buttonWithLabel(view.output, "Seçilenleri Outlook'a Ekle").props.title, /termini yok/);
    } finally { view.unmount(); }
  });
});

/* ── Panel ve tablo tümleşmesi ──────────────────────────────────── */

test('istemci takma adı ile çıplak GUID aynı aboneliği gösterir', async () => {
  const guid = 'c3c3c3c3-3333-4333-8333-333333333333';
  assert.equal(store.outlookTaskKey(`task-${guid}`), guid);
  assert.equal(store.outlookTaskKey(guid.toUpperCase()), guid);
  assert.equal(store.outlookTaskKey('  '), '');

  // Sunucu çıplak GUID döner; arayüz `task-<uuid>` takma adını taşır.
  await prepareStore(state({ tasks: [{ taskId: guid.toUpperCase(), delivered: true }] }));
  await withActualDataMode(async () => {
    const view = mountComponent(OutlookCalendarAction, {
      task: { ...TASK, id: `task-${guid}` },
      actions: {}
    });
    try {
      assert.ok(buttonWithLabel(view.output, 'Outlook bağlantısı etkin'), 'takma adlı görev de "eklendi" görünmelidir');
    } finally { view.unmount(); }
  });
});

test('salt okunur görev paneli Outlook eylemini taşır', async () => {
  await prepareStore();
  globalThis[CLIENT_STATE] = { people: [], workspace: { people: [] }, tasks: [], projects: [] };
  try {
    await withActualDataMode(async () => {
      const view = mountComponent(ReadOnlyTaskDrawer, { task: TASK, onClose() {} });
      try {
        assert.ok(findElement(view.output, (node) => node.type === OutlookCalendarAction),
          'salt okunur panelde Outlook eylemi bulunmalıdır');
      } finally { view.unmount(); }
    });
  } finally {
    delete globalThis[CLIENT_STATE];
  }
});

test('düzenlenebilir paneller Outlook eylemini kaydedilmemiş değişiklik uyarısıyla taşır', async () => {
  const project = { id: 'project-1', code: 'P4417041', name: 'İHA Projesi', sourceType: 'MANUAL', isActive: true, tags: [] };
  const root = { id: 'wbs-1', projectId: project.id, parentId: null, code: 'P4417041', name: 'Kök', sortOrder: 0 };
  const editableTask = {
    ...TASK,
    projectId: project.id,
    wbsId: root.id,
    status: 'todo',
    priority: 'normal',
    assigneeIds: [],
    progress: 0,
    plannedStart: '2026-09-15',
    plannedFinish: '2026-09-15'
  };
  globalThis[CLIENT_STATE] = {
    people: [], projects: [project], calendars: [], wbs: [root], tasks: [editableTask],
    baselines: [], taskBaselineSnapshots: [], assignmentScopeSicils: [], assignableProjects: [],
    isExecutive: false, isSystemAdmin: false,
    workspace: { people: [], projects: [project], wbs: [root], tasks: [editableTask] }
  };
  try {
    await withActualDataMode(async () => {
      for (const [Drawer, extraProps] of [
        [TaskDrawer, { tasks: [editableTask] }],
        [SimpleTaskDrawer, {}]
      ]) {
        const view = mountComponent(Drawer, {
          task: editableTask,
          onClose() {},
          onUpdate() {},
          onDelete() {},
          canDelete: false,
          canManageAssignees: false,
          hasUnsavedChanges: true,
          ...extraProps
        });
        try {
          const action = findElement(view.output, (node) => node.type === OutlookCalendarAction);
          assert.ok(action, `${Drawer.name} Outlook eylemini taşımalıdır`);
          assert.match(action.props.disabledReason, /Kaydet ile kaydedin/);
        } finally { view.unmount(); }
      }
    });
  } finally {
    delete globalThis[CLIENT_STATE];
  }
});

test('Görevler tablosu toplu seçim sütunu ve toplu eylem çubuğu taşır', () => {
  const source = read('src/features/tasks/TasksView.jsx');
  assert.match(source, /<OutlookBulkAction tasks=\{selectedTasks\}/);
  assert.match(source, /aria-label="Sayfadaki görevleri seç"/);
  assert.match(source, /görevini seç/);
  // Seçim kutusu satır tıklamasını yutar: kutuyu işaretlemek paneli açmaz.
  assert.match(source, /className="tasks-select-cell" onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  // Boş tablo satırı yeni sütunu da kapsar.
  assert.match(source, /colSpan=\{13\}/);
});

test('istemci katmanı SMTP yapılandırmasını ve alıcı adresini hiç görmez', () => {
  for (const path of [
    'src/features/outlook/outlookClient.js',
    'src/features/outlook/outlookSubscriptionStore.js',
    'src/features/outlook/OutlookCalendarAction.jsx',
    'src/features/outlook/OutlookBulkAction.jsx',
    'src/features/outlook/outlookPresentation.js'
  ]) {
    const source = read(path);
    assert.equal(source.includes('SMTP_'), false, `${path} SMTP yapılandırmasını okumamalıdır`);
    assert.equal(/\bto:\s*\[/.test(source), false, `${path} alıcı listesi göndermemelidir`);
  }
  // İstemci yalnızca görev kimliği gönderir.
  const client = read('src/features/outlook/outlookClient.js');
  assert.match(client, /JSON\.stringify\(\{ taskIds \}\)/);
  assert.equal(client.includes('email'), false);
});

test('ilk yükleme tamamlanmadan Outlook eylemi etkinleşmez', async () => {
  store.resetOutlookStore();
  await withActualDataMode(async () => {
    const view = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
    try { assert.equal(buttonWithLabel(view.output, "Outlook'a Ekle").props.disabled, true); }
    finally { view.unmount(); store.resetOutlookStore(); }
  });
});

test('bekleyen veya başarısız ilk davet teslim edilmiş gibi gösterilmez', async () => {
  for (const failureCode of [null, 'DELIVERY_FAILED']) {
    await prepareStore(state({ tasks: [{ taskId: TASK.id, pending: true, delivered: false, failureCode }] }));
    await withActualDataMode(async () => {
      const view = mountComponent(OutlookCalendarAction, { task: TASK, actions: {} });
      try {
        assert.equal(buttonWithLabel(view.output, 'Outlook bağlantısı etkin'), null);
        assert.ok(buttonWithLabel(view.output, failureCode ? 'başarısız' : 'bekliyor'));
      } finally { view.unmount(); }
    });
  }
});

test('geçici okuma hatası yeniden denenir, süren okumalar birleştirilir', async () => {
  store.resetOutlookStore();
  let calls = 0;
  const load = async () => { calls += 1; return calls === 1 ? { ok: false } : { ok: true, ...state() }; };
  await Promise.all([store.ensureOutlookState({ load }), store.ensureOutlookState({ load })]);
  assert.equal(calls, 1);
  assert.equal(store.getOutlookSnapshot().status, 'error');
  await store.ensureOutlookState({ load });
  assert.equal(calls, 2);
  assert.equal(store.getOutlookSnapshot().status, 'ready');
});

test('veri kipi değişimi eski isteğin sonucunu yeni bağlama taşımaz', async () => {
  store.resetOutlookStore();
  store.setOutlookDataMode('actual');
  let resolve;
  const first = store.ensureOutlookState({ load: () => new Promise((done) => { resolve = done; }) });
  await Promise.resolve();
  store.setOutlookDataMode('demo');
  store.setOutlookDataMode('actual');
  await store.ensureOutlookState({ load: async () => ({ ok: true, ...state({ enabled: false }) }) });
  resolve({ ok: true, ...state({ tasks: [{ taskId: TASK.id, delivered: true }] }) });
  await first;
  assert.equal(store.getOutlookSnapshot().enabled, false);
  assert.equal(store.isTaskInOutlook(store.getOutlookSnapshot(), TASK.id), false);
});

test('eylemler abonelik durumunu sunucu yanıtından alır', async () => {
  await prepareStore(state({ tasks: [{ taskId: TASK.id, delivered: true }] }));
  await store.resendOutlookInvitation(TASK.id, { request: async () => ({ ok: true, status: 'REMOVED', subscribed: false }) });
  assert.equal(store.isTaskInOutlook(store.getOutlookSnapshot(), TASK.id), false);
  await store.removeTaskFromOutlook(TASK.id, { request: async () => ({ ok: true, status: 'IN_PROGRESS', subscribed: true, pending: true, delivered: true }) });
  assert.equal(store.isTaskInOutlook(store.getOutlookSnapshot(), TASK.id), true);
  assert.equal(store.outlookTaskState(store.getOutlookSnapshot(), TASK.id).pending, true);
});

test('toplu kısmi hata yeniden denenecek seçimi korur', async () => {
  await prepareStore();
  await withActualDataMode(async () => {
    let cleared = false;
    const view = mountComponent(OutlookBulkAction, {
      tasks: [TASK], onCompleted: () => { cleared = true; },
      action: async () => ({ ok: true, summary: { failed: 1, total: 1 }, results: [{ taskId: TASK.id, status: 'FAILED' }] })
    });
    try {
      await buttonWithLabel(view.output, "Seçilenleri Outlook'a Ekle").props.onClick();
      assert.equal(cleared, false);
      view.render();
      assert.match(JSON.stringify(view.output), /1 görev eklenemedi/);
    } finally { view.unmount(); }
  });
});

test('farklı görevlerin eşzamanlı sonuçları birbirini silmez', async () => {
  await prepareStore();
  let resolve;
  const first = store.addTaskToOutlook('a', { request: () => new Promise((done) => { resolve = done; }) });
  await store.addTaskToOutlook('b', { request: async () => ({ ok: true, status: 'ADDED', subscribed: true, delivered: true }) });
  resolve({ ok: true, status: 'ADDED', subscribed: true, delivered: true });
  await first;
  assert.deepEqual([...store.getOutlookSnapshot().subscribed].sort(), ['a', 'b']);
  assert.equal(store.getOutlookSnapshot().busy.size, 0);
});

for (const [delivery, label] of [
  [{ delivered: true }, 'Outlook bağlantısı etkin'],
  [{ delivered: true, pending: true }, 'Outlook gönderimi bekliyor'],
  [{ delivered: true, pending: true, failureCode: 'DELIVERY_FAILED' }, 'Outlook gönderimi başarısız'],
  [{ delivered: false, completionSuspended: true }, 'Outlook bağlantısı bekletiliyor']
]) {
  test(`abonelik ve davet durumu takvim onayı iddia etmez: ${label}`, async () => {
    await prepareStore(state({ tasks: [{ taskId: TASK.id, ...delivery }] }));
    await withActualDataMode(async () => {
      const task = { ...TASK, status: delivery.completionSuspended ? 'done' : 'todo' };
      const view = mountComponent(OutlookCalendarAction, { task, actions: {} });
      try {
        const button = buttonWithLabel(view.output, label);
        assert.ok(button);
        assert.doesNotMatch(JSON.stringify(view.output), /Outlook'a eklendi/);
        assert.equal(store.isTaskInOutlook(store.getOutlookSnapshot(), task.id), true);
        assert.equal(store.outlookTaskState(store.getOutlookSnapshot(), task.id).delivered, delivery.delivered);
        if (!delivery.completionSuspended) assert.match(button.props.title, /kabul veya takvim durumunu doğrulamaz/);
        button.props.onClick({ preventDefault() {}, stopPropagation() {} }); view.render();
        const resend = buttonWithLabel(view.output, 'Outlook davetini yeniden gönder');
        assert.ok(resend);
        assert.equal(Boolean(resend.props.disabled), Boolean(delivery.completionSuspended));
        assert.equal(buttonWithLabel(view.output, "Outlook'tan kaldır").props.disabled, false);
      } finally { view.unmount(); }
    });
  });
}
