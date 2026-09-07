import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
const { TaskDetailOverlay } = await import('../src/features/task-detail/TaskDetailOverlay.jsx');
const { ScheduleRequestCenter } = await import('../src/features/schedule-change/ScheduleRequestCenter.jsx');

function fixture() {
  const task = { id: 't1', version: 'v1', task: 'Başlangıç', projectId: 'p1', wbsId: 'w1', assigneeIds: ['100'], sorumlu: ['Aynı Ad'], status: 'todo', priority: 'medium', description: 'Not', deps: [] };
  return { selectedTask: task, tasks: [task], projects: [{ id: 'p1', name: 'Proje', accessLevel: 'FULL', tags: [] }], people: [{ id: '100', employeeNo: '100', name: 'Aynı Ad' }, { id: '200', employeeNo: '200', name: 'Aynı Ad' }],
    currentUser: { id: '1' }, assignmentScopeSicils: [], assignableProjects: [], wbs: [{ id: 'w1', projectId: 'p1', name: 'Kök', code: '1', parentId: null }], calendars: [], baselines: [], taskBaselineSnapshots: [], scheduleRequests: [], actions: {} };
}
function editorFor(simple) {
  const outer = mountComponent(TaskDetailOverlay, { simple });
  const editor = mountComponent(outer.output.type, outer.output.props);
  const drawer = mountComponent(editor.output.type, editor.output.props);
  return { editor, drawer, sync() { editor.render(); drawer.render(editor.output.props); }, close() { drawer.unmount(); editor.unmount(); outer.unmount(); } };
}
function input(tree, predicate) {
  const element = findElement(tree, predicate);
  assert.ok(element, 'İstenen denetim bulunmalıdır.');
  return element;
}
for (const simple of [true, false]) {
  test(`${simple ? 'Temel' : 'Kapsamlı'} Kipte alan ve sorumlu düzenlemeleri yalnızca Kaydet ile gönderilir`, async () => {
    const state = fixture();
    const calls = [];
    let finish;
    let closeCalls = 0;
    state.actions = { saveTaskEdits: (edits) => { calls.push(edits); return new Promise((resolve) => { finish = resolve; }); }, closeTask: () => { closeCalls++; return { ok: true }; } };
    globalThis[CLIENT_STATE] = state;
    const view = editorFor(simple);
    try {
      input(view.drawer.output, (node) => ['input', 'textarea'].includes(node.type) && node.props.value === 'Başlangıç').props.onChange({ target: { value: 'Düzenlenmiş başlık' } });
      view.sync();
      const selector = input(view.drawer.output, (node) => node.props?.ariaLabel === 'Sorumlu ekle');
      assert.ok(selector.props.options.some((option) => option.value === '200'));
      selector.props.onChange('200');
      view.sync();
      assert.equal(calls.length, 0);
      assert.equal(state.tasks[0].task, 'Başlangıç');
      const save = input(view.drawer.output, (node) => node.type === 'button' && node.props.className === 'btn primary');
      const first = save.props.onClick();
      const repeated = save.props.onClick();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0][0].patch.assigneeIds, ['100', '200']);
      assert.equal(calls[0][0].patch.task, 'Düzenlenmiş başlık');
      view.sync();
      assert.equal(input(view.drawer.output, (node) => node.type === 'fieldset').props.disabled, true);
      assert.equal(closeCalls, 0);
      finish({ ok: true });
      await Promise.all([first, repeated]);
      assert.equal(closeCalls, 1);
    } finally { view.close(); delete globalThis[CLIENT_STATE]; }
  });

  test(`${simple ? 'Temel' : 'Kapsamlı'} Kipte kapanış ve boş başlık kalıcı yazma başlatmaz`, async () => {
    const state = fixture();
    let saves = 0;
    let closes = 0;
    state.actions = { saveTaskEdits: () => { saves++; }, closeTask: () => { closes++; } };
    globalThis[CLIENT_STATE] = state;
    const view = editorFor(simple);
    try {
      input(view.drawer.output, (node) => ['input', 'textarea'].includes(node.type) && node.props.value === 'Başlangıç').props.onChange({ target: { value: ' ' } });
      view.sync();
      assert.equal(input(view.drawer.output, (node) => node.type === 'button' && node.props.className === 'btn primary').props.disabled, true);
      await input(view.drawer.output, (node) => node.props?.className === 'drawer-backdrop').props.onClick();
      assert.equal(closes, 1);
      assert.equal(saves, 0);
      assert.equal(state.tasks[0].task, 'Başlangıç');
    } finally { view.close(); delete globalThis[CLIENT_STATE]; }
  });
}

