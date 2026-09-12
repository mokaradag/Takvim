import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';
import { activityDateRange } from '../src/server/reports/activityDates.js';
import { taskActivityChanges } from '../src/server/reports/taskActivityChanges.js';
import { fetchTaskActivities } from '../src/data/api/taskActivityClient.js';
registerServerOnlyShim();
const { TASK_ACTIVITY_SQL, normalizeActivityQuery } = await import('../src/server/reports/taskActivityReport.js');
const PROJECT = '11111111-1111-4111-8111-888888888881';
const PRIVATE = '11111111-1111-4111-8111-888888888882';
const TASK = '33333333-3333-4333-8333-888888888881';
const OTHER = '33333333-3333-4333-8333-888888888882';
const DELETED = '33333333-3333-4333-8333-888888888883';
const manager = 950001, employee = 950002, outsider = 950003;
const range = { period: 'custom', from: '2026-09-08', to: '2026-09-08' };
function event(id, overrides = {}) {
  return { AuditId: id, OccurredAt: '2026-09-08T10:00:00Z', ActorSicil: employee, ActorDisplayName: 'Ayşe Demir',
    EntityType: 'TASK', EntityId: TASK, ProjectId: PROJECT, ActionCode: 'UPDATE', CorrelationId: `action-${id}`,
    BeforeJson: JSON.stringify({ Title: 'Radar testleri', Status: 'todo', Progress: 20 }),
    AfterJson: JSON.stringify({ Title: 'Radar testleri', Status: 'in_progress', Progress: 50 }), ...overrides };
}
function seed(overrides = {}) {
  return { calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }], people: [
    { Sicil: manager, DisplayName: 'Yönetici' },
    { Sicil: employee, DisplayName: 'Ayşe Yeni Soyadı', Directorate: 'D', Department: 'M', Unit: 'B' },
    { Sicil: outsider, DisplayName: 'Kapsam dışı', Directorate: 'D2', Department: 'M', Unit: 'B' }
  ], executiveScope: [{ ManagerSicil: manager, EmployeeSicil: employee }],
  projects: [
    { ProjectId: PROJECT, SourceType: 'CORPORATE', ProjectCode: 'PRJ-123', ProjectName: 'Radar' },
    { ProjectId: PRIVATE, SourceType: 'CORPORATE', ProjectCode: 'PRJ-456', ProjectName: 'Gizli' }
  ], tasks: [{ TaskId: TASK, ProjectId: PROJECT, Title: 'Yeni görev adı', Status: 'in_progress', CreatedBySicil: outsider },
    { TaskId: OTHER, ProjectId: PRIVATE, Title: 'Görünmemeli', Status: 'todo', CreatedBySicil: outsider }],
  taskAssignees: [{ TaskId: TASK, Sicil: employee }, { TaskId: OTHER, Sicil: outsider }],
  auditLog: [event(1)], ...overrides };
}

test('Bugün ve Dün, UTC gece yarısını değil İstanbul takvim gününü kapsar', () => {
  const today = activityDateRange({}, new Date('2026-09-07T21:15:00Z'));
  assert.equal(today.from, '2026-09-08');
  assert.equal(today.startUtc.toISOString(), '2026-09-07T21:00:00.000Z');
  assert.equal(today.endUtc.toISOString(), '2026-09-08T21:00:00.000Z');
  const yesterday = activityDateRange({ period: 'yesterday' }, new Date('2026-09-07T21:15:00Z'));
  assert.equal(yesterday.startUtc.toISOString(), '2026-09-06T21:00:00.000Z');
  assert.equal(yesterday.endUtc.toISOString(), today.startUtc.toISOString());
  const week = activityDateRange({ period: 'week' }, new Date('2026-09-07T21:15:00Z'));
  assert.equal(week.from, '2026-09-02');
  assert.equal(week.to, '2026-09-08');
  const historical = activityDateRange({ period: 'custom', from: '2015-01-08', to: '2015-01-08' });
  assert.equal(historical.startUtc.toISOString(), '2015-01-07T22:00:00.000Z');
});

