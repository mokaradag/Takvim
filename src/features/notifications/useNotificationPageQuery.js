'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSessionContext } from '../../state/hooks/index.js';

/** Aynı alıcının son bilinen sonucu korunur; yeni kapsam kesinleşmeden sayı uydurulmaz. */
export function useNotificationPageQuery(query, enabled, fetchPage, summary, empty) {
  const session = useSessionContext();
  const actual = session?.dataMode === 'actual';
  const recipient = String(session?.currentUser?.employeeNo ?? session?.currentUser?.id ?? '');
  const owner = `${actual}:${recipient}`;
  const key = JSON.stringify(query);
  const scope = Object.fromEntries(Object.entries(query).filter(([name]) => name !== 'page'));
  const scopeKey = JSON.stringify(scope);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ owner: null, key: '', dataKey: '', scopeKey: '', data: empty, known: false });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!actual || !enabled) return undefined;
    let cancelled = false;
    setState((current) => current.owner === owner
      ? { ...current, key, loading: true, error: null }
      : { owner, key, dataKey: '', scopeKey: '', data: empty, known: false, loading: true, error: null });
    const timer = setTimeout(async () => {
      let result;
      try { result = await fetchPage(JSON.parse(key)); }
      catch (error) { result = { ok: false, message: error.message || 'Bildirimler yüklenemedi.' }; }
      if (cancelled) return;
      setState((current) => {
        if (current.owner !== owner || current.key !== key) return current;
        return result.ok
          ? { owner, key, dataKey: key, scopeKey, data: result.value, known: true, loading: false, error: null }
          : { ...current, loading: false, error: result.message };
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actual, enabled, owner, key, scopeKey, revision, summary, fetchPage, empty]);

  const owned = actual && state.owner === owner;
  const known = owned && state.known;
  const rowsKnown = known && state.dataKey === key;
  const scopeKnown = known && state.scopeKey === scopeKey;
  const matching = owned && state.key === key;
  const data = known
    ? { ...state.data, ...(rowsKnown ? {} : { items: [], page: Number(query.page || 0) }) }
    : empty;

  return {
    data,
    known: !actual || Boolean(known),
    rowsKnown: !actual || Boolean(rowsKnown),
    totalKnown: !actual || Boolean(scopeKnown),
    countsKnown: !actual || Boolean(scopeKnown),
    loading: actual && enabled && (!matching || Boolean(state.loading)),
    refreshing: actual && enabled && Boolean(rowsKnown && state.loading),
    error: owned ? state.error : null,
    actual, owner, refresh
  };
}
