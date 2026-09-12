'use client';
import { useState } from 'react';
import { Icons } from '../../../components/icons';
import { COMPONENTS, severityLabel } from '../../../domain/observability/eventModel.js';
import { HEALTH_STATES, normalizeHealthState } from '../../../domain/observability/healthModel.js';
import { formatBytes, formatDuration, formatRelativeTime, formatUptime } from '../../../domain/observability/metrics.js';
import { AdminSection, SkeletonRows } from '../components/AdminSection.jsx';
import { DetailDrawer, DrawerField } from '../components/DetailDrawer.jsx';
import { HealthDot } from '../components/HealthDot.jsx';
import { MetricTile } from '../components/MetricTile.jsx';
import { healthNarrative, healthTone, severityTone } from '../systemAdminPresentation.js';

/**
 * Genel Durum.
 *
 * Yönetici on saniyede şu soruları yanıtlayabilmelidir: sistem sağlıklı mı,
 * ne bozuk, ne zaman bozuldu, ne yapmalıyım. Bu yüzden sıralama şudur:
 * durum → dikkat gerektirenler → bileşenler → göstergeler → eğilim → akış.
 */
function uptimeOf(components = []) {
  const application = components.find((component) => component.key === COMPONENTS.APPLICATION);
  return application?.detail?.uptimeSeconds ?? null;
}

function resourceOf(components = []) {
  return components.find((component) => component.key === COMPONENTS.RESOURCES)?.detail || null;
}

function outlookQueueOf(overview) {
  return overview?.outlook?.queue || null;
}

