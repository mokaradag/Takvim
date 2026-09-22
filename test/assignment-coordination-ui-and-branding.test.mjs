import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_STATE, findElement, mountComponent } from './helpers/clientComponentHarness.mjs';
import {
  COORDINATION_DECISIONS,
  COORDINATION_STATUSES,
  allowedCoordinationDecisions,
  isExternalOrganization,
  isOpenCoordinationStatus,
  organizationPath
} from '../src/domain/assignment/assignmentCoordination.js';
import {
  NOTIFICATION_PREVIEW_LIMIT,
  NOTIFICATION_SOURCES,
  mergeNotificationPreviews,
  totalNotificationCounts
} from '../src/domain/notifications/notificationInbox.js';
import {
  notificationCenterCounts,
  notificationCenterItems
} from '../src/features/notifications/notificationCenterItems.js';
import { APP_FAVICON_DATA_URI } from '../src/lib/appFavicon.js';

const { ScheduleRequestCenter } = await import('../src/features/schedule-change/ScheduleRequestCenter.jsx');
const { AssignmentCoordinationDialog } = await import('../src/features/assignment-coordination/AssignmentCoordinationDialog.jsx');
const { ExternalAssigneePicker } = await import('../src/features/assignment-coordination/ExternalAssigneePicker.jsx');
const { DirectoryPersonSearch } = await import('../src/features/assignment-coordination/DirectoryPersonSearch.jsx');
const { AssigneeMailToggle } = await import('../src/features/assignment-coordination/AssigneeMailToggle.jsx');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

/* ── Alan modeli ─────────────────────────────────────────────── */

test('koordinasyon kararları duruma ve role göre açılır', () => {
  assert.deepEqual(
    allowedCoordinationDecisions(COORDINATION_STATUSES.PENDING, { isManager: true }),
    [COORDINATION_DECISIONS.APPROVE, COORDINATION_DECISIONS.REQUEST_CHANGE, COORDINATION_DECISIONS.REJECT]
  );
  assert.deepEqual(
    allowedCoordinationDecisions(COORDINATION_STATUSES.PENDING, { isRequester: true }),
    [COORDINATION_DECISIONS.CANCEL]
  );
  assert.deepEqual(
    allowedCoordinationDecisions(COORDINATION_STATUSES.APPROVED, { isManager: true }),
    [COORDINATION_DECISIONS.REQUEST_CANCELLATION]
  );
  assert.deepEqual(
    allowedCoordinationDecisions(COORDINATION_STATUSES.CANCELLATION_REQUESTED, { isRequester: true }),
    [COORDINATION_DECISIONS.APPROVE, COORDINATION_DECISIONS.REJECT]
  );
  // Sonuçlanmış kayıt hiçbir eylem sunmaz.
  assert.deepEqual(allowedCoordinationDecisions(COORDINATION_STATUSES.REJECTED, { isManager: true }), []);
  assert.equal(isOpenCoordinationStatus(COORDINATION_STATUSES.PENDING), true);
  assert.equal(isOpenCoordinationStatus(COORDINATION_STATUSES.APPROVED), false);
});

test('kurumsal künye metni ve dış birim ayrımı yalnızca gösterim içindir', () => {
  assert.equal(organizationPath({ directorate: 'D', department: 'M', unit: 'B' }), 'D / M / B');
  assert.equal(organizationPath({ directorate: 'D', unit: null }), 'D');
  assert.equal(organizationPath({}), '');
  assert.equal(
    isExternalOrganization({ directorate: 'D', department: 'M', unit: 'B' }, { directorate: 'D', department: 'M', unit: 'C' }),
    true
  );
  assert.equal(
    isExternalOrganization({ directorate: 'D', department: 'M', unit: 'B' }, { directorate: 'D', department: 'M', unit: 'B' }),
    false
  );
  // Künyesi bilinmeyen kişi "dış birim" sayılmaz.
  assert.equal(isExternalOrganization({ directorate: 'D' }, {}), false);
});

