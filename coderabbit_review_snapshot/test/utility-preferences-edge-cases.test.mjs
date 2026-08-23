import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_MAP,
  personColorVar,
  personInitials,
  projectColorKey,
  projectColorVar
} from '../src/lib/colors.js';
import { appZoom } from '../src/lib/zoom.js';
import {
  WORKSPACE_STORAGE_KEY,
  readWorkspacePreference,
  writeWorkspacePreference
} from '../src/state/workspacePreference.js';
import {
  selectPrimaryBaselineForProject,
  selectTaskBaselineSnapshot
} from '../src/state/selectors/baselineSelectors.js';
import { migrateLegacyTaskSchedule } from '../src/data/migrations/legacyTaskSchedule.js';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    read(key) {
      return values.get(key);
    }
  };
}

test('COLOR_MAP is frozen and exposes all supported design tokens', () => {
  assert.equal(Object.isFrozen(COLOR_MAP), true);
  assert.deepEqual(Object.keys(COLOR_MAP), ['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);
});

test('known projects resolve to their configured color keys', () => {
  assert.equal(projectColorKey('Web Sitesi Yenileme'), 'blue');
  assert.equal(projectColorKey('Mobil Uygulama'), 'purple');
  assert.equal(projectColorKey('Marka Kimliği'), 'emerald');
});

test('unknown project colors are deterministic across repeated calls', () => {
  const first = projectColorKey('Yeni Proje');
  const second = projectColorKey('Yeni Proje');
  assert.equal(first, second);
  assert.equal(Object.hasOwn(COLOR_MAP, first), true);
});

test('empty project names fall back deterministically to blue', () => {
  assert.equal(projectColorKey(''), 'blue');
  assert.equal(projectColorKey(null), 'blue');
});

test('projectColorVar returns the CSS variable for configured and fallback keys', () => {
  assert.equal(projectColorVar('Altyapı'), 'var(--c-cyan)');
  assert.equal(Object.values(COLOR_MAP).includes(projectColorVar('Bilinmeyen Proje')), true);
});

test('personColorVar returns configured colors for known people', () => {
  assert.equal(personColorVar('Ayşe Kaya'), 'var(--c-emerald)');
  assert.equal(personColorVar('Mehmet Demir'), 'var(--c-purple)');
});

test('personColorVar is deterministic for unknown people', () => {
  assert.equal(personColorVar('Yeni Kişi'), personColorVar('Yeni Kişi'));
  assert.equal(Object.values(COLOR_MAP).includes(personColorVar('Yeni Kişi')), true);
});

test('personInitials trims repeated spaces and returns at most two initials', () => {
  assert.equal(personInitials('  Mehmet   Onur   Karadağ  '), 'MO');
});

test('personInitials uppercases Turkish characters and handles one-word names', () => {
  assert.equal(personInitials('özge'), 'Ö');
});

test('personInitials safely handles nullish and empty values', () => {
  assert.equal(personInitials(null), '');
  assert.equal(personInitials(undefined), '');
  assert.equal(personInitials(''), '');
});

test('appZoom returns 1 when document is unavailable', () => {
  const previous = globalThis.document;
  try {
    delete globalThis.document;
    assert.equal(appZoom(), 1);
  } finally {
    if (previous !== undefined) globalThis.document = previous;
  }
});

test('appZoom parses numeric body zoom values', () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { body: { style: { zoom: '1.25' } } };
    assert.equal(appZoom(), 1.25);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('appZoom converts CSS percentage zoom values to scale factors', () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { body: { style: { zoom: '125%' } } };
    assert.equal(appZoom(), 1.25);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('appZoom falls back to 1 for empty and invalid values', () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { body: { style: { zoom: '' } } };
    assert.equal(appZoom(), 1);
    globalThis.document.body.style.zoom = 'invalid';
    assert.equal(appZoom(), 1);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('workspace preference uses a stable storage key', () => {
  assert.equal(WORKSPACE_STORAGE_KEY, 'mergen-rota.workspace.v1');
});

test('readWorkspacePreference returns null when storage is unavailable', () => {
  assert.equal(readWorkspacePreference(null), null);
});

test('readWorkspacePreference returns null when the key is absent', () => {
  assert.equal(readWorkspacePreference(createStorage()), null);
});

test('readWorkspacePreference parses stored workspace values', () => {
  const storage = createStorage({
    [WORKSPACE_STORAGE_KEY]: JSON.stringify({ workspaceMode: 'project', selectedProjectId: 'p1' })
  });
  assert.deepEqual(readWorkspacePreference(storage), {
    workspaceMode: 'project',
    selectedProjectId: 'p1'
  });
});

test('readWorkspacePreference normalizes missing stored fields to null', () => {
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: '{}' });
  assert.deepEqual(readWorkspacePreference(storage), {
    workspaceMode: null,
    selectedProjectId: null
  });
});

test('readWorkspacePreference returns null for invalid JSON', () => {
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: '{bad-json' });
  assert.equal(readWorkspacePreference(storage), null);
});

test('readWorkspacePreference contains storage read failures', () => {
  assert.equal(readWorkspacePreference({ getItem() { throw new Error('boom'); } }), null);
});

test('writeWorkspacePreference persists an explicit project selection', () => {
  const storage = createStorage();
  assert.equal(writeWorkspacePreference({ workspaceMode: 'project', selectedProjectId: 'p2' }, storage), true);
  assert.deepEqual(JSON.parse(storage.read(WORKSPACE_STORAGE_KEY)), {
    workspaceMode: 'project',
    selectedProjectId: 'p2'
  });
});

test('writeWorkspacePreference applies portfolio defaults for missing preference data', () => {
  const storage = createStorage();
  assert.equal(writeWorkspacePreference(undefined, storage), true);
  assert.deepEqual(JSON.parse(storage.read(WORKSPACE_STORAGE_KEY)), {
    workspaceMode: 'portfolio',
    selectedProjectId: null
  });
});

test('writeWorkspacePreference returns false when storage is unavailable', () => {
  assert.equal(writeWorkspacePreference({ workspaceMode: 'portfolio' }, null), false);
});

test('writeWorkspacePreference contains storage write failures', () => {
  assert.equal(writeWorkspacePreference({}, { setItem() { throw new Error('boom'); } }), false);
});

test('legacy migration copies old values when canonical fields are absent', () => {
  assert.deepEqual(migrateLegacyTaskSchedule({
    baslangicTarihi: '2026-01-01',
    bitisTarihi: '2026-01-05',
    hedefTarih: '2026-01-06'
  }), {
    plannedStart: '2026-01-01',
    plannedFinish: '2026-01-05',
    targetFinish: '2026-01-06'
  });
});

test('legacy migration preserves canonical values when both old and new fields exist', () => {
  const result = migrateLegacyTaskSchedule({
    plannedStart: '2026-02-01',
    baslangicTarihi: '2026-01-01',
    plannedFinish: '2026-02-05',
    bitisTarihi: '2026-01-05',
    targetFinish: '2026-02-06',
    hedefTarih: '2026-01-06'
  });
  assert.deepEqual(result, {
    plannedStart: '2026-02-01',
    plannedFinish: '2026-02-05',
    targetFinish: '2026-02-06'
  });
});

test('legacy migration does not mutate its input object', () => {
  const input = { id: 't1', baslangicTarihi: '2026-01-01' };
  const before = structuredClone(input);
  const result = migrateLegacyTaskSchedule(input);
  assert.deepEqual(input, before);
  assert.notStrictEqual(result, input);
});

test('legacy migration safely handles empty input and preserves unrelated fields', () => {
  assert.deepEqual(migrateLegacyTaskSchedule(), {});
  assert.deepEqual(migrateLegacyTaskSchedule({ id: 't1', title: 'Task' }), { id: 't1', title: 'Task' });
});

test('primary baseline selector requires a project ID', () => {
  assert.equal(selectPrimaryBaselineForProject([{ projectId: 'p1', isPrimary: true }], null), null);
});

test('primary baseline selector ignores non-primary baselines', () => {
  const baselines = [
    { id: 'b1', projectId: 'p1', isPrimary: false },
    { id: 'b2', projectId: 'p1', isPrimary: true }
  ];
  assert.equal(selectPrimaryBaselineForProject(baselines, 'p1')?.id, 'b2');
});

test('primary baseline selector returns null when no matching primary baseline exists', () => {
  assert.equal(selectPrimaryBaselineForProject([{ id: 'b1', projectId: 'p2', isPrimary: true }], 'p1'), null);
});

test('task baseline snapshot selector requires both task and baseline IDs', () => {
  const snapshots = [{ taskId: 't1', baselineId: 'b1' }];
  assert.equal(selectTaskBaselineSnapshot(snapshots, null, 'b1'), null);
  assert.equal(selectTaskBaselineSnapshot(snapshots, 't1', null), null);
});

test('task baseline snapshot selector matches the exact composite key', () => {
  const snapshots = [
    { id: 's1', taskId: 't1', baselineId: 'b1' },
    { id: 's2', taskId: 't1', baselineId: 'b2' }
  ];
  assert.equal(selectTaskBaselineSnapshot(snapshots, 't1', 'b2')?.id, 's2');
  assert.equal(selectTaskBaselineSnapshot(snapshots, 't2', 'b2'), null);
});
