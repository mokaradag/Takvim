import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import {
  decideCoordinationAndRefresh,
  notificationActionError,
  openTaskNotification
} from '../src/features/notifications/notificationActions.js';

const { useTaskNotificationQuery } = await import('../src/features/notifications/useTaskNotificationQuery.js');
const { NotificationHistorySection } = await import('../src/features/notifications/NotificationHistorySection.jsx');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const session = (sicil = 100) => ({ dataMode: 'actual', currentUser: { employeeNo: String(sicil), name: 'Kullanıcı' } });
const page = (id = 'n1', extra = {}) => ({
  items: [{ id, source: 'TASK_EVENT', kind: 'TASK_ASSIGNED', taskId: 't1', taskCount: 1,
    taskTitle: 'Görev', unread: true, taskAvailable: true, sortAt: '2026-10-16T12:00:00Z' }],
  total: 61, page: 0, pageSize: 25, counts: { pending: 61, history: 9 }, ...extra
});

test('aynı sorgu yenilenirken satır ve toplam yetkili kalır; yeni kapsam toplamı bilinmiyor olur', async () => {
  const previousFetch = globalThis.fetch;
  globalThis[CLIENT_STATE] = { session: session(100), actions: { openTask: async () => ({ ok: true }) } };
  let heldResolve = null;
  let mode = 'normal';
  globalThis.fetch = async (url) => {
    const tab = new URL(String(url), 'http://local').searchParams.get('tab');
    if (mode === 'hold' && tab === 'pending') return new Promise((resolve) => { heldResolve = resolve; });
    if (tab === 'history') return Response.json({ error: { message: 'Geçmiş yüklenemedi' } }, { status: 503 });
    return Response.json(page());
  };
  const view = mountComponent(({ tab = 'pending', pageNo = 0 }) => useTaskNotificationQuery({ tab, page: pageNo }), {});
  try {
    await delay(240); view.render();
    assert.equal(view.output.rowsKnown, true);
    assert.equal(view.output.totalKnown, true);
    assert.equal(view.output.data.total, 61);

    mode = 'hold';
    view.output.refresh(); view.render(); await delay(240); view.render();
    assert.equal(view.output.loading, true);
    assert.equal(view.output.refreshing, true);
    assert.equal(view.output.rowsKnown, true);
    assert.equal(view.output.totalKnown, true);
    assert.equal(view.output.data.items[0].id, 'n1');
    assert.equal(view.output.data.total, 61);

    const section = mountComponent(NotificationHistorySection, {
      result: view.output, setPage() {}, onChanged() {}
    });
    try {
      const readButton = findElement(section.output, (node) => node.type === 'button' && node.props.children === 'Okundu işaretle');
      assert.equal(readButton.props.disabled, false, 'arka plan yenilemesi geçerli satırı kilitlememelidir');
    } finally { section.unmount(); }

    heldResolve(Response.json(page('n2'))); await delay(0); view.render();
    assert.equal(view.output.data.items[0].id, 'n2');

    mode = 'normal';
    view.render({ tab: 'history', pageNo: 0 }); await delay(0); view.render();
    assert.equal(view.output.totalKnown, false);
    assert.deepEqual(view.output.data.items, []);
    await delay(240); view.render();
    assert.equal(view.output.error, 'Geçmiş yüklenemedi');
    assert.equal(view.output.totalKnown, false);
    assert.notEqual(view.output.data.total, 0, 'önceki toplam saklanabilir ama yeni kapsam için yetkili sayılmaz');
  } finally {
    view.unmount(); globalThis.fetch = previousFetch; delete globalThis[CLIENT_STATE];
  }
});

test('görev açma, okuma ve yenileme hataları birbirini gizlemez', async () => {
  const outcome = await openTaskNotification(
    { taskId: 't1', taskCount: 1 },
    async () => ({ ok: false, error: { message: 'Görev açılamadı' } }),
    async () => ({ ok: false, message: 'Okuma başarısız', refreshError: 'Yenileme başarısız' })
  );
  assert.deepEqual(
    [outcome.openError, outcome.readError, outcome.refreshError],
    ['Görev açılamadı', 'Okuma başarısız', 'Yenileme başarısız']
  );
  const message = notificationActionError(outcome);
  assert.match(message, /Görev açma: Görev açılamadı/);
  assert.match(message, /Okuma: Okuma başarısız/);
  assert.match(message, /Yenileme: Yenileme başarısız/);
});