test('zil üç kaynağı tek listede birleştirir ve önizlemeyi sekizle sınırlar', () => {
  const schedule = Array.from({ length: 6 }, (unused, index) => ({
    id: `s${index}`, status: 'PENDING', isDecisionOwner: true, taskTitle: `Talep ${index}`, unread: true
  }));
  const coordination = [{
    source: NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION, id: 'c1', status: 'PENDING', mode: 'REQUEST',
    assigneeName: 'Dış Personel', taskTitle: 'Görev', actionable: true, unread: true,
    sortAt: '2026-09-20T09:00:00.000Z', assigneeOrganization: 'D / M / B', allowedDecisions: []
  }];
  const events = [{
    source: NOTIFICATION_SOURCES.TASK_EVENT, id: 'n1', kind: 'TASK_ASSIGNED', taskCount: 1,
    actorName: 'Atayan', taskTitle: 'Görev', unread: true, actionable: false,
    sortAt: '2026-09-21T09:00:00.000Z', projectCode: 'P1', projectName: 'Proje'
  }];
  const items = notificationCenterItems({
    scheduleRequests: schedule, assignmentCoordinations: coordination, taskNotifications: events
  });
  assert.equal(items.length, 8);
  // Karar bekleyen kayıtlar önce gelir; bilgilendirme sona kalır.
  assert.equal(items[items.length - 1].id, 'n1');
  assert.equal(items.filter((item) => item.source === NOTIFICATION_SOURCES.SCHEDULE_REQUEST).length, 6);

  const many = Array.from({ length: 12 }, (unused, index) => ({
    id: `x${index}`, status: 'PENDING', isDecisionOwner: true, taskTitle: `T ${index}`, unread: true
  }));
  assert.equal(notificationCenterItems({ scheduleRequests: many }).length, NOTIFICATION_PREVIEW_LIMIT);
  assert.equal(mergeNotificationPreviews([[], []]).length, 0);
});

test('rozet sayısı bütün kaynakların toplamıdır', () => {
  assert.deepEqual(
    notificationCenterCounts({ unreadCount: 3, pendingCount: 1 }, { unreadCount: 2, pendingCount: 4 }),
    { unreadCount: 5, pendingCount: 5 }
  );
  assert.deepEqual(totalNotificationCounts([]), { unreadCount: 0, pendingCount: 0 });
  assert.deepEqual(totalNotificationCounts([undefined, null]), { unreadCount: 0, pendingCount: 0 });
});

/* ── Zil arayüzü ─────────────────────────────────────────────── */

test('zil atama koordinasyonunu ve atama olayını aynı panelde gösterir', () => {
  globalThis[CLIENT_STATE] = {
    scheduleRequests: [],
    scheduleRequestSummary: { unreadCount: 0, pendingCount: 0 },
    assignmentCoordinations: [{
      source: NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION, id: 'c1', status: 'PENDING', mode: 'REQUEST',
      assigneeName: 'Dış Personel', assigneeSicil: '900', taskTitle: 'Saha kurulumu', projectName: 'Proje',
      actionable: true, unread: true, sortAt: '2026-09-20T09:00:00.000Z', allowedDecisions: ['APPROVE'],
      assigneeOrganization: 'D / M / B', taskAvailable: true, version: 'AAAAAAAAAAE='
    }],
    taskNotifications: [{
      source: NOTIFICATION_SOURCES.TASK_EVENT, id: 'n1', kind: 'TASK_ASSIGNED', taskCount: 3,
      actorName: 'Atayan Kişi', taskTitle: 'Görev', projectCode: 'P1', projectName: 'Proje',
      unread: true, actionable: false, sortAt: '2026-09-19T09:00:00.000Z', taskId: 't1', taskAvailable: true
    }],
    notificationSummary: { unreadCount: 2, pendingCount: 1 },
    actions: {}
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null };
  const view = mountComponent(ScheduleRequestCenter, {});
  try {
    const toggle = findElement(view.output, (node) => node.props?.className === 'icon-btn schedule-request-toggle');
    assert.match(toggle.props['aria-label'], /2 okunmamış bildirim, 1 kararınızı bekleyen kayıt/);
    toggle.props.onClick(); view.render();

    const cards = findElement(view.output, (node) => node.props?.className === 'schedule-request-list').props.children;
    assert.equal(cards.length, 2);
    // Karar bekleyen koordinasyon önce gelir.
    assert.equal(cards[0].key, 'ASSIGNMENT_COORDINATION:c1');
    assert.equal(cards[1].key, 'TASK_EVENT:n1');
    const headlines = cards.map((card) => findElement(card, (node) => node.type === 'strong').props.children[0]);
    assert.equal(headlines[0], 'Kararınız bekleniyor');
    assert.equal(headlines[1], '3 görev atandı');
  } finally { view.unmount(); delete globalThis.document; delete globalThis[CLIENT_STATE]; }
});

