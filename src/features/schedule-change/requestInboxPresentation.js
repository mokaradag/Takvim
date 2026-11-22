import {
  COORDINATION_MODES,
  COORDINATION_STATUS_LABELS
} from '../../domain/assignment/assignmentCoordination.js';
import { extractActualId } from '../../domain/identity/actualId.js';
import { NOTIFICATION_SOURCES, TASK_NOTIFICATION_KINDS } from '../../domain/notifications/notificationInbox.js';
import {
  REQUEST_INBOX_CATEGORIES,
  REQUEST_INBOX_CATEGORY_LABELS
} from '../../domain/notifications/requestInbox.js';
import { SCHEDULE_STATUS_LABELS } from '../notifications/notificationCenterItems.js';

/**
 * Talepler birleşik tablosunun satır sunumu — SAF dönüşüm.
 *
 * Üç kaynak aynı tabloda gösterilir; her kaynağın durum sözlüğü ve iş anlamı
 * korunur. "Okundu" bir durum değildir: satırdaki "Yeni" etiketi yalnızca
 * okunmamışlığı söyler, kabul/ret/tamamlanma yerine geçmez.
 */

/** Durum süzgecinin seçenekleri: iki talep kaynağının durum kodlarının birleşimi. */
export const REQUEST_STATUS_FILTER_OPTIONS = Object.freeze([
  { value: 'PENDING', label: 'Bekliyor / Onay bekliyor' },
  { value: 'ACCEPTED', label: SCHEDULE_STATUS_LABELS.ACCEPTED },
  { value: 'APPROVED', label: COORDINATION_STATUS_LABELS.APPROVED },
  { value: 'REJECTED', label: 'Reddedildi' },
  { value: 'CHANGE_REQUESTED', label: COORDINATION_STATUS_LABELS.CHANGE_REQUESTED },
  { value: 'CANCELLATION_REQUESTED', label: COORDINATION_STATUS_LABELS.CANCELLATION_REQUESTED },
  { value: 'CANCELLED', label: 'Değiştirildi / İptal edildi' },
  { value: 'STALE', label: 'Güncelliğini yitirdi' }
]);

export const REQUEST_CATEGORY_FILTER_OPTIONS = Object.freeze(
  Object.values(REQUEST_INBOX_CATEGORIES).map((value) => ({ value, label: REQUEST_INBOX_CATEGORY_LABELS[value] }))
);

function projectOptionKey(value) {
  if (value == null || value === '') return '';
  return extractActualId(value) ?? String(value).trim().toLowerCase();
}

/** Proje dizisi olmayan yanıtlarda sayfalar arasında yalnızca proje künyelerini saklar. */
export function retainRequestProjects(previous, { projects, items }) {
  if (Array.isArray(projects)) return projects;
  const byKey = new Map();
  for (const project of previous) {
    const key = projectOptionKey(project?.id);
    if (key) byKey.set(key, project);
  }
  for (const item of items) {
    const key = projectOptionKey(item?.projectId);
    if (!key) continue;
    const existing = byKey.get(key);
    byKey.set(key, {
      id: existing?.id ?? item.projectId,
      name: existing?.name || String(item.projectName || '').trim(),
      code: existing?.code || String(item.projectCode || '').trim()
    });
  }
  return [...byKey.values()];
}

/**
 * Talepler ve Atama Koordinasyonu proje süzgecinin seçenekleri.
 *
 * Kullanıcının olağan proje listesine ek olarak, görmeye yetkili olduğu
 * talep/koordinasyon kayıtlarında temsil edilen projeleri de içerir; yetkisiz
 * projeleri açmaz.
 */
export function buildRequestProjectOptions(projects = [], ...recordLists) {
  const byKey = new Map();
  const upsert = (rawId, rawName, rawCode) => {
    const key = projectOptionKey(rawId);
    if (!key) return;
    const name = String(rawName || '').trim();
    const code = String(rawCode || '').trim();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        value: String(rawId),
        label: name || code || 'Adsız proje',
        description: code,
        keywords: [code, name].filter(Boolean)
      });
      return;
    }
    if ((!existing.label || existing.label === 'Adsız proje' || existing.label === existing.description) && name) {
      existing.label = name;
    }
    if (!existing.description && code) existing.description = code;
    for (const kw of [code, name]) {
      if (kw && !existing.keywords.includes(kw)) existing.keywords.push(kw);
    }
  };
  for (const project of projects || []) {
    if (!project) continue;
    upsert(project.id ?? project.projectId, project.name || project.projectName, project.code || project.projectCode);
  }
  for (const list of recordLists) {
    for (const entry of list || []) {
      if (!entry) continue;
      if (entry.source === NOTIFICATION_SOURCES.TASK_EVENT && !entry.projectId && Number(entry.taskCount || 1) > 1) continue;
      const isProjectOption = entry.projectId === undefined && entry.taskId === undefined && entry.source === undefined;
      const id = isProjectOption ? entry.id : entry.projectId;
      const name = isProjectOption ? (entry.name ?? entry.projectName) : entry.projectName;
      const code = isProjectOption ? (entry.code ?? entry.projectCode) : entry.projectCode;
      upsert(id, name, code);
    }
  }
  return [
    { value: '', label: 'Tüm projeler' },
    ...[...byKey.values()].sort((left, right) => left.label.localeCompare(right.label, 'tr'))
  ];
}

/** Kaynak + kimlik: üç tabloda kimlikler çakışabilir, satır anahtarı ikisini taşır. */
export function requestInboxKey(item) {
  return `${item?.source || NOTIFICATION_SOURCES.SCHEDULE_REQUEST}:${item?.id}`;
}

export function sameRequestInboxItem(left, right) {
  return Boolean(left && right) && requestInboxKey(left) === requestInboxKey(right);
}

