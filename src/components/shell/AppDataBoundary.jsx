'use client';
import { useDataLifecycle } from '../../state/hooks';
import { AppLogo } from './AppLogo';

function DataMessage({ children }) {
  return (
    <div className="app">
      <div className="main" style={{ width: '100%' }}>
        <main className="content" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <div className="col" style={{ gap: 14, width: 'min(460px, calc(100vw - 32px))' }}>
            <div className="card">{children}</div>
            {/* Veri modu anahtarı Ayarlar sayfasında yaşar; kabuk render edilemediğinde
                kullanıcıya yalnızca yeniden deneme yolu gösterilir. */}
          </div>
        </main>
      </div>
    </div>
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
  const { dataStatus, hasLoadedOnce, reloadData } = useDataLifecycle();

  if (dataStatus === 'loading' && !hasLoadedOnce) {
    return (
      <DataMessage>
        <div className="col" style={{ gap: 12, alignItems: 'center', textAlign: 'center', padding: 18 }}>
          <AppLogo size={42} />
          <div style={{ fontSize: 16, fontWeight: 700 }}>Veriler yükleniyor...</div>
          <div className="muted" style={{ fontSize: 12.5 }}>Proje verileri hazırlanıyor.</div>
        </div>
      </DataMessage>
    );
  }

  if (dataStatus === 'error' && !hasLoadedOnce) {
    return (
      <DataMessage>
        <div className="col" style={{ gap: 12, alignItems: 'flex-start', padding: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Veriler yüklenemedi.</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            Proje verilerine şu anda erişilemiyor. Bağlantı yeniden kullanılabilir olduğunda tekrar deneyin.
          </div>
          <button className="btn primary" onClick={reloadData}>Yeniden Dene</button>
        </div>
      </DataMessage>
    );
  }

  return children;
}
