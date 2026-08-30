/**
 * Gerçek Sistem yığınını uçtan uca kuran test yardımcısı.
 *
 * Zincir gerçek kodla kurulur:
 *   uygulama durumu (appState) → kalıcılaştırma düzenleyicisi
 *   → `createApiRepository` (istemci kimlik kanonikleştirmesi + HTTP gövdesi)
 *   → gerçek Next.js rota gövdeleri (`/api/mergen-rota/*`)
 *   → sıralı → sertleştirilmiş → temel SQL deposu
 *   → bellek içi SQL Server ikizi (`fakeSqlServer.mjs`)
 *
 * `server-only` paketi düz Node içinde hata fırlattığı için `serverOnlyShim`
 * ile boş bir modüle yönlendirilir; başka hiçbir modül taklit edilmez.
 */
import { appStateReducer, createInitialState, createLoadingState } from '../../src/state/appState.js';
import { createStateMutationOrchestrator, loadApplicationData } from '../../src/state/persistence.js';
import { createApiRepository } from '../../src/data/api/createApiRepository.js';
import { createFakeDatabase, createFakeSqlServerDriver } from './fakeSqlServer.mjs';
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function applyEnvironment({ corporateWbsSource = true, authMode = 'development' } = {}) {
  process.env.MERGEN_ROTA_DB_SERVER = 'sqlserver.test.internal';
  process.env.MERGEN_ROTA_DB_DATABASE = 'MERGEN_Rota';
  // Varsayılan yığın geçici geliştirme kimliğini kullanır; Keycloak uçtan uca
  // testleri bu kipi açıkça 'keycloak' olarak seçer.
  process.env.MERGEN_ROTA_AUTH_MODE = authMode;
  process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED = 'true';
  process.env.MERGEN_ROTA_DEV_SICIL = '900001';
  // Kurumsal katalog tazeleme penceresi süreç düzeyindedir. Testlerin
  // birbirinin penceresini devralmaması için varsayılan olarak kapatılır;
  // pencereyi sınayan testler bu değişkeni kendisi ayarlar.
  if (process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS == null) process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS = '0';
  if (corporateWbsSource) {
    process.env.MERGEN_ROTA_WBS_DB_SERVER = 'sqlserver-wbs.test.internal';
    process.env.MERGEN_ROTA_WBS_DB_DATABASE = 'KURUMSAL_WBS';
    process.env.MERGEN_ROTA_WBS_DB_TABLE = 'CN43N';
  } else {
    delete process.env.MERGEN_ROTA_WBS_DB_SERVER;
    delete process.env.MERGEN_ROTA_WBS_DB_DATABASE;
  }
}

/**
 * Uçtan uca yığını hazırlar.
 *
 * @param {object} seed  `createFakeDatabase` tohumu
 * @param {object} options `{ sicil, corporateWbsSource }`
 */
