'use client';
import { useState } from 'react';
import { Icons } from '../icons';
import { Avatar } from '../ui';
import { DATA_MODES } from '../../data/dataMode';
import { resolveUserDepartmentLabel, resolveUserDisplayName } from '../../domain/identity/sessionUser.js';
import { useCurrentUser } from '../../state/hooks';
import { useDataMode } from './DataModeContext';

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
export function SidebarUserPanel({ theme, onToggleTheme }) {
  const currentUser = useCurrentUser();
  const { dataMode } = useDataMode();
  const [signingOut, setSigningOut] = useState(false);

  const name = resolveUserDisplayName(currentUser);
  const department = resolveUserDepartmentLabel(currentUser);
  const employeeNo = currentUser?.employeeNo || currentUser?.sicil || null;
  const canSignOut = dataMode === DATA_MODES.ACTUAL;

  const signOut = async () => {
    setSigningOut(true);
    try {
      const response = await fetch('/api/mergen-rota/auth/logout', { method: 'POST', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      // Yönlendirmeyi istemci yapar: sunucu 302 döndürseydi fetch akışında
      // yönlendirme döngüsü oluşabilirdi.
      window.location.assign(body?.endSessionUrl || '/');
    } catch {
      window.location.assign('/');
    }
  };

  return (
    <div className="sidebar-footer-row">
      <div className="user-chip">
        <Avatar name={name} employeeNo={employeeNo} size="lg" />
        <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
          <div className="name" title={name}>{name}</div>
          <div className="department" title={department}>{department}</div>
        </div>
      </div>
      <button
        className="icon-btn"
        onClick={onToggleTheme}
        title="Tema"
        aria-label="Temayı değiştir"
      >
        {theme === 'light' ? <Icons.Moon size={15} /> : <Icons.Sun size={15} />}
      </button>
      {canSignOut && (
        <button
          className="icon-btn"
          onClick={signOut}
          disabled={signingOut}
          title="Oturumu kapat"
          aria-label="Oturumu kapat"
        >
          <Icons.LogOut size={15} />
        </button>
      )}
    </div>
  );
}
