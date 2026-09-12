'use client';
import { useCallback, useState } from 'react';
import { Icons } from '../../../components/icons';
import { ALERT_STATES, severityLabel } from '../../../domain/observability/eventModel.js';
import { TIME_RANGES, formatRelativeTime } from '../../../domain/observability/metrics.js';
import { AdminSection } from '../components/AdminSection.jsx';
import { DetailDrawer, DrawerField } from '../components/DetailDrawer.jsx';
import { alertStateLabel, severityTone, stalenessNotice } from '../systemAdminPresentation.js';
import { acknowledgeAlertRequest, loadSystemEventsRequest } from '../systemAdminClient.js';
import { useAdminResource } from '../useAdminResource.js';

/**
 * Hatalar ve Olaylar.
 *
 * Ham günlük dökümü DEĞİLDİR: yinelenen aynı sorun tek satırda toplanır, her
 * kayıt kararlı bir kod ve ilişkilendirme kimliği taşır. Yönetici buradan
 * "ne oldu, kaç kez oldu, hâlâ sürüyor mu, ne yapmalıyım" sorularını
 * yanıtlayabilir.
 */
const EVENTS_REFRESH_MS = 30000;
const PAGE_SIZE = 25;

const EMPTY_FILTERS = Object.freeze({ severity: '', component: '', code: '', search: '', state: 'active', range: '24h' });

