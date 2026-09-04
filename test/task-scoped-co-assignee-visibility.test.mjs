import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  filterTaskAssigneeCandidates,
  resolveTaskAssigneeDisplayRecords,
  taskAssigneeMutationPatch
} from '../src/features/task-detail/taskAssigneeDisplay.js';
import { resolveTaskMutationAccess } from '../src/state/projectWritePolicy.js';
import { createActualStack, DEFAULT_CALENDAR_ID } from './helpers/actualStack.mjs';
import { resolveAvatarEntries } from '../src/components/avatarIdentity.js';
import { personPhotoUrl } from '../src/lib/userPhoto.js';

const PROJECT_ID = '71111111-1111-4111-8111-111111111111';
const WBS_ID = '72222222-2222-4222-8222-222222222222';
const TASK_ID = '73333333-3333-4333-8333-333333333333';
const OWNER = 920001;
const CURRENT_ASSIGNEE = 920002;
const CO_ASSIGNEE = 920003;
const HIDDEN_CREATOR = 920004;
const PHOTO_BASE = 'https://fotograf.test.internal/kurumsal/personel';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function seed() {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Takvim', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: OWNER, DisplayName: 'Proje Sahibi', Username: 'projesahibi' },
      { Sicil: CURRENT_ASSIGNEE, DisplayName: 'Ayşe Görevli', Username: 'aysegorevli' },
      { Sicil: CO_ASSIGNEE, DisplayName: 'Mehmet Görevli', Username: 'mehmetgorevli' }
    ],
    projects: [{
      ProjectId: PROJECT_ID,
      SourceType: 'MANUAL',
      ProjectCode: 'ORTAK',
      ProjectName: 'Ortak Görev Projesi',
      LeadSicil: OWNER,
      CalendarId: DEFAULT_CALENDAR_ID,
      IsActive: 1
    }],
    projectAccess: [{ ProjectId: PROJECT_ID, Sicil: OWNER, AccessLevel: 'FULL', GrantSource: 'OWNER' }],
    wbs: [{ WbsId: WBS_ID, ProjectId: PROJECT_ID, ParentWbsId: null, Code: '1', Name: 'Ortak Görev Projesi' }],
    tasks: [{
      TaskId: TASK_ID,
      ProjectId: PROJECT_ID,
      WbsId: WBS_ID,
      Title: 'Birlikte yürütülen görev',
      Status: 'todo',
      Priority: 'medium',
      TargetFinish: '2026-09-10'
    }],
    taskAssignees: [
      { TaskId: TASK_ID, Sicil: CURRENT_ASSIGNEE },
      { TaskId: TASK_ID, Sicil: CO_ASSIGNEE }
    ]
  };
}

test('göreve atanmış kullanıcı tüm eş sorumlu adlarını görev kapsamında ve salt okunur görür', async () => {
  const stack = await createActualStack(seed(), { sicil: CURRENT_ASSIGNEE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    assert.deepEqual(task.assigneeIds, [String(CURRENT_ASSIGNEE)]);
    assert.deepEqual(task.assigneeDisplayNames, ['Ayşe Görevli', 'Mehmet Görevli']);
    assert.deepEqual(task.sorumlu, ['Ayşe Görevli', 'Mehmet Görevli']);
    assert.deepEqual(task.assigneeAvatarIdentities, [
      { name: 'Ayşe Görevli', employeeNo: String(CURRENT_ASSIGNEE) },
      { name: 'Mehmet Görevli', employeeNo: String(CO_ASSIGNEE) }
    ]);
    assert.equal(stack.state.people.some((person) => person.id === String(CO_ASSIGNEE)), false);

    const avatarEntries = resolveAvatarEntries({ people: task.assigneeAvatarIdentities });
    assert.equal(
      personPhotoUrl(avatarEntries[1].person, PHOTO_BASE),
      `${PHOTO_BASE}/${CO_ASSIGNEE}.jpg`
    );

    const records = resolveTaskAssigneeDisplayRecords(task, stack.state.people, true);
    assert.deepEqual(records.map((record) => record.name), ['Ayşe Görevli', 'Mehmet Görevli']);
    assert.equal(records[1].id, null);
    assert.deepEqual(records[1].person, {
      name: 'Mehmet Görevli',
      employeeNo: String(CO_ASSIGNEE)
    });

    const contentAccess = resolveTaskMutationAccess(stack.state, task.id, { task: 'Güncel başlık' });
    assert.equal(contentAccess.ok, true);
    assert.equal(contentAccess.scope, 'ASSIGNEE');
    assert.equal(contentAccess.canManageAssignees, false);

    const assigneeAccess = resolveTaskMutationAccess(stack.state, task.id, {
      assigneeIds: [String(CURRENT_ASSIGNEE), String(CO_ASSIGNEE)]
    });
    assert.equal(assigneeAccess.ok, false);
    assert.equal(assigneeAccess.code, 'TASK_ASSIGNEE_FIELD_FORBIDDEN');
  } finally {
    await stack.dispose();
  }
});

test('sorumlu düzenlemesi rehberde çözülemeyen kimlik ve adları korur', () => {
  const people = [
    { id: '1001', name: 'Ayşe Görevli' },
    { id: '1003', name: 'Yeni Görevli' }
  ];
  const task = {
    assigneeIds: ['1001', '1002'],
    assigneeDisplayNames: ['Ayşe Görevli', 'Rehber Dışı Görevli'],
    sorumlu: ['Ayşe Görevli', 'Rehber Dışı Görevli']
  };

  const added = taskAssigneeMutationPatch(task, people, [...task.assigneeIds, '1003']);
  assert.deepEqual(added.assigneeIds, ['1001', '1002', '1003']);
  assert.deepEqual(added.sorumlu, ['Ayşe Görevli', 'Yeni Görevli', 'Rehber Dışı Görevli']);

  const removed = taskAssigneeMutationPatch(task, people, ['1002']);
  assert.deepEqual(removed.assigneeIds, ['1002']);
  assert.deepEqual(removed.sorumlu, ['Rehber Dışı Görevli']);
});

test('çözülemeyen sorumlu adıyla çakışan rehber kişisi yeniden aday gösterilmez', () => {
  const people = [
    { id: '2001', name: '  Rehber Dışı Görevli  ' },
    { id: '2002', name: 'Başka Görevli' }
  ];
  const task = {
    assigneeIds: ['1002'],
    sorumlu: ['Rehber Dışı Görevli']
  };

  const selected = resolveTaskAssigneeDisplayRecords(task, people, false);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, null);

  const candidates = filterTaskAssigneeCandidates(people, selected);
  assert.deepEqual(candidates.map((person) => person.id), ['2002']);
});

