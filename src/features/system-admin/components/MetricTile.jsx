'use client';
import { Sparkline } from '../../../components/ui';
import { Icons } from '../../../components/icons';
import { formatMetricValue } from '../systemAdminPresentation.js';

/**
 * İşletim göstergesi kutucuğu.
 *
 * Kutucuk KOMPAKTTIR: tek sayı için koca bir kart ayrılmaz. Eğilim yalnızca
 * anlamlı olduğunda (en az iki ölçüm) çizilir; ölçülemeyen değer "—" gösterilir
 * ve sıfır gibi okunmaz.
 */
export function MetricTile({
  label,
  value,
  unit = 'count',
  hint = null,
  tone = 'neutral',
  trend = null,
  trendColor = 'var(--accent)',
  icon = null,
  onClick = null
}) {
  const Icon = icon ? Icons[icon] : null;
  // Ölçülmemiş kovalar eğilimden DÜŞÜRÜLÜR; sıfır olarak çizilmez.
  const points = (trend || [])
    .filter((point) => point?.value != null)
    .map((point) => Number(point.value))
    .filter(Number.isFinite);
  const content = (
    <>
      <span className="sysadmin-tile-label">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </span>
      <span className="sysadmin-tile-value">{formatMetricValue(value, unit)}</span>
      {points.length > 1 && (
        <span className="sysadmin-tile-trend" aria-hidden="true">
          <Sparkline values={points} color={trendColor} width={92} height={22} />
        </span>
      )}
      {hint && <span className="sysadmin-tile-hint">{hint}</span>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`sysadmin-tile sysadmin-tile-${tone} is-clickable`} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={`sysadmin-tile sysadmin-tile-${tone}`}>{content}</div>;
}
