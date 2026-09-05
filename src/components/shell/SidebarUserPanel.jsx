'use client';
import { Icons } from '../icons';
import { Avatar } from '../ui';
import { resolveUserDepartmentLabel, resolveUserDisplayName } from '../../domain/identity/sessionUser.js';
import { useCurrentUser } from '../../state/hooks';

/**
 * Kenar çubuğu kullanıcı bloğu.
 *
 * Kimlik SUNUCUDAN gelir: Gerçek Sistem'de doğrulanmış Keycloak oturumundan
 * üretilen `session.currentUser`. Buradaki hiçbir değer yetkilendirmede
 * kullanılmaz; yalnızca gösterim amaçlıdır.
 *
 * Ad altındaki satır artık uydurma bir "rol" değil, Keycloak `department`
 * claim'idir. Değer yoksa nötr bir yedek metin gösterilir.
 *
 * Not: Eski "Kullanım rehberi" kısayol düğmesi buradan KALDIRILDI; Yardım
 * sayfası normal gezinme öğesi olarak durmaya devam eder. Boşalan yatay alan
 * uzun departman adlarına ayrılmıştır.
 */
export function SidebarUserPanel({
  theme,
  onToggleTheme,
  simpleMode,
  onChooseMode,
  sidebarPinned,
  onToggleSidebarPin,
  signOutState
}) {
  const currentUser = useCurrentUser();
  const { canSignOut, signOut, signingOut, signOutError } = signOutState;

  const name = resolveUserDisplayName(currentUser);
  const department = resolveUserDepartmentLabel(currentUser);
  const employeeNo = currentUser?.employeeNo || currentUser?.sicil || null;

  return (
    <div className="sidebar-user-panel">
      <div className="user-chip">
        <Avatar name={name} employeeNo={employeeNo} size="lg" />
        <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
          <div className="name" title={name}>{name}</div>
          <div className="department" title={department}>{department}</div>
        </div>
      </div>
      <div className="sidebar-utility-row">
        <button
          className="sidebar-utility-button"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Koyu temaya geç' : 'Açık temaya geç'}
          aria-label="Temayı değiştir"
        >
          {theme === 'light' ? <Icons.Moon size={15} /> : <Icons.Sun size={15} />}
        </button>
        <div className="sidebar-mode-toggle" role="group" aria-label="Çalışma kipi">
          <button type="button" aria-pressed={simpleMode} aria-label="Temel Kip" title="Temel Kip" onClick={() => { if (!simpleMode) onChooseMode('simple'); }}>
            <span className="sidebar-mode-short" aria-hidden="true">T</span><span className="sidebar-mode-copy">Temel</span>
          </button>
          <button type="button" aria-pressed={!simpleMode} aria-label="Kapsamlı Kip" title="Kapsamlı Kip" onClick={() => { if (simpleMode) onChooseMode('advanced'); }}>
            <span className="sidebar-mode-short" aria-hidden="true">K</span><span className="sidebar-mode-copy">Kapsamlı</span>
          </button>
        </div>
        {canSignOut && (
          <button
            className="sidebar-utility-button"
            onClick={signOut}
            disabled={signingOut}
            title="Oturumu kapat"
            aria-label="Oturumu kapat"
          >
            <Icons.LogOut size={15} />
          </button>
        )}
      </div>
      <div className="sidebar-meta-row">
        <div className="sidebar-version"><span>MERGEN Rota</span><span>· Sürüm 1.0</span></div>
        <button
          type="button"
          className={`sidebar-pin-button${sidebarPinned ? ' active' : ''}`}
          onClick={onToggleSidebarPin}
          aria-pressed={sidebarPinned}
          title={sidebarPinned ? 'Kenar çubuğu sabitlemesini kaldır' : 'Kenar çubuğunu açık sabitle'}
          aria-label={sidebarPinned ? 'Kenar çubuğu sabitlemesini kaldır' : 'Kenar çubuğunu açık sabitle'}
        >
          {sidebarPinned ? <Icons.Pin size={13} /> : <Icons.PinOff size={13} />}
        </button>
      </div>
      {signOutError && (
        <span role="alert" className="sidebar-signout-error">{signOutError}</span>
      )}
    </div>
  );
}
