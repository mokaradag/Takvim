import { PRIORITIES, normalizePriorityId } from '../../domain/constants/index.js';

const FIELDS = [
  ['Title', 'task', 'Görev adı'], ['Description', 'description', 'Notlar'], ['Keyword', 'keyword', 'Etiket'],
  ['Status', 'status', 'Durum'], ['Progress', 'progress', 'İlerleme'], ['Priority', 'priority', 'Öncelik'],
  ['PlannedStart', 'plannedStart', 'Planlanan başlangıç'], ['PlannedFinish', 'plannedFinish', 'Planlanan bitiş'],
  ['TargetFinish', 'targetFinish', 'Termin'], ['ActualStart', 'actualStart', 'Gerçekleşen başlangıç'],
  ['ActualFinish', 'actualFinish', 'Gerçekleşen bitiş'], ['PlannedDurationDays', 'plannedDurationDays', 'Planlanan süre'],
  ['RemainingDurationDays', 'remainingDurationDays', 'Kalan süre'], ['IsMilestone', 'milestone', 'Kilometre taşı'],
  ['RecurrenceRule', 'recurrenceRule', 'Yineleme']
];
const STATUS = { planned: 'Yapılacak', 'not-started': 'Yapılacak', todo: 'Yapılacak', in_progress: 'Devam ediyor', 'in-progress': 'Devam ediyor', blocked: 'Devam ediyor', done: 'Tamamlandı', completed: 'Tamamlandı', cancelled: 'Tamamlandı' };
function snapshot(value) {
  if (!value) return {};
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return result && !Array.isArray(result) && typeof result === 'object' ? result : {}; }
  catch { return {}; }
}
function field(data, column, name) {
  if (Object.hasOwn(data, column)) return data[column];
  if (Object.hasOwn(data, name)) return data[name];
  if (column === 'Title' && Object.hasOwn(data, 'title')) return data.title;
  if (column === 'IsMilestone' && Object.hasOwn(data, 'isMilestone')) return data.isMilestone;
  return undefined;
}
function display(value, column) {
  if (value == null || value === '') return '—';
  if (column === 'Status') return STATUS[value] || 'Belirtilmemiş';
  if (column === 'Priority') return PRIORITIES[normalizePriorityId(value)].label;
  if (column === 'Progress') return `%${Number(value)}`;
  if (column.endsWith('Start') || column.endsWith('Finish')) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date) : '—';
  }
  if (column === 'IsMilestone') return value ? 'Evet' : 'Hayır';
  if (column === 'RecurrenceRule') return value ? 'Tanımlı' : '—';
  return String(value).slice(0, 500);
}
function normalized(value, column) {
  if (column === 'Priority') return normalizePriorityId(value);
  if (column === 'Status') return STATUS[value] || String(value ?? '');
  if (column.endsWith('Start') || column.endsWith('Finish')) return value ? String(value).slice(0, 10) : '';
  return String(value ?? '');
}
export function taskActivityChanges(events, people = new Map()) {
  const changes = new Map();
  let created = false, deleted = false, completed = false;
  let title = '', projectName = '', projectCode = '';
  const assignees = new Map();
  for (const event of events) {
    const before = snapshot(event.BeforeJson), after = snapshot(event.AfterJson);
    const current = event.ActionCode === 'DELETE' ? before : after;
    title = field(current, 'Title', 'task') || title || field(before, 'Title', 'task') || '';
    projectName = current.ProjectName || current.projectName || projectName || before.ProjectName || '';
    projectCode = current.ProjectCode || current.projectCode || projectCode || before.ProjectCode || '';
    created ||= event.ActionCode === 'CREATE'; deleted ||= event.ActionCode === 'DELETE';
    const oldStatus = field(before, 'Status', 'status'), newStatus = field(after, 'Status', 'status');
    completed ||= ['done', 'completed'].includes(newStatus) && !['done', 'completed'].includes(oldStatus);
    if (event.ActionCode !== 'UPDATE') continue;
    for (const [column, name, label] of FIELDS) {
      const oldValue = field(before, column, name), newValue = field(after, column, name);
      if (newValue === undefined || oldValue === undefined) continue;
      const existing = changes.get(column);
      const startValue = existing ? existing.before : oldValue;
      changes.set(column, { column, label, before: startValue, after: newValue });
    }
    if (Array.isArray(before.assigneeIds) && Array.isArray(after.assigneeIds)) {
      const oldIds = new Set(before.assigneeIds.map(String)), newIds = new Set(after.assigneeIds.map(String));
      for (const id of new Set([...oldIds, ...newIds])) {
        const existing = assignees.get(id);
        assignees.set(id, { before: existing ? existing.before : oldIds.has(id), after: newIds.has(id) });
      }
    }
  }
  const lines = [];
  if (created) lines.push('Yeni görev oluşturuldu');
  if (deleted) lines.push('Görev silindi');
  if (completed) lines.push('Tamamlandı');
  for (const change of changes.values()) {
    if (normalized(change.before, change.column) === normalized(change.after, change.column)) continue;
    if (change.column === 'RecurrenceRule') lines.push('Yineleme düzeni değiştirildi');
    else lines.push(`${change.label}: ${display(change.before, change.column)} → ${display(change.after, change.column)}`);
  }
  for (const [id, change] of assignees) {
    if (change.before === change.after) continue;
    lines.push(`Sorumlu ${change.after ? 'eklendi' : 'çıkarıldı'}: ${people.get(id) || `Çalışan ${id}`}`);
  }
  return { title, projectName, projectCode, changes: lines.length ? lines : ['Görev güncellendi'],
    kind: deleted ? 'deleted' : created ? 'created' : completed ? 'completed' : 'updated' };
}
export function auditAssigneeIds(events) {
  const ids = new Set();
  for (const event of events) for (const json of [event.BeforeJson, event.AfterJson]) {
    const members = snapshot(json).assigneeIds;
    for (const id of Array.isArray(members) ? members : []) if (/^\d+$/.test(String(id))) ids.add(String(id));
  }
  return [...ids];
}
