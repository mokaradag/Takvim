'use client';
import { useEffect, useState } from 'react';
import { fetchRequestInbox } from '../../data/api/assignmentCoordinationClient.js';
import { useNotificationSummary, useScheduleRequestSummary, useSessionContext } from '../../state/hooks/index.js';

const EMPTY = Object.freeze({
  items: [], total: 0, page: 0, pageSize: 25,
  counts: { pending: 0, sent: 0, history: 0, coordination: 0 }
});

/**
 * Talepler · Gelenler / Gönderdiklerim / Geçmiş sorgusu.
 *
 * Üç kaynağın birleşik listesi SUNUCUDA süzülür ve sayfalanır; geçmiş uygulama
 * anlık görüntüsüne yüklenmez. Zil sayaçları değiştiğinde (okundu işareti,
 * karar, yeni bildirim) sayfa yeniden okunur; geç gelen yanıt yok sayılır.
 */
export function useRequestInboxQuery(query, enabled = true) {
  const session = useSessionContext();
  const summary = useScheduleRequestSummary();
  const notificationSummary = useNotificationSummary();
  const actual = session?.dataMode === 'actual';
  const key = JSON.stringify(query);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ key: '', data: EMPTY, loading: false, error: null });
  useEffect(() => {
    if (!actual || !enabled) return undefined;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const result = await fetchRequestInbox(JSON.parse(key));
      if (cancelled) return;
      setState({ key, data: result.ok ? result.value : EMPTY, loading: false, error: result.ok ? null : result.message });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actual, enabled, key, revision, summary, notificationSummary]);
  return { data: actual && state.key === key ? state.data : EMPTY,
    loading: actual && enabled && (state.loading || state.key !== key), error: state.key === key ? state.error : null,
    actual, refresh: () => setRevision((value) => value + 1) };
}
