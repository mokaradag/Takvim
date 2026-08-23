'use client';
import { createContext, useContext } from 'react';
import { DATA_MODES } from '../../data/dataMode.js';

export const DataModeContext = createContext({
  dataMode: DATA_MODES.DEMO,
  async setDataMode() {}
});

export function useDataMode() {
  return useContext(DataModeContext);
}