test('başarılı koordinasyon kararı yenileme hatasıyla başarısızlığa dönüşmez', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ outcome: 'UPDATED' });
  try {
    const result = await decideCoordinationAndRefresh('c1', { decision: 'APPROVE' }, async () => {
      throw new Error('Yenileme başarısız');
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.outcome, 'UPDATED');
    assert.equal(result.refreshError, 'Yenileme başarısız');
  } finally { globalThis.fetch = previousFetch; }
});

test('alıcı değişirse görev açma sonrası okundu PATCH işlemi başlamaz ve görev açma koruması taşınır', async () => {
  let releaseOpen;
  let current = true;
  let readCalls = 0;
  let receivedGuard = null;
  const operation = openTaskNotification(
    { taskId: 't1', taskCount: 1 },
    async (_taskId, options) => {
      receivedGuard = options.isCurrent;
      return new Promise((resolve) => { releaseOpen = resolve; });
    },
    async () => { readCalls += 1; return { ok: true }; },
    () => current
  );
  await delay(0);
  assert.equal(receivedGuard(), true);
  current = false;
  assert.equal(receivedGuard(), false);
  releaseOpen({ ok: true });
  const outcome = await operation;
  assert.equal(outcome.stale, true);
  assert.equal(readCalls, 0);
});

test('openTask alıcı korumasını yenileme sonrasına ve UI mutasyonundan öncesine taşır', () => {
  const source = read('src/state/AppStateProvider.jsx');
  const start = source.indexOf('const openTask = useCallback(async (taskOrId, options = {}) => {');
  const end = source.indexOf('\n  /**', start);
  const block = source.slice(start, end);
  assert.ok(start >= 0);
  assert.match(block, /const isCurrent = typeof options\.isCurrent === 'function'/);
  assert.match(block, /const refreshed = await reloadData\(\{ refreshMode: 'manual' \}\);\n      if \(!isCurrent\(\)\) return \{ ok: false, stale: true \};/);
  const lastGuard = block.lastIndexOf("if (!isCurrent()) return { ok: false, stale: true };");
  const firstMutation = block.indexOf('taskCreationDraftRef.current = null;');
  assert.ok(lastGuard > 0 && lastGuard < firstMutation, 'son alıcı denetimi ilk UI mutasyonundan hemen önce olmalıdır');
});

test('sayfalama SQL yolları geniş geçmiş yerine dar nüfus ve son sayfa kimlikleri kullanır', () => {
  const taskSql = read('src/server/notifications/taskNotificationQueries.js');
  assert.match(taskSql, /#TaskNotificationPopulation/);
  assert.match(taskSql, /#TaskNotificationPageIds/);
  assert.doesNotMatch(taskSql, /INTO #TaskNotificationPage(?:\s|;)/);
  assert.match(taskSql, /INNER JOIN #TaskNotificationPageIds page/);

  const coordinationSql = read('src/server/assignment/assignmentCoordinationQueries.js');
  assert.match(coordinationSql, /#CoordinationPopulation/);
  assert.match(coordinationSql, /#CoordinationPageIds/);
  assert.doesNotMatch(coordinationSql, /INTO #CoordinationPage(?:\s|;)/);
  assert.match(coordinationSql, /INNER JOIN #CoordinationPageIds page/);
  assert.match(coordinationSql, /pageNeedsRequester/);
  assert.match(coordinationSql, /pageNeedsAssignee/);
});

test('Talepler bilinmeyen tarih toplamını sıfır diye çizmez', () => {
  const source = read('src/features/schedule-change/ScheduleRequestsView.jsx');
  assert.match(source, /dateRequests\.totalKnown === false \? '…' : data\.total/);
  assert.doesNotMatch(source, /<h3>Tarih değişikliği talepleri <span className="muted tabular">\(\{data\.total\}\)/);
});