test('başarısız Kaydet taslağı açık tutar; yeniden deneme aynı değişikliği gönderir', async () => {
  const state = fixture();
  const calls = [];
  let closes = 0;
  state.actions = { saveTaskEdits: async (edits) => { calls.push(edits); return calls.length === 1 ? { ok: false, error: { message: 'Kayıt reddedildi' } } : { ok: true }; }, closeTask: () => { closes++; } };
  globalThis[CLIENT_STATE] = state;
  const view = editorFor(true);
  try {
    input(view.drawer.output, (node) => ['input', 'textarea'].includes(node.type) && node.props.value === 'Başlangıç').props.onChange({ target: { value: 'Taslağım' } });
    view.sync();
    await input(view.drawer.output, (node) => node.type === 'button' && node.props.className === 'btn primary').props.onClick();
    view.sync();
    assert.equal(closes, 0);
    assert.equal(view.editor.output.props.saveError, 'Kayıt reddedildi');
    assert.equal(view.editor.output.props.task.task, 'Taslağım');
    await input(view.drawer.output, (node) => node.type === 'button' && node.props.className === 'btn primary').props.onClick();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(closes, 1);
  } finally { view.close(); delete globalThis[CLIENT_STATE]; }
});

test('bildirim ayrıntısındaki Görevi aç doğru kimliği çağırır ve erişim hatasını gösterir', async () => {
  const state = fixture();
  state.scheduleRequests = [{ id: 'r1', taskId: 't1', status: 'ACCEPTED', taskTitle: 'Başlangıç' }];
  const opened = [];
  state.actions = { openTask: async (id) => { opened.push(id); return { ok: false, error: { message: 'Görev artık bulunamıyor' } }; } };
  globalThis[CLIENT_STATE] = state;
  const center = mountComponent(ScheduleRequestCenter, {});
  let details;
  try {
    input(center.output, (node) => node.props?.className === 'icon-btn schedule-request-toggle').props.onClick();
    // Açılan menünün belge dinleyicileri test belgesinde karşılanır.
    globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
    center.render();
    input(center.output, (node) => node.props?.className === 'schedule-request-card').props.onClick();
    center.render();
    const selected = input(center.output, (node) => typeof node.type === 'function' && node.props?.request);
    details = mountComponent(selected.type, selected.props);
    await input(details.output, (node) => node.type === 'button' && String(node.props.children).includes('Görevi aç')).props.onClick();
    details.render();
    assert.deepEqual(opened, ['t1']);
    assert.ok(findElement(details.output, (node) => node.props?.role === 'alert'));
  } finally { details?.unmount(); center.unmount(); delete globalThis.document; delete globalThis[CLIENT_STATE]; }
});


test('yeni görevde Ardıllar etkin; ekleme, gecikme ve kaldırma Kaydet öncesinde yalnızca taslaktır', async () => {
  const state = fixture();
  const draft = { ...state.selectedTask, id: 'new', version: undefined, task: 'Yeni görev' };
  state.selectedTask = draft;
  state.taskCreationDraft = { task: draft, scope: 'FULL', createdAt: '2026-09-07' };
  const saved = [];
  let cancelled = 0;
  state.actions = { saveTaskDraft: async (...args) => { saved.push(args); return { ok: true }; }, cancelTaskDraft: () => { cancelled++; }, closeTask: () => {} };
  globalThis[CLIENT_STATE] = state;
  const view = editorFor(false);
  let relations;
  try {
    const relationElement = input(view.drawer.output, (node) => typeof node.type === 'function' && node.props?.onUpdateTask);
    relations = mountComponent(relationElement.type, relationElement.props);
    const successorTab = input(relations.output, (node) => node.props?.role === 'tab' && String(node.props.children).includes('Ardıllar'));
    assert.equal(successorTab.props.disabled, false);
    successorTab.props.onClick();
    relations.render();
    const add = () => input(relations.output, (node) => node.props?.placeholder === '+ Ardıl görev seçin...').props.onChange('t1');
    add();
    relations.render();
    input(relations.output, (node) => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value: '3' } });
    relations.render();
    assert.equal(saved.length, 0);
    assert.deepEqual(state.tasks[0].deps, []);
    input(relations.output, (node) => node.props?.['aria-label'] === 'İlişkiyi kaldır').props.onClick();
    relations.render();
    assert.ok(input(relations.output, (node) => node.props?.placeholder === '+ Ardıl görev seçin...').props.options.some((option) => option.value === 't1'));
    add();
    relations.render();
    input(relations.output, (node) => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value: '3' } });
    view.sync();
    await input(view.drawer.output, (node) => node.type === 'button' && node.props.className === 'btn primary').props.onClick();
    assert.equal(saved.length, 1);
    assert.equal(saved[0][0].id, 'new');
    assert.equal(saved[0][1].relatedEdits[0].id, 't1');
    assert.equal(saved[0][1].relatedEdits[0].patch.deps[0].predecessorId, 'new');
    assert.equal(saved[0][1].relatedEdits[0].patch.deps[0].lagValue, 3);
    assert.equal(cancelled, 0);
  } finally { relations?.unmount(); view.close(); delete globalThis[CLIENT_STATE]; }
});
