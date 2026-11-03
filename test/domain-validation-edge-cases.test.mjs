import test from 'node:test';
import assert from 'node:assert/strict';

import { DOMAIN_MODEL_VERSION } from '../src/domain/models/index.js';
import {
  normalizeProjectReferences,
  normalizeTaskReferences,
  normalizeTaskScheduleFields,
  validateTaskBaselineSnapshot,
  validateTaskSchedule,
  validateTaskWbsAssignment,
  validateTaskWbsMove,
  validateWbsDeletion,
  validateWbsReparent,
  validateWbsStructure
} from '../src/domain/validation/index.js';

const people = [
  { id: 'u1', name: 'Ayşe' },
  { id: 'u2', name: 'Bora' }
];
const projects = [
  { id: 'p1', name: 'One' },
  { id: 'p2', name: 'Two' }
];
const wbs = [
  { id: 'p1-root', projectId: 'p1', parentId: null, code: '1', name: 'One', sortOrder: 1 },
  { id: 'p1-a', projectId: 'p1', parentId: 'p1-root', code: '1.1', name: 'A', sortOrder: 1 },
  { id: 'p1-b', projectId: 'p1', parentId: 'p1-root', code: '1.2', name: 'B', sortOrder: 2 },
  { id: 'p1-a1', projectId: 'p1', parentId: 'p1-a', code: '1.1.1', name: 'A1', sortOrder: 1 },
  { id: 'p2-root', projectId: 'p2', parentId: null, code: '2', name: 'Two', sortOrder: 1 }
];

function codes(issues) {
  return issues.map((item) => item.code);
}

test("alan modeli sürümü güncel kanonik şema sürümünde kalır", () => {
  assert.equal(DOMAIN_MODEL_VERSION, 5);
});

test("proje normalleştirmesi açık leadId değerini eski görünüm liderinden önce korur", () => {
  const result = normalizeProjectReferences({ id: 'p1', leadId: 'u2', lead: 'Ayşe' }, people);
  assert.equal(result.leadId, 'u2');
});

test("proje normalleştirmesi eski lider adını kararlı kimliğe çözer", () => {
  assert.equal(normalizeProjectReferences({ id: 'p1', lead: 'Ayşe' }, people).leadId, 'u1');
});

test("proje normalleştirmesi bilinmeyen lideri boş değer yapar", () => {
  assert.equal(normalizeProjectReferences({ id: 'p1', lead: 'Unknown' }, people).leadId, null);
});

test("proje normalleştirmesi açık veri tarihini korur", () => {
  assert.equal(normalizeProjectReferences({ id: 'p1', dataDate: '2026-07-22' }, people).dataDate, '2026-07-22');
});

test("proje normalleştirmesi eksik veri tarihini boş değerle doldurur", () => {
  assert.equal(normalizeProjectReferences({ id: 'p1' }, people).dataDate, null);
});

test("görev çizelgesi normalleştirmesi boş tarih metnini boş değere çevirir", () => {
  const result = normalizeTaskScheduleFields({
    plannedStart: '', plannedFinish: '', targetFinish: '', actualStart: '', actualFinish: ''
  });
  assert.equal(result.plannedStart, null);
  assert.equal(result.plannedFinish, null);
  assert.equal(result.targetFinish, null);
  assert.equal(result.actualStart, null);
  assert.equal(result.actualFinish, null);
});

test("görev çizelgesi normalleştirmesi geçerli değerleri korur", () => {
  const result = normalizeTaskScheduleFields({
    plannedStart: '2026-07-20',
    plannedFinish: '2026-07-24',
    targetFinish: '2026-07-27',
    actualStart: '2026-07-21',
    actualFinish: '2026-07-23',
    plannedDurationDays: 5,
    remainingDurationDays: 2
  });
  assert.equal(result.plannedStart, '2026-07-20');
  assert.equal(result.plannedFinish, '2026-07-24');
  assert.equal(result.targetFinish, '2026-07-27');
  assert.equal(result.actualStart, '2026-07-21');
  assert.equal(result.actualFinish, '2026-07-23');
  assert.equal(result.plannedDurationDays, 5);
  assert.equal(result.remainingDurationDays, 2);
});

