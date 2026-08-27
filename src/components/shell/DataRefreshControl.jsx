'use client';
import { useEffect, useState } from 'react';
import { Icons } from '../icons';
import { useDataLifecycle } from '../../state/hooks';
import { dataRefreshFailure, dataRefreshLabel, dataRefreshTitle } from './dataRefreshLabel.js';

export function DataRefreshControl() {
  const { dataStatus, loadError, lastRefreshedAt, reloadData } = useDataLifecycle();
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState(null);
  const busy = refreshing || dataStatus === 'loading';
  const refreshFailure = dataRefreshFailure({ localFailure: failure, dataStatus, loadError });

  useEffect(() => {
    if (dataStatus !== 'error') setFailure(null);
  }, [dataStatus, lastRefreshedAt]);

  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    setFailure(null);
    try {
      const result = await reloadData();
      if (!result?.ok) setFailure(result?.error?.message || 'Veriler yenilenemedi.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <button
      type="button"
      className={`data-refresh-control${refreshFailure ? ' is-error' : ''}`}
      onClick={refresh}
      disabled={busy}
      aria-busy={busy}
      title={refreshFailure || dataRefreshTitle(lastRefreshedAt)}
    >
      <Icons.Refresh size={13} className={busy ? 'is-spinning' : ''} />
      <span>{busy ? 'Yenileniyor…' : dataRefreshLabel(lastRefreshedAt)}</span>
    </button>
  );
}
