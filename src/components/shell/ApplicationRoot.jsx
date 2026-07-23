'use client';
import { useMemo, useState } from 'react';
import { AppStateProvider } from '../../state/AppStateProvider';
import { DATA_MODES, DATA_MODE_STORAGE_KEY, DataModeContext, createRepositoryForDataMode } from '../../data/dataMode';
import AppShell from './AppShell';
import { AppDataBoundary } from './AppDataBoundary';
import { DataModeChooser } from './DataModeChooser';
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
  const [dataMode, setDataModeState] = useState(readInitialDataMode);
  const repository = useMemo(() => dataMode ? createRepositoryForDataMode(dataMode) : null, [dataMode]);

  const setDataMode = async (nextMode) => {
    if (nextMode !== DATA_MODES.DEMO && nextMode !== DATA_MODES.ACTUAL) return;
    if (repository?.flush) await repository.flush();
    try { localStorage.setItem(DATA_MODE_STORAGE_KEY, nextMode); } catch {}
    setDataModeState(nextMode);
  };

  if (!dataMode) return <DataModeChooser onChoose={setDataMode} />;

  return (
    <DataModeContext.Provider value={{ dataMode, setDataMode }}>
      <AppStateProvider key={dataMode} repository={repository}>
        <AppDataBoundary>
          <PresentationPolish />
          <AppShell />
          <PersistenceStatus />
        </AppDataBoundary>
      </AppStateProvider>
    </DataModeContext.Provider>
  );
}