test('rapor girdileri sınırlandırılır; yetkisiz ekip seçimi ve bozuk aralık reddedilir', () => {
  const actor = { isExecutive: false, isSystemAdmin: false };
  assert.throws(() => normalizeActivityQuery({ ...range, scope: 'team' }, actor), /yönetici kapsamı/);
  for (const input of [{ pageSize: 51 }, { page: -1 }, { person: '1 OR 1=1' }, { projectId: 'secret' }, { kind: 'UPDATE' },
    { period: 'custom', from: '2026-02-30' }, { period: 'custom', from: '2024-01-01', to: '2026-01-01' }]) {
    assert.throws(() => normalizeActivityQuery({ ...range, ...input }, actor));
  }
  assert.equal(normalizeActivityQuery(range, { isExecutive: true }).scope, 'team');
});

test('alan farkları Türkçe iş diline çevrilir; tek kaydetmedeki tekrarlar net farkta birleşir', () => {
  const first = event(1, { BeforeJson: JSON.stringify({ Status: 'todo', Progress: 20, Priority: 'medium', TargetFinish: '2026-09-10', assigneeIds: [1] }),
    AfterJson: JSON.stringify({ status: 'in_progress', progress: 50, priority: 'high', targetFinish: '2026-09-12', assigneeIds: [2] }) });
  const second = event(2, { BeforeJson: JSON.stringify({ progress: 50 }), AfterJson: JSON.stringify({ progress: 70 }) });
  const result = taskActivityChanges([first, second], new Map([['1', 'Mehmet'], ['2', 'Ahmet']]));
  assert.ok(result.changes.includes('Durum: Yapılacak → Devam ediyor'));
  assert.ok(result.changes.includes('İlerleme: %20 → %70'));
  assert.ok(result.changes.includes('Öncelik: Orta → Yüksek'));
  assert.ok(result.changes.some((line) => line.startsWith('Termin: 10 Eyl 2026 → 12 Eyl 2026')));
  assert.ok(result.changes.includes('Sorumlu çıkarıldı: Mehmet'));
  assert.ok(result.changes.includes('Sorumlu eklendi: Ahmet'));
  assert.equal(result.changes.some((line) => line.includes('Progress') || line.includes('UPDATE')), false);
  assert.equal(taskActivityChanges([event(3, { BeforeJson: '{broken', AfterJson: '{}' })]).changes[0], 'Görev güncellendi');
});

