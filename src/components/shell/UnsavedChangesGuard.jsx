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
 * Üç katman uygulanır:
 *  - `visibilitychange` (sekme gizlendiğinde) ve `pagehide` bekleyen kuyruğu
 *    hemen boşaltır. Bu son yazma `keepalive` ile gönderilir: sıradan bir
 *    `fetch`, sayfa boşaltılırken tarayıcı tarafından iptal edilebilir.
 *  - `beforeunload` kaydedilmemiş ya da SÜREN bir yazma varsa tarayıcının kendi
 *    onay penceresini açar; kullanıcı kaydın tamamlanmasını bekleyebilir.
 *
 * Süren yazmalar `pendingMutationCount` üzerinden görülür: boşaltma başladığı
 * anda yama kuyruktan çıkar, dolayısıyla yalnızca kuyruğa bakmak isteği yolda
 * olan bir kaydı korumasız bırakırdı. Reddedilip saklanan yamalar da
 * `hasPendingChanges()` içinde sayılır: başarısız bir kayıt "kaydedilmiş" gibi
 * değerlendirilip sessizce atılmaz.
 *
 * Bileşen DOM üretmez.
 */
export function UnsavedChangesGuard() {
  const { actions, pendingMutationCount } = useAppState();
  const { flushPendingChanges, hasPendingChanges } = actions;
  const isSaving = pendingMutationCount > 0;

  useEffect(() => {
    const flushBeforeTeardown = () => {
      if (hasPendingChanges()) flushPendingChanges({ keepalive: true });
    };
    const flushIfHidden = () => {
      if (document.visibilityState === 'hidden') flushBeforeTeardown();
    };
    const onBeforeUnload = (event) => {
      if (!hasPendingChanges() && !isSaving) return undefined;
      // Kaydı yine de başlatırız: kullanıcı "ayrıl" derse istek `keepalive`
      // sayesinde sayfa kapansa bile tamamlanır.
      flushBeforeTeardown();
      event.preventDefault();
      event.returnValue = '';
      return '';
    };

    document.addEventListener('visibilitychange', flushIfHidden);
    window.addEventListener('pagehide', flushBeforeTeardown);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', flushIfHidden);
      window.removeEventListener('pagehide', flushBeforeTeardown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [flushPendingChanges, hasPendingChanges, isSaving]);

  return null;
}
