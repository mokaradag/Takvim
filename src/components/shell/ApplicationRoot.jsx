'use client';
import { useEffect, useMemo, useState } from 'react';
import { AppStateProvider } from '../../state/AppStateProvider';
import { DATA_MODES, DATA_MODE_STORAGE_KEY, createRepositoryForDataMode } from '../../data/dataMode';
import AppShell from './AppShell';
import { AppDataBoundary } from './AppDataBoundary';
import { DataModeChooser } from './DataModeChooser';
import { DataModeContext } from './DataModeContext';
import { DataModeIndicator } from './DataModeIndicator';
import { PersistenceStatus } from './PersistenceStatus';
import { PresentationPolish } from './PresentationPolish';

function readInitialDataMode() {
  try {
    const value = localStorage.getItem(DATA_MODE_STORAGE_KEY);
    return value === DATA_MODES.DEMO || value === DATA_MODES.ACTUAL ? value : null;
  } catch {
    return null;
  }
}

export default function ApplicationRoot() {
  const [dataMode, setDataModeState] = useState(null);
  const repository = useMemo(() => dataMode ? createRepositoryForDataMode(dataMode) : null, [dataMode]);

  useEffect(() => {
    setDataModeState(readInitialDataMode());
  }, []);

  const setDataMode = async (nextMode) => {
    if (nextMode !== DATA_MODES.DEMO && nextMode !== DATA_MODES.ACTUAL) return;
    try { localStorage.setItem(DATA_MODE_STORAGE_KEY, nextMode); } catch {}
    setDataModeState(nextMode);
  };

  if (!dataMode) return <DataModeChooser onChoose={setDataMode} />;

  return (
    <DataModeContext.Provider value={{ dataMode, setDataMode }}>
      <AppStateProvider key={dataMode} repository={repository}>
        <DataModeIndicator />
        <AppDataBoundary>
          <PresentationPolish />
          <AppShell />
          <PersistenceStatus />
        </AppDataBoundary>
      </AppStateProvider>
    </DataModeContext.Provider>
  );
}
