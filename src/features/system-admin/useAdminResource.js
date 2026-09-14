'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isDataStale, mergeResourceState, shouldRefreshOnReturn } from './adminPolling.js';

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
/** Reddeden bir yükleyiciyi, birleştirilebilir bir hata yanıtına çevirir. */
function failureResponse(error) {
  const code = String(error?.code || error?.name || 'REQUEST_FAILED').slice(0, 60);
  return { ok: false, code, message: 'Veri alınamadı.' };
}

export function useAdminResource(loader, { intervalMs = 10000, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, lastUpdatedAt: null, failureCount: 0 });
  const [loading, setLoading] = useState(Boolean(enabled));
  // Süren isteğin SÖZÜ tutulur: çağıran onun yerleşmesini bekleyip hemen
  // yerine geçebilir (bkz. `tick`).
  const inFlightRef = useRef(null);
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);
  const lastUpdatedRef = useRef(null);
  const refreshRef = useRef(() => Promise.resolve());
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    lastUpdatedRef.current = state.lastUpdatedAt;
  }, [state.lastUpdatedAt]);

  const runOnce = useCallback(async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    controllerRef.current = controller;
    setLoading(true);
    let response = null;
    try {
      response = await loader({ signal: controller?.signal });
    } catch (error) {
      // Yükleyicinin REDDETMESİ yoklamayı durdurmamalıdır: tek bir geçici ağ
      // hatası otomatik izlemeyi kalıcı olarak susturuyordu. İptal edilen
      // istek hata değildir; son geçerli durum olduğu gibi kalır.
      if (!controller?.signal.aborted) response = failureResponse(error);
    } finally {
      // Sökülmüş bileşenin ya da iptal edilmiş isteğin yanıtı UYGULANMAZ.
      if (mountedRef.current && !controller?.signal.aborted) {
        if (response) setState((previous) => mergeResourceState(previous, response));
        setLoading(false);
      }
    }
  }, [loader]);

  const run = useCallback(() => {
    // Aynı anda İKİ istek gitmez; ama çağıran süren isteğin bitişini
    // bekleyebilsin diye söz döndürülür.
    if (inFlightRef.current) return inFlightRef.current;
    const promise = runOnce().finally(() => { inFlightRef.current = null; });
    inFlightRef.current = promise;
    return promise;
  }, [runOnce]);

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
    let polling = null;
    let refreshing = null;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const schedule = () => {
      clearTimeout(timer);
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    const load = async (fresh = false) => {
      const pending = inFlightRef.current;
      const aborted = controllerRef.current?.signal.aborted;
      if (pending) await pending;
      if (cancelled) return;
      if (!fresh && hidden()) return;
      // Eski yükleyicinin iptal edilmiş isteğinin yerine hemen yenisi gelir.
      if (!pending || fresh || aborted) await run();
    };
    const tick = () => {
      if (cancelled) return Promise.resolve();
      clearTimeout(timer);
      if (refreshing) return refreshing;
      if (polling) return polling;
      polling = load().finally(() => {
        polling = null;
        if (!refreshing) schedule();
      });
      return polling;
    };
    const explicitRefresh = () => {
      if (cancelled) return Promise.resolve();
      if (refreshing) return refreshing;
      clearTimeout(timer);
      // Elle yenileme, mutasyondan önce başlamış yanıtla tamamlanmaz.
      refreshing = load(true).finally(() => {
        refreshing = null;
        schedule();
      });
      return refreshing;
    };
    refreshRef.current = explicitRefresh;
    tick();

    const onVisibility = () => {
      if (cancelled) return;
      if (shouldRefreshOnReturn({ hidden: hidden(), lastUpdatedAt: lastUpdatedRef.current, intervalMs })) tick();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controllerRef.current?.abort();
      if (refreshRef.current === explicitRefresh) refreshRef.current = () => Promise.resolve();
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
    refresh
  };
}
