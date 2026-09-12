'use client';
import { useId, useMemo, useState } from 'react';
import { formatMetricValue } from '../systemAdminPresentation.js';

/**
 * Zaman serisi grafiği — bağımlılıksız SVG.
 *
 * Kurumsal kurulumda dış CDN ya da grafik kitaplığı YOKTUR; grafik saf SVG ile
 * çizilir. Eksenler birim taşır, boş ve KISMİ veri açıkça gösterilir: ölçüm
 * bulunmayan kovalarda çizgi kesilir, sıfıra düşürülmez.
 */

const PADDING = { top: 12, right: 12, bottom: 22, left: 46 };

function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max === min) return [min, min + 1];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (unused, index) => min + step * index);
}

function timeLabel(value, bucketSeconds) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return bucketSeconds >= 6 * 3600
    ? date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' })
    : date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

export function TrendChart({
  series = [],
  unit = 'ms',
  height = 190,
  width = 720,
  bucketSeconds = 300,
  emptyMessage = 'Bu aralıkta ölçüm toplanmadı.',
  label = 'Zaman serisi grafiği'
}) {
  const gradientId = `trend-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [hover, setHover] = useState(null);

  const model = useMemo(() => {
    const points = series.flatMap((entry) => entry.points || []);
    // `Number(null)` sıfırdır: ölçülmemiş kova sıfır değer gibi ele alınmamalıdır.
    const values = points
      .filter((point) => point.value != null)
      .map((point) => Number(point.value))
      .filter((value) => Number.isFinite(value));
    const timestamps = [...new Set(points.map((point) => new Date(point.bucketStart).getTime()))]
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    if (!values.length || timestamps.length < 2) return null;
    const min = Math.min(0, ...values);
    const max = Math.max(...values) * 1.08 || 1;
    return { min, max, timestamps, first: timestamps[0], last: timestamps[timestamps.length - 1] };
  }, [series]);

  if (!model) {
    return (
      <div className="sysadmin-chart sysadmin-chart-empty" role="img" aria-label={`${label}: veri yok`}>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const innerW = width - PADDING.left - PADDING.right;
  const innerH = height - PADDING.top - PADDING.bottom;
  const span = Math.max(1, model.last - model.first);
  const xOf = (timestamp) => PADDING.left + ((timestamp - model.first) / span) * innerW;
  const yOf = (value) => PADDING.top + innerH - ((value - model.min) / (model.max - model.min || 1)) * innerH;

  const ticks = niceTicks(model.min, model.max);
  const hoveredAt = hover == null ? null : model.timestamps[hover];

  const onMove = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / bounds.width;
    const target = model.first + ratio * span;
    let best = 0;
    let distance = Infinity;
    model.timestamps.forEach((timestamp, index) => {
      const delta = Math.abs(timestamp - target);
      if (delta < distance) { distance = delta; best = index; }
    });
    setHover(best);
  };

  return (
    <div className="sysadmin-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <line
            key={tick}
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={yOf(tick)}
            y2={yOf(tick)}
            className="sysadmin-chart-gridline"
          />
        ))}
        {series.map((entry, entryIndex) => {
          // Ölçümü olmayan kovada çizgi KESİLİR; eksik veri sıfır gibi çizilmez.
          const segments = [];
          let current = [];
          for (const point of entry.points || []) {
            const value = point.value == null ? Number.NaN : Number(point.value);
            const timestamp = new Date(point.bucketStart).getTime();
            if (!Number.isFinite(value) || !Number.isFinite(timestamp)) {
              if (current.length) segments.push(current);
              current = [];
              continue;
            }
            current.push(`${xOf(timestamp).toFixed(1)},${yOf(value).toFixed(1)}`);
          }
          if (current.length) segments.push(current);
          return segments.map((segment, index) => (
            <polyline
              key={`${entry.id}-${index}`}
              points={segment.join(' ')}
              fill="none"
              stroke={entry.color || 'var(--accent)'}
              strokeWidth={entryIndex === 0 ? 2 : 1.5}
              strokeDasharray={entry.dashed ? '4 3' : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
              className="sysadmin-chart-line"
            />
          ));
        })}
        {hoveredAt != null && (
          <line
            x1={xOf(hoveredAt)}
            x2={xOf(hoveredAt)}
            y1={PADDING.top}
            y2={PADDING.top + innerH}
            className="sysadmin-chart-cursor"
          />
        )}
      </svg>
      <div className="sysadmin-chart-axis-y" aria-hidden="true">
        {[...ticks].reverse().map((tick) => (
          <span key={tick}>{formatMetricValue(tick, unit)}</span>
        ))}
      </div>
      <div className="sysadmin-chart-axis-x" aria-hidden="true">
        <span>{timeLabel(model.first, bucketSeconds)}</span>
        <span>{timeLabel(model.last, bucketSeconds)}</span>
      </div>
      {hoveredAt != null && (
        <div className="sysadmin-chart-tip" role="status">
          <strong>{new Date(hoveredAt).toLocaleString('tr-TR')}</strong>
          {series.map((entry) => {
            const point = (entry.points || []).find((item) => new Date(item.bucketStart).getTime() === hoveredAt);
            return (
              <span key={entry.id}>
                <i style={{ background: entry.color || 'var(--accent)' }} aria-hidden="true" />
                {entry.label}: {formatMetricValue(point?.value, unit)}
              </span>
            );
          })}
        </div>
      )}
      <div className="sysadmin-chart-legend">
        {series.map((entry) => (
          <span key={entry.id}>
            <i style={{ background: entry.color || 'var(--accent)' }} aria-hidden="true" />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
