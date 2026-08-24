import { assertAppRepository } from './contracts/appRepository.js';
import { createMockRepository } from './mock/createMockRepository.js';

export { createMockRepository } from './mock/createMockRepository.js';
export { normalizeTaskRecord } from './normalizeTaskRecord.js';
export { migrateLegacyTaskSchedule } from './migrations/legacyTaskSchedule.js';
/**
 * Demo Modu deposu — İLK KULLANIMDA kurulur.
 *
 * Modül düzeyinde HEMEN oluşturulan bir tekil, Gerçek Sistem seçilmiş olsa da
 * içe aktarma anında demo tohum verisini kuruyordu. Erişim bir işlev üzerinden
 * verilir: depo yalnızca gerçekten Demo Modu kullanıldığında üretilir ve
 * `AppStateProvider` kendi deposunu geçerken hiç kurulmaz.
 */
let demoRepository = null;

export function getAppRepository() {
  if (!demoRepository) demoRepository = assertAppRepository(createMockRepository());
  return demoRepository;
}
