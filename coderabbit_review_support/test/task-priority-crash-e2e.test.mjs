/**
 * "Yeni görev" sonrası istemci çökmesi · uçtan uca.
 *
 * Belirti: Görevler sayfasından bir görev oluşturulduğunda tarayıcı
 * "Application error: a client-side exception has occurred" ekranına düşüyor,
 * konsolda `TypeError: Cannot read properties of undefined (reading 'color')`
 * görünüyordu. Aynı hata Kanban ve Raporlar sayfalarında da, bir proje için tek
 * bir görev bulunması yeterliyken tekrarlanıyordu.
 *
 * Kök neden: Gerçek Sistem şeması önceliği belirtilmeyen görevlere `normal`
 * yazıyordu; arayüzün öncelik kataloğunda (`kritik/yüksek/orta/düşük`) böyle
 * bir kimlik yok. `PRIORITIES[t.priority]` `undefined` dönüyor, `prio.color`
 * okuması tüm ağacı düşürüyordu.
 *
 * Bu dosya gerçek kalıcılaştırma zinciriyle görev oluşturur, sunucudan dönen
 * anlık görüntüyü okur ve sayfaların o veriyle çöküp çökmediğini görünüm
 * mantığının kendisini çalıştırarak sınar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActualStack, corporateSeed } from './helpers/actualStack.mjs';
import { createNewTask } from '../src/state/appState.js';
import {
  DEFAULT_PRIORITY_ID,
  PRIORITIES,
  normalizePriorityId,
  resolvePriority
} from '../src/domain/constants/index.js';
import { normalizeTaskRecord } from '../src/data/normalizeTaskRecord.js';

const TASK_ID = 'task-2b1f4d0e-7c4a-4c19-9f2b-0d6a1e5c8b31';

async function createTaskThroughStack(stack) {
  const project = stack.project('P4417041');
  const result = await stack.persistence.mutate('task/create', () => ({
    type: 'task/add',
    task: {
      ...createNewTask({ ...stack.state, workspaceMode: 'project', selectedProjectId: project.id }, undefined, TASK_ID),
      task: 'Yeni görev'
    }
  }));
  assert.equal(result.ok, true, result.error?.message);
  return project;
}

test('öncelik kataloğu bilinmeyen ve eski değerleri kanonik kimliğe indirger', () => {
  assert.equal(normalizePriorityId('normal'), DEFAULT_PRIORITY_ID);
  assert.equal(normalizePriorityId(undefined), DEFAULT_PRIORITY_ID);
  assert.equal(normalizePriorityId(''), DEFAULT_PRIORITY_ID);
  assert.equal(normalizePriorityId('   '), DEFAULT_PRIORITY_ID);
  assert.equal(normalizePriorityId('CRITICAL'), 'critical');
  assert.equal(normalizePriorityId('bilinmeyen-deger'), DEFAULT_PRIORITY_ID);

  // Hiçbir giriş için tanım eksik dönmez; `prio.color` her zaman okunabilir.
  for (const value of ['normal', null, undefined, '', 42, {}, 'low', 'high']) {
    const priority = resolvePriority(value);
    assert.ok(priority, `öncelik tanımı bulunmalıdır: ${String(value)}`);
    assert.equal(typeof priority.color, 'string');
    assert.equal(typeof priority.label, 'string');
    assert.ok(PRIORITIES[priority.id]);
  }
});

test('Görevler sayfasından oluşturulan görev katalogda karşılığı olan öncelikle döner', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    await createTaskThroughStack(stack);
    await stack.reload();

    const task = stack.state.tasks.find((entry) => entry.task === 'Yeni görev');
    assert.ok(task, 'oluşturulan görev anlık görüntüde bulunmalıdır');
    assert.ok(PRIORITIES[task.priority], `öncelik katalogda olmalıdır: ${task.priority}`);
    assert.equal(task.priority, DEFAULT_PRIORITY_ID);

    // Görevler/Kanban/Gantt satırlarının okuduğu ifade tam olarak budur.
    const prio = resolvePriority(task.priority);
    assert.equal(prio.color, PRIORITIES[DEFAULT_PRIORITY_ID].color);
  } finally {
    await stack.dispose();
  }
});

test('kalıcı kayıttaki eski `normal` önceliği arayüze kanonik olarak taşınır', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    await createTaskThroughStack(stack);

    // Eski sürümlerin yazdığı kayıt taklit edilir: veritabanında `normal` durur.
    for (const row of stack.db.tasks) row.Priority = 'normal';
    await stack.reload();

    const task = stack.state.tasks.find((entry) => entry.task === 'Yeni görev');
    assert.equal(task.priority, DEFAULT_PRIORITY_ID, 'eski değer sunucu izdüşümünde kanonikleştirilmelidir');
    assert.ok(PRIORITIES[task.priority]);
  } finally {
    await stack.dispose();
  }
});

test('veri sınırı bozuk öncelik taşıyan kayıtları da güvenli hâle getirir', () => {
  const context = {
    projects: [{ id: 'p1', name: 'Alpha', code: 'A1', color: 'blue' }],
    people: [],
    wbs: [{ id: 'w1', projectId: 'p1', parentId: null, code: '1', name: 'Alpha', sortOrder: 1 }],
    calendars: []
  };

  for (const value of ['normal', 'GARIP', '', null, undefined]) {
    const record = normalizeTaskRecord({ id: 't1', projectId: 'p1', task: 'X', priority: value }, context);
    assert.ok(PRIORITIES[record.priority], `normalizasyon katalog kimliği vermelidir: ${String(value)}`);
  }

  const preserved = normalizeTaskRecord({ id: 't2', projectId: 'p1', task: 'Y', priority: 'critical' }, context);
  assert.equal(preserved.priority, 'critical', 'geçerli öncelik değiştirilmemelidir');
});

test('Görevler, Kanban ve Raporlar öncelik okumalarını çökmeden yapar', async () => {
  const stack = await createActualStack(corporateSeed());
  try {
    await createTaskThroughStack(stack);
    for (const row of stack.db.tasks) row.Priority = 'normal';
    await stack.reload();

    const tasks = stack.state.tasks;
    assert.equal(tasks.length, 1);

    // Görevler ve Kanban satırı: `resolvePriority(...).color`
    for (const task of tasks) {
      assert.doesNotThrow(() => resolvePriority(task.priority).color);
      assert.doesNotThrow(() => resolvePriority(task.priority).label);
    }

    // Raporlar risk matrisi: katalog anahtarlarıyla kurulur, görevler oraya düşer.
    const matrix = {};
    for (const key of Object.keys(PRIORITIES)) matrix[key] = { todo: [], in_progress: [], overdue: [] };
    assert.doesNotThrow(() => {
      for (const task of tasks) {
        if (task.status === 'done') continue;
        matrix[normalizePriorityId(task.priority)].todo.push(task);
      }
    });
    assert.equal(matrix[DEFAULT_PRIORITY_ID].todo.length, 1);
  } finally {
    await stack.dispose();
  }
});
