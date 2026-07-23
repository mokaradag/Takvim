'use client';
import { createContext, useContext } from 'react';
import { assertAppRepository } from './contracts/appRepository.js';
import { createMockRepository } from './mock/createMockRepository.js';
import { createApiRepository } from './api/createApiRepository.js';

export const DATA_MODES = Object.freeze({ DEMO: 'demo', ACTUAL: 'actual' });
export const DATA_MODE_STORAGE_KEY = 'mergen_rota_data_mode_v1';

export function createRepositoryForDataMode(mode) {
  return assertAppRepository(mode === DATA_MODES.ACTUAL ? createApiRepository() : createMockRepository());
}

export const DataModeContext = createContext({ dataMode: DATA_MODES.DEMO, setDataMode() {} });
export function useDataMode() { return useContext(DataModeContext); }