test('koordinasyon penceresi izin verilen eylemleri ve Sicil künyesini gösterir', () => {
  const record = {
    id: 'c1', status: 'PENDING', mode: 'REQUEST', taskId: 't1', taskTitle: 'Saha kurulumu',
    projectCode: 'P1', projectName: 'Proje', requesterName: 'Talep Eden', requesterSicil: '100',
    assigneeName: 'Dış Personel', assigneeSicil: '900', assigneeOrganization: 'D / M / B',
    createdAt: '2026-09-20T09:00:00.000Z', decidedAt: null, targetFinish: '2026-10-01',
    requesterMessage: 'Montaj desteği', decisionMessage: '', suggestedAssigneeSicil: null,
    suggestedAssigneeName: null, version: 'AAAAAAAAAAE=', taskAvailable: true,
    allowedDecisions: ['APPROVE', 'REQUEST_CHANGE', 'REJECT'], isManager: true, isRequester: false
  };
  const view = mountComponent(AssignmentCoordinationDialog, {
    record, onClose() {}, onDecide: async () => ({ ok: true }), onOpenTask: async () => ({ ok: true })
  });
  try {
    const dialog = findElement(view.output, (node) => node.props?.role === 'dialog');
    assert.equal(dialog.props['aria-modal'], 'true');
    const buttons = [];
    const collect = (node) => {
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (!node || typeof node !== 'object') return;
      if (node.type === 'button') buttons.push(node);
      collect(node.props?.children);
    };
    collect(view.output);
    const labels = buttons.map((button) => JSON.stringify(button.props.children) ?? '');
    assert.equal(labels.some((label) => label.includes('Onayla')), true);
    assert.equal(labels.some((label) => label.includes('Değişiklik İste')), true);
    assert.equal(labels.some((label) => label.includes('Reddet')), true);
    assert.equal(labels.some((label) => label.includes('Atamanın Kaldırılmasını İste')), false);
    // Alternatif öneri Sicil ile seçilir; ad eşleşmesi kullanılmaz.
    assert.ok(findElement(view.output, (node) => node.type === DirectoryPersonSearch));
    const facts = findElement(view.output, (node) => node.props?.className === 'coordination-facts');
    assert.match(JSON.stringify(facts), /"Sicil ","900"/);
    assert.match(JSON.stringify(facts), /"Sicil ","100"/);
  } finally { view.unmount(); }
});

test('kurum dışı personel anahtarı KAPALI başlar ve talebi açıkça duyurur', () => {
  const requested = [];
  const view = mountComponent(ExternalAssigneePicker, {
    canAssignDirectly: () => false,
    onAssignDirectly() {},
    requestedAssignees: [],
    onRequestAssignee: (person) => requested.push(person),
    onCancelRequest() {},
    assignedSicils: []
  });
  try {
    const toggle = findElement(view.output, (node) => node.props?.role === 'switch');
    assert.equal(toggle.props.checked, false);
    assert.equal(findElement(view.output, (node) => node.type === DirectoryPersonSearch), null);

    toggle.props.onChange({ target: { checked: true } }); view.render();
    const search = findElement(view.output, (node) => node.type === DirectoryPersonSearch);
    assert.ok(search, 'anahtar açılınca dizin araması görünmelidir');
    search.props.onSelect({ sicil: 900, name: 'Dış Personel', organization: { directorate: 'D' } });
    view.render();
    assert.deepEqual(requested.map((person) => person.sicil), [900]);
    const notice = findElement(view.output, (node) => node.props?.className === 'external-assignee-notice');
    assert.match(JSON.stringify(notice.props.children), /doğrudan atama yetkinizin dışında/);
    assert.match(JSON.stringify(notice.props.children), /atama talebi gönderilecektir/);
  } finally { view.unmount(); }
});

test('doğrudan atama yetkisi varsa kişi olağan sorumlu listesine eklenir', () => {
  const assigned = [];
  const requested = [];
  const view = mountComponent(ExternalAssigneePicker, {
    canAssignDirectly: () => true,
    onAssignDirectly: (person) => assigned.push(person),
    requestedAssignees: [],
    onRequestAssignee: (person) => requested.push(person),
    onCancelRequest() {},
    assignedSicils: []
  });
  try {
    findElement(view.output, (node) => node.props?.role === 'switch').props.onChange({ target: { checked: true } });
    view.render();
    findElement(view.output, (node) => node.type === DirectoryPersonSearch)
      .props.onSelect({ sicil: 900, name: 'Dış Personel', organization: {} });
    view.render();
    assert.deepEqual(assigned.map((person) => person.sicil), [900]);
    assert.deepEqual(requested, []);
    assert.equal(findElement(view.output, (node) => node.props?.className === 'external-assignee-notice'), null);
  } finally { view.unmount(); }
});

