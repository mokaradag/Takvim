'use client';
import { useCallback, useMemo, useState } from 'react';
import { Icons } from '../../../components/icons';
import { GAUGE_KEYS, GAUGE_LABELS, TIME_RANGES, formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../../../domain/observability/metrics.js';
import { AdminSection } from '../components/AdminSection.jsx';
import { MetricTile } from '../components/MetricTile.jsx';
import { TrendChart } from '../components/TrendChart.jsx';
import { baselineNarrative, stalenessNotice } from '../systemAdminPresentation.js';
import { loadSystemPerformanceRequest } from '../systemAdminClient.js';
import { useAdminResource } from '../useAdminResource.js';

/**
 * Performans.
 *
 * Geçmiş SQL'de saklanır; grafikler sayfa açıkken biriken geçici bir diziden
 * değil, kalıcı toplamlardan çizilir. Aralık sunucuda sınırlanır ve bu sekme
 * genel bakıştan DAHA SEYREK yenilenir: maliyetli veri, yalnızca bakılırken ve
 * ölçülü sıklıkta okunur.
 */
const PERFORMANCE_REFRESH_MS = 60000;

const SORTABLE_COLUMNS = [
  { id: 'operation', label: 'İşlem', align: 'left' },
  { id: 'count', label: 'Sayı', align: 'right' },
  { id: 'p50Ms', label: 'P50', align: 'right' },
  { id: 'p95Ms', label: 'P95', align: 'right' },
  { id: 'p99Ms', label: 'P99', align: 'right' },
  { id: 'errorRate', label: 'Hata oranı', align: 'right' },
  { id: 'lastSeenAt', label: 'Son görülme', align: 'right' }
];

function gaugePoints(gauges, key) {
  return (gauges?.[key] || []).map((point) => ({ bucketStart: point.bucketStart, value: point.value }));
}

function resourceValue(metric, format) {
  if (!metric?.available) return 'ölçülemiyor';
  return format(metric.value);
}

export function SystemPerformanceTab({ enabled = true }) {
  const [range, setRange] = useState('24h');
  const [sort, setSort] = useState({ key: 'p95Ms', direction: 'desc' });

  const loader = useCallback((options) => loadSystemPerformanceRequest(range, options), [range]);
  const resource = useAdminResource(loader, { intervalMs: PERFORMANCE_REFRESH_MS, enabled });
  const data = resource.data;

  const operations = useMemo(() => {
    const rows = [...(data?.operations || [])];
    const factor = sort.direction === 'asc' ? 1 : -1;
    return rows.sort((left, right) => {
      const a = left[sort.key];
      const b = right[sort.key];
      if (typeof a === 'string' || typeof b === 'string') {
        return String(a ?? '').localeCompare(String(b ?? ''), 'tr') * factor;
      }
      return ((Number(a) || 0) - (Number(b) || 0)) * factor;
    });
  }, [data, sort]);

  if (!enabled) {
    return (
      <AdminSection
        title="Başarım ölçümleri"
        icon="Chart"
        empty
        emptyMessage="Demo Kipinde üretim başarım verisi okunmaz."
        emptyHint="Gerçek Sistem verisine geçerek P50/P95/P99, hata oranı ve kaynak eğilimlerini görüntüleyin."
      />
    );
  }

  const notice = stalenessNotice({ stale: resource.stale, lastUpdatedAt: resource.lastUpdatedAt, error: resource.error });
  const summary = data?.summary || {};
  const resources = data?.resources || {};

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="sysadmin-toolbar">
        <div className="seg sysadmin-range" role="group" aria-label="Zaman aralığı">
          {Object.values(TIME_RANGES).map((option) => (
            <button
              key={option.id}
              type="button"
              className={range === option.id ? 'active' : ''}
              aria-pressed={range === option.id}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="sysadmin-toolbar-right">
          {notice && <span className="sysadmin-stale-note">{notice}</span>}
          <button type="button" className="btn ghost sm" onClick={resource.refresh} disabled={resource.refreshing}>
            <Icons.Refresh size={13} className={resource.refreshing ? 'sysadmin-spin' : ''} /> Yenile
          </button>
        </div>
      </div>

      {data?.schemaReady === false && (
        <div className="card sysadmin-warning" role="status">
          <Icons.Database size={14} aria-hidden="true" />
          Telemetri tabloları bulunamadı. <code>database/MR_Upgrade_0012_System_Observability.sql</code> betiği
          çalıştırılana kadar geçmiş eğilim saklanmaz; yalnızca bu sürecin belleğindeki özet gösterilir.
        </div>
      )}

      <AdminSection title="Özet" icon="Activity" loading={resource.loading}>
        <div className="sysadmin-tile-grid">
          <MetricTile label="İstek sayısı" value={summary.count} unit="count" icon="Table" />
          <MetricTile label="Hata oranı" value={summary.errorRate} unit="ratio" icon="Alert"
            tone={summary.errorRate > 0 ? 'warn' : 'neutral'}
            hint={baselineNarrative(data?.baseline?.errorRate, { unit: 'ratio' })} />
          <MetricTile label="Ortalama süre" value={summary.avgMs} unit="ms" icon="Clock" />
          <MetricTile label="P50" value={summary.p50Ms} unit="ms" icon="Clock" />
          <MetricTile label="P95" value={summary.p95Ms} unit="ms" icon="Clock"
            hint={baselineNarrative(data?.baseline?.p95, { unit: 'ms' })} />
          <MetricTile label="P99" value={summary.p99Ms} unit="ms" icon="Clock" />
          <MetricTile label="En yavaş gözlem" value={summary.maxMs} unit="ms" icon="TrendUp" />
          <MetricTile label="Güncel pencere" value={data?.live?.p95Ms} unit="ms" icon="Activity"
            hint={data?.live?.count ? `${data.live.count} istek (son 15 dk)` : 'son 15 dakikada istek yok'} />
        </div>
      </AdminSection>

      <AdminSection
        title="Yanıt süresi dağılımı"
        icon="Chart"
        description="Kovalar arası yüzdelikler ağırlıklı ortalamadır; kesin değer güncel pencerede hesaplanır."
        loading={resource.loading}
      >
        <TrendChart
          label="P50, P95 ve P99 yanıt süresi"
          unit="ms"
          bucketSeconds={Math.round((data?.range?.bucketMs || 300000) / 1000)}
          series={[
            { id: 'p95', label: 'P95', color: 'var(--accent)', points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.p95Ms })) },
            { id: 'p50', label: 'P50', color: 'var(--status-done)', points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.p50Ms })) },
            { id: 'p99', label: 'P99', color: 'var(--status-blocked)', dashed: true, points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.p99Ms })) }
          ]}
        />
      </AdminSection>

      <div className="sysadmin-chart-grid">
        <AdminSection title="Hata oranı" icon="Alert" loading={resource.loading}>
          <TrendChart
            label="Hata oranı eğilimi"
            unit="ratio"
            bucketSeconds={Math.round((data?.range?.bucketMs || 300000) / 1000)}
            series={[{ id: 'error', label: 'Hata oranı', color: 'var(--status-overdue)', points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.errorRate })) }]}
          />
        </AdminSection>
        <AdminSection title="İstek hacmi" icon="TrendUp" loading={resource.loading}>
          <TrendChart
            label="İstek hacmi eğilimi"
            unit="count"
            bucketSeconds={Math.round((data?.range?.bucketMs || 300000) / 1000)}
            series={[{ id: 'count', label: 'İstek', color: 'var(--c-cyan)', points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.count })) }]}
          />
        </AdminSection>
        <AdminSection title={GAUGE_LABELS[GAUGE_KEYS.PROCESS_HEAP_USED]} icon="Layers" loading={resource.loading}>
          <TrendChart
            label="Süreç belleği eğilimi"
            unit="count"
            bucketSeconds={Math.round((data?.range?.bucketMs || 300000) / 1000)}
            series={[{ id: 'heap', label: 'Yığın (bayt)', color: 'var(--c-purple)', points: gaugePoints(data?.gauges, GAUGE_KEYS.PROCESS_HEAP_USED) }]}
          />
        </AdminSection>
        <AdminSection title={GAUGE_LABELS[GAUGE_KEYS.OUTLOOK_QUEUE_PENDING]} icon="Mail" loading={resource.loading}>
          <TrendChart
            label="Outlook kuyruk derinliği"
            unit="count"
            bucketSeconds={Math.round((data?.range?.bucketMs || 300000) / 1000)}
            series={[
              { id: 'pending', label: 'Bekleyen', color: 'var(--accent)', points: gaugePoints(data?.gauges, GAUGE_KEYS.OUTLOOK_QUEUE_PENDING) },
              { id: 'oldest', label: 'En eski (dk)', color: 'var(--status-blocked)', dashed: true, points: gaugePoints(data?.gauges, GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES) }
            ]}
          />
        </AdminSection>
      </div>

      <AdminSection
        title="Yavaş İşlemler"
        icon="Table"
        description="Toplam süreye göre en maliyetli işlemler. Başlığa tıklayarak sıralayın."
        loading={resource.loading}
        empty={!resource.loading && operations.length === 0}
        emptyMessage="Bu aralıkta ölçülen işlem yok."
      >
        <div className="sysadmin-table-wrap">
          <table className="tbl sysadmin-table">
            <thead>
              <tr>
                {SORTABLE_COLUMNS.map((column) => (
                  <th key={column.id} style={{ textAlign: column.align }} aria-sort={sort.key === column.id ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button
                      type="button"
                      className="sysadmin-sort-btn"
                      onClick={() => setSort((current) => ({
                        key: column.id,
                        direction: current.key === column.id && current.direction === 'desc' ? 'asc' : 'desc'
                      }))}
                    >
                      {column.label}
                      {sort.key === column.id && (sort.direction === 'asc' ? <Icons.ChevronUp size={11} /> : <Icons.ChevronDown size={11} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {operations.map((row) => (
                <tr key={row.operation}>
                  <td className="sysadmin-op-name">{row.operation}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{row.count}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{formatDuration(row.p50Ms)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{formatDuration(row.p95Ms)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{formatDuration(row.p99Ms)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{formatPercent(row.errorRate)}</td>
                  <td className="muted" style={{ textAlign: 'right' }}>{row.lastSeenAt ? formatRelativeTime(row.lastSeenAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminSection>

      <AdminSection
        title="Süreç ve sunucu kaynakları"
        icon="Server"
        description="Bu platformda ölçülemeyen değerler uydurulmaz; açıkça “ölçülemiyor” yazar."
        loading={resource.loading}
      >
        <div className="sysadmin-resource-grid">
          <ResourceRow label="Çalışma zamanı" value={resources.runtimeVersion || 'bilinmiyor'} />
          <ResourceRow label="Platform" value={resources.platform || 'bilinmiyor'} />
          <ResourceRow label="Süreç belleği (RSS)" value={resourceValue(resources.rss, formatBytes)} />
          <ResourceRow label="Kullanılan yığın" value={resourceValue(resources.heapUsed, formatBytes)} />
          <ResourceRow label="Yığın toplamı" value={resourceValue(resources.heapTotal, formatBytes)} />
          <ResourceRow label="Yığın kullanım oranı" value={resourceValue(resources.heapUsedRatio, formatPercent)} />
          <ResourceRow label="Süreç CPU kullanımı" value={resourceValue(resources.cpuPercent, (value) => `%${value.toFixed(1)}`)} />
          <ResourceRow label="Olay döngüsü gecikmesi" value={resourceValue(resources.eventLoopDelayMs, formatDuration)} />
          <ResourceRow label="Sunucu yük ortalaması" value={resourceValue(resources.hostLoadAverage, (value) => value.toFixed(2))} />
          <ResourceRow label="Sunucu belleği kullanımı" value={resourceValue(resources.hostMemory?.usedRatio, formatPercent)} />
        </div>
      </AdminSection>
    </div>
  );
}

function ResourceRow({ label, value }) {
  return (
    <div className="sysadmin-resource-row">
      <span>{label}</span>
      <strong className="tabular">{value}</strong>
    </div>
  );
}
