'use client';
import { useState } from 'react';
import { Icons } from '../icons';
import { useAppState } from '../../state/AppStateProvider';
import { useDataMode } from './DataModeContext';

const MODE_COPY = Object.freeze({
  demo: { label: 'Demo', hint: 'Örnek veri', icon: 'Sparkle' },
  actual: { label: 'Gerçek Sistem', hint: 'Kurumsal SQL Server', icon: 'Database' }
});

/**
 * Veri modu anahtarı. `variant="sidebar"` kenar çubuğu altbilgisine gömülür;
 * `variant="floating"` yalnızca uygulama kabuğu render edilemediğinde
 * (yükleme/hata ekranları) kullanılır. Böylece anahtar, kaydetme bildirimlerinin
 * bulunduğu sağ alt köşeyi artık işgal etmez.
 */
export function DataModeIndicator({ variant = 'sidebar' }) {
  const { dataMode, setDataMode } = useDataMode();
  const { actions } = useAppState();
  const [switching, setSwitching] = useState(false);
  const nextMode = dataMode === 'demo' ? 'actual' : 'demo';
  const current = MODE_COPY[dataMode] || MODE_COPY.demo;
  const next = MODE_COPY[nextMode];
  const CurrentIcon = Icons[current.icon] || Icons.Database;

  const switchMode = async () => {
    setSwitching(true);
    try {
      const flushResult = await actions.flushPendingChanges();
      if (!flushResult?.ok) return;
      await setDataMode(nextMode);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div
      className={`data-mode-indicator data-mode-variant-${variant} data-mode-${dataMode}`}
      aria-label={`Veri modu: ${current.label}`}
    >
      <span className="data-mode-current">
        <CurrentIcon size={13} />
        <span className="data-mode-current-copy">
          <strong>{current.label}</strong>
          <small>{current.hint}</small>
        </span>
      </span>
      <button type="button" onClick={switchMode} disabled={switching} title={`${next.label} moduna geç`}>
        {switching ? 'Geçiliyor…' : `${next.label} moduna geç`}
      </button>
    </div>
  );
}
