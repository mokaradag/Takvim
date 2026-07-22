'use client';
import { AppStateProvider } from '../../state/AppStateProvider';
import AppShell from './AppShell';
import { AppDataBoundary } from './AppDataBoundary';
import { PersistenceStatus } from './PersistenceStatus';
import { PresentationPolish } from './PresentationPolish';

export default function ApplicationRoot() {
  return (
    <AppStateProvider>
      <AppDataBoundary>
        <PresentationPolish />
        <AppShell />
        <PersistenceStatus />
      </AppDataBoundary>
    </AppStateProvider>
  );
}
