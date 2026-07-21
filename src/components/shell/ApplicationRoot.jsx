'use client';
import { AppStateProvider } from '../../state/AppStateProvider';
import AppShell from './AppShell';

export default function ApplicationRoot() {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  );
}
