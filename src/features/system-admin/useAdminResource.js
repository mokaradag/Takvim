'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isDataStale, mergeResourceState, shouldPoll, shouldRefreshOnReturn } from './adminPolling.js';

/**
 * Yönetim konsolunun yenileme kancası.
 *
 * Davranış kuralları `adminPolling.js` içindedir; burada yalnızca tarayıcı
 * bağlantısı kurulur:
 *   • aynı anda İKİ istek gitmez,
 *   • sekme gizliyken yoklama durur, dönüşte veri bayatsa hemen tazelenir,
 *   • sökülen bileşenin isteği iptal edilir ve geç gelen yanıt yok sayılır,
 *   • geçici hata SON GEÇERLİ veriyi silmez.
 *
 * Bu döngü uygulamanın olağan görev verisi yenilemesinden BAĞIMSIZDIR: yönetim
 * konsolu ne anlık görüntü ister ne de kullanıcı durumuna dokunur.
 */
export function useAdminResource(loader, { intervalMs = 10000, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, lastUpdatedAt: null, failureCount: 0 });
  const [loading, setLoading] = useState(Boolean(enabled));
  const inFlightRef = useRef(false);
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    controllerRef.current = controller;
    setLoading(true);
    let response = null;
    try {
      response = await loader({ signal: controller?.signal });
    } finally {
      inFlightRef.current = false;
      // Sökülmüş bileşenin ya da iptal edilmiş isteğin yanıtı UYGULANMAZ.
      if (mountedRef.current && !controller?.signal.aborted) {
        if (response) setState((previous) => mergeResourceState(previous, response));
        setLoading(false);
      }
    }
  }, [loader]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const tick = async () => {
      if (cancelled) return;
      if (shouldPoll({ hidden: hidden(), enabled: true, inFlight: inFlightRef.current })) await run();
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();

    const onVisibility = () => {
      if (cancelled) return;
      setState((previous) => {
        if (shouldRefreshOnReturn({ hidden: hidden(), lastUpdatedAt: previous.lastUpdatedAt, intervalMs })) run();
        return previous;
      });
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controllerRef.current?.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, run]);

  return {
    data: state.data,
    error: state.error,
    lastUpdatedAt: state.lastUpdatedAt,
    failureCount: state.failureCount,
    loading: loading && !state.data,
    refreshing: loading && Boolean(state.data),
    stale: isDataStale({ lastUpdatedAt: state.lastUpdatedAt, intervalMs }),
    refresh: run
  };
}
