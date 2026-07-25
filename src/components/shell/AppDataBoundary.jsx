'use client';
import { useDataLifecycle } from '../../state/hooks';
import { AppLogo } from './AppLogo';
import { DataModeIndicator } from './DataModeIndicator';

function DataMessage({ children }) {
  return (
    <div className="app">
      <div className="main" style={{ width: '100%' }}>
        <main className="content" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <div className="col" style={{ gap: 14, width: 'min(460px, calc(100vw - 32px))' }}>
            <div className="card">{children}</div>
            {/* Kabuk render edilemediğinde bile kullanıcı Demo moduna dönebilmelidir. */}
            <DataModeIndicator variant="boundary" />
          </div>
        </main>
      </div>
    </div>
  );
}

export function AppDataBoundary({ children }) {
  const { dataStatus, reloadData } = useDataLifecycle();

  if (dataStatus === 'loading') {
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

  if (dataStatus === 'error') {
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
