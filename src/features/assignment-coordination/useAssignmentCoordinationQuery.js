'use client';
import { fetchAssignmentCoordinations } from '../../data/api/assignmentCoordinationClient.js';
import { useNotificationSummary } from '../../state/hooks/index.js';
import { useNotificationPageQuery } from '../notifications/useNotificationPageQuery.js';

const EMPTY = Object.freeze({
  items: [], total: 0, page: 0, pageSize: 25,
  counts: { all: 0, incoming: 0, archive: 0, pending: 0, sent: 0, history: 0 }
});

/** Alıcıya ait sunucu sayfası; tam geçmiş anlık görüntüye yüklenmez. */
export function useAssignmentCoordinationQuery(query, enabled = true) {
  return useNotificationPageQuery(query, enabled, fetchAssignmentCoordinations, useNotificationSummary(), EMPTY);
}
