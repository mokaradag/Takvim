'use client';
import { useEffect, useMemo, useState } from 'react';
import { AppStateProvider } from '../../state/AppStateProvider';
import { DATA_MODES, DATA_MODE_STORAGE_KEY, createRepositoryForDataMode } from '../../data/dataMode';
import { Icons } from '../icons';
import AppShell from './AppShell';
import { AppDataBoundary } from './AppDataBoundary';
import { AppLogo } from './AppLogo';
import { DataModeChooser } from './DataModeChooser';
import { DataModeContext } from './DataModeContext';
import { PersistenceStatus } from './PersistenceStatus';
import { PresentationPolish } from './PresentationPolish';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';
import { corporateLoginHref, hasCorporateSession } from './actualAuthBootstrap.js';

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readInitialDataMode() {
  const storage = browserStorage();
  const value = storage?.getItem(DATA_MODE_STORAGE_KEY);
  return value === DATA_MODES.DEMO || value === DATA_MODES.ACTUAL ? value : null;
}

function CorporateSessionGate({ children, onUseDemo }) {
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('checking');
    setError(null);

    hasCorporateSession({ signal: controller.signal })
      .then((authenticated) => {
        if (controller.signal.aborted) return;
        if (authenticated) {
          setStatus('ready');
          return;
        }
        setStatus('redirecting');
        window.location.replace(corporateLoginHref());
      })
      .catch((caught) => {
        if (controller.signal.aborted || caught?.name === 'AbortError') return;
        setError(caught);
        setStatus('error');
      });

    return () => controller.abort();
  }, [attempt]);

  if (status === 'ready') return children;

  return (
    <div className="app-boot">
      <div className="app-boot-aura" aria-hidden="true" />
      <div className="app-boot-card">
        <div className="app-boot-brand">
          <AppLogo size={46} />
          <div className="app-boot-wordmark">
            <span>MERGEN</span><strong>Rota</strong>
          </div>
        </div>
        <h1 className="app-boot-title">
          {status === 'error' ? 'Kurumsal oturum denetlenemedi' : 'Kurumsal oturum hazırlanıyor'}
        </h1>
        <p className="app-boot-sub">
          {status === 'error'
            ? (error?.message || 'Oturum sunucusuna ulaşılamadı.')
            : status === 'redirecting'
              ? 'Oturum açma sayfasına yönlendiriliyorsunuz.'
              : 'Kurumsal oturumunuz denetleniyor. Lütfen bekleyin.'}
        </p>
        {status === 'error'
          ? (
            <div className="app-boot-actions">
              <button className="btn primary" type="button" onClick={() => setAttempt((value) => value + 1)}>
                Yeniden Dene
              </button>
              <button className="btn" type="button" onClick={onUseDemo}>
                <Icons.Sparkle size={13} /> Demo kipine geç
              </button>
            </div>
          )
          : (
            <div className="app-boot-progress" role="progressbar" aria-label="Kurumsal oturum hazırlanıyor" aria-busy="true">
              <span />
            </div>
          )}
      </div>
    </div>
  );
}

export default function ApplicationRoot() {
  // Saklanan kip İLK RENDER'da okunur. Etkiyle okunduğunda ilk kare her zaman
  // `DataModeChooser` çiziyor, kullanıcı her yeniden yüklemede pencereyi
  // görüyor ve o karede yapılan bir tıklama saklanan kipi eziyordu. Bileşen
  // `dynamic(..., { ssr: false })` ile yüklenir (bkz. app/page.js), bu yüzden
  // tembel başlatıcı hidrasyon uyuşmazlığı üretmez.
  const [dataMode, setDataModeState] = useState(readInitialDataMode);
  const repository = useMemo(() => dataMode
    ? createRepositoryForDataMode(dataMode, { aliasStorage: browserStorage() })
    : null, [dataMode]);

  const setDataMode = async (nextMode) => {
    if (nextMode !== DATA_MODES.DEMO && nextMode !== DATA_MODES.ACTUAL) return;
    try { browserStorage()?.setItem(DATA_MODE_STORAGE_KEY, nextMode); } catch {}
    setDataModeState(nextMode);
  };

  if (!dataMode) return <DataModeChooser onChoose={setDataMode} />;

  const application = (
    <AppStateProvider key={dataMode} repository={repository}>
      <AppDataBoundary>
        <PresentationPolish />
        <AppShell />
        <PersistenceStatus />
        <UnsavedChangesGuard />
      </AppDataBoundary>
    </AppStateProvider>
  );

  return (
    <DataModeContext.Provider value={{ dataMode, setDataMode }}>
      {dataMode === DATA_MODES.ACTUAL
        ? <CorporateSessionGate onUseDemo={() => setDataMode(DATA_MODES.DEMO)}>{application}</CorporateSessionGate>
        : application}
    </DataModeContext.Provider>
  );
}