test("görev çizelgesi normalleştirmesi kilometre taşını sıfır süreye zorlar", () => {
  assert.equal(normalizeTaskScheduleFields({ milestone: true, plannedDurationDays: 99 }).plannedDurationDays, 0);
});

test("görev çizelgesi normalleştirmesi kilometre taşı olmayanın sıfır süresini korur", () => {
  assert.equal(normalizeTaskScheduleFields({ milestone: false, plannedDurationDays: 0 }).plannedDurationDays, 0);
});

test("görev çizelgesi normalleştirmesi eksik süreyi boş değerle doldurur", () => {
  const result = normalizeTaskScheduleFields({});
  assert.equal(result.plannedDurationDays, null);
  assert.equal(result.remainingDurationDays, null);
});

test("görev başvurusu proje kimliğini kanonik projectId ile çözer", () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p2', proje: 'One' }, { projects, people, wbs });
  assert.equal(result.projectId, 'p2');
  assert.equal(result.proje, 'Two');
  assert.equal(result.wbsId, 'p2-root');
});

test("görev başvurusu eski proje görünüm adına döner", () => {
  const result = normalizeTaskReferences({ id: 't1', proje: 'One' }, { projects, people, wbs });
  assert.equal(result.projectId, 'p1');
  assert.equal(result.proje, 'One');
});

test("proje çözülemezse bilinmeyen kanonik projectId korunur", () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'missing', proje: 'Legacy' }, { projects, people, wbs });
  assert.equal(result.projectId, 'missing');
  assert.equal(result.proje, 'Legacy');
  assert.equal(result.wbsId, null);
});

test("görev başvurusu bilinmeyen kanonik sorumlu kimliğini süzer", () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', assigneeIds: ['u1', 'missing'] }, { projects, people, wbs });
  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Ayşe']);
});

test("kanonik kimlik dizinde yoksa kapsamlı görünüm adları korunur", () => {
  const result = normalizeTaskReferences({
    id: 't1',
    projectId: 'p1',
    assigneeIds: ['u1', 'missing'],
    assigneeCount: 2,
    assigneeDisplayNames: ['Ayşe', 'Rehber Dışı Görevli']
  }, { projects, people, wbs });

  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Ayşe', 'Rehber Dışı Görevli']);
});

test("görev başvurusu eski addan kanonik sorumlu kimliği türetir", () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', sorumlu: ['Bora', 'Unknown', 'Ayşe'] }, { projects, people, wbs });
  assert.deepEqual(result.assigneeIds, ['u2', 'u1']);
  assert.deepEqual(result.sorumlu, ['Bora', 'Ayşe']);
});

test("eski ad da verilse görünüm adı kanonik kimlikten çözülür", () => {
  const result = normalizeTaskReferences({
    id: 't1', projectId: 'p1', assigneeIds: ['u1'], sorumlu: ['Bora']
  }, { projects, people, wbs });
  assert.deepEqual(result.assigneeIds, ['u1']);
  assert.deepEqual(result.sorumlu, ['Ayşe']);
});

test("görev başvurusu geçerli aynı projeli WBS atamasını korur", () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', wbsId: 'p1-a' }, { projects, people, wbs });
  assert.equal(result.wbsId, 'p1-a');
});

test("görev başvurusu başka projeli WBS yerine proje varsayılanını atar", () => {
  const result = normalizeTaskReferences({ id: 't1', projectId: 'p1', wbsId: 'p2-root' }, { projects, people, wbs });
  assert.equal(result.wbsId, 'p1-root');
});

test("görev başvurusu eksik bağımlılığı boş dizi varsayar", () => {
  assert.deepEqual(normalizeTaskReferences({ id: 't1', projectId: 'p1' }, { projects, people, wbs }).deps, []);
});