export function SystemEventsTab({ enabled = true, focusedComponent = null }) {
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, component: focusedComponent || '' }));
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState(null);
  const [acknowledging, setAcknowledging] = useState(null);

  const loader = useCallback((options) => loadSystemEventsRequest({
    ...filters,
    offset,
    limit: PAGE_SIZE
  }, options), [filters, offset]);
  const resource = useAdminResource(loader, { intervalMs: EVENTS_REFRESH_MS, enabled });

  const setFilter = (key, value) => {
    setOffset(0);
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const acknowledge = async (alertId) => {
    setAcknowledging(alertId);
    await acknowledgeAlertRequest(alertId);
    setAcknowledging(null);
    await resource.refresh();
  };

  if (!enabled) {
    return (
      <AdminSection
        title="İşletim olayları"
        icon="Alert"
        empty
        emptyMessage="Demo Kipinde işletim olayları okunmaz."
        emptyHint="Gerçek Sistem verisine geçerek uyarıları, olay geçmişini ve ilişkilendirme kimliklerini görüntüleyin."
      />
    );
  }

  const data = resource.data;
  const alerts = data?.alerts || [];
  const events = data?.events || [];
  const notice = stalenessNotice({ stale: resource.stale, lastUpdatedAt: resource.lastUpdatedAt, error: resource.error });
  const total = data?.total || 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card sysadmin-filters" role="search">
        <label className="sysadmin-filter">
          <span>Ağırlık</span>
          <select className="input" value={filters.severity} onChange={(event) => setFilter('severity', event.target.value)}>
            <option value="">Tümü</option>
            {(data?.filters?.severities || []).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="sysadmin-filter">
          <span>Bileşen</span>
          <select className="input" value={filters.component} onChange={(event) => setFilter('component', event.target.value)}>
            <option value="">Tümü</option>
            {(data?.filters?.components || []).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="sysadmin-filter">
          <span>Olay kodu</span>
          <select className="input" value={filters.code} onChange={(event) => setFilter('code', event.target.value)}>
            <option value="">Tümü</option>
            {(data?.filters?.codes || []).map((option) => (
              <option key={option.id} value={option.id}>{option.id}</option>
            ))}
          </select>
        </label>
        <label className="sysadmin-filter">
          <span>Zaman aralığı</span>
          <select className="input" value={filters.range} onChange={(event) => setFilter('range', event.target.value)}>
            {Object.values(TIME_RANGES).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="sysadmin-filter">
          <span>Uyarı durumu</span>
          <select className="input" value={filters.state} onChange={(event) => setFilter('state', event.target.value)}>
            <option value="active">Yalnızca açık</option>
            <option value="all">Çözülenler dâhil</option>
          </select>
        </label>
        <label className="sysadmin-filter sysadmin-filter-grow">
          <span>Ara</span>
          <input
            className="input"
            type="search"
            value={filters.search}
            placeholder="Özet ya da olay kodu"
            onChange={(event) => setFilter('search', event.target.value)}
          />
        </label>
        <button type="button" className="btn ghost sm" onClick={() => { setFilters({ ...EMPTY_FILTERS }); setOffset(0); }}>
          <Icons.Close size={12} /> Süzgeçleri temizle
        </button>
      </div>

      {notice && <p className="sysadmin-stale-note" role="status">{notice}</p>}

      {data?.schemaReady === false && (
        <div className="card sysadmin-warning" role="status">
          <Icons.Database size={14} aria-hidden="true" />
          Olay ve uyarı tabloları bulunamadı. <code>database/MR_Upgrade_0012_System_Observability.sql</code> betiği
          çalıştırılmadan kalıcı olay geçmişi tutulmaz.
        </div>
      )}

      <AdminSection
        title="Uyarılar"
        icon="Bell"
        description="Aynı koşul tek uyarıda toplanır; sayaç yinelemeyi gösterir. Çözme kararını sağlık değerlendirmesi verir."
        loading={resource.loading}
        empty={!resource.loading && alerts.length === 0}
        emptyMessage="Açık uyarı yok."
      >
        <ul className="sysadmin-alert-list">
          {alerts.map((alert) => (
            <li key={alert.id} className={`sysadmin-alert sysadmin-alert-${severityTone(alert.severity)}`}>
              <div className="sysadmin-alert-head">
                <span className={`sysadmin-badge sysadmin-badge-${severityTone(alert.severity)}`}>{severityLabel(alert.severity)}</span>
                <strong>{alert.summary}</strong>
                <span className="sysadmin-chip">{alertStateLabel(alert.state)}</span>
                {alert.occurrenceCount > 1 && <span className="sysadmin-chip">×{alert.occurrenceCount}</span>}
              </div>
              <div className="sysadmin-alert-meta">
                <span className="tabular">{alert.code}</span>
                <span>{alert.component}</span>
                <span>İlk: {formatRelativeTime(alert.firstSeenAt)}</span>
                <span>Son: {formatRelativeTime(alert.lastSeenAt)}</span>
              </div>
              <div className="sysadmin-alert-actions">
                <button type="button" className="btn ghost sm" onClick={() => setDetail({ kind: 'alert', item: alert })}>
                  Ayrıntı
                </button>
                {alert.state === ALERT_STATES.OPEN && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={acknowledging === alert.id}
                    onClick={() => acknowledge(alert.id)}
                  >
                    <Icons.Check size={12} /> {acknowledging === alert.id ? 'Onaylanıyor…' : 'Onayla'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </AdminSection>

      <AdminSection
        title="Olay geçmişi"
        icon="Table"
        description={`Toplam ${total} kayıt. Özdeş olaylar yazılırken tek satırda toplanır.`}
        loading={resource.loading}
        empty={!resource.loading && events.length === 0}
        emptyMessage="Seçilen süzgeçlerle olay bulunamadı."
      >
        <div className="sysadmin-table-wrap">
          <table className="tbl sysadmin-table">
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Ağırlık</th>
                <th>Bileşen</th>
                <th>Kod</th>
                <th>Özet</th>
                <th style={{ textAlign: 'right' }}>Yineleme</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="muted">{formatRelativeTime(event.occurredAt)}</td>
                  <td>
                    <span className={`sysadmin-badge sysadmin-badge-${severityTone(event.severity)}`}>
                      {severityLabel(event.severity)}
                    </span>
                  </td>
                  <td className="tabular sysadmin-ref">{event.component}</td>
                  <td className="tabular sysadmin-ref">{event.code}</td>
                  <td>{event.summary}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{event.occurrenceCount}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn ghost sm" onClick={() => setDetail({ kind: 'event', item: event })}
                      aria-label={`${event.summary} ayrıntısını aç`}>
                      <Icons.ChevronRight size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sysadmin-pager">
          <button type="button" className="btn ghost sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <Icons.ChevronLeft size={12} /> Önceki
          </button>
          <span className="muted">{total === 0 ? '0' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total}`}</span>
          <button type="button" className="btn ghost sm" disabled={!hasNext} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Sonraki <Icons.ChevronRight size={12} />
          </button>
        </div>
      </AdminSection>

      {detail && (
        <DetailDrawer
          title={detail.item.summary}
          subtitle={`${severityLabel(detail.item.severity)} · ${detail.item.component}`}
          onClose={() => setDetail(null)}
          footer={detail.kind === 'alert' && detail.item.state === ALERT_STATES.OPEN ? (
            <button type="button" className="btn primary sm" onClick={async () => { await acknowledge(detail.item.id); setDetail(null); }}>
              <Icons.Check size={13} /> Uyarıyı onayla
            </button>
          ) : null}
        >
          <div className="col" style={{ gap: 10 }}>
            <DrawerField label="Olay kodu" value={detail.item.code} mono />
            <DrawerField label="Bileşen" value={detail.item.component} mono />
            <DrawerField label="İlişkilendirme kimliği" value={detail.item.correlationId} mono />
            <DrawerField label="Yineleme" value={detail.item.occurrenceCount} mono />
            {detail.kind === 'alert' ? (
              <>
                <DrawerField label="Durum" value={alertStateLabel(detail.item.state)} />
                <DrawerField label="İlk görülme" value={detail.item.firstSeenAt} mono />
                <DrawerField label="Son görülme" value={detail.item.lastSeenAt} mono />
                <DrawerField label="Onaylayan sicil" value={detail.item.acknowledgedBySicil} mono />
                <DrawerField label="Çözülme" value={detail.item.resolvedAt} mono />
              </>
            ) : (
              <DrawerField label="Zaman" value={detail.item.occurredAt} mono />
            )}
            {detail.item.detail && <p className="sysadmin-drawer-message">{detail.item.detail}</p>}
            {detail.item.action && (
              <p className="sysadmin-drawer-message sysadmin-drawer-action">
                <Icons.Info size={12} aria-hidden="true" /> {detail.item.action}
              </p>
            )}
            {detail.item.context && (
              <pre className="sysadmin-drawer-json">{JSON.stringify(detail.item.context, null, 2)}</pre>
            )}
          </div>
        </DetailDrawer>
      )}
    </div>
  );
}
