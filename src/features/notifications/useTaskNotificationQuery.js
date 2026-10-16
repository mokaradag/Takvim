'use client';
import { fetchTaskNotifications } from '../../data/api/assignmentCoordinationClient.js';
import { useNotificationSummary } from '../../state/hooks/index.js';
import { useNotificationPageQuery } from '../notifications/useNotificationPageQuery.js';

const EMPTY = Object.freeze({
  items: [], total: 0, page: 0, pageSize: 25,
  counts: { pending: 0, history: 0 }
});

/** Alıcıya ait sunucu sayfası; tam geçmiş anlık görüntüye yüklenmez. */
export function useTaskNotificationQuery(query, enabled = true) {
  return useNotificationPageQuery(query, enabled, fetchTaskNotifications, useNotificationSummary(), EMPTY);
}