test('kırpılmış görev kapsamı adı rehber kişisini ikinci kez göstermez', () => {
  const records = resolveTaskAssigneeDisplayRecords({
    assigneeIds: ['1001'],
    assigneeDisplayNames: ['Ayşe Görevli']
  }, [{ id: '1001', name: '  Ayşe Görevli  ' }], true);

  assert.equal(records.length, 1);
  assert.equal(records[0].id, '1001');
});

test('görev güncelleme yanıtı gizli Sicili maskeleyip önceki görev kapsamlı fotoğrafı korur', async () => {
  const stack = await createActualStack(seed(), { sicil: CURRENT_ASSIGNEE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    const result = await stack.persistence.updateTask(task.id, { task: 'Güncellenen görev' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.taskUpserts[0].assigneeDisplayNames, ['Ayşe Görevli', 'Mehmet Görevli']);
    assert.deepEqual(result.value.taskUpserts[0].assigneeAvatarIdentities, [
      { name: 'Ayşe Görevli', employeeNo: String(CURRENT_ASSIGNEE) }
    ]);
    assert.equal(JSON.stringify(result.value.taskUpserts[0]).includes(String(CO_ASSIGNEE)), false);
    assert.deepEqual(stack.state.tasks[0].assigneeDisplayNames, ['Ayşe Görevli', 'Mehmet Görevli']);
    assert.deepEqual(stack.state.tasks[0].assigneeAvatarIdentities, [
      { name: 'Ayşe Görevli', employeeNo: String(CURRENT_ASSIGNEE) },
      { name: 'Mehmet Görevli', employeeNo: String(CO_ASSIGNEE) }
    ]);
    assert.equal(
      personPhotoUrl(stack.state.tasks[0].assigneeAvatarIdentities[1], PHOTO_BASE),
      `${PHOTO_BASE}/${CO_ASSIGNEE}.jpg`
    );
    assert.deepEqual(stack.db.taskAssignees.map((entry) => entry.Sicil).sort(), [CURRENT_ASSIGNEE, CO_ASSIGNEE]);
  } finally {
    await stack.dispose();
  }
});

test('kısmi görev sorumlusu görevi tanımlayan kişinin kimlik, ad ve fotoğraf anahtarını görür', async () => {
  const data = seed();
  data.people.push({ Sicil: HIDDEN_CREATOR, DisplayName: 'Gizli Oluşturan', Username: 'gizliolusturan' });
  data.tasks[0].CreatedBySicil = HIDDEN_CREATOR;
  const stack = await createActualStack(data, { sicil: CURRENT_ASSIGNEE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    assert.equal(task.createdBySicil, String(HIDDEN_CREATOR));
    assert.equal(task.createdByName, 'Gizli Oluşturan');
    assert.equal(task.isCurrentUserCreator, false);
    assert.equal(stack.state.people.some((person) => person.id === String(HIDDEN_CREATOR)), false);
    assert.equal(JSON.stringify(task).includes(String(HIDDEN_CREATOR)), true);
    assert.equal(JSON.stringify(task).includes('Gizli Oluşturan'), true);

    const result = await stack.persistence.updateTask(task.id, { task: 'Kimlik sızdırmadan güncellendi' });
    assert.equal(result.ok, true);
    assert.equal(result.value.taskUpserts[0].createdBySicil, String(HIDDEN_CREATOR));
    assert.equal(result.value.taskUpserts[0].createdByName, 'Gizli Oluşturan');
  } finally {
    await stack.dispose();
  }
});

test('kendi oluşturduğu görevin yetkili künye kimliği snapshot ve mutasyon yanıtında korunur', async () => {
  const data = seed();
  data.tasks[0].CreatedBySicil = CURRENT_ASSIGNEE;
  const stack = await createActualStack(data, { sicil: CURRENT_ASSIGNEE, corporateWbsSource: false });
  try {
    const task = stack.state.tasks[0];
    assert.equal(task.createdBySicil, String(CURRENT_ASSIGNEE));
    assert.equal(task.createdByName, 'Ayşe Görevli');
    assert.equal(task.isCurrentUserCreator, true);

    const result = await stack.persistence.updateTask(task.id, { task: 'Künye korunarak güncellendi' });
    assert.equal(result.ok, true);
    assert.equal(result.value.taskUpserts[0].createdBySicil, String(CURRENT_ASSIGNEE));
    assert.equal(result.value.taskUpserts[0].createdByName, 'Ayşe Görevli');
  } finally {
    await stack.dispose();
  }
});

test('rehber adı bulunmayan kapsam dışı eş sorumlunun Sicili ad yerine açığa çıkmaz', async () => {
  const missingDirectoryEntry = seed();
  missingDirectoryEntry.people = missingDirectoryEntry.people.filter((person) => person.Sicil !== CO_ASSIGNEE);
  const stack = await createActualStack(missingDirectoryEntry, {
    sicil: CURRENT_ASSIGNEE,
    corporateWbsSource: false
  });
  try {
    const task = stack.state.tasks[0];
    assert.deepEqual(task.assigneeIds, [String(CURRENT_ASSIGNEE)]);
    assert.deepEqual(task.assigneeDisplayNames, ['Ayşe Görevli']);
    assert.equal(JSON.stringify(task).includes(String(CO_ASSIGNEE)), false);
    assert.equal(task.assigneeCount, 2);
    for (const drawerPath of [
      'src/features/task-detail/TaskDrawer.jsx',
      'src/features/task-detail/SimpleTaskDrawer.jsx'
    ]) {
      const drawer = read(drawerPath);
      assert.match(drawer, /Number\(local\.assigneeCount \|\| 0\) - selectedAssignees\.length/);
      assert.match(drawer, /sorumlunun adı personel kaydında bulunamadığı için gösterilemiyor/);
    }
  } finally {
    await stack.dispose();
  }
});

test('genel personel sorgusu eş sorumluyu görev görünürlüğünden rehbere taşımaz', () => {
  const repositorySource = read('src/server/repository/sqlAppRepository.js');
  const projectionSource = read('src/server/repository/projectedSqlAppRepository.js');
  assert.match(repositorySource, /OR visibleAssignee\.Sicil = @sicil/);
  assert.match(repositorySource, /es\.EmployeeSicil = visibleAssignee\.Sicil/);
  assert.doesNotMatch(repositorySource, /visibilityGate\.TaskId = visibleTask\.TaskId/);
  assert.match(repositorySource, /CASE WHEN auth\.IdentityVisible = 1 THEN ta\.Sicil ELSE NULL END AS Sicil/);
  assert.match(repositorySource, /WHEN auth\.IdentityVisible = 1\s+AND NULLIF\(LTRIM\(RTRIM\(pd\.DisplayName\)\), ''\) IS NOT NULL\s+THEN ta\.Sicil/);
  assert.match(projectionSource, /END AS AvatarEmployeeNo/);
  assert.match(projectionSource, /JOIN STRING_SPLIT\(@taskIds, ','\) visible/);
});

test('SQL test doubles do not project assignees from inactive projects', () => {
  const fakeSql = read('test/helpers/fakeSqlServer.mjs');
  assert.match(fakeSql, /if \(!task \|\| !project\?\.IsActive\) return \[\];/);
  assert.match(fakeSql, /sqlText\.includes\('LEFT JOIN dbo\.MR_V_PeopleDirectory pd'\)/);
});
