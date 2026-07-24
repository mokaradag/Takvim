'use client';
import { useState } from 'react';
import { useAppState } from '../../state/AppStateProvider';
import { useDataMode } from './DataModeContext';

export function DataModeIndicator() {
  const { dataMode, setDataMode } = useDataMode();
  const { actions } = useAppState();
  const [switching, setSwitching] = useState(false);
  const nextMode = dataMode === 'demo' ? 'actual' : 'demo';
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
    <div className={`data-mode-indicator data-mode-${dataMode}`} aria-label={`Veri modu: ${dataMode === 'demo' ? 'Demo' : 'Gerçek Sistem'}`}>
      <strong>{dataMode === 'demo' ? 'DEMO' : 'GERÇEK SİSTEM'}</strong>
      <button type="button" onClick={switchMode} disabled={switching}>
        {switching ? 'Geçiliyor…' : nextMode === 'demo' ? 'Demo Moduna Geç' : 'Gerçek Sisteme Geç'}
      </button>
    </div>
  );
}
