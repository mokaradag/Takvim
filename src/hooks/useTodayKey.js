'use client';
import { useEffect, useState } from 'react';
import { fmtISO, today } from '../scheduling/dates';

/**
 * Takvim gününü İZLEYEN referans anahtarı.
 *
 * Tarihe duyarlı memolar `today()` yerine kararlı bir ISO anahtara bağlanır.
 * Ancak anahtarı yalnızca çizim sırasında hesaplamak yetmez: hiçbir görev/durum
 * değişikliği olmayan bir sayfa gece yarısını açık geçtiğinde yeniden
 * çizilmez ve bütün ölçümler dünün sınıflandırmasında kalırdı.
 *
 * Bu yüzden bir sonraki YEREL gece yarısında durum güncellenir. Sekme uykuda
 * kalıp zamanlayıcı ertelenirse görünürlük değişimi de anahtarı tazeler.
 */
export function useTodayKey() {
  const [key, setKey] = useState(() => fmtISO(today()));

  useEffect(() => {
    let timer = null;
    const refresh = () => setKey((current) => {
      const next = fmtISO(today());
      return next === current ? current : next;
    });

    const scheduleNextMidnight = () => {
      const now = new Date();
      // Sınırın bir saniye ötesi hedeflenir: tam gece yarısında uyanan bir
      // zamanlayıcı, saat henüz dünü gösterirken tetiklenebilir.
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = setTimeout(() => {
        refresh();
        scheduleNextMidnight();
      }, Math.max(1000, midnight.getTime() - now.getTime()));
    };

    scheduleNextMidnight();
    const onVisibilityChange = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return key;
}
