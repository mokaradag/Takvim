'use client';
import { useRef, useState } from 'react';
import { DATA_MODES } from '../../data/dataMode';
import { publicRotaPath } from '../../lib/publicPath.js';
import { useSessionContext } from '../../state/hooks';
import { useDataMode } from './DataModeContext';

const SIGN_OUT_TIMEOUT_MS = 15_000;

/**
 * Oturum kapatma — TEK merkez.
 *
 * Kenar çubuğu kullanıcı bloğu ile üst çubuktaki hızlı eylemler aynı akışı
 * paylaşır: iki ayrı kopya, birinde düzeltilen bir hata ötekinde kalıyordu.
 *
 * BAŞARISIZ çıkış başarılı gibi sunulmaz: yanıt durumu denetlenmezse 403
 * (aynı köken denetimi) ya da 500 dönen bir istekte oturum çerezi geçerli
 * kalır ve kullanıcı uygulamaya oturumu AÇIK döner.
 */
export function useSignOut() {
  const session = useSessionContext();
  const { dataMode } = useDataMode();
  const requestInFlightRef = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const canSignOut = dataMode === DATA_MODES.ACTUAL && session?.authMode === 'keycloak';
  const appRoot = publicRotaPath('/');

  const signOut = async () => {
    // React durum güncellemesi bir sonraki çizime kadar görünür olmaz. Aynı
    // tıklama çevriminde iki denetim de çalışırsa yalnızca `signingOut`
    // denetimi iki POST isteğini engelleyemez; eşzamanlı ref anında kilitler.
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setSigningOut(true);
    setSignOutError('');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
    try {
      const response = await fetch(publicRotaPath('/api/mergen-rota/auth/logout'), {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSignOutError(body?.error?.message || 'Oturum kapatılamadı. Lütfen yeniden deneyin.');
        return;
      }
      // Yönlendirmeyi istemci yapar: sunucu 302 döndürseydi fetch akışında
      // yönlendirme döngüsü oluşabilirdi.
      window.location.assign(body?.endSessionUrl || appRoot);
    } catch {
      // İstek hiç tamamlanmadıysa (çevrimdışı, ağ hatası, iptal) oturum
      // SUNUCUDA hâlâ açıktır; hata gösterilir ve yeniden denenebilir.
      setSignOutError('Oturum kapatılamadı. Lütfen yeniden deneyin.');
    } finally {
      clearTimeout(timeoutId);
      requestInFlightRef.current = false;
      setSigningOut(false);
    }
  };

  return { canSignOut, signOut, signingOut, signOutError };
}