test('yönetici ekip aktörünü görür; çalışanın ilgisiz görevi ve başka aktör kapsamı açmaz', async () => {
  const stack = await createActualStack(seed({ auditLog: [event(1), event(2, { EntityId: OTHER, ProjectId: PRIVATE }), event(3, { ActorSicil: outsider })] }), { sicil: manager, corporateWbsSource: false });
  try {
    const report = await fetchTaskActivities(range);
    assert.equal(report.ok, true); assert.equal(report.value.total, 1);
    assert.equal(report.value.items[0].actorName, 'Ayşe Demir');
    assert.equal(report.value.items[0].taskTitle, 'Radar testleri');
    assert.equal(report.value.items[0].actorId, String(employee));
    assert.deepEqual(report.value.filters.people.map((person) => person.id), [String(employee)]);
    assert.deepEqual(report.value.filters.projects.map((project) => project.id), [PROJECT]);
    for (const manipulated of [{ person: outsider }, { projectId: PRIVATE }, { person: employee, projectId: PRIVATE, scope: 'visible', isAdmin: 'true', sicil: outsider }]) {
      assert.equal((await fetchTaskActivities({ ...range, ...manipulated })).value.total, 0);
    }
    const visible = await fetchTaskActivities({ ...range, scope: 'visible' });
    assert.equal(visible.value.total, 2);
    assert.equal(visible.value.items.some((row) => row.actorId === String(outsider)), true, 'aktör mevcut sorumludan türetilmez');
    const response = await fetch(`/api/mergen-rota/reports/task-activities?${new URLSearchParams(range)}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(await response.json()), /BeforeJson|AfterJson|ActorSicil|CorrelationId|RowVersion/);
  } finally { await stack.dispose(); }
});

for (const permission of ['SYSTEM_ADMIN', 'FULL', 'READ']) {
  test(`${permission}: mevcut geniş görünürlük kuralları korunur`, async () => {
    const stack = await createActualStack(seed({
      ...(permission === 'SYSTEM_ADMIN' ? { systemAdminSicils: [manager] } : { projectAccess: [{ ProjectId: PRIVATE, Sicil: manager, AccessLevel: permission }] }),
      auditLog: [event(1), event(2, { EntityId: OTHER, ProjectId: PRIVATE })]
    }), { sicil: manager, corporateWbsSource: false });
    try { assert.equal((await fetchTaskActivities(range)).value.total, 2); }
    finally { await stack.dispose(); }
  });
}

test('ilişkili çoklu alan değişiklikleri tek satır, özet ve tamamlanma olarak sayılır', async () => {
  const stack = await createActualStack(seed({ auditLog: [event(1, { CorrelationId: 'save' }), event(2, { CorrelationId: 'save',
    BeforeJson: JSON.stringify({ Status: 'in_progress', Progress: 50 }), AfterJson: JSON.stringify({ Status: 'done', Progress: 100 }) }),
    event(3, { EntityType: 'TASK_SCHEDULE_REQUEST' })] }), { sicil: manager, corporateWbsSource: false });
  try {
    const { value } = await fetchTaskActivities({ ...range, kind: 'completed' });
    assert.equal(value.total, 1); assert.deepEqual(value.summary, { tasks: 1, people: 1, completed: 1 });
    assert.ok(value.items[0].changes.includes('İlerleme: %20 → %100'));
    assert.ok(value.items[0].changes.includes('Tamamlandı'));
    assert.equal((await fetchTaskActivities({ ...range, kind: 'updated' })).value.total, 0);
  } finally { await stack.dispose(); }
});

test('silinen görev son yetkili atama künyesinden görünür; eksik eski kayıt güvenle korunur', async () => {
  const deletion = event(2, { EntityId: DELETED, ActionCode: 'DELETE', BeforeJson: JSON.stringify({ Title: 'Silinen radar testi', assigneeIds: [employee], CreatedBySicil: outsider }), AfterJson: null });
  const hiddenDeletion = event(3, { EntityId: OTHER, ProjectId: PRIVATE, ActionCode: 'DELETE', BeforeJson: JSON.stringify({ Title: 'Gizli silinen', assigneeIds: [outsider] }), AfterJson: null });
  const stack = await createActualStack(seed({ tasks: [], taskAssignees: [], auditLog: [deletion, hiddenDeletion] }), { sicil: manager, corporateWbsSource: false });
  try {
    const { value } = await fetchTaskActivities(range);
    assert.equal(value.total, 1); assert.equal(value.items[0].taskTitle, 'Silinen radar testi');
    assert.equal(value.items[0].taskAvailable, false); assert.deepEqual(value.items[0].changes, ['Görev silindi']);
  } finally { await stack.dispose(); }
});

test('tarih, kişi, proje, hareket türü ve tam kurumsal yol sunucuda süzülür; sayfa büyüklüğü sınırlıdır', async () => {
  const events = Array.from({ length: 61 }, (_, index) => event(index + 1));
  events.push(event(62, { OccurredAt: '2026-09-07T20:59:59Z' }), event(63, { OccurredAt: '2026-09-08T21:00:00Z' }),
    event(64, { OccurredAt: '2026-09-07T21:00:00Z' }));
  const stack = await createActualStack(seed({ auditLog: events }), { sicil: manager, corporateWbsSource: false });
  try {
    const { value } = await fetchTaskActivities({ ...range, person: employee, projectId: PROJECT, kind: 'updated', directorate: 'D', department: 'D\u001fM', unit: 'D\u001fM\u001fB' });
    assert.equal(value.total, 62); assert.equal(value.items.length, 25); assert.equal(value.items[0].id, '61');
    const last = (await fetchTaskActivities({ ...range, page: 999 })).value;
    assert.equal(last.page, 2); assert.equal(last.items.length, 12); assert.equal(last.items.at(-1).id, '64');
    assert.equal((await fetchTaskActivities({ ...range, department: 'D2\u001fM' })).value.total, 0);
    assert.equal((await fetchTaskActivities({ ...range, period: 'custom', from: '2026-09-09', to: '2026-09-09' })).value.total, 1);
    assert.equal((await fetchTaskActivities({ ...range, pageSize: 51 })).ok, false);
  } finally { await stack.dispose(); }
});

test('sorgu güvenlik sınırı ve dizin sözleşmesi; ham geçmiş genel anlık görüntüye eklenmez', () => {
  assert.match(TASK_ACTIVITY_SQL, /a\.OccurredAt >= @startUtc AND a\.OccurredAt < @endUtc/);
  assert.match(TASK_ACTIVITY_SQL, /es\.EmployeeSicil = a\.ActorSicil/);
  assert.match(TASK_ACTIVITY_SQL, /t\.ProjectId = a\.ProjectId AND EXISTS/);
  assert.match(TASK_ACTIVITY_SQL, /@partialTasks/);
  assert.match(TASK_ACTIVITY_SQL, /GROUP BY ActionGroup, EntityId, ActorSicil, ProjectId/);
  assert.match(TASK_ACTIVITY_SQL, /OFFSET \(@safePage \* @pageSize\) ROWS FETCH NEXT @pageSize/);
  assert.doesNotMatch(TASK_ACTIVITY_SQL, /CAST\(.*OccurredAt AS date\)|GETUTCDATE|NOLOCK/);
  assert.match(readFileSync(new URL('../database/MR_Upgrade_0009_Task_Activity_Report.sql', import.meta.url), 'utf8'), /EntityType, OccurredAt DESC, AuditId DESC/);
  assert.doesNotMatch(readFileSync(new URL('../src/server/repository/projectedSqlAppRepository.js', import.meta.url), 'utf8'), /MR_AuditLog|queryTaskActivities/);
});

test('kaydedilen görev denetimi kalıcı değerleri ve atamaları taşır; dar yazma sahte fark üretmez', async () => {
  const stack = await createActualStack(seed({ auditLog: [] }), { sicil: employee, corporateWbsSource: false });
  try {
    const saved = await stack.persistence.updateTask(TASK, { description: 'Yeni not', progress: 70 });
    assert.equal(saved.ok, true);
    assert.equal((await stack.persistence.flush()).ok, true);
    const audit = stack.db.auditLog.find((row) => row.EntityType === 'TASK');
    assert.ok(audit);
    const before = JSON.parse(audit.BeforeJson), after = JSON.parse(audit.AfterJson);
    assert.deepEqual(before.assigneeIds, [employee]); assert.deepEqual(after.assigneeIds, [employee]);
    assert.equal(after.Title, stack.db.tasks[0].Title);
    assert.equal(after.Progress, stack.db.tasks[0].Progress);
    assert.equal(after.PlannedStart, stack.db.tasks[0].PlannedStart);
    assert.equal(audit.ActorSicil, employee);
    const changes = taskActivityChanges([audit]).changes;
    assert.deepEqual(changes.slice(0, 2), ['Notlar: — → Yeni not', 'İlerleme: — → %70']);
    assert.match(after.ActualStart, /^\d{4}-\d{2}-\d{2}$/);
    const expectedActualStart = new Intl.DateTimeFormat('tr-TR', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(after.ActualStart));
    assert.equal(changes[2], `Gerçekleşen başlangıç: — → ${expectedActualStart}`);
    assert.equal(changes.length, 3);
  } finally { await stack.dispose(); }
});