/** 8 baytlık SQL Server `rowversion` belirtecini karşılaştırılabilir tam sayıya çevirir. */
function decodeRowVersionBigInt(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{11}=$/.test(value)) return null;
  let bytes;
  try {
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(value);
      if (binary.length !== 8) return null;
      bytes = new Uint8Array(8);
      for (let i = 0; i < 8; i += 1) bytes[i] = binary.charCodeAt(i);
    } else if (typeof Buffer !== 'undefined') {
      bytes = Buffer.from(value, 'base64');
      if (bytes.length !== 8) return null;
    } else return null;
  } catch {
    return null;
  }
  let result = 0n;
  for (let i = 0; i < 8; i += 1) result = (result << 8n) | BigInt(bytes[i]);
  return result;
}

/**
 * Aynı kaydın iki kopyasından yetkili ve daha güncel olanı seçer.
 *
 * Karar yanıtıyla elde tutulan kayıt, henüz yenilenmemiş eski liste satırına
 * ezilmez; ancak sunucudan en az o kadar güncel ya da daha yeni sürüm/durum
 * taşıyan bir kayıt geldiğinde elde tutulan kopyanın yerini alır.
 */
export function selectFresherRecord(incoming, retained, { supersededVersion = null } = {}) {
  if (!retained) return incoming;
  if (!incoming || String(incoming.id) !== String(retained.id)) return incoming || retained;
  const incomingVersion = incoming.version ?? null;
  const retainedVersion = retained.version ?? null;
  if (incomingVersion && retainedVersion) {
    if (incomingVersion === retainedVersion) return incoming;
    const incomingSeq = decodeRowVersionBigInt(incomingVersion);
    const retainedSeq = decodeRowVersionBigInt(retainedVersion);
    if (incomingSeq != null && retainedSeq != null) {
      return incomingSeq >= retainedSeq ? incoming : retained;
    }
    if (supersededVersion && incomingVersion === supersededVersion && retainedVersion !== supersededVersion) {
      return retained;
    }
  }
  if (retained.status && retained.status !== 'PENDING' && incoming.status === 'PENDING') {
    return retained;
  }
  const incomingDecided = incoming.decidedAt ? Date.parse(incoming.decidedAt) : NaN;
  const retainedDecided = retained.decidedAt ? Date.parse(retained.decidedAt) : NaN;
  if (Number.isFinite(incomingDecided) && Number.isFinite(retainedDecided)) {
    return incomingDecided >= retainedDecided ? incoming : retained;
  }
  if (Number.isFinite(retainedDecided) && !Number.isFinite(incomingDecided)) return retained;
  return incoming;
}

function scheduleRow(item) {
  const actionable = Boolean(item.isDecisionOwner) && item.status === 'PENDING' && item.taskAvailable !== false;
  return {
    category: REQUEST_INBOX_CATEGORY_LABELS.SCHEDULE_REQUEST,
    statusLabel: SCHEDULE_STATUS_LABELS[item.status] || item.status,
    statusClass: String(item.status || '').toLowerCase(),
    actorName: item.requesterName,
    actorSicil: item.requesterSicil,
    detail: '',
    createdAt: item.createdAt,
    decidedAt: item.decidedAt,
    actionable
  };
}

function coordinationRow(item) {
  const notice = item.mode === COORDINATION_MODES.NOTICE;
  return {
    category: notice ? REQUEST_INBOX_CATEGORY_LABELS.ASSIGNMENT_NOTICE : REQUEST_INBOX_CATEGORY_LABELS.ASSIGNMENT_REQUEST,
    statusLabel: COORDINATION_STATUS_LABELS[item.status] || item.status,
    statusClass: `coordination-${String(item.status || '').toLowerCase()}`,
    actorName: item.requesterName,
    actorSicil: item.requesterSicil,
    detail: item.assigneeName ? `Görevlendirilen: ${item.assigneeName}` : '',
    createdAt: item.createdAt,
    decidedAt: item.decidedAt,
    actionable: Boolean(item.actionable)
  };
}

function taskEventRow(item) {
  const assigned = item.kind === TASK_NOTIFICATION_KINDS.TASK_ASSIGNED;
  const count = Number(item.taskCount || 1);
  return {
    category: count > 1
      ? `${count} görev ${assigned ? 'atandı' : 'sorumluluğunuzdan çıkarıldı'}`
      : REQUEST_INBOX_CATEGORY_LABELS[assigned ? 'TASK_ASSIGNED' : 'TASK_UNASSIGNED'],
    statusLabel: assigned ? 'Görev atandı' : 'Sorumluluk kaldırıldı',
    statusClass: assigned ? 'coordination-approved' : 'coordination-cancelled',
    actorName: item.actorName,
    actorSicil: item.actorSicil,
    detail: '',
    createdAt: item.occurredAt,
    decidedAt: null,
    actionable: false
  };
}

export function requestInboxRow(item) {
  const source = item?.source || NOTIFICATION_SOURCES.SCHEDULE_REQUEST;
  const row = source === NOTIFICATION_SOURCES.ASSIGNMENT_COORDINATION
    ? coordinationRow(item)
    : source === NOTIFICATION_SOURCES.TASK_EVENT ? taskEventRow(item) : scheduleRow(item);
  return {
    ...row,
    key: requestInboxKey(item),
    source,
    unread: Boolean(item?.unread),
    taskAvailable: item?.taskAvailable !== false,
    taskTitle: item?.taskTitle || (source === NOTIFICATION_SOURCES.TASK_EVENT ? 'Görev' : 'Silinen görev'),
    projectLabel: [item?.projectCode, item?.projectName].filter(Boolean).join(' · ')
  };
}
