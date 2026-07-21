import { assertAppRepository } from './contracts/appRepository';
import { createMockRepository } from './mock/createMockRepository';

export { createMockRepository } from './mock/createMockRepository';
export const appRepository = assertAppRepository(createMockRepository());
