import 'server-only';
import { NOTIFICATION_PREVIEW_LIMIT } from '../../domain/notifications/notificationInbox.js';
import {
  COORDINATION_INBOX_SQL,
  bindCoordinationScope,
  mapCoordinationInbox,
  updateCoordinationNotifications
} from '../assignment/assignmentCoordinationQueries.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { sql, withSqlTransaction } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import {
  TASK_NOTIFICATION_INBOX_SQL,
  mapTaskNotificationInbox,
  updateTaskNotifications
} from './taskNotificationQueries.js';

/**
 * Zil merkezinin BİRLEŞİK okuması.
 *
 * Atama koordinasyonu ve görev bildirimi TEK gidiş-dönüşte okunur: anlık
 * görüntüye eklenen maliyet bir sorgudur ve iki kaynak da en fazla sekiz satır
 * ile iki sayaç taşır. Geçmişin tamamı hiçbir zaman anlık görüntüye girmez.
 */
export async function readNotificationInbox(executor, actor) {
  const request = bindCoordinationScope(executor.request(), actor);
  request.input('limit', sql.Int, NOTIFICATION_PREVIEW_LIMIT);
  const result = await request.query(`${COORDINATION_INBOX_SQL}\n${TASK_NOTIFICATION_INBOX_SQL}`);
  const sets = result.recordsets || [];
  const coordination = mapCoordinationInbox(sets[0], sets[1], actor.sicil);
  const taskEvents = mapTaskNotificationInbox(sets[2], sets[3]);
  return {
    coordination,
    taskEvents,
    unreadCount: coordination.unreadCount + taskEvents.unreadCount,
    pendingCount: coordination.pendingCount
  };
}

const MISSING_TABLE_NUMBERS = new Set([208, 4145]);
const NEW_TABLES = [
  'MR_TaskAssignmentCoordinations',
  'MR_AssignmentCoordinationRecipients',
  'MR_TaskNotifications'
];

/** Göç uygulanmadan açılan kurulumda zil, var olan talep akışıyla çalışmayı sürdürür. */
export function isMissingNotificationInboxSchema(error) {
  return MISSING_TABLE_NUMBERS.has(Number(error?.number))
    && NEW_TABLES.some((name) => String(error?.message || '').includes(name));
}

function invalid(message) {
  throw new ServerPersistenceError('MUTATION_FAILED', message, { status: 400 });
}

/**
 * Okundu / temizlendi — kaynağına göre doğru tabloya yazar.
 *
 * İstemci tek uçtan karışık bir liste gönderebilir; her kayıt kendi kaynağının
 * sürüm ve sahiplik kurallarından geçer.
 */
export async function markNotifications(input = {}) {
  const action = input.action === 'dismiss' ? 'dismiss' : 'read';
  if (!['read', 'dismiss'].includes(input.action)) invalid('Bildirim işlemi geçersiz.');
  const entries = Array.isArray(input.notifications) ? input.notifications : [];
  if (!entries.length || entries.length > 100) invalid('Bildirim işlemi geçersiz.');
  const coordination = [];
  const taskEvents = [];
  for (const entry of entries) {
    const id = canonicalActualId(entry?.id);
    if (!id) invalid('Bildirim kimliği geçersiz.');
    const target = entry?.source === 'TASK_EVENT' ? taskEvents : coordination;
    target.push({ id, version: entry?.version });
  }
  return withSqlTransaction(async (executor) => {
    const actor = await loadAuthorizationContext(executor);
    if (coordination.length) await updateCoordinationNotifications(executor, actor, coordination, action);
    if (taskEvents.length) await updateTaskNotifications(executor, actor, taskEvents, action);
    return { ok: true };
  }, { deadlockRetries: 2 });
}
