'use client';
import { useEffect, useState } from 'react';
import { Icons } from '../icons';
import { useDataLifecycle } from '../../state/hooks';
import { useReducedMotion } from '../../hooks/useReducedMotion.js';
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
  return (
    <div className="app-boot">
      <div className="app-boot-aura" aria-hidden="true" />
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

const BOOT_STEPS = [
  { id: 'catalog', label: 'Kurumsal katalog', Icon: Icons.Database },
  { id: 'wbs', label: 'İş dağılım ağacı', Icon: Icons.Layers },
  { id: 'tasks', label: 'Görevler', Icon: Icons.Table }
];

/**
 * Yükleme adımları sırayla vurgulanır.
 *
 * Gerçek ilerleme sunucudan akmadığı için yüzde UYDURULMAZ; vurgu yalnızca
 * hangi aşamaların hazırlandığını anlatan sakin bir göstergedir.
 */
function BootSteps() {
  const [activeStep, setActiveStep] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    // Tercih etkinken adım döngüsü HİÇ çalışmaz. CSS geçersiz kılması yalnızca
    // giriş animasyonunu kapatıyor, 900 ms'de bir değişen etkin durum ise
    // görünür biçimde hareket etmeye devam ediyordu.
    if (reduceMotion) {
      setActiveStep(0);
      return undefined;
    }
    const timer = setInterval(() => setActiveStep((current) => (current + 1) % BOOT_STEPS.length), 900);
    return () => clearInterval(timer);
  }, [reduceMotion]);

  return (
    <div className="app-boot-steps">
      {BOOT_STEPS.map((step, index) => (
        <span
          key={step.id}
          // Hareket azaltıldığında bütün adımlar durağan biçimde vurgulanır:
          // kullanıcı hangi aşamaların hazırlandığını yine görür.
          className={`app-boot-step${reduceMotion || index === activeStep ? ' is-active' : ''}`}
          style={{ '--step-delay': `${index * 110}ms` }}
        >
          <step.Icon size={12} /> {step.label}
        </span>
      ))}
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
          Projeler, iş dağılım ağacı ve görevler hazırlanıyor. Kurumsal kaynak ilk açılışta eşitlenir.
        </p>
        <div className="app-boot-progress" role="progressbar" aria-label="Veriler yükleniyor" aria-busy="true">
          <span />
        </div>
        <BootSteps />
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
