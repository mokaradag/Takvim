'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { DATA_MODES } from '../../data/dataMode.js';
import { useDataMode } from '../../components/shell/DataModeContext.jsx';
import {
  ensureOutlookState,
  getOutlookSnapshot,
  setOutlookDataMode,
  subscribeToOutlookStore
} from './outlookSubscriptionStore.js';

/**
 * Outlook abonelik durumunu okur ve ilk kullanımda yükler.
 *
 * Durum ORTAK depodadır: görev tablosu ve görev paneli aynı kümeyi görür, bir
 * yerde eklenen görev ötekinde de "eklendi" görünür.
 */
export function useOutlookCalendar() {
  const { dataMode } = useDataMode();
  const actualDataMode = dataMode === DATA_MODES.ACTUAL;
  const state = useSyncExternalStore(subscribeToOutlookStore, getOutlookSnapshot, getOutlookSnapshot);

  useEffect(() => {
    // Demo Kipte hiçbir istek yapılmaz: gerçek posta gönderimi yalnızca Gerçek
    // Sistem verisiyle çalışır.
    setOutlookDataMode(actualDataMode ? 'actual' : 'demo');
    if (!actualDataMode) return;
    if (getOutlookSnapshot().status !== 'ready') ensureOutlookState();
  }, [actualDataMode]);

  return { state, actualDataMode };
}