for (const [name, task, expectedCode, expectedField] of [
  ['invalid planned-start format', { plannedStart: '22-07-2026' }, 'INVALID_PLANNED_START', 'plannedStart'],
  ['impossible planned-start date', { plannedStart: '2026-02-30' }, 'INVALID_PLANNED_START', 'plannedStart'],
  ['invalid planned-finish format', { plannedFinish: '2026/07/22' }, 'INVALID_PLANNED_FINISH', 'plannedFinish'],
  ['impossible planned-finish date', { plannedFinish: '2026-13-01' }, 'INVALID_PLANNED_FINISH', 'plannedFinish'],
  ['invalid actual-start format', { actualStart: 'July 22, 2026' }, 'INVALID_ACTUAL_START', 'actualStart'],
  ['invalid actual-finish format', { actualStart: '2026-07-20', actualFinish: 'bad' }, 'INVALID_ACTUAL_FINISH', 'actualFinish'],
  ['negative planned duration', { plannedDurationDays: -1 }, 'NEGATIVE_OR_INVALID_DURATION', 'plannedDurationDays'],
  ['NaN planned duration', { plannedDurationDays: Number.NaN }, 'NEGATIVE_OR_INVALID_DURATION', 'plannedDurationDays'],
  ['infinite remaining duration', { remainingDurationDays: Infinity }, 'NEGATIVE_OR_INVALID_DURATION', 'remainingDurationDays'],
  ['negative remaining duration', { remainingDurationDays: -0.5 }, 'NEGATIVE_OR_INVALID_DURATION', 'remainingDurationDays'],
  ['non-zero milestone duration', { milestone: true, plannedDurationDays: 1 }, 'MILESTONE_NON_ZERO_DURATION', 'plannedDurationDays']
]) {
  test(`görev çizelgesi doğrulaması ${name} durumunu bildirir`, () => {
    const issue = validateTaskSchedule(task).find((item) => item.code === expectedCode);
    assert.ok(issue);
    assert.equal(issue.field, expectedField);
  });
}

test("görev çizelgesi doğrulaması artık gün tarihini kabul eder", () => {
  assert.deepEqual(validateTaskSchedule({
    plannedStart: '2028-02-29',
    plannedFinish: '2028-02-29',
    plannedDurationDays: 1
  }), []);
});

test("görev çizelgesi doğrulaması planlanan bitişin başlangıçtan önce olduğunu bildirir", () => {
  assert.deepEqual(codes(validateTaskSchedule({
    plannedStart: '2026-07-23', plannedFinish: '2026-07-22'
  })), ['PLANNED_FINISH_BEFORE_START']);
});

test("görev çizelgesi doğrulaması gerçek başlangıç olmadan bitişi bildirir", () => {
  assert.ok(codes(validateTaskSchedule({ actualFinish: '2026-07-22' })).includes('ACTUAL_FINISH_WITHOUT_START'));
});

test("görev çizelgesi doğrulaması gerçek bitişin başlangıçtan önce olduğunu bildirir", () => {
  assert.ok(codes(validateTaskSchedule({
    actualStart: '2026-07-23', actualFinish: '2026-07-22'
  })).includes('ACTUAL_FINISH_BEFORE_START'));
});

test("görev çizelgesi doğrulaması bağımsız sorunları birlikte bildirebilir", () => {
  const result = validateTaskSchedule({
    plannedStart: 'bad',
    plannedFinish: 'also-bad',
    actualFinish: '2026-07-22',
    plannedDurationDays: -1,
    milestone: true
  });
  assert.deepEqual(codes(result), [
    'INVALID_PLANNED_START',
    'INVALID_PLANNED_FINISH',
    'ACTUAL_FINISH_WITHOUT_START',
    'NEGATIVE_OR_INVALID_DURATION',
    'MILESTONE_NON_ZERO_DURATION'
  ]);
});

test("görev çizelgesi doğrulaması boş çizelge kaydını kabul eder", () => {
  assert.deepEqual(validateTaskSchedule({}), []);
});

test("görev çizelgesi doğrulaması sıfır süreli kilometre taşını kabul eder", () => {
  assert.deepEqual(validateTaskSchedule({ milestone: true, plannedDurationDays: 0 }), []);
});

test("baz plan doğrulaması başlangıçtan önce bitişi bildirir", () => {
  assert.deepEqual(codes(validateTaskBaselineSnapshot({
    plannedStart: '2026-07-23', plannedFinish: '2026-07-22'
  })), ['BASELINE_FINISH_BEFORE_START']);
});

