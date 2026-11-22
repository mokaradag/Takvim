'use client';
import { useRef, useState } from 'react';

/** Okundu işaretini ve liste okumasını kendi sonuçlarıyla gösterir. */
export function useNotificationRead(markNotifications, refresh) {
  const [failedMark, setFailedMark] = useState(null);
  const markSequence = useRef(0);

  const clearMarkError = () => {
    markSequence.current += 1;
    setFailedMark(null);
  };
  const sendMark = async (item) => {
    const sequence = ++markSequence.current;
    setFailedMark(null);
    let message;
    try {
      const result = await markNotifications([item]);
      if (!result?.ok) message = result?.message || 'Bildirim güncellenemedi.';
    } catch (error) {
      message = error?.message || 'Bildirim güncellenemedi.';
    }
    if (message && sequence === markSequence.current) setFailedMark({ item, message });
    refresh();
  };

  return {
    markRead: (item) => item.unread ? sendMark(item) : undefined,
    markError: failedMark?.message,
    retryMark: () => failedMark && sendMark(failedMark.item),
    clearMarkError
  };
}
