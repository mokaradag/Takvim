import { assertAppRepository } from './contracts/appRepository.js';
import { createMockRepository } from './mock/createMockRepository.js';
import { createApiRepository } from './api/createApiRepository.js';

export const DATA_MODES = Object.freeze({ DEMO: 'demo', ACTUAL: 'actual' });
export const DATA_MODE_STORAGE_KEY = 'mergen_rota_data_mode_v1';

export function createRepositoryForDataMode(mode, actualRepositoryOptions = {}) {
  return assertAppRepository(
    mode === DATA_MODES.ACTUAL
      ? createApiRepository(actualRepositoryOptions)
      : createMockRepository()
  );
}
