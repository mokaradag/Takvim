import { assertAppRepository } from './contracts/appRepository.js';
import { createMockRepository } from './mock/createMockRepository.js';

export { createMockRepository } from './mock/createMockRepository.js';
export { normalizeTaskRecord } from './normalizeTaskRecord.js';
export { migrateLegacyTaskSchedule } from './migrations/legacyTaskSchedule.js';
export const appRepository = assertAppRepository(createMockRepository());