for (const value of [-1, Number.NaN, Infinity]) {
  test(`baz plan doğrulaması geçersiz ${String(value)} süreyi reddeder`, () => {
    assert.deepEqual(codes(validateTaskBaselineSnapshot({ plannedDurationDays: value })), [
      'NEGATIVE_OR_INVALID_BASELINE_DURATION'
    ]);
  });
}

test("baz plan doğrulaması sıfır süreyi kabul eder", () => {
  assert.deepEqual(validateTaskBaselineSnapshot({ plannedDurationDays: 0 }), []);
});

test("WBS yapı doğrulaması kimliksiz kaydı yok sayar", () => {
  assert.deepEqual(validateWbsStructure([null, {}, { name: 'No ID' }]), []);
});

test("WBS yapı doğrulaması yinelenen kimliği belirlenimci bildirir", () => {
  const result = validateWbsStructure([
    { id: 'x', projectId: 'p1', parentId: null },
    { id: 'x', projectId: 'p1', parentId: null }
  ]);
  assert.deepEqual(codes(result), ['DUPLICATE_WBS_ID']);
  assert.equal(result[0].nodeId, 'x');
});

test("WBS yapı doğrulaması kendini üst yapmayı bildirir", () => {
  const result = validateWbsStructure([{ id: 'x', projectId: 'p1', parentId: 'x' }]);
  assert.equal(result[0].code, 'WBS_SELF_PARENT');
  assert.equal(result[0].details.parentId, 'x');
});

test("WBS yapı doğrulaması eksik üstü bildirir", () => {
  const result = validateWbsStructure([{ id: 'x', projectId: 'p1', parentId: 'missing' }]);
  assert.equal(result[0].code, 'MISSING_WBS_PARENT');
  assert.equal(result[0].details.parentId, 'missing');
});

test("WBS yapı doğrulaması başka projeli üst ayrıntısını bildirir", () => {
  const result = validateWbsStructure([
    { id: 'a', projectId: 'p1', parentId: null },
    { id: 'b', projectId: 'p2', parentId: 'a' }
  ]);
  const issue = result.find((item) => item.code === 'CROSS_PROJECT_WBS_PARENT');
  assert.deepEqual(issue.details, { parentId: 'a', projectId: 'p2', parentProjectId: 'p1' });
});

test("WBS yapı doğrulaması ayrık döngü başına tek kanonik sorun üretir", () => {
  const result = validateWbsStructure([
    { id: 'b', projectId: 'p1', parentId: 'a' },
    { id: 'a', projectId: 'p1', parentId: 'b' },
    { id: 'd', projectId: 'p1', parentId: 'c' },
    { id: 'c', projectId: 'p1', parentId: 'd' }
  ]).filter((item) => item.code === 'WBS_CYCLE');
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.nodeId), ['a', 'c']);
  assert.deepEqual(result.map((item) => item.details.nodeIds), [['a', 'b'], ['c', 'd']]);
});

test("görev WBS ataması WBS kaydı olmayan görevi kabul eder", () => {
  assert.deepEqual(validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: null }, wbs), []);
});

test("görev WBS ataması bilinmeyen WBS kaydını reddeder", () => {
  const result = validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: 'missing' }, wbs);
  assert.equal(result[0].code, 'UNKNOWN_TASK_WBS');
  assert.equal(result[0].nodeId, 't1');
});

test("görev WBS ataması başka projenin WBS kaydını reddeder", () => {
  const result = validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: 'p2-root' }, wbs);
  assert.equal(result[0].code, 'CROSS_PROJECT_TASK_WBS');
  assert.equal(result[0].details.wbsProjectId, 'p2');
});

test("görev WBS ataması aynı projeli WBS kaydını kabul eder", () => {
  assert.deepEqual(validateTaskWbsAssignment({ id: 't1', projectId: 'p1', wbsId: 'p1-a' }, wbs), []);
});