test('e-posta seçeneği varsayılan kapalıdır ve kalıcı tercih saklamaz', () => {
  let checked = false;
  const view = mountComponent(AssigneeMailToggle, { checked, onChange: (next) => { checked = next; } });
  try {
    const input = findElement(view.output, (node) => node.type === 'input');
    assert.equal(input.props.type, 'checkbox');
    assert.equal(input.props.checked, false);
    input.props.onChange({ target: { checked: true } });
    assert.equal(checked, true);
  } finally { view.unmount(); }
  // Tercih hiçbir kalıcı depoya yazılmaz.
  const source = read('src/features/assignment-coordination/AssigneeMailToggle.jsx');
  assert.equal(/localStorage|sessionStorage/.test(source), false);
});

test('görev düzenleyicileri e-posta seçeneğini ve kurum dışı seçimi işlem başına taşır', () => {
  for (const file of ['src/features/task-detail/TaskDrawer.jsx', 'src/features/task-detail/SimpleTaskDrawer.jsx']) {
    const source = read(file);
    assert.match(source, /<AssigneeMailToggle/, file);
    assert.match(source, /<ExternalAssigneePicker/, file);
    assert.match(source, /useState\(false\)/, file);
    assert.match(source, /notifyAssignees/, file);
    assert.match(source, /assignmentRequest: assignmentRequests\.assignmentRequest/, file);
    assert.equal(/localStorage/.test(source), false, file);
  }
  // Talep, görev kalıcılaştıktan SONRA ayrı uçtan gönderilir.
  const overlay = read('src/features/task-detail/TaskDetailOverlay.jsx');
  assert.match(overlay, /submitAssignmentRequest\(\s*isCreating \? result\.value\?\.id : task\.id/);
});

test('dizin araması en az iki karakterden sonra ve gecikmeli gönderilir', () => {
  const source = read('src/features/assignment-coordination/DirectoryPersonSearch.jsx');
  assert.match(source, /DIRECTORY_MIN_QUERY_LENGTH/);
  assert.match(source, /setTimeout\(async \(\) => \{/);
  assert.match(source, /DIRECTORY_SEARCH_DEBOUNCE_MS/);
  // Geç gelen yanıt sıra numarasıyla elenir.
  assert.match(source, /if \(requestRef\.current !== sequence\) return;/);
  const client = read('src/data/api/directoryClient.js');
  assert.match(client, /DIRECTORY_MIN_QUERY_LENGTH = 2/);
  assert.ok(/DIRECTORY_SEARCH_DEBOUNCE_MS = (2\d\d|3\d\d)/.test(client));
});

/* ── Marka ───────────────────────────────────────────────────── */

test('sekme simgesi pusula markasıdır ve açık/koyu bağlamda okunur kalır', () => {
  assert.match(APP_FAVICON_DATA_URI, /^data:image\/svg\+xml;utf8,<svg/);
  // Ana logoyla aynı biçim: gövde çemberi, ibre ve merkez noktası.
  assert.match(APP_FAVICON_DATA_URI, /<circle cx='16' cy='16' r='9'/);
  assert.match(APP_FAVICON_DATA_URI, /<path d='M21\.6 10\.4/);
  // Kendi zemini vardır: açık ve koyu sekme çubuğunda aynı karşıtlıkla görünür.
  assert.match(APP_FAVICON_DATA_URI, /<rect width='32' height='32' rx='8' fill='url\(%23rotaMark\)'\/>/);
  // İlgisiz "M" harfi markası kaldırılmıştır.
  assert.equal(APP_FAVICON_DATA_URI.includes("M6 22V11l5 7 5-7v11"), false);

  const layout = read('src/app/layout.js');
  assert.match(layout, /href=\{FAVICON\}/);
  assert.match(layout, /rel="icon" type="image\/svg\+xml"/);
  assert.match(layout, /rel="alternate icon"/);
  // Simge ek bir ağ isteği doğurmaz: dış kaynak ya da gömülü resim yoktur
  // (tek `http` geçişi SVG ad alanıdır).
  assert.equal(/<image|xlink:href|url\(http/.test(APP_FAVICON_DATA_URI), false);
  assert.equal((APP_FAVICON_DATA_URI.match(/https?:\/\//g) || []).length, 1);

  // Ana logo ile aynı ürün kimliği: iki yüzey de pusula çizer.
  assert.match(read('src/components/shell/AppLogo.jsx'), /Rota compass mark/);
});
