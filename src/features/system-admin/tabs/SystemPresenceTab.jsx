'use client';
import { useCallback, useMemo } from 'react';
import { Icons } from '../../../components/icons';
import { PRESENCE_ACTIVE_WINDOW_MS } from '../../../domain/presence/presenceModel.js';
import { AdminSection } from '../components/AdminSection.jsx';
import { MetricTile } from '../components/MetricTile.jsx';
import { loadSystemPresenceRequest } from '../systemAdminClient.js';
import { useAdminResource } from '../useAdminResource.js';
import { presenceDuration, presenceTimestamp } from '../systemAdminPresentation.js';

/**
 * Sistem Yönetimi · Aktif Kullanıcılar.
 *
 * "Aktif" AÇIK bir tanımdır ve "oturum açmış kullanıcı listesi" DEĞİLDİR:
 * son üç dakika içinde kimliği doğrulanmış bir nabız görülen kullanıcıdır.
 *
 * Yoklama YALNIZCA bu sekme etkinken çalışır; veri ana uygulama anlık
 * görüntüsüne girmez ve yetki sunucuda bağımsız olarak denetlenir.
 */
const REFRESH_INTERVAL_MS = 30000;

export function SystemPresenceTab({ enabled = true }) {
  const load = useCallback((options) => loadSystemPresenceRequest(options), []);
  const presence = useAdminResource(load, { intervalMs: REFRESH_INTERVAL_MS, enabled });
  const data = presence.data;
  const metrics = data?.metrics || {};
  const users = useMemo(() => data?.users || [], [data]);
  const activeWindowMs = data?.definition?.activeWindowMs || PRESENCE_ACTIVE_WINDOW_MS;
  const activeMinutes = Math.round(activeWindowMs / 60000);

  return (
    <div className="sysadmin-presence">
      <div className="sysadmin-tile-grid sysadmin-presence-metrics">
        <MetricTile label="Şu anda aktif" value={metrics.activeCount} icon="Users" tone="ok"
          hint={`Son ${activeMinutes} dakikada nabız görülen kullanıcı`} />
        <MetricTile label="Son 15 dk aktif" value={metrics.recentCount} icon="Clock"
          hint="Kısa süre önce uygulamayı kullanan kişi sayısı" />
        <MetricTile label="Aktif direktörlük" value={metrics.directorateCount} icon="Layers"
          hint="Şu anda aktif kullanıcıların direktörlük sayısı" />
        <MetricTile label="Aktif müdürlük" value={metrics.departmentCount} icon="Briefcase"
          hint="Şu anda aktif kullanıcıların müdürlük sayısı" />
      </div>

      <AdminSection
        title="Aktif kullanıcılar"
        icon="Users"
        description={`Aktif = son ${activeMinutes} dakika içinde kimliği doğrulanmış nabız. Liste son 15 dakikayı kapsar.`}
        loading={presence.loading}
        error={presence.error?.message || null}
        empty={!presence.loading && !presence.error && users.length === 0}
        emptyMessage="Şu anda etkin kullanıcı görünmüyor."
        emptyHint={data?.enabled === false ? 'Varlık tablosu bu kurulumda henüz oluşturulmamış.' : null}
        className="sysadmin-presence-section"
        actions={presence.lastUpdatedAt && (
          <span className="sysadmin-updated tabular">
            <Icons.Refresh size={11} aria-hidden="true" /> {new Date(presence.lastUpdatedAt).toLocaleTimeString('tr-TR')}
          </span>
        )}
      >
        <div className="sysadmin-presence-scroll">
          <table className="table sysadmin-table sysadmin-presence-table">
            <caption className="sr-only">Aktif kullanıcılar</caption>
            <thead>
              <tr>
                <th scope="col">Ad Soyad</th>
                <th scope="col">Sicil</th>
                <th scope="col">Direktörlük</th>
                <th scope="col">Müdürlük</th>
                <th scope="col">Birim</th>
                <th scope="col">Aktif süre</th>
                <th scope="col">Son görülme</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const stale = !user.lastSeenAt
                  || Date.now() - Date.parse(user.lastSeenAt) > activeWindowMs;
                return (
                  <tr key={user.sicil} className={stale ? 'is-idle' : undefined}>
                    <td>
                      <span className="sysadmin-presence-name">
                        <span className={`sysadmin-dot ${stale ? 'sysadmin-dot-idle' : 'sysadmin-dot-ok'}`} aria-hidden="true" />
                        {user.name}
                      </span>
                    </td>
                    <td className="tabular">{user.sicil}</td>
                    <td>{user.directorate || '—'}</td>
                    <td>{user.department || '—'}</td>
                    <td>{user.unit || '—'}</td>
                    <td className="tabular">{presenceDuration(user.sessionStartedAt)}</td>
                    <td className="tabular">{presenceTimestamp(user.lastSeenAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminSection>
    </div>
  );
}