test("görev WBS taşıması boş seçimi reddeder", () => {
  assert.equal(validateTaskWbsMove([], wbs, [], 'p1-root')[0].code, 'TASK_MOVE_SELECTION_EMPTY');
});

test("görev WBS taşıması eksik hedefi reddeder", () => {
  assert.equal(validateTaskWbsMove([], wbs, ['t1'], 'missing')[0].code, 'WBS_TARGET_NOT_FOUND');
});

test("görev WBS taşıması eksik seçili görevleri bildirir", () => {
  assert.equal(validateTaskWbsMove([], wbs, ['missing'], 'p1-root')[0].code, 'TASK_NOT_FOUND');
});

test("görev WBS taşıması başka projeli hedef atamasını reddeder", () => {
  const result = validateTaskWbsMove([{ id: 't1', projectId: 'p1' }], wbs, ['t1'], 'p2-root');
  assert.equal(result[0].code, 'CROSS_PROJECT_TASK_WBS_MOVE');
});

test("görev WBS taşıması seçili görev kimliklerini tekilleştirir", () => {
  const result = validateTaskWbsMove([{ id: 't1', projectId: 'p2' }], wbs, ['t1', 't1'], 'p1-root');
  assert.equal(result.length, 1);
});

test("görev WBS taşıması çok sayıda aynı projeli görevi kabul eder", () => {
  const tasks = [{ id: 't1', projectId: 'p1' }, { id: 't2', projectId: 'p1' }];
  assert.deepEqual(validateTaskWbsMove(tasks, wbs, ['t1', 't2'], 'p1-b'), []);
});

for (const [name, args, expected] of [
  ['missing source node', ['missing', 'p1-root'], 'WBS_NODE_NOT_FOUND'],
  ['missing target parent', ['p1-a', 'missing'], 'WBS_PARENT_NOT_FOUND'],
  ['root movement', ['p1-root', 'p1-a'], 'WBS_ROOT_REPARENT_FORBIDDEN'],
  ['self-parenting', ['p1-a', 'p1-a'], 'WBS_SELF_PARENT'],
  ['cross-project movement', ['p1-a', 'p2-root'], 'CROSS_PROJECT_WBS_PARENT'],
  ['movement below a descendant', ['p1-a', 'p1-a1'], 'WBS_REPARENT_TO_DESCENDANT']
]) {
  test(`WBS üst öğe doğrulaması ${name} durumunu reddeder`, () => {
    assert.equal(validateWbsReparent(wbs, ...args)[0].code, expected);
  });
}

test("WBS üst doğrulaması aynı projeli kardeş dala taşımayı kabul eder", () => {
  assert.deepEqual(validateWbsReparent(wbs, 'p1-a1', 'p1-b'), []);
});

test("WBS silme doğrulaması kullanılmayan yaprağı kabul eder", () => {
  assert.deepEqual(validateWbsDeletion(wbs, [], 'p1-a1'), []);
});

test("WBS silme doğrulaması doğrudan çocukları bildirir", () => {
  const result = validateWbsDeletion(wbs, [], 'p1-a');
  assert.equal(result[0].code, 'WBS_HAS_CHILDREN');
  assert.deepEqual(result[0].details.childIds, ['p1-a1']);
});

test("WBS silme doğrulaması doğrudan atanmış görevleri bildirir", () => {
  const result = validateWbsDeletion(wbs, [{ id: 't1', wbsId: 'p1-a1' }], 'p1-a1');
  assert.equal(result[0].code, 'WBS_HAS_TASKS');
  assert.deepEqual(result[0].details.taskIds, ['t1']);
});

test("WBS silme doğrulaması iki engel varsa çocuğu görevden önce bildirir", () => {
  const result = validateWbsDeletion(wbs, [{ id: 't1', wbsId: 'p1-a' }], 'p1-a');
  assert.deepEqual(codes(result), ['WBS_HAS_CHILDREN', 'WBS_HAS_TASKS']);
});


test("WBS silme doğrulaması boş olsa da proje kökünü reddeder", () => {
  const result = validateWbsDeletion(wbs, [], 'p2-root');
  assert.equal(result[0].code, 'WBS_ROOT_DELETE_FORBIDDEN');
});
