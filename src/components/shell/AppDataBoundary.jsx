'use client';
import { useState } from 'react';
import { Icons } from '../icons';
import { useDataLifecycle } from '../../state/hooks';
import { AppLogo } from './AppLogo';
import { DATA_MODES } from '../../data/dataMode';
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
  return (
    <div className="app-boot">
      <div className="app-boot-aura" aria-hidden="true" />
      <div className="app-boot-card">{children}</div>
    </div>
  );
}

/**
 * Veri modu anahtarı Ayarlar sayfasında yaşar; Ayarlar'a ise yalnızca uygulama
 * kabuğu üzerinden ulaşılır. İlk yükleme başarısız olduğunda kabuk hiç render
 * edilmediği için kullanıcının Demo moduna dönebileceği tek çıkış yolu burada
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
      <Icons.Sparkle size={13} /> {switching ? 'Geçiliyor…' : 'Demo moduna geç'}
    </button>
  );
}

/**
 * Yükleme/hata perdesi YALNIZCA ilk veri yüklemesinde gösterilir.
 *
 * Daha önce veri yüklendiyse yeniden yükleme (proje oluşturma, kaydetme sonrası
 * tazeleme, veri modu değişikliği dışındaki her akış) kabuğu söktürmez: aksi
 * hâlde AppShell yeniden monte olur, yerel durumu (açık sayfa, karşılama ekranı
 * tercihi, seçili sekme) sıfırlanır ve kullanıcı "Projeyi oluştur" düğmesine
 * bastığında uygulama baştan açılmış gibi davranıyordu.
 */
export function AppDataBoundary({ children }) {
  const { dataStatus, hasLoadedOnce, loadError, reloadData } = useDataLifecycle();
  // Kimlik doğrulanmadıysa yarım yüklenmiş Gerçek Sistem verisi gösterilmez;
  // kullanıcıya açık bir oturum açma yolu sunulur. Demo moduna SESSİZCE
  // düşülmez: Demo yalnızca kullanıcının bilinçli seçimidir.
  const unauthorized = loadError?.code === 'UNAUTHORIZED';

  if (dataStatus === 'loading' && !hasLoadedOnce) {
    return (
      <DataMessage>
        <div className="app-boot-brand">
          <AppLogo size={46} />
          <div className="app-boot-wordmark">
            <span>MERGEN</span><strong>Rota</strong>
          </div>
        </div>
        <h1 className="app-boot-title">Veriler yükleniyor</h1>
        <p className="app-boot-sub">
          Projeler, iş dağılım ağacı ve görevler hazırlanıyor. Kurumsal kaynak ilk açılışta eşitlenir.
        </p>
        <div className="app-boot-progress" role="progressbar" aria-label="Veriler yükleniyor" aria-busy="true">
          <span />
        </div>
        <div className="app-boot-steps">
          <span className="app-boot-step"><Icons.Database size={12} /> Kurumsal katalog</span>
          <span className="app-boot-step"><Icons.Layers size={12} /> Dağılım ağacı</span>
          <span className="app-boot-step"><Icons.Table size={12} /> Görevler</span>
        </div>
      </DataMessage>
    );
  }

  if (dataStatus === 'error' && !hasLoadedOnce) {
    return (
      <DataMessage>
        <div className="app-boot-brand">
          <AppLogo size={46} />
          <div className="app-boot-wordmark">
            <span>MERGEN</span><strong>Rota</strong>
          </div>
        </div>
        <h1 className="app-boot-title">{unauthorized ? 'Oturum açmanız gerekiyor' : 'Veriler yüklenemedi'}</h1>
        <p className="app-boot-sub">
          {unauthorized
            ? 'Gerçek Sistem verileri yalnızca kurumsal kimlikle görüntülenebilir. Kurumsal hesabınızla oturum açın.'
            : 'Proje verilerine şu anda erişilemiyor. Bağlantı yeniden kullanılabilir olduğunda tekrar deneyin.'}
        </p>
        <div className="app-boot-actions">
          {unauthorized
            ? (
              <a className="btn primary" href="/api/mergen-rota/auth/login">
                <Icons.LogIn size={13} /> Kurumsal oturum aç
              </a>
            )
            : <button className="btn primary" onClick={reloadData}>Yeniden Dene</button>}
          <DemoModeEscape />
        </div>
      </DataMessage>
    );
  }

  return children;
}
