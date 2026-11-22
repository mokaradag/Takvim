'use client';
import { useRef, useState } from 'react';
import { useDataLifecycle, useTaskActions } from '../../state/hooks/index.js';

/** Okundu işaretini ve liste okumasını kendi sonuçlarıyla gösterir. */
export function useNotificationRead(markNotifications, refresh, refreshInbox = null) {
  const [failedMark, setFailedMark] = useState(null);
  const markSequence = useRef(0);
  const { reloadData: lifecycleReload } = useDataLifecycle();
  const taskActions = useTaskActions();
  const reloadInbox = refreshInbox || taskActions?.reloadData || lifecycleReload;

  const clearMarkError = () => {
    markSequence.current += 1;
    setFailedMark(null);
  };
  const sendMark = async (item) => {
    const sequence = ++markSequence.current;
    setFailedMark(null);
    let message;
    let refreshOnly = false;
    try {
      const result = await markNotifications([item]);
      if (!result?.ok) {
        message = result?.message || 'Bildirim güncellenemedi.';
      } else if (result.refreshError) {
        // İşaret kaydedildi ancak zil uzlaştırma okuması başarısız oldu:
        // yineleme yalnızca okumayı tekrarlar, işareti yeniden göndermez.
        message = result.refreshError.message || 'Bildirimler yenilenemedi.';
        refreshOnly = true;
      }
    } catch (error) {
      message = error?.message || 'Bildirim güncellenemedi.';
    }
    if (message && sequence === markSequence.current) setFailedMark({ item, message, refreshOnly });
    refresh();
  };
  const retryRefresh = async () => {
    const sequence = ++markSequence.current;
    setFailedMark(null);
    let message;
    if (typeof reloadInbox === 'function') {
      try {
        const reload = await reloadInbox({ preserveFailedTaskUpdates: true });
        if (reload?.ok === false) {
          message = reload.error?.message || reload.message || 'Bildirimler yenilenemedi.';
        }
      } catch (error) {
        message = error?.message || 'Bildirimler yenilenemedi.';
      }
    }
    if (message && sequence === markSequence.current) {
      setFailedMark({ item: null, message, refreshOnly: true });
    }
    refresh();
  };

  return {
    markRead: (item) => item.unread ? sendMark(item) : undefined,
    markError: failedMark?.message,
    retryMark: () => failedMark && (failedMark.refreshOnly ? retryRefresh() : sendMark(failedMark.item)),
    clearMarkError
  };
}
