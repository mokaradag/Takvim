'use client';
import { Icons } from '../../components/icons';
import { HEALTH_STATES, normalizeHealthState } from '../../domain/observability/healthModel.js';
import { COMPONENTS } from '../../domain/observability/eventModel.js';
import { formatRelativeTime } from '../../domain/observability/metrics.js';
import { HealthDot } from './components/HealthDot.jsx';
import { healthNarrative, healthTone, stalenessNotice } from './systemAdminPresentation.js';

/**
 * Kalıcı sistem sağlığı şeridi.
 *
 * Hangi sekme açık olursa olsun üstte durur ve tek bakışta şunu söyler:
 * genel durum, kaç bileşen sağlıklı, kaç uyarı ve kritik var, bilgi ne zaman
 * tazelendi, bayat mı. Sorunlu bir bileşene tıklamak ilgili sekmeye götürür.
 */

/** Şeritte kısayol olarak gösterilen çekirdek bileşenler. */
const STRIP_COMPONENTS = [
  { key: COMPONENTS.DATABASE, short: 'SQL' },
  { key: COMPONENTS.CORPORATE_WBS, short: 'CN43N' },
  { key: COMPONENTS.SMTP, short: 'SMTP' },
  { key: COMPONENTS.OUTLOOK, short: 'Outlook' },
  { key: COMPONENTS.AUTHENTICATION, short: 'Kimlik' }
];

export function SystemHealthStrip({
  overview = null,
  stale = false,
  error = null,
  lastUpdatedAt = null,
  refreshing = false,
  onRefresh,
  onNavigate
}) {
  const state = normalizeHealthState(overview?.state);
  const counts = overview?.counts || {};
  const notice = stalenessNotice({ stale, lastUpdatedAt, error });
  const byKey = new Map((overview?.components || []).map((component) => [component.key, component]));

  return (
    <div className={`sysadmin-strip sysadmin-strip-${healthTone(state)}`} data-state={state}>
      <div className="sysadmin-strip-main">
        <HealthDot state={overview ? state : HEALTH_STATES.UNKNOWN} size={15} />
        {/* Yalnızca durum DEĞİŞİMİ duyurulur; her yenileme okuyucuyu meşgul etmez. */}
        <span className="sysadmin-strip-narrative" role="status" aria-live="polite">
          {overview ? healthNarrative({ state, counts, attentionCount: overview.attention?.length || 0 })
            : 'Sistem durumu henüz alınmadı.'}
        </span>
      </div>

      <div className="sysadmin-strip-components">
        {STRIP_COMPONENTS.map(({ key, short }) => {
          const component = byKey.get(key);
          const componentState = normalizeHealthState(component?.state);
          const problem = componentState === HEALTH_STATES.WARNING || componentState === HEALTH_STATES.CRITICAL
            || componentState === HEALTH_STATES.UNKNOWN;
          return (
            <button
              key={key}
              type="button"
              className={`sysadmin-strip-chip sysadmin-strip-chip-${healthTone(componentState)}`}
              onClick={() => onNavigate?.(component?.tab, key)}
              title={component ? `${component.label}: ${component.message}` : `${short}: durum bilinmiyor`}
              aria-label={`${component?.label || short} durumu: ${component?.stateLabel || 'Bilinmiyor'}${problem ? ', ayrıntı için seçin' : ''}`}
            >
              <HealthDot state={componentState} label={short} size={11} compact />
            </button>
          );
        })}
        <span className="sysadmin-strip-counts">
          <span className="sysadmin-strip-count sysadmin-strip-count-crit">{counts.critical || 0} kritik</span>
          <span className="sysadmin-strip-count sysadmin-strip-count-warn">{counts.warning || 0} uyarı</span>
        </span>
      </div>

      <div className="sysadmin-strip-refresh">
        {notice
          ? <span className="sysadmin-strip-stale"><Icons.Alert size={12} aria-hidden="true" /> {notice}</span>
          : <span className="sysadmin-strip-updated">
            Son yenileme: {lastUpdatedAt ? formatRelativeTime(lastUpdatedAt) : 'henüz yok'}
          </span>}
        <button
          type="button"
          className="btn ghost sm"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Sistem durumunu şimdi yenile"
        >
          <Icons.Refresh size={13} className={refreshing ? 'sysadmin-spin' : ''} />
          {refreshing ? 'Yenileniyor' : 'Yenile'}
        </button>
      </div>
    </div>
  );
}
