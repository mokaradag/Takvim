'use client';
import { AppStateProvider } from '../../state/AppStateProvider';
import AppShell from './AppShell';
import { AppDataBoundary } from './AppDataBoundary';
import { PersistenceStatus } from './PersistenceStatus';

export default function ApplicationRoot() {
  return (
    <AppStateProvider>
      <AppDataBoundary>
        <AppShell />
        <PersistenceStatus />
      </AppDataBoundary>
    </AppStateProvider>
  );
}
