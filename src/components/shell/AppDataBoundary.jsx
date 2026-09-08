'use client';
import { useEffect, useState } from 'react';
import { Icons } from '../icons';
import { useDataLifecycle } from '../../state/hooks';
import Image from 'next/image';
import { AppLogo } from './AppLogo';
import { DATA_MODES } from '../../data/dataMode';
import { publicRotaPath } from '../../lib/publicPath.js';
import { useDataMode } from './DataModeContext';

/**
 * Açılış perdesi kendi tam ekran düzenini kurar.
 *
 * Daha önce uygulama kabuğunun `.app` ızgarası kullanılıyordu. O ızgaranın ilk
 * sütunu 240 pikselle kenar çubuğuna ayrılmıştır; perde tek çocuk olduğu için
 * o dar sütuna düşüyor ve kart ekranın solunda kırpılmış görünüyordu. Buradaki
 * `.app-boot` düzeni ızgaradan bağımsızdır ve kartı her zaman ekranın ortasına
 * yerleştirir.
 */
function DataMessage({ children }) {
  const logoUrl = publicRotaPath('/api/mergen-rota/company-logo');
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <div className="app-boot">
      <div className="app-boot-stars" aria-hidden="true" />
      <div className="app-boot-nebula" aria-hidden="true" />
      <div className="app-boot-orbit" aria-hidden="true" />
      {logoUrl && !logoFailed && <Image className="app-boot-company-logo" src={logoUrl}
        alt="Kurum logosu" width={220} height={64} unoptimized onError={() => setLogoFailed(true)} />}
      <div className="app-boot-card">{children}</div>
    </div>
  );
}

/** Perdenin marka bloğu; ürün adı her perdede aynı ağırlıkta görünür. */
function BootBrand() {
  return (
    <div className="app-boot-brand">
      <AppLogo size={54} />
      <div className="app-boot-wordmark">
        <span>MERGEN</span><strong>Rota</strong>
        <small>Görev Yönetimi</small>
      </div>
    </div>
  );
}

/**
 * Veri kipi anahtarı Ayarlar sayfasında yaşar; Ayarlar'a ise yalnızca uygulama
 * kabuğu üzerinden ulaşılır. İlk yükleme başarısız olduğunda kabuk hiç render
 * edilmediği için kullanıcının Demo kipine dönebileceği tek çıkış yolu burada
 * sunulur. Aksi hâlde Gerçek Sistem erişilemediğinde uygulama tümüyle kilitlenir.
 */
function DemoModeEscape() {
  const { dataMode, setDataMode } = useDataMode();
  const [switching, setSwitching] = useState(false);
  if (dataMode === DATA_MODES.DEMO) return null;

  return (
    <button
      type="button"
      className="btn"
      disabled={switching}
      onClick={async () => {
        setSwitching(true);
        try { await setDataMode(DATA_MODES.DEMO); }
        finally { setSwitching(false); }
      }}
    >
      <Icons.Sparkle size={13} /> {switching ? 'Geçiliyor…' : 'Demo kipine geç'}
    </button>
  );
}

/**
 * Yükleme/hata perdesi YALNIZCA ilk veri yüklemesinde gösterilir.
 *
 * Daha önce veri yüklendiyse yeniden yükleme (proje oluşturma, kaydetme sonrası
 * tazeleme, veri kipi değişikliği dışındaki her akış) kabuğu söktürmez: aksi
 * hâlde AppShell yeniden monte olur, yerel durumu (açık sayfa, karşılama ekranı
 * tercihi, seçili sekme) sıfırlanır ve kullanıcı "Projeyi oluştur" düğmesine
 * bastığında uygulama baştan açılmış gibi davranıyordu.
 */
export function AppDataBoundary({ children }) {
  const { dataStatus, hasLoadedOnce, loadError, reloadData } = useDataLifecycle();
  const sessionRequired = loadError?.code === 'SESSION_REQUIRED';
  const authenticationRejected = loadError?.code === 'UNAUTHORIZED';
  const appRoot = publicRotaPath('/');
  const loginHref = `${publicRotaPath('/api/mergen-rota/auth/login')}?returnTo=${encodeURIComponent(appRoot)}`;

  useEffect(() => {
    if (sessionRequired) window.location.replace(loginHref);
  }, [loginHref, sessionRequired]);

  if (dataStatus === 'loading' && !hasLoadedOnce) {
    return (
      <DataMessage>
        <BootBrand />
        <h1 className="app-boot-title">Veriler yükleniyor</h1>
        <p className="app-boot-sub">
          Çalışma alanınız hazırlanıyor.
        </p>
        <div className="app-boot-progress" role="progressbar" aria-label="Veriler yükleniyor" aria-busy="true">
          <span />
        </div>
      </DataMessage>
    );
  }

  if (dataStatus === 'error' && !hasLoadedOnce && sessionRequired) {
    return (
      <DataMessage>
        <BootBrand />
        <h1 className="app-boot-title">Kurumsal oturum yenileniyor</h1>
        <p className="app-boot-sub">Oturum açma sayfasına yönlendiriliyorsunuz.</p>
        <div className="app-boot-progress" role="progressbar" aria-label="Kurumsal oturum yenileniyor" aria-busy="true">
          <span />
        </div>
      </DataMessage>
    );
  }

  if (dataStatus === 'error' && !hasLoadedOnce) {
    return (
      <DataMessage>
        <BootBrand />
        <h1 className="app-boot-title">
          {authenticationRejected ? 'Kimlik doğrulanamadı' : 'Veriler yüklenemedi'}
        </h1>
        <p className="app-boot-sub">
          {authenticationRejected
            ? (loadError?.message || 'Kurumsal kimliğiniz doğrulanamadı. Sistem yöneticinizle görüşün.')
            : 'Proje verilerine şu anda erişilemiyor. Bağlantı yeniden kullanılabilir olduğunda tekrar deneyin.'}
        </p>
        <div className="app-boot-actions">
          <button className="btn primary" onClick={reloadData}>Yeniden Dene</button>
          <DemoModeEscape />
        </div>
      </DataMessage>
    );
  }

  return children;
}
