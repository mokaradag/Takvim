import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { bodyClassesForTweaks, TWEAKS_BOOTSTRAP_SCRIPT } from '../src/lib/tweaksBootstrap.js';
import { mergeTweakPreferences, TWEAK_DEFAULTS } from '../src/lib/tweaks-defaults.js';

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

test('hareket azaltma ilk boyamada varsayılandır ve kayıtlı seçim korunur', () => {
  for (const [raw, expected] of [
    [null, true],
    ['{}', true],
    ['{"theme":"light"}', true],
    ['{"reduceMotion":true}', true],
    ['{"reduceMotion":false}', false],
    ['{"reduceMotion":null}', true],
    ['{"reduceMotion":"false"}', true],
    ['{"reduceMotion":0}', true],
    ['bozuk JSON', true],
    ['null', true],
    ['[]', true],
    [new Error('Depolama kapalı'), true]
  ]) {
    const classes = new Set();
    runInNewContext(TWEAKS_BOOTSTRAP_SCRIPT, {
      localStorage: { getItem() { if (raw instanceof Error) throw raw; return raw; } },
      document: {
        body: {
          classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
          style: {}
        },
        documentElement: { style: { setProperty() {} } }
      }
    });
    assert.equal(classes.has('reduce-motion'), expected, String(raw));
    if (raw === '{"theme":"light"}') assert.equal(classes.has('theme-light'), true);
  }
  assert.ok(bodyClassesForTweaks().includes('reduce-motion'));
  assert.ok(bodyClassesForTweaks({ reduceMotion: undefined }).includes('reduce-motion'));
  assert.equal(bodyClassesForTweaks({ reduceMotion: false }).includes('reduce-motion'), false);
});

test('tercih yükleme yalnızca doğru türdeki tanımlı değerleri kabul eder', () => {
  for (const invalid of [undefined, null, 'false', 0, [], {}]) {
    const values = mergeTweakPreferences(TWEAK_DEFAULTS, {
      reduceMotion: invalid, highContrast: invalid, showEmblem: invalid
    });
    assert.equal(values.reduceMotion, true);
    assert.equal(values.highContrast, false);
    assert.equal(values.showEmblem, true);
    assert.ok(bodyClassesForTweaks({ reduceMotion: invalid }).includes('reduce-motion'));
  }
  for (const invalid of [null, [], 'false', 0]) {
    assert.deepEqual(mergeTweakPreferences(TWEAK_DEFAULTS, invalid), TWEAK_DEFAULTS);
  }
  for (const invalid of [undefined, null, '1.25', NaN, Infinity]) {
    assert.equal(mergeTweakPreferences(TWEAK_DEFAULTS, { fontScale: invalid }).fontScale, 1);
  }
  const overrides = { reduceMotion: false, highContrast: true, showEmblem: false, fontScale: 1.25, theme: 'light' };
  assert.deepEqual(mergeTweakPreferences(TWEAK_DEFAULTS, overrides), { ...TWEAK_DEFAULTS, ...overrides });
  assert.deepEqual(mergeTweakPreferences(TWEAK_DEFAULTS, { theme: null, unknown: true }), TWEAK_DEFAULTS);
  assert.deepEqual(mergeTweakPreferences(TWEAK_DEFAULTS, Object.create(overrides)), TWEAK_DEFAULTS);
});

test('ilk boyama ve tercih yükleme bozuk alanlarda aynı varsayılanları kullanır', () => {
  for (const preferences of [
    { reduceMotion: null, highContrast: 'false', showEmblem: 0, fontScale: '1.25', theme: false },
    { reduceMotion: false, highContrast: true, showEmblem: false, fontScale: 1.25, theme: 'light' }
  ]) {
    const classes = new Set();
    const style = {};
    runInNewContext(TWEAKS_BOOTSTRAP_SCRIPT, {
      localStorage: { getItem() { return JSON.stringify(preferences); } },
      document: {
        body: {
          classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
          style
        },
        documentElement: { style: { setProperty() {} } }
      }
    });
    const expected = mergeTweakPreferences(TWEAK_DEFAULTS, preferences);
    assert.deepEqual([...classes], bodyClassesForTweaks(expected));
    assert.equal(style.zoom, String(expected.fontScale));
  }
});

