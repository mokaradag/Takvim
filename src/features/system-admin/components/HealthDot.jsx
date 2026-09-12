'use client';
import { Icons } from '../../../components/icons';
import { HEALTH_STATES, healthLabel, normalizeHealthState } from '../../../domain/observability/healthModel.js';
import { healthTone } from '../systemAdminPresentation.js';

/**
 * Durum göstergesi.
 *
 * Durum YALNIZCA renkle anlatılmaz: her göstergede simge ve metin karşılığı
 * bulunur, böylece renk ayrımı olmayan kullanıcılar da durumu okuyabilir.
 */
const STATE_ICON = {
  [HEALTH_STATES.HEALTHY]: Icons.Check,
  [HEALTH_STATES.WARNING]: Icons.Alert,
  [HEALTH_STATES.CRITICAL]: Icons.Alert,
  [HEALTH_STATES.UNKNOWN]: Icons.Help,
  [HEALTH_STATES.NOT_CONFIGURED]: Icons.Circle
};

export function HealthDot({ state, label = null, size = 12, stale = false, compact = false }) {
  const normalized = normalizeHealthState(state);
  const Icon = STATE_ICON[normalized] || Icons.Help;
  const text = label ?? healthLabel(normalized);
  return (
    <span className={`sysadmin-state sysadmin-state-${healthTone(normalized)}${compact ? ' is-compact' : ''}`}>
      <Icon size={size} aria-hidden="true" />
      <span className="sysadmin-state-label">{text}</span>
      {stale && <span className="sysadmin-state-stale" title="Görüntülenen bilgi bayatladı">bayat</span>}
    </span>
  );
}
