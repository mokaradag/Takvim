import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SIDEBAR_PREFERENCE,
  SIDEBAR_PREFERENCE_KEY,
  readSidebarPreference,
  writeSidebarPreference
} from '../src/components/shell/sidebarPreference.js';
import { executeTaskCreation } from '../src/state/taskCreationPolicy.js';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key)
  };
}

test('kenar çubuğu ilk kullanımda sabit ve açık başlar, tercih güvenle saklanır', () => {
  assert.deepEqual(readSidebarPreference(memoryStorage()), DEFAULT_SIDEBAR_PREFERENCE);
  assert.deepEqual(readSidebarPreference(memoryStorage({ [SIDEBAR_PREFERENCE_KEY]: '{bozuk' })), {
    pinned: true,
    collapsed: false
  });

  const storage = memoryStorage();
  writeSidebarPreference({ pinned: false, collapsed: true }, storage);
  assert.deepEqual(JSON.parse(storage.value(SIDEBAR_PREFERENCE_KEY)), { pinned: false, collapsed: true });
  assert.deepEqual(readSidebarPreference(storage), { pinned: false, collapsed: true });
});

test('localStorage özelliğine erişim reddedilirse varsayılan tercih güvenle döner', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('Erişim reddedildi.', 'SecurityError');
    }
  });
  try {
    assert.deepEqual(readSidebarPreference(), DEFAULT_SIDEBAR_PREFERENCE);
    assert.doesNotThrow(() => writeSidebarPreference({ pinned: false, collapsed: true }));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('yeni görev düğmesi yalnızca taslak açar, kalıcı yazma Kaydet eylemine aittir', () => {
  const tasksView = read('src/features/tasks/TasksView.jsx');
  const provider = read('src/state/AppStateProvider.jsx');
  const detailOverlay = read('src/features/task-detail/TaskDetailOverlay.jsx');
  const advancedDrawer = read('src/features/task-detail/TaskDrawer.jsx');
  const simpleDrawer = read('src/features/task-detail/SimpleTaskDrawer.jsx');

  assert.match(tasksView, /const createTask = \(\) => beginTaskDraft\(\);/);
  assert.doesNotMatch(tasksView, /onAddTask/);

  const draftStart = provider.indexOf('const beginTaskDraft');
  const draftEnd = provider.indexOf('const updateTaskDraft', draftStart);
  const saveStart = provider.indexOf('const saveTaskDraft');
  const saveEnd = provider.indexOf('/**\n   * Tekrarlayan görev serisini', saveStart);
  assert.ok(draftStart >= 0 && draftEnd > draftStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.doesNotMatch(provider.slice(draftStart, draftEnd), /persistence\.mutate/);
  assert.match(provider.slice(saveStart, saveEnd), /persistence\.mutate/);
  assert.match(provider, /resolveTaskCreationAccess\(stateRef\.current, task\.projectId\)/);
  assert.match(provider, /creation\.ok \? creation\.scope : null/);
  assert.match(provider, /withCompletionStamp\(draftState, id, patch\)/);
  assert.match(provider, /withCompletionStamp\(draftState, draft\.task\.id, input \|\| draft\.task\)/);
  const activeDraftCheck = provider.indexOf("String(taskCreationDraftRef.current?.task?.id || '') !== String(draft.task.id)", saveStart);
  const draftClear = provider.indexOf('taskCreationDraftRef.current = null;', activeDraftCheck);
  assert.ok(activeDraftCheck > saveStart && draftClear > activeDraftCheck);

  assert.match(detailOverlay, /const canManageDraft = creationDraft\.scope === 'FULL' \|\| creationDraft\.scope === 'ASSIGNMENT'/);
  assert.match(detailOverlay, /canChooseWbs=\{Boolean\(creationDraft\.scope\)\}/);

  for (const drawer of [advancedDrawer, simpleDrawer]) {
    assert.match(drawer, /isCreating \? saveCreationDraft/);
    assert.match(drawer, /'Kaydet'/);
    assert.doesNotMatch(drawer, /'Tamam'/);
  }
});

test('açıkça temizlenen proje başka bir projeye düşmeden reddedilir', async () => {
  let mutateCalls = 0;
  const result = await executeTaskCreation({
    state: {
      projects: [{ id: 'p1', name: 'Proje', accessLevel: 'FULL' }],
      assignableProjects: [],
      tasks: [],
      wbs: [],
      calendars: [],
      people: [],
      workspaceMode: 'portfolio'
    },
    input: { projectId: null, task: 'Projesiz görev' },
    id: 'draft-explicitly-cleared',
    async mutate() {
      mutateCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(result.result.ok, false);
  assert.equal(result.result.error.code, 'PROJECT_REQUIRED');
  assert.equal(result.result.error.field, 'projectId');
  assert.equal(mutateCalls, 0);
});

test('alt araç alanı tema, mod ve çıkışı sıralar; üst çubuk yinelenen denetimleri taşımaz', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const panel = read('src/components/shell/SidebarUserPanel.jsx');
  const css = read('src/app/styles/shell.css');
  const globals = read('src/app/globals.css');

  assert.doesNotMatch(shell, /QuickActions/);
  assert.ok(panel.indexOf('onToggleTheme') < panel.indexOf('sidebar-mode-toggle'));
  assert.ok(panel.indexOf('sidebar-mode-toggle') < panel.indexOf('onClick={signOut}'));
  assert.match(panel, /MERGEN Rota/);
  assert.match(panel, /Sürüm 1\.0/);
  assert.doesNotMatch(panel, /Gelişmiş Mod<\/div>/);

  assert.match(shell, /sidebar-is-\$\{sidebarPinned \? 'pinned' : 'unpinned'\}/);
  assert.match(css, /\.app\.sidebar-is-collapsed,[\s\S]*grid-template-columns: 72px/);
  assert.match(css, /\.sidebar-is-unpinned \.sidebar:hover/);
  assert.match(panel, /sidebar-pin-button/);
  assert.match(globals, /\.hept-sidebar \{[\s\S]*bottom: -126px;/);
});
