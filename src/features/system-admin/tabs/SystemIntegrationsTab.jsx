'use client';
import { useCallback, useState } from 'react';
import { Icons } from '../../../components/icons';
import { formatDuration, formatRelativeTime } from '../../../domain/observability/metrics.js';
import { AdminSection } from '../components/AdminSection.jsx';
import { HealthDot } from '../components/HealthDot.jsx';
import { stalenessNotice } from '../systemAdminPresentation.js';
import { loadSystemIntegrationsRequest, testIntegrationRequest } from '../systemAdminClient.js';
import { useAdminResource } from '../useAdminResource.js';

/**
 * Entegrasyonlar.
 *
 * Tek soruyu yanıtlar: MERGEN Rota bağımlılıklarına ulaşabiliyor mu? Kartlar
 * parola, jeton, bağlantı dizesi ya da adres göstermez; yapılandırma yalnızca
 * "Yapılandırılmış / Yapılandırılmamış" olarak bildirilir.
 *
 * Bağlantı testleri yıkıcı değildir; SMTP testi ileti GÖNDERMEZ.
 */
const INTEGRATIONS_REFRESH_MS = 30000;

export function SystemIntegrationsTab({ enabled = true }) {
  const loader = useCallback((options) => loadSystemIntegrationsRequest(options), []);
  const resource = useAdminResource(loader, { intervalMs: INTEGRATIONS_REFRESH_MS, enabled });
  const [testing, setTesting] = useState(null);
  const [results, setResults] = useState({});

  const runTest = async (id) => {
    setTesting(id);
    const response = await testIntegrationRequest(id);
    setTesting(null);
    setResults((current) => ({
      ...current,
      [id]: response.ok
        ? { ok: response.result?.ok, message: response.result?.message || 'Test tamamlandı.' }
        : { ok: false, message: response.message || 'Test çalıştırılamadı.' }
    }));
    await resource.refresh();
  };

  if (!enabled) {
    return (
      <AdminSection
        title="Entegrasyonlar"
        icon="Link"
        empty
        emptyMessage="Demo Kipinde bağımlılık durumu okunmaz."
        emptyHint="Gerçek Sistem verisine geçerek SQL, CN43N, kurumsal kaynaklar, kimlik doğrulama ve SMTP durumunu görüntüleyin."
      />
    );
  }

  const integrations = resource.data?.integrations || [];
  const notice = stalenessNotice({ stale: resource.stale, lastUpdatedAt: resource.lastUpdatedAt, error: resource.error });

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="sysadmin-toolbar">
        <span className="sysadmin-toolbar-title">
          {resource.data?.generatedAt ? `Durum ${formatRelativeTime(resource.data.generatedAt)} alındı.` : 'Bağımlılık durumu yükleniyor…'}
        </span>
        <div className="sysadmin-toolbar-right">
          {notice && <span className="sysadmin-stale-note">{notice}</span>}
          <button type="button" className="btn ghost sm" onClick={resource.refresh} disabled={resource.refreshing}>
            <Icons.Refresh size={13} className={resource.refreshing ? 'sysadmin-spin' : ''} /> Yenile
          </button>
        </div>
      </div>

      <AdminSection
        title="Bağımlılıklar"
        icon="Link"
        description="Bağlantı testleri yıkıcı değildir; SMTP testi ileti göndermeden yalnızca el sıkışmayı dener."
        loading={resource.loading}
        empty={!resource.loading && integrations.length === 0}
        emptyMessage="Entegrasyon bilgisi alınamadı."
      >
        <ul className="sysadmin-integration-list">
          {integrations.map((integration) => {
            const result = results[integration.id];
            return (
              <li key={integration.id} className="sysadmin-integration">
                <div className="sysadmin-integration-main">
                  <HealthDot state={integration.state} size={13} />
                  <div className="col" style={{ gap: 2, minWidth: 0 }}>
                    <strong>{integration.label}</strong>
                    <span className="sysadmin-integration-kind">{integration.kind}</span>
                    <span className="sysadmin-integration-message">{integration.message}</span>
                  </div>
                </div>
                <dl className="sysadmin-integration-meta">
                  <div>
                    <dt>Yapılandırma</dt>
                    <dd>{integration.configured ? 'Yapılandırılmış' : 'Yapılandırılmamış'}</dd>
                  </div>
                  <div>
                    <dt>Son başarılı</dt>
                    <dd>{integration.lastSuccessAt ? formatRelativeTime(integration.lastSuccessAt) : 'bilinmiyor'}</dd>
                  </div>
                  <div>
                    <dt>Son hata</dt>
                    <dd>{integration.lastFailureAt
                      ? `${formatRelativeTime(integration.lastFailureAt)}${integration.lastFailureCode ? ` (${integration.lastFailureCode})` : ''}`
                      : 'yok'}</dd>
                  </div>
                  <div>
                    <dt>Gecikme</dt>
                    <dd>{integration.durationMs != null ? formatDuration(integration.durationMs) : '—'}</dd>
                  </div>
                </dl>
                {integration.detail?.missing?.length > 0 && (
                  <p className="sysadmin-integration-missing">
                    Eksik ayarlar: <span className="tabular">{integration.detail.missing.join(', ')}</span>
                  </p>
                )}
                <div className="sysadmin-integration-actions">
                  {integration.testable && (
                    <button type="button" className="btn sm" disabled={testing === integration.id} onClick={() => runTest(integration.id)}>
                      <Icons.Link size={12} /> {testing === integration.id ? 'Deneniyor…' : 'Bağlantıyı Test Et'}
                    </button>
                  )}
                  {result && (
                    <span className={`sysadmin-test-result ${result.ok ? 'is-ok' : 'is-fail'}`} role="status">
                      {result.ok ? <Icons.Check size={12} /> : <Icons.Alert size={12} />} {result.message}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </AdminSection>
    </div>
  );
}
