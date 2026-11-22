'use client';
import { useEffect, useState } from 'react';
import { fetchRequestInbox } from '../../data/api/assignmentCoordinationClient.js';
import {
  useDataLifecycle,
  useNotificationSummary,
  useScheduleRequestSummary,
  useSessionContext
} from '../../state/hooks/index.js';
import { retainRequestProjects } from './requestInboxPresentation.js';

const EMPTY = Object.freeze({
  items: [], total: 0, page: 0, pageSize: 25,
  counts: { pending: 0, sent: 0, history: 0, coordination: 0 }
});

/**
 * Talepler · Gelenler / Gönderdiklerim / Geçmiş sorgusu.
 *
 * Üç kaynağın birleşik listesi SUNUCUDA süzülür ve sayfalanır; geçmiş uygulama
 * anlık görüntüsüne yüklenmez. Zil sayaçları değiştiğinde veya anlık görüntü
 * yenilendiğinde sayfa yeniden okunur; geç gelen yanıt yok sayılır.
 */
export function useRequestInboxQuery(query, enabled = true) {
  const session = useSessionContext();
  const summary = useScheduleRequestSummary();
  const notificationSummary = useNotificationSummary();
  const { lastRefreshedAt } = useDataLifecycle();
  const actual = session?.dataMode === 'actual';
  const key = JSON.stringify(query);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ key: '', data: null, retainedProjects: [], loading: false, error: null });
  useEffect(() => {
    if (!actual || !enabled) return undefined;
    let cancelled = false;
    // Doğrulanmış sayfa arka planda yenilenirken yükleme bildirimi gösterilmez.
    setState((current) => (current.key === key && current.data ? current : { ...current, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const result = await fetchRequestInbox(JSON.parse(key));
      if (cancelled) return;
      setState((current) => ({
        key,
        data: result.ok ? result.value : (current.key === key ? current.data : null),
        retainedProjects: result.ok ? retainRequestProjects(current.retainedProjects, result.value) : current.retainedProjects,
        loading: false,
        error: result.ok ? null : result.message
      }));
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actual, enabled, key, revision, summary, notificationSummary, lastRefreshedAt]);
  return {
    data: actual && state.key === key ? (state.data ?? EMPTY) : EMPTY,
    retainedProjects: actual ? state.retainedProjects : [],
    loading: actual && enabled && (state.key !== key || (!state.data && state.loading)),
    error: state.key === key ? state.error : null,
    actual,
    refresh: () => setRevision((value) => value + 1)
  };
}