test("COLOR_MAP donmuştur ve bütün tasarım belirteçlerini sunar", () => {
  assert.equal(Object.isFrozen(COLOR_MAP), true);
  assert.deepEqual(Object.keys(COLOR_MAP), ['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);
});

test("bilinen proje yapılandırılmış renk anahtarına çözülür", () => {
  assert.equal(projectColorKey('Web Sitesi Yenileme'), 'blue');
  assert.equal(projectColorKey('Mobil Uygulama'), 'purple');
  assert.equal(projectColorKey('Marka Kimliği'), 'emerald');
});

test("bilinmeyen proje rengi yinelenen çağrıda belirlenimcidir", () => {
  const first = projectColorKey('Yeni Proje');
  const second = projectColorKey('Yeni Proje');
  assert.equal(first, second);
  assert.equal(Object.hasOwn(COLOR_MAP, first), true);
});

test("boş proje adı belirlenimci maviye döner", () => {
  assert.equal(projectColorKey(''), 'blue');
  assert.equal(projectColorKey(null), 'blue');
});

test("projectColorVar yapılandırılmış ve dönüş anahtarı için CSS değişkeni döndürür", () => {
  assert.equal(projectColorVar('Altyapı'), 'var(--c-cyan)');
  assert.equal(Object.values(COLOR_MAP).includes(projectColorVar('Bilinmeyen Proje')), true);
});

test("personColorVar bilinen kişi için yapılandırılmış rengi döndürür", () => {
  assert.equal(personColorVar('Ayşe Kaya'), 'var(--c-emerald)');
  assert.equal(personColorVar('Mehmet Demir'), 'var(--c-purple)');
});

test("personColorVar bilinmeyen kişide belirlenimcidir", () => {
  assert.equal(personColorVar('Yeni Kişi'), personColorVar('Yeni Kişi'));
  assert.equal(Object.values(COLOR_MAP).includes(personColorVar('Yeni Kişi')), true);
});

test("personInitials yinelenen boşluğu kırpar ve en çok iki baş harf döndürür", () => {
  assert.equal(personInitials('  Mehmet   Onur   Karadağ  '), 'MO');
});

test("personInitials Türkçe harfi büyütür ve tek sözcüklü adı işler", () => {
  assert.equal(personInitials('özge'), 'Ö');
});

test("personInitials boş değerleri güvenle işler", () => {
  assert.equal(personInitials(null), '');
  assert.equal(personInitials(undefined), '');
  assert.equal(personInitials(''), '');
});

test("appZoom belge yokken bir döndürür", () => {
  const previous = globalThis.document;
  try {
    delete globalThis.document;
    assert.equal(appZoom(), 1);
  } finally {
    if (previous !== undefined) globalThis.document = previous;
  }
});

test("appZoom sayısal gövde yakınlaştırmasını ayrıştırır", () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { body: { style: { zoom: '1.25' } } };
    assert.equal(appZoom(), 1.25);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("appZoom CSS yüzde yakınlaştırmasını ölçek katsayısına çevirir", () => {
  const previous = globalThis.document;
  try {
    globalThis.document = { body: { style: { zoom: '125%' } } };
    assert.equal(appZoom(), 1.25);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("appZoom boş veya bozuk değerde bire döner", () => {
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

test("çalışma alanı tercihi kararlı depo anahtarı kullanır", () => {
  assert.equal(WORKSPACE_STORAGE_KEY, 'mergen-rota.workspace.v1');
});

test("readWorkspacePreference depo yokken boş değer döndürür", () => {
  assert.equal(readWorkspacePreference(null), null);
});

test("readWorkspacePreference anahtar yokken boş değer döndürür", () => {
  assert.equal(readWorkspacePreference(createStorage()), null);
});

test("readWorkspacePreference kayıtlı alan değerini ayrıştırır", () => {
  const storage = createStorage({
    [WORKSPACE_STORAGE_KEY]: JSON.stringify({ workspaceMode: 'project', selectedProjectId: 'p1' })
  });
  assert.deepEqual(readWorkspacePreference(storage), {
    workspaceMode: 'project',
    selectedProjectId: 'p1'
  });
});

test("readWorkspacePreference eksik kayıtlı alanı boş değere çevirir", () => {
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: '{}' });
  assert.deepEqual(readWorkspacePreference(storage), {
    workspaceMode: null,
    selectedProjectId: null
  });
});

test("readWorkspacePreference bozuk JSON için boş değer döndürür", () => {
  const storage = createStorage({ [WORKSPACE_STORAGE_KEY]: '{bad-json' });
  assert.equal(readWorkspacePreference(storage), null);
});

test("readWorkspacePreference depo okuma hatasını kapsar", () => {
  assert.equal(readWorkspacePreference({ getItem() { throw new Error('boom'); } }), null);
});

test("writeWorkspacePreference açık proje seçimini saklar", () => {
  const storage = createStorage();
  assert.equal(writeWorkspacePreference({ workspaceMode: 'project', selectedProjectId: 'p2' }, storage), true);
  assert.deepEqual(JSON.parse(storage.read(WORKSPACE_STORAGE_KEY)), {
    workspaceMode: 'project',
    selectedProjectId: 'p2'
  });
});

test("writeWorkspacePreference eksik tercihte portföy varsayılanını uygular", () => {
  const storage = createStorage();
  assert.equal(writeWorkspacePreference(undefined, storage), true);
  assert.deepEqual(JSON.parse(storage.read(WORKSPACE_STORAGE_KEY)), {
    workspaceMode: 'portfolio',
    selectedProjectId: null
  });
});

test("writeWorkspacePreference depo yokken yanlış döndürür", () => {
  assert.equal(writeWorkspacePreference({ workspaceMode: 'portfolio' }, null), false);
});

test("writeWorkspacePreference depo yazma hatasını kapsar", () => {
  assert.equal(writeWorkspacePreference({}, { setItem() { throw new Error('boom'); } }), false);
});

test("eski taşıma kanonik alan yoksa eski değeri kopyalar", () => {
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

test("eski ve yeni alan birlikteyse taşıma kanonik değeri korur", () => {
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

test("eski taşıma girdi nesnesini değiştirmez", () => {
  const input = { id: 't1', baslangicTarihi: '2026-01-01' };
  const before = structuredClone(input);
  const result = migrateLegacyTaskSchedule(input);
  assert.deepEqual(input, before);
  assert.notStrictEqual(result, input);
});

test("eski taşıma boş girdiyi güvenle işler ve ilgisiz alanı korur", () => {
  assert.deepEqual(migrateLegacyTaskSchedule(), {});
  assert.deepEqual(migrateLegacyTaskSchedule({ id: 't1', title: 'Task' }), { id: 't1', title: 'Task' });
});

test("birincil baz plan seçicisi proje kimliği ister", () => {
  assert.equal(selectPrimaryBaselineForProject([{ projectId: 'p1', isPrimary: true }], null), null);
});

test("birincil baz plan seçicisi birincil olmayanı yok sayar", () => {
  const baselines = [
    { id: 'b1', projectId: 'p1', isPrimary: false },
    { id: 'b2', projectId: 'p1', isPrimary: true }
  ];
  assert.equal(selectPrimaryBaselineForProject(baselines, 'p1')?.id, 'b2');
});

test("birincil baz plan seçicisi eşleşme yoksa boş değer döndürür", () => {
  assert.equal(selectPrimaryBaselineForProject([{ id: 'b1', projectId: 'p2', isPrimary: true }], 'p1'), null);
});

test("görev baz plan seçicisi görev ve baz plan kimliğini birlikte ister", () => {
  const snapshots = [{ taskId: 't1', baselineId: 'b1' }];
  assert.equal(selectTaskBaselineSnapshot(snapshots, null, 'b1'), null);
  assert.equal(selectTaskBaselineSnapshot(snapshots, 't1', null), null);
});

test("görev baz plan seçicisi tam birleşik anahtarı eşleştirir", () => {
  const snapshots = [
    { id: 's1', taskId: 't1', baselineId: 'b1' },
    { id: 's2', taskId: 't1', baselineId: 'b2' }
  ];
  assert.equal(selectTaskBaselineSnapshot(snapshots, 't1', 'b2')?.id, 's2');
  assert.equal(selectTaskBaselineSnapshot(snapshots, 't2', 'b2'), null);
});
