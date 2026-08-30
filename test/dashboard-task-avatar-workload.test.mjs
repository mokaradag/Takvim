import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDashboardWorkload } from '../src/features/dashboard/workloadProjection.js';
import { parseDate } from '../src/scheduling/dates/index.js';

test('pano iş yükü görev kapsamlı Sicil kimliğini ve fotoğrafı genel dizin olmadan korur', () => {
  const rows = selectDashboardWorkload([{
    id: 'task-1',
    status: 'in_progress',
    targetFinish: '2026-09-03',
    sorumlu: ['Ayşe Demir'],
    assigneeDisplayNames: ['Ayşe Demir'],
    assigneeAvatarIdentities: [{ name: 'Ayşe Demir', employeeNo: '940002' }]
  }], [{ id: 'current-user', name: 'Başka Kullanıcı', employeeNo: '940001' }], parseDate('2026-08-29'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sicil:940002');
  assert.deepEqual(rows[0].person, { name: 'Ayşe Demir', employeeNo: '940002' });
});

test('aynı adlı çalışanlar Sicil ile ayrılır ve yanlış dizin fotoğrafı kullanılmaz', () => {
  const rows = selectDashboardWorkload([{
    id: 'task-1',
    status: 'planned',
    targetFinish: '2026-09-03',
    sorumlu: ['Deniz Kaya', 'Deniz Kaya'],
    assigneeDisplayNames: ['Deniz Kaya', 'Deniz Kaya'],
    assigneeAvatarIdentities: [
      { name: 'Deniz Kaya', employeeNo: '940010' },
      { name: 'Deniz Kaya', employeeNo: '940011' }
    ]
  }], [{ id: 'person-a', name: 'Deniz Kaya', employeeNo: '940010', photoUrl: '/photo/a' }], parseDate('2026-08-29'));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id), ['sicil:940010', 'sicil:940011']);
  assert.equal(rows[0].person.photoUrl, '/photo/a');
  assert.equal(rows[1].person.photoUrl, undefined);
  assert.equal(rows[1].person.employeeNo, '940011');
});

test('boş görev projeksiyonu eski sorumlu adlarına düşer ve karma kimlikler tek Sicil satırında birleşir', () => {
  const people = [{ id: 'person-1', name: 'Ayşe Demir', employeeNo: '940002', photoUrl: '/photo/ayse' }];
  const rows = selectDashboardWorkload([
    {
      id: 'task-1',
      status: 'planned',
      targetFinish: '2026-09-03',
      sorumlu: ['Ayşe Demir'],
      assigneeDisplayNames: [],
      assigneeIds: ['person-1']
    },
    {
      id: 'task-2',
      status: 'in_progress',
      targetFinish: '2026-09-04',
      assigneeDisplayNames: ['Ayşe Demir'],
      assigneeAvatarIdentities: [{ name: 'Ayşe Demir', employeeNo: '940002' }]
    }
  ], people, parseDate('2026-08-29'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sicil:940002');
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].person.photoUrl, '/photo/ayse');
});

test('boş sorumlu adları elenirken izleyen sorumlunun kimlik sırası korunur', () => {
  const people = [{ id: 'person-2', name: 'Ayşe Demir', employeeNo: '940002', photoUrl: '/photo/ayse' }];
  const rows = selectDashboardWorkload([{
    id: 'task-1',
    status: 'planned',
    targetFinish: '2026-09-03',
    assigneeDisplayNames: ['', 'Ayşe Demir'],
    assigneeIds: ['person-1', 'person-2']
  }], people, parseDate('2026-08-29'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sicil:940002');
  assert.equal(rows[0].person.photoUrl, '/photo/ayse');
});
