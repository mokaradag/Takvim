'use client';
import { useEffect } from 'react';
import { useAppState } from '../../state/AppStateProvider';

/**
 * Kaydedilmemiş düzenleme koruması.
 *
 * Görev metni, açıklama ve ilerleme gibi alanlar yazma yükünü azaltmak için
 * 250 ms'lik bir birleştirme kuyruğunda bekletilir. Kullanıcı bu aralıkta
 * sekmeyi kapatırsa düzenleme hiçbir zaman sunucuya ulaşmıyor, üstelik
 * "Kaydedildi" göstergesi de hiç görünmediği için kayıp fark edilmiyordu.
 *
 * İki katman uygulanır:
 *  - `visibilitychange` (sekme gizlendiğinde) bekleyen kuyruk hemen boşaltılır.
 *    Tarayıcılar bu olayı sekme kapanışında da güvenilir biçimde tetikler ve
 *    eşzamansız isteğe şans tanır.
 *  - `beforeunload` bekleyen ya da süren bir yazma varsa tarayıcının kendi
 *    onay penceresini açar; kullanıcı kaydın tamamlanmasını bekleyebilir.
 *
 * Bileşen DOM üretmez.
 */
export function UnsavedChangesGuard() {
  const { actions, isSaving } = useAppState();
  const { flushPendingChanges, hasPendingChanges } = actions;

  useEffect(() => {
    const flushIfHidden = () => {
      if (document.visibilityState === 'hidden' && hasPendingChanges()) flushPendingChanges();
    };
    const onBeforeUnload = (event) => {
      if (!hasPendingChanges() && !isSaving) return undefined;
      // Kaydı yine de başlatırız: kullanıcı "ayrıl" derse istek çoğu tarayıcıda
      // yine de yola çıkar.
      flushPendingChanges();
      event.preventDefault();
      event.returnValue = '';
      return '';
    };

    document.addEventListener('visibilitychange', flushIfHidden);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', flushIfHidden);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [flushPendingChanges, hasPendingChanges, isSaving]);

  return null;
}