export async function createActualStack(seed = {}, options = {}) {
  registerServerOnlyShim();
  const previousDevSicil = process.env.MERGEN_ROTA_DEV_SICIL;
  applyEnvironment(options);
  if (options.sicil) process.env.MERGEN_ROTA_DEV_SICIL = String(options.sicil);

  const db = createFakeDatabase(seed);
  const driver = createFakeSqlServerDriver(db);

  const { setSqlDriverForTests, resetSqlPoolForTests } = await import('../../src/server/db/pool.js');
  const { resetCorporateWbsPoolForTests } = await import('../../src/server/db/corporateWbsPool.js');
  const { resetCorporateWbsSyncScheduleForTests } = await import('../../src/server/repository/corporateWbsSyncSchedule.js');
  setSqlDriverForTests(driver);
  resetSqlPoolForTests();
  resetCorporateWbsPoolForTests();
  resetCorporateWbsSyncScheduleForTests();

  // Kimlik sağlayıcısı yığın kurulmadan ÖNCE yerleştirilir: ilk anlık görüntü
  // isteği zaten doğrulanmış kimlikle çalışmalıdır.
  const { setCurrentUserProvider } = await import('../../src/server/identity/currentUserProvider.js');
  setCurrentUserProvider(options.currentUserProvider || null);

  const commitRoute = await import('../../src/app/api/mergen-rota/commit/route.js');
  const snapshotRoute = await import('../../src/app/api/mergen-rota/snapshot/route.js');
  const sessionRoute = await import('../../src/app/api/mergen-rota/session/route.js');
  const scheduleCreateRoute = await import('../../src/app/api/mergen-rota/schedule-changes/route.js');
  const scheduleDecisionRoute = await import('../../src/app/api/mergen-rota/schedule-changes/[requestId]/route.js');

  const requests = [];
  const fetchImplementation = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, method: init.method || 'GET' });
    if (path.endsWith('/commit')) {
      return commitRoute.POST(new Request('http://localhost' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: init.body
      }));
    }
    if (path.endsWith('/snapshot')) {
      return snapshotRoute.GET(new Request('http://localhost' + path, {
        method: 'GET',
        headers: init.headers
      }));
    }
    if (path.endsWith('/session')) return sessionRoute.GET();
    if (path.endsWith('/api/mergen-rota/schedule-changes') && (init.method || 'GET') === 'POST') {
      return scheduleCreateRoute.POST(new Request('http://localhost' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: init.body
      }));
    }
    const scheduleMatch = path.match(/\/api\/mergen-rota\/schedule-changes\/([^/]+)$/);
    if (scheduleMatch && (init.method || 'GET') === 'PATCH') {
      return scheduleDecisionRoute.PATCH(new Request('http://localhost' + path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: init.body
      }), { params: { requestId: decodeURIComponent(scheduleMatch[1]) } });
    }
    throw new Error(`Unexpected request path: ${path}`);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImplementation;

  const repository = createApiRepository({ aliasStorage: memoryStorage() });
  let state = createLoadingState();
  const applyStateAction = (action) => {
    state = appStateReducer(state, action);
    return state;
  };
  const persistence = createStateMutationOrchestrator({
    repository,
    getState: () => state,
    applyStateAction,
    taskPatchDelayMs: 1,
    now: () => '2026-07-25T09:00:00.000Z'
  });

  async function reload({ refreshMode = 'initial' } = {}) {
    const loaded = await loadApplicationData(repository, { refreshMode });
    if (!loaded.ok) throw new Error(`Snapshot load failed: ${loaded.error?.message}`);
    state = createInitialState(loaded.snapshot);
    return state;
  }

  await reload();

  return {
    db,
    driver,
    repository,
    persistence,
    requests,
    reload,
    applyStateAction,
    get state() { return state; },
    project(code) {
      return state.projects.find((entry) => String(entry.code || '').toUpperCase() === String(code).toUpperCase()) || null;
    },
    projectWbs(projectId) {
      return state.wbs.filter((node) => node.projectId === projectId);
    },
    rootWbs(projectId) {
      return state.wbs.find((node) => node.projectId === projectId && node.parentId == null) || null;
    },
    async dispose() {
      globalThis.fetch = originalFetch;
      setSqlDriverForTests(null);
      resetSqlPoolForTests();
      resetCorporateWbsPoolForTests();
      resetCorporateWbsSyncScheduleForTests();
      if (previousDevSicil == null) delete process.env.MERGEN_ROTA_DEV_SICIL;
      else process.env.MERGEN_ROTA_DEV_SICIL = previousDevSicil;
    }
  };
}

/**
 * Kurumsal kaynaktan gelen, RFC 4122 sürüm bitleri taşımayan GUID örneği.
 * Ekran görüntülerindeki hata iletisinde geçen biçimin aynısıdır.
 */
export const CORPORATE_PROJECT_ID = 'D5D70AEC-0A88-F111-9136-00505699BACD';
export const CORPORATE_ROOT_WBS_ID = 'DED70AEC-0A88-F111-9136-005056998ACD';
export const DEFAULT_CALENDAR_ID = 'C0A80101-1111-4111-8111-111111111111';

export function corporateSeed(overrides = {}) {
  return {
    calendars: [{ CalendarId: DEFAULT_CALENDAR_ID, Name: 'Kurumsal Çalışma Takvimi', IsDefault: 1, IsActive: 1 }],
    people: [
      { Sicil: 900001, DisplayName: 'Test Kullanıcı', Username: 'tkullanici', JobTitle: 'Product Manager', Team: 'PYO', Sector: null, Directorate: null, Department: null, Unit: null },
      { Sicil: 900010, DisplayName: 'Sentetik Proje Yöneticisi', Username: 'sproje', JobTitle: 'Proje Yöneticisi', Team: 'PYO', Sector: null, Directorate: null, Department: null, Unit: null }
    ],
    systemAdminSicils: [900001],
    corporateProjects: [
      { ProjectCode: 'P4417041', ProjectName: 'İHA Hava Savunma Sistemi ELDD Projesi', ProjectTypeCode: 'GD', ProjectTypeName: 'Garanti dışı faaliyetler' }
    ],
    corporateProjectAccess: [
      { ProjectCode: 'P4417041', Sicil: 900010, RoleCode: 'PROJECT_MANAGER' }
    ],
    projects: [{
      ProjectId: CORPORATE_PROJECT_ID,
      SourceType: 'CORPORATE',
      ProjectCode: 'P4417041',
      ProjectName: 'İHA Hava Savunma Sistemi ELDD Projesi',
      ProjectTypeCode: 'GD',
      ProjectTypeName: 'Garanti dışı faaliyetler',
      LeadSicil: 900010,
      DataDate: null,
      ColorToken: 'blue',
      CalendarId: DEFAULT_CALENDAR_ID
    }],
    wbs: [{
      WbsId: CORPORATE_ROOT_WBS_ID,
      ProjectId: CORPORATE_PROJECT_ID,
      ParentWbsId: null,
      Code: 'P4417041',
      Name: 'İHA Hava Savunma Sistemi ELDD Projesi',
      SortOrder: 0,
      SourceType: 'CORPORATE'
    }],
    ...overrides
  };
}
