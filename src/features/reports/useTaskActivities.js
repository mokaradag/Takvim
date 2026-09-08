'use client';
import { useEffect, useState } from 'react';
import { fetchTaskActivities } from '../../data/api/taskActivityClient.js';
import { useSessionContext } from '../../state/hooks/index.js';
import { EMPTY_TASK_ACTIVITY_DATA as EMPTY, taskActivityQueryViewState } from './taskActivityQueryState.js';

export function useTaskActivities(query, enabled) {
  const session = useSessionContext();
  const actual = session?.dataMode === 'actual';
  const key = JSON.stringify(query);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ key: '', data: EMPTY, loading: false, error: null });
  useEffect(() => {
    if (!actual || !enabled) return undefined;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    const timer = setTimeout(async () => {
      const result = await fetchTaskActivities(JSON.parse(key));
      if (!cancelled) setState({ key, data: result.ok ? result.value : EMPTY, loading: false, error: result.ok ? null : result.message });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actual, enabled, key, revision]);
  const view = taskActivityQueryViewState(state, key, actual);
  return { ...view,
    loading: actual && enabled && (state.loading || state.key !== key), actual,
    refresh: () => setRevision((value) => value + 1) };
}
