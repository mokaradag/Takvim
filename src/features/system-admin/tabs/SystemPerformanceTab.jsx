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

/**
 * Birleştirilmiş yüzdelik KESİN değildir.
 *
 * Kovalar arası ağırlıklı ortalama, birleşik örneklerin gerçek yüzdeliği
 * değildir; değer bu yüzden "≈" ile sunulur ve kesin sanılmaz.
 */
function percentileText(value, approximate) {
  const text = formatDuration(value);
  return approximate && text !== '—' ? `≈ ${text}` : text;
}

/** Metin ve tarih dışındaki sütunlar sayısal karşılaştırılır. */
const TEXT_SORT_COLUMNS = new Set(['operation']);
const DATE_SORT_COLUMNS = new Set(['lastSeenAt']);

function sortableNumber(key, row) {
  const value = row?.[key];
  if (value == null || value === '') return null;
  const numeric = DATE_SORT_COLUMNS.has(key) ? new Date(value).getTime() : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function SystemPerformanceTab({ enabled = true }) {
  const [range, setRange] = useState('24h');
  const [sort, setSort] = useState({ key: 'p95Ms', direction: 'desc' });

  const loader = useCallback((options) => loadSystemPerformanceRequest(range, options), [range]);
  const resource = useAdminResource(loader, { intervalMs: PERFORMANCE_REFRESH_MS, enabled });
  const data = resource.data?.range?.id === range ? resource.data : null;

  const operations = useMemo(() => {
    const rows = [...(data?.operations || [])];
    const factor = sort.direction === 'asc' ? 1 : -1;
    return rows.sort((left, right) => {
      if (TEXT_SORT_COLUMNS.has(sort.key)) {
        return String(left[sort.key] ?? '').localeCompare(String(right[sort.key] ?? ''), 'tr') * factor;
      }
      const a = sortableNumber(sort.key, left);
      const b = sortableNumber(sort.key, right);
      // ÖLÇÜLEMEYEN değer sıfır sayılmaz: artan sıralamada ölçümsüz satırlar
      // gerçekten hızlı işlemlerin önüne geçerdi. Eksik değer her iki yönde de
      // sonda kalır.
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * factor;
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
  const approximate = summary.percentilesApproximate === true;
  // Hiç veri alınamadıysa "ölçülen işlem yok" DEĞİL, "alınamadı" gösterilir.
  const requestError = !data && resource.error
    ? `Başarım verisi alınamadı (${resource.error.code}). ${resource.error.message || ''}`.trim()
    : null;
  const bucketSeconds = Math.round((data?.range?.bucketMs || 300000) / 1000);

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

      <AdminSection
        title="Özet"
        icon="Activity"
        loading={resource.loading}
        error={requestError}
        description={approximate
          ? 'Yüzdelikler birden çok kovanın ağırlıklı ortalamasıdır; “≈” ile işaretli değerler yaklaşıktır.'
          : null}
      >
        <div className="sysadmin-tile-grid">
          <MetricTile label="İstek sayısı" value={summary.count} unit="count" icon="Table" />
          <MetricTile label="Hata oranı" value={summary.errorRate} unit="ratio" icon="Alert"
            tone={summary.errorRate > 0 ? 'warn' : 'neutral'}
            hint={baselineNarrative(data?.baseline?.errorRate, { unit: 'ratio' })} />
          <MetricTile label="Ortalama süre" value={summary.avgMs} unit="ms" icon="Clock" />
          <MetricTile label="P50" value={percentileText(summary.p50Ms, approximate)} unit="raw" icon="Clock" />
          <MetricTile label="P95" value={percentileText(summary.p95Ms, approximate)} unit="raw" icon="Clock"
            hint={baselineNarrative(data?.baseline?.p95, { unit: 'ms' })} />
          <MetricTile label="P99" value={percentileText(summary.p99Ms, approximate)} unit="raw" icon="Clock" />
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
          bucketSeconds={bucketSeconds}
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
            bucketSeconds={bucketSeconds}
            series={[{ id: 'error', label: 'Hata oranı', color: 'var(--status-overdue)', points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.errorRate })) }]}
          />
        </AdminSection>
        <AdminSection title="İstek hacmi" icon="TrendUp" loading={resource.loading}>
          <TrendChart
            label="İstek hacmi eğilimi"
            unit="count"
            bucketSeconds={bucketSeconds}
            series={[{ id: 'count', label: 'İstek', color: 'var(--c-cyan)', points: (data?.series || []).map((row) => ({ bucketStart: row.bucketStart, value: row.count })) }]}
          />
        </AdminSection>
        <AdminSection title={GAUGE_LABELS[GAUGE_KEYS.PROCESS_HEAP_USED]} icon="Layers" loading={resource.loading}>
          {/* Değerler BAYT'tır: birimsiz sayı olarak yazılırsa eksen ve nokta
              etiketleri okunamaz büyüklükte tam sayılar gösterir. */}
          <TrendChart
            label="Süreç belleği eğilimi"
            unit="bytes"
            bucketSeconds={bucketSeconds}
            series={[{ id: 'heap', label: 'Yığın', color: 'var(--c-purple)', points: gaugePoints(data?.gauges, GAUGE_KEYS.PROCESS_HEAP_USED) }]}
          />
        </AdminSection>
        {/* Kuyruk DERİNLİĞİ (kayıt) ile kuyruk YAŞI (dakika) aynı eksene
            çizilemez: ölçekleri birbirini bastırır ve eksen iki ayrı birimi
            temsil etmiş olurdu. İki ayrı grafik kullanılır. */}
        <AdminSection title={GAUGE_LABELS[GAUGE_KEYS.OUTLOOK_QUEUE_PENDING]} icon="Mail" loading={resource.loading}>
          <TrendChart
            label="Outlook kuyruk derinliği"
            unit="count"
            bucketSeconds={bucketSeconds}
            series={[
              { id: 'pending', label: 'Bekleyen kayıt', color: 'var(--accent)', points: gaugePoints(data?.gauges, GAUGE_KEYS.OUTLOOK_QUEUE_PENDING) }
            ]}
          />
        </AdminSection>
        <AdminSection title={GAUGE_LABELS[GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES]} icon="Clock" loading={resource.loading}>
          <TrendChart
            label="Outlook kuyruğunda en eski bekleyen kaydın yaşı"
            unit="minutes"
            bucketSeconds={bucketSeconds}
            series={[
              { id: 'oldest', label: 'En eski (dk)', color: 'var(--status-blocked)', points: gaugePoints(data?.gauges, GAUGE_KEYS.OUTLOOK_QUEUE_OLDEST_MINUTES) }
            ]}
          />
        </AdminSection>
      </div>

      <AdminSection
        title="Yavaş İşlemler"
        icon="Table"
        description="Ortalama gecikmeye göre en yavaş işlemler. Başlığa tıklayarak sıralayın."
        loading={resource.loading}
        error={requestError}
        empty={!resource.loading && !requestError && operations.length === 0}
        emptyMessage="Bu aralıkta ölçülen işlem yok."
      >
        <div className="sysadmin-table-wrap">
          {/* Tabloya ERİŞİLEBİLİR AD verilir; ekran okuyucu kullanıcısı sayfadaki
              öteki tablolardan ayırabilmelidir. */}
          <table className="tbl sysadmin-table" aria-label="Yavaş işlemler">
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
                  <td className="tabular" style={{ textAlign: 'right' }}>{percentileText(row.p50Ms, row.percentilesApproximate)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{percentileText(row.p95Ms, row.percentilesApproximate)}</td>
                  <td className="tabular" style={{ textAlign: 'right' }}>{percentileText(row.p99Ms, row.percentilesApproximate)}</td>
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
