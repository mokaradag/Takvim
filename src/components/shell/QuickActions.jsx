'use client';
import { Icons } from '../icons';
import { Spinner } from '../Loader';

/**
 * Üst çubuk hızlı eylemleri.
 *
 * Mod seçimi (Basit / Gelişmiş), tema anahtarı ve oturum kapatma her sayfadan
 * tek tıkla erişilebilir. Üçü de daha önce yalnızca Ayarlar sayfasında ya da
 * kenar çubuğunun altında duruyordu; en sık kullanılan üç eylem için sayfa
 * değiştirmek gerekiyordu.
 */
export function QuickActions({ simpleMode, onChooseMode, theme, onToggleTheme, signOutState }) {
  const { canSignOut, signOut, signingOut, signOutError } = signOutState;
  const light = theme === 'light';

  return (
    <div className="quick-actions" role="group" aria-label="Hızlı eylemler">
      <div className="quick-mode-switch" role="group" aria-label="Uygulama modu">
        <button
          type="button"
          className={simpleMode ? 'active' : ''}
          aria-pressed={simpleMode}
          title="Basit Mod · Hızlı görev tanımı ve takvim"
          onClick={() => !simpleMode && onChooseMode('simple')}
        >
          <Icons.Sparkle size={12} /> <span>Basit</span>
        </button>
        <button
          type="button"
          className={!simpleMode ? 'active' : ''}
          aria-pressed={!simpleMode}
          title="Gelişmiş Mod · Tüm planlama araçları"
          onClick={() => simpleMode && onChooseMode('advanced')}
        >
          <Icons.Layers size={12} /> <span>Gelişmiş</span>
        </button>
      </div>

      {/* Tema anahtarı: kaydırmalı düğme, seçili tarafı vurgular. */}
      <button
        type="button"
        role="switch"
        aria-checked={light}
        aria-label={light ? 'Koyu temaya geç' : 'Açık temaya geç'}
        title={light ? 'Koyu tema' : 'Açık tema'}
        className={`theme-switch${light ? ' is-light' : ''}`}
        onClick={onToggleTheme}
      >
        <span className="theme-switch-icon sun"><Icons.Sun size={11} /></span>
        <span className="theme-switch-icon moon"><Icons.Moon size={11} /></span>
        <span className="theme-switch-knob" />
      </button>

      {canSignOut && (
        <button
          type="button"
          className="quick-action-btn quick-signout"
          onClick={signOut}
          disabled={signingOut}
          aria-busy={signingOut}
          title={signOutError || 'Oturumu kapat'}
          aria-label="Oturumu kapat"
        >
          {signingOut ? <Spinner size={14} /> : <Icons.LogOut size={14} />}
        </button>
      )}
      {signOutError && <span role="alert" className="quick-signout-error">{signOutError}</span>}
    </div>
  );
}
