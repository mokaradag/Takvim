'use client';
import { fetchScheduleChanges } from '../../data/api/scheduleChangeClient.js';
import { useScheduleRequestSummary } from '../../state/hooks/index.js';
import { useNotificationPageQuery } from '../notifications/useNotificationPageQuery.js';

const EMPTY = Object.freeze({
  items: [], total: 0, page: 0, pageSize: 25,
  counts: { pending: 0, sent: 0, history: 0 }
});

/** Alıcıya ait sunucu sayfası; tam geçmiş anlık görüntüye yüklenmez. */
export function useScheduleRequestQuery(query, enabled = true) {
  return useNotificationPageQuery(query, enabled, fetchScheduleChanges, useScheduleRequestSummary(), EMPTY);
}