export function SystemOverviewTab({
  overview = null,
  loading = false,
  error = null,
  stale = false,
  lastUpdatedAt = null,
  demoMode = false,
  onNavigate
}) {
  const [detail, setDetail] = useState(null);

  if (demoMode) {
    return (
      <div className="col" style={{ gap: 14 }}>
        <AdminSection
          title="Canlı sistem durumu"
          icon="Activity"
          description="Demo Kipinde üretim sağlık uçları çağrılmaz."
          empty
          emptyMessage="Demo Kipinde canlı gözlemlenebilirlik kullanılamaz."
          emptyHint="Gerçek Sistem verisine geçerek sağlık, başarım ve kuyruk ölçümlerini görüntüleyin."
        />
      </div>
    );
  }

  if (loading && !overview) {
    return (
      <div className="col" style={{ gap: 14 }}>
        <section className="card sysadmin-section"><SkeletonRows count={4} /></section>
        <section className="card sysadmin-section"><SkeletonRows count={5} /></section>
      </div>
    );
  }

  const state = normalizeHealthState(overview?.state);
  const components = overview?.components || [];
  const attention = overview?.attention || [];
  const api = overview?.api || {};
  const trends = overview?.trends || {};
  const queue = outlookQueueOf(overview);
  const resources = resourceOf(components);
  const wbs = components.find((component) => component.key === COMPONENTS.CORPORATE_WBS);
  const reminder = components.find((component) => component.key === COMPONENTS.REMINDER);

  return (
    <div className="col sysadmin-overview" style={{ gap: 14 }}>
      <section className={`card sysadmin-hero sysadmin-hero-${healthTone(state)}`}>
        <div className="sysadmin-hero-main">
          <HealthDot state={overview ? state : HEALTH_STATES.UNKNOWN} size={18} />
          <p className="sysadmin-hero-text">
            {overview
              ? healthNarrative({ state, counts: overview.counts, attentionCount: attention.length })
              : 'Sistem durumu alınamadı; hiçbir bileşen ölçülemedi.'}
          </p>
        </div>
        <dl className="sysadmin-hero-meta">
          <div>
            <dt>Son yenileme</dt>
            <dd>{lastUpdatedAt ? formatRelativeTime(lastUpdatedAt) : 'bilinmiyor'}{stale ? ' · bayat' : ''}</dd>
          </div>
          <div>
            <dt>Çalışma süresi</dt>
            <dd>{formatUptime(uptimeOf(components))}</dd>
          </div>
          <div>
            <dt>Ölçüm penceresi</dt>
            <dd>{api.windowMs ? `${Math.round(api.windowMs / 60000)} dakika` : '—'}</dd>
          </div>
        </dl>
        {error && (
          <p className="sysadmin-inline-error" role="status">
            <Icons.Alert size={13} aria-hidden="true" />
            Son yenileme başarısız ({error.code}). Ekrandaki bilgi son geçerli ölçüme aittir.
          </p>
        )}
      </section>

      <AdminSection
        title="Dikkat Gerektirenler"
        icon="Alert"
        description="Ağırlığa ve tazeliğe göre sıralanır. Çözülen koşullar listeden düşer."
        empty={attention.length === 0}
        emptyMessage="Açık bir sorun yok. Sağlıklı sistem sessizdir."
        emptyHint={overview?.alertsSchemaReady === false
          ? 'Uyarı tabloları bulunamadı; 0012 yükseltmesi uygulanmalıdır.'
          : null}
        className="sysadmin-attention"
      >
        <ul className="sysadmin-attention-list">
          {attention.map((item) => (
            <li key={item.id} className={`sysadmin-attention-item sysadmin-attention-${severityTone(item.severity)}`}>
              <div className="sysadmin-attention-head">
                <span className={`sysadmin-badge sysadmin-badge-${severityTone(item.severity)}`}>
                  {severityLabel(item.severity)}
                </span>
                <strong>{item.summary}</strong>
                {item.occurrenceCount > 1 && <span className="sysadmin-chip">×{item.occurrenceCount}</span>}
                <span className="sysadmin-attention-state">{item.active ? 'Sürüyor' : 'Kapandı'}</span>
              </div>
              <div className="sysadmin-attention-meta">
                <span>{item.component}</span>
                <span>İlk: {item.firstSeenAt ? formatRelativeTime(item.firstSeenAt) : '—'}</span>
                <span>Son: {item.lastSeenAt ? formatRelativeTime(item.lastSeenAt) : '—'}</span>
              </div>
              {item.action && <p className="sysadmin-attention-action"><Icons.Info size={12} aria-hidden="true" /> {item.action}</p>}
              <div className="sysadmin-attention-links">
                <button type="button" className="btn ghost sm" onClick={() => setDetail({ kind: 'attention', item })}>
                  Ayrıntı
                </button>
                <button type="button" className="btn ghost sm" onClick={() => onNavigate?.(item.tab, item.component)}>
                  İlgili sekmeyi aç <Icons.ArrowRight size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </AdminSection>

      <AdminSection
        title="Bileşen sağlığı"
        icon="Server"
        description="Ölçülemeyen bileşen sağlıklı sayılmaz; bilinmeyen ayrıca gösterilir."
        empty={components.length === 0}
        emptyMessage="Bileşen durumu alınamadı."
      >
        <div className="sysadmin-component-grid">
          {components.map((component) => (
            <button
              key={component.key}
              type="button"
              className={`sysadmin-component sysadmin-component-${healthTone(component.state)}`}
              onClick={() => setDetail({ kind: 'component', item: component })}
            >
              <span className="sysadmin-component-head">
                <HealthDot state={component.state} size={12} stale={component.stale} />
                <strong>{component.label}</strong>
              </span>
              <span className="sysadmin-component-message">{component.message}</span>
              <span className="sysadmin-component-meta">
                {component.durationMs != null && <span>{formatDuration(component.durationMs)}</span>}
                <span>Son başarı: {component.lastSuccessAt ? formatRelativeTime(component.lastSuccessAt) : 'bilinmiyor'}</span>
              </span>
            </button>
          ))}
        </div>
      </AdminSection>

      <AdminSection
        title="İşletim göstergeleri"
        icon="Chart"
        description="Son ölçüm penceresinden alınan özet; eğilimler süreç belleğindeki kovalardan çizilir."
      >
        <div className="sysadmin-tile-grid">
          <MetricTile label="API P95" value={api.p95Ms} unit="ms" icon="Clock" trend={trends.latencyP95}
            hint={api.count ? `${api.count} istek` : 'ölçüm yok'} />
          <MetricTile label="Hata oranı" value={api.errorRate} unit="ratio" icon="Alert" trend={trends.errorRate}
            trendColor="var(--status-overdue)" hint={api.errorCount ? `${api.errorCount} hata` : 'hata yok'} />
          <MetricTile label="Bekleyen Outlook" value={queue?.pending} unit="count" icon="Mail"
            trend={trends.queueDepth} onClick={() => onNavigate?.('kuyruklar', COMPONENTS.OUTLOOK)} />
          <MetricTile label="Hatalı teslimat" value={queue?.failed} unit="count" icon="Alert"
            tone={queue?.failed ? 'warn' : 'neutral'} onClick={() => onNavigate?.('kuyruklar', COMPONENTS.OUTLOOK)} />
          <MetricTile label="En eski bekleyen" icon="Clock" unit="count"
            value={overview?.outlook?.age?.oldestUnattemptedAt
              ? Math.round((Date.now() - new Date(overview.outlook.age.oldestUnattemptedAt).getTime()) / 60000)
              : 0}
            hint="dakika (hiç denenmemiş kayıt)" />
          <MetricTile label="Son CN43N eşitlemesi" icon="Database" unit="raw"
            value={wbs?.detail?.lastSyncedAt ? formatRelativeTime(wbs.detail.lastSyncedAt) : '—'} />
          <MetricTile label="Son hatırlatma turu" icon="MailCheck" unit="raw"
            value={reminder?.detail?.lastRun?.completedAt
              ? formatRelativeTime(reminder.detail.lastRun.completedAt)
              : reminder?.detail?.automaticEnabled ? 'henüz yok' : 'kapalı'} />
          <MetricTile label="Süreç belleği" icon="Layers" unit="raw"
            value={resources?.heapUsed != null ? formatBytes(resources.heapUsed) : '—'} trend={trends.memory} />
          <MetricTile label="Çalışma süresi" icon="Activity" unit="raw" value={formatUptime(uptimeOf(components))} />
        </div>
      </AdminSection>

      <AdminSection
        title="Son işletim olayları"
        icon="Bell"
        description="Bu sunucunun belleğindeki en yeni işletim satırları."
        empty={(overview?.feed || []).length === 0}
        emptyMessage="Bu sunucuda henüz işletim olayı kaydedilmedi."
      >
        <ul className="sysadmin-feed">
          {(overview?.feed || []).map((entry, index) => (
            <li key={`${entry.at}-${entry.code}-${index}`}>
              <span className={`sysadmin-dot sysadmin-dot-${severityTone(entry.severity)}`} aria-hidden="true" />
              <span className="sysadmin-feed-summary">{entry.summary}</span>
              <span className="sysadmin-feed-meta">{entry.component} · {formatRelativeTime(entry.at)}</span>
            </li>
          ))}
        </ul>
      </AdminSection>

      {detail && (
        <DetailDrawer
          title={detail.kind === 'component' ? detail.item.label : detail.item.summary}
          subtitle={detail.kind === 'component' ? detail.item.stateLabel : severityLabel(detail.item.severity)}
          onClose={() => setDetail(null)}
        >
          {detail.kind === 'component' ? (
            <div className="col" style={{ gap: 10 }}>
              <p className="sysadmin-drawer-message">{detail.item.message}</p>
              <DrawerField label="Bileşen" value={detail.item.key} mono />
              <DrawerField label="Durum" value={detail.item.stateLabel} />
              <DrawerField label="Son denetim" value={detail.item.lastCheckedAt} mono />
              <DrawerField label="Son başarılı işlem" value={detail.item.lastSuccessAt || 'bilinmiyor'} mono />
              <DrawerField label="Yanıt süresi" value={detail.item.durationMs != null ? formatDuration(detail.item.durationMs) : null} />
              {detail.item.detail && (
                <pre className="sysadmin-drawer-json">{JSON.stringify(detail.item.detail, null, 2)}</pre>
              )}
            </div>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <DrawerField label="Olay kodu" value={detail.item.code} mono />
              <DrawerField label="Bileşen" value={detail.item.component} mono />
              <DrawerField label="Ağırlık" value={severityLabel(detail.item.severity)} />
              <DrawerField label="İlk görülme" value={detail.item.firstSeenAt} mono />
              <DrawerField label="Son görülme" value={detail.item.lastSeenAt} mono />
              <DrawerField label="Yineleme" value={detail.item.occurrenceCount} mono />
              {detail.item.detail && <p className="sysadmin-drawer-message">{detail.item.detail}</p>}
              {detail.item.action && <p className="sysadmin-drawer-message"><Icons.Info size={12} /> {detail.item.action}</p>}
            </div>
          )}
        </DetailDrawer>
      )}
    </div>
  );
}
