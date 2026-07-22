import { normalizePersonReferences, normalizeProjectReferences } from '../../domain/validation/index.js';
import { normalizeTaskRecord } from '../normalizeTaskRecord.js';
import { addDays, fmtISO, today } from '../../scheduling/dates/index.js';
import { CALENDARS } from './calendars.js';

const MOCK_DATA_DATE = '2026-07-21';

const RAW_PROJECTS = [
  { id: 'p-web', code: 'PRJ-WEB-001', name: 'Web Sitesi Yenileme', source: 'corporate', color: 'blue', lead: 'Ahmet Yılmaz', calendarId: 'cal-tr-standard-2026', dataDate: MOCK_DATA_DATE },
  { id: 'p-mobile', code: 'PRJ-MOB-002', name: 'Mobil Uygulama', source: 'corporate', color: 'purple', lead: 'Mehmet Demir', calendarId: 'cal-tr-standard-2026', dataDate: MOCK_DATA_DATE },
  { id: 'p-social', code: 'PRJ-SOS-003', name: 'Sosyal Medya', source: 'corporate', color: 'rose', lead: 'Ayşe Kaya', calendarId: 'cal-tr-standard-2026', dataDate: MOCK_DATA_DATE },
  { id: 'p-db', code: 'PRJ-DB-004', name: 'Veritabanı Göçü', source: 'corporate', color: 'amber', lead: 'Can Özkan', calendarId: 'cal-tr-standard-2026', dataDate: MOCK_DATA_DATE },
  { id: 'p-infra', code: 'PRJ-ALT-005', name: 'Altyapı', source: 'corporate', color: 'cyan', lead: 'Can Özkan', calendarId: 'cal-tr-operations-2026', dataDate: MOCK_DATA_DATE },
  { id: 'p-brand', code: 'PRJ-MRK-006', name: 'Marka Kimliği', source: 'corporate', color: 'emerald', lead: 'Elif Yıldız', calendarId: 'cal-tr-standard-2026', dataDate: MOCK_DATA_DATE }
];

const RAW_PEOPLE = [
  { id: 'u-ahmet', employeeNo: '100101', name: 'Ahmet Yılmaz', role: 'Senior Designer', team: 'Tasarım', color: 'blue' },
  { id: 'u-mehmet', employeeNo: '100102', name: 'Mehmet Demir', role: 'Backend Lead', team: 'Mühendislik', color: 'purple' },
  { id: 'u-ayse', employeeNo: '100103', name: 'Ayşe Kaya', role: 'Frontend Engineer', team: 'Mühendislik', color: 'emerald' },
  { id: 'u-elif', employeeNo: '100104', name: 'Elif Yıldız', role: 'QA Engineer', team: 'Mühendislik', color: 'rose' },
  { id: 'u-can', employeeNo: '100105', name: 'Can Özkan', role: 'DevOps Engineer', team: 'Operasyon', color: 'amber' },
  { id: 'u-zeynep', employeeNo: '100106', name: 'Zeynep Aydın', role: 'Product Manager', team: 'Ürün', color: 'cyan' },
  { id: 'u-burak', employeeNo: '100107', name: 'Burak Şahin', role: 'Content Strategist', team: 'Pazarlama', color: 'purple' }
];

function rel(days) {
  return fmtISO(addDays(today(), days));
}

const RAW_TASKS = [
  { id: 't1', proje: 'Web Sitesi Yenileme', task: 'UI/UX tasarım sisteminin oluşturulması ve onayı', keyword: 'Tasarım', sorumlu: ['Ahmet Yılmaz'], status: 'done', priority: 'high', plannedStart: rel(-32), plannedFinish: rel(-20), targetFinish: rel(-18), actualStart: rel(-31), actualFinish: rel(-19), color: 'blue', plannedHours: 96, actualHours: 104, budget: 48000, spent: 51200, progress: 100 },
  { id: 't2', proje: 'Web Sitesi Yenileme', task: 'Frontend bileşenlerinin React + Tailwind ile kodlanması', keyword: 'Frontend', sorumlu: ['Ayşe Kaya'], status: 'in_progress', priority: 'critical', plannedStart: rel(-18), plannedFinish: rel(5), targetFinish: rel(7), actualStart: rel(-17), color: 'blue', deps: [{ id: 't1', type: 'FS' }], progress: 65, plannedHours: 184, actualHours: 132, budget: 92000, spent: 64500 },
  { id: 't3', proje: 'Web Sitesi Yenileme', task: 'CMS entegrasyonu ve içerik göçü', keyword: 'CMS', sorumlu: ['Mehmet Demir', 'Burak Şahin'], status: 'todo', priority: 'high', plannedStart: rel(6), plannedFinish: rel(18), targetFinish: rel(20), color: 'blue', deps: [{ id: 't2', type: 'FS' }], plannedHours: 96, actualHours: 0, budget: 48000, spent: 0 },
  { id: 't4', proje: 'Web Sitesi Yenileme', task: 'SEO ve performans optimizasyonu', keyword: 'SEO', sorumlu: ['Ayşe Kaya'], status: 'todo', priority: 'medium', plannedStart: rel(15), plannedFinish: rel(22), targetFinish: rel(25), color: 'blue', plannedHours: 56, actualHours: 0, budget: 28000, spent: 0 },
  { id: 't4m', proje: 'Web Sitesi Yenileme', task: 'Lansman: Yeni site yayında', keyword: 'Lansman', sorumlu: ['Zeynep Aydın'], status: 'todo', priority: 'critical', milestone: true, plannedStart: rel(26), plannedFinish: rel(26), targetFinish: rel(26), color: 'blue', plannedHours: 0, actualHours: 0, budget: 0, spent: 0, deps: [{ id: 't4', type: 'FS' }] },

  { id: 't5', proje: 'Mobil Uygulama', task: 'Kimlik doğrulama API uçlarının yazılması', keyword: 'Auth API', sorumlu: ['Mehmet Demir'], status: 'done', priority: 'critical', plannedStart: rel(-26), plannedFinish: rel(-12), targetFinish: rel(-10), actualStart: rel(-25), actualFinish: rel(-11), color: 'purple', plannedHours: 112, actualHours: 108, budget: 56000, spent: 54000, progress: 100 },
  { id: 't6', proje: 'Mobil Uygulama', task: 'Push notification altyapısının kurulması', keyword: 'Push', sorumlu: ['Mehmet Demir'], status: 'in_progress', priority: 'high', plannedStart: rel(-8), plannedFinish: rel(6), targetFinish: rel(8), color: 'purple', progress: 40, plannedHours: 112, actualHours: 56, budget: 56000, spent: 24000 },
  { id: 't7', proje: 'Mobil Uygulama', task: 'Entegrasyon ve uçtan uca testlerin tamamlanması', keyword: 'Test', sorumlu: ['Elif Yıldız', 'Mehmet Demir'], status: 'todo', priority: 'high', plannedStart: rel(7), plannedFinish: rel(16), targetFinish: rel(18), color: 'purple', deps: [{ id: 't6', type: 'FF' }], plannedHours: 72, actualHours: 0, budget: 36000, spent: 0 },
  { id: 't8', proje: 'Mobil Uygulama', task: 'App Store ve Play Store yayın hazırlığı', keyword: 'Store', sorumlu: ['Zeynep Aydın'], status: 'todo', priority: 'medium', plannedStart: rel(17), plannedFinish: rel(24), targetFinish: rel(26), color: 'purple', deps: [{ id: 't7', type: 'FS' }], plannedHours: 56, actualHours: 0, budget: 28000, spent: 0 },
  { id: 't8m', proje: 'Mobil Uygulama', task: 'Sürüm 2.0 yayımlandı', keyword: 'Sürüm', sorumlu: ['Zeynep Aydın'], status: 'todo', priority: 'critical', milestone: true, plannedStart: rel(27), plannedFinish: rel(27), targetFinish: rel(27), color: 'purple', deps: [{ id: 't8', type: 'FS' }], plannedHours: 0, actualHours: 0, budget: 0, spent: 0 },

  { id: 't9', proje: 'Sosyal Medya', task: 'Haziran kampanya görsellerinin hazırlanması', keyword: 'Görseller', sorumlu: ['Ahmet Yılmaz'], status: 'in_progress', priority: 'medium', plannedStart: rel(-6), plannedFinish: rel(4), targetFinish: rel(6), color: 'rose', progress: 50, plannedHours: 64, actualHours: 32, budget: 32000, spent: 14500 },
  { id: 't10', proje: 'Sosyal Medya', task: 'Influencer iş birlikleri ve içerik takvimi', keyword: 'Kampanya', sorumlu: ['Burak Şahin', 'Ayşe Kaya'], status: 'todo', priority: 'medium', plannedStart: rel(2), plannedFinish: rel(14), targetFinish: rel(16), color: 'rose', plannedHours: 80, actualHours: 0, budget: 40000, spent: 0 },

  { id: 't11', proje: 'Veritabanı Göçü', task: 'Mevcut kullanıcı verisinin yeni sunucuya taşınması', keyword: 'DB Göçü', sorumlu: ['Mehmet Demir', 'Can Özkan'], status: 'in_progress', priority: 'critical', plannedStart: rel(-4), plannedFinish: rel(3), targetFinish: rel(2), color: 'amber', progress: 80, plannedHours: 56, actualHours: 48, budget: 28000, spent: 23000 },
  { id: 't12', proje: 'Veritabanı Göçü', task: 'İndeks ve sorgu optimizasyonu', keyword: 'Optimizasyon', sorumlu: ['Mehmet Demir'], status: 'todo', priority: 'high', plannedStart: rel(4), plannedFinish: rel(10), targetFinish: rel(12), color: 'amber', deps: [{ id: 't11', type: 'FS' }], plannedHours: 48, actualHours: 0, budget: 24000, spent: 0 },
  { id: 't12m', proje: 'Veritabanı Göçü', task: 'Eski veritabanı devre dışı bırakıldı', keyword: 'Eski Sistem', sorumlu: ['Can Özkan'], status: 'todo', priority: 'high', milestone: true, plannedStart: rel(13), plannedFinish: rel(13), targetFinish: rel(13), color: 'amber', deps: [{ id: 't12', type: 'FS' }], plannedHours: 0, actualHours: 0, budget: 0, spent: 0 },

  { id: 't13', proje: 'Altyapı', task: 'CI/CD pipeline yenilemesi', keyword: 'CI/CD', sorumlu: ['Can Özkan'], status: 'in_progress', priority: 'high', plannedStart: rel(-10), plannedFinish: rel(2), targetFinish: rel(4), color: 'cyan', progress: 70, plannedHours: 80, actualHours: 64, budget: 40000, spent: 28500 },
  { id: 't14', proje: 'Altyapı', task: 'Sunucu işletim sistemi ve paket güncellemeleri', keyword: 'Sunucu', sorumlu: ['Can Özkan'], status: 'todo', priority: 'medium', plannedStart: rel(3), plannedFinish: rel(5), targetFinish: rel(5), color: 'cyan', deps: [{ id: 't11', type: 'SS' }], plannedHours: 24, actualHours: 0, budget: 12000, spent: 0 },
  { id: 't15', proje: 'Altyapı', task: 'Felaket kurtarma planı dokümantasyonu', keyword: 'DR Plan', sorumlu: ['Can Özkan', 'Zeynep Aydın'], status: 'todo', priority: 'low', plannedStart: rel(8), plannedFinish: rel(20), targetFinish: rel(22), color: 'cyan', plannedHours: 64, actualHours: 0, budget: 32000, spent: 0 },

  { id: 't16', proje: 'Marka Kimliği', task: 'Yeni logo varyasyonları ve kullanım kılavuzu', keyword: 'Logo', sorumlu: ['Ahmet Yılmaz', 'Elif Yıldız'], status: 'done', priority: 'medium', plannedStart: rel(-40), plannedFinish: rel(-22), targetFinish: rel(-20), actualStart: rel(-39), actualFinish: rel(-21), color: 'emerald', plannedHours: 88, actualHours: 92, budget: 44000, spent: 46000, progress: 100 },
  { id: 't17', proje: 'Marka Kimliği', task: 'Tipografi sisteminin yenilenmesi', keyword: 'Tipografi', sorumlu: ['Ahmet Yılmaz'], status: 'in_progress', priority: 'medium', plannedStart: rel(-12), plannedFinish: rel(1), targetFinish: rel(3), color: 'emerald', progress: 85, plannedHours: 56, actualHours: 48, budget: 28000, spent: 23800 },
  { id: 't18', proje: 'Marka Kimliği', task: 'Marka rehberi PDF yayınlanması', keyword: 'Rehber', sorumlu: ['Elif Yıldız', 'Burak Şahin'], status: 'todo', priority: 'low', plannedStart: rel(2), plannedFinish: rel(9), targetFinish: rel(11), color: 'emerald', deps: [{ id: 't17', type: 'FS' }], plannedHours: 40, actualHours: 0, budget: 20000, spent: 0 },

  { id: 't19', proje: 'Sosyal Medya', task: 'Q1 kampanya raporunun yöneticilere sunulması', keyword: 'Rapor', sorumlu: ['Zeynep Aydın'], status: 'in_progress', priority: 'high', plannedStart: rel(-14), plannedFinish: rel(-2), targetFinish: rel(-3), color: 'rose', progress: 90, plannedHours: 24, actualHours: 26, budget: 12000, spent: 13000 }
];

export { CALENDARS };
export const PEOPLE = RAW_PEOPLE.map((person) => normalizePersonReferences(person));
export const PROJECTS = RAW_PROJECTS.map((project) => normalizeProjectReferences(project, PEOPLE));

export const WBS = [
  { id: 'wbs-p-web-root', projectId: 'p-web', parentId: null, code: '1', name: 'Web Sitesi Yenileme', sortOrder: 1 },
  { id: 'wbs-p-web-management', projectId: 'p-web', parentId: 'wbs-p-web-root', code: '1.1', name: 'Yönetim', sortOrder: 1 },
  { id: 'wbs-p-web-design', projectId: 'p-web', parentId: 'wbs-p-web-root', code: '1.2', name: 'Tasarım', sortOrder: 2 },
  { id: 'wbs-p-web-development', projectId: 'p-web', parentId: 'wbs-p-web-root', code: '1.3', name: 'Geliştirme', sortOrder: 3 },
  { id: 'wbs-p-web-frontend', projectId: 'p-web', parentId: 'wbs-p-web-development', code: '1.3.1', name: 'Frontend', sortOrder: 1 },
  { id: 'wbs-p-web-cms', projectId: 'p-web', parentId: 'wbs-p-web-development', code: '1.3.2', name: 'CMS ve İçerik', sortOrder: 2 },
  { id: 'wbs-p-web-launch', projectId: 'p-web', parentId: 'wbs-p-web-root', code: '1.4', name: 'Yayına Alma', sortOrder: 4 },

  { id: 'wbs-p-mobile-root', projectId: 'p-mobile', parentId: null, code: '2', name: 'Mobil Uygulama', sortOrder: 1 },
  { id: 'wbs-p-mobile-backend', projectId: 'p-mobile', parentId: 'wbs-p-mobile-root', code: '2.1', name: 'Backend', sortOrder: 1 },
  { id: 'wbs-p-mobile-development', projectId: 'p-mobile', parentId: 'wbs-p-mobile-root', code: '2.2', name: 'Mobil Geliştirme', sortOrder: 2 },
  { id: 'wbs-p-mobile-test', projectId: 'p-mobile', parentId: 'wbs-p-mobile-root', code: '2.3', name: 'Test', sortOrder: 3 },
  { id: 'wbs-p-mobile-release', projectId: 'p-mobile', parentId: 'wbs-p-mobile-root', code: '2.4', name: 'Yayın', sortOrder: 4 },

  { id: 'wbs-p-social-root', projectId: 'p-social', parentId: null, code: '3', name: 'Sosyal Medya', sortOrder: 1 },
  { id: 'wbs-p-social-planning', projectId: 'p-social', parentId: 'wbs-p-social-root', code: '3.1', name: 'Kampanya Planlama', sortOrder: 1 },
  { id: 'wbs-p-social-creative', projectId: 'p-social', parentId: 'wbs-p-social-root', code: '3.2', name: 'İçerik ve Görsel', sortOrder: 2 },
  { id: 'wbs-p-social-reporting', projectId: 'p-social', parentId: 'wbs-p-social-root', code: '3.3', name: 'Raporlama', sortOrder: 3 },

  { id: 'wbs-p-db-root', projectId: 'p-db', parentId: null, code: '4', name: 'Veritabanı Göçü', sortOrder: 1 },
  { id: 'wbs-p-db-planning', projectId: 'p-db', parentId: 'wbs-p-db-root', code: '4.1', name: 'Hazırlık ve Planlama', sortOrder: 1 },
  { id: 'wbs-p-db-migration', projectId: 'p-db', parentId: 'wbs-p-db-root', code: '4.2', name: 'Veri Taşıma', sortOrder: 2 },
  { id: 'wbs-p-db-optimization', projectId: 'p-db', parentId: 'wbs-p-db-root', code: '4.3', name: 'Optimizasyon', sortOrder: 3 },
  { id: 'wbs-p-db-cutover', projectId: 'p-db', parentId: 'wbs-p-db-root', code: '4.4', name: 'Geçiş ve Kapatma', sortOrder: 4 },

  { id: 'wbs-p-infra-root', projectId: 'p-infra', parentId: null, code: '5', name: 'Altyapı', sortOrder: 1 },
  { id: 'wbs-p-infra-delivery', projectId: 'p-infra', parentId: 'wbs-p-infra-root', code: '5.1', name: 'Teslimat Altyapısı', sortOrder: 1 },
  { id: 'wbs-p-infra-platform', projectId: 'p-infra', parentId: 'wbs-p-infra-root', code: '5.2', name: 'Platform Bakımı', sortOrder: 2 },
  { id: 'wbs-p-infra-continuity', projectId: 'p-infra', parentId: 'wbs-p-infra-root', code: '5.3', name: 'İş Sürekliliği', sortOrder: 3 },

  { id: 'wbs-p-brand-root', projectId: 'p-brand', parentId: null, code: '6', name: 'Marka Kimliği', sortOrder: 1 },
  { id: 'wbs-p-brand-visual', projectId: 'p-brand', parentId: 'wbs-p-brand-root', code: '6.1', name: 'Görsel Kimlik', sortOrder: 1 },
  { id: 'wbs-p-brand-typography', projectId: 'p-brand', parentId: 'wbs-p-brand-root', code: '6.2', name: 'Tipografi', sortOrder: 2 },
  { id: 'wbs-p-brand-guide', projectId: 'p-brand', parentId: 'wbs-p-brand-root', code: '6.3', name: 'Marka Rehberi', sortOrder: 3 }
];

const TASK_WBS_BY_ID = {
  t1: 'wbs-p-web-design',
  t2: 'wbs-p-web-frontend',
  t3: 'wbs-p-web-cms',
  t4: 'wbs-p-web-frontend',
  t4m: 'wbs-p-web-launch',
  t5: 'wbs-p-mobile-backend',
  t6: 'wbs-p-mobile-backend',
  t7: 'wbs-p-mobile-test',
  t8: 'wbs-p-mobile-release',
  t8m: 'wbs-p-mobile-release',
  t9: 'wbs-p-social-creative',
  t10: 'wbs-p-social-planning',
  t11: 'wbs-p-db-migration',
  t12: 'wbs-p-db-optimization',
  t12m: 'wbs-p-db-cutover',
  t13: 'wbs-p-infra-delivery',
  t14: 'wbs-p-infra-platform',
  t15: 'wbs-p-infra-continuity',
  t16: 'wbs-p-brand-visual',
  t17: 'wbs-p-brand-typography',
  t18: 'wbs-p-brand-guide',
  t19: 'wbs-p-social-reporting'
};

const taskContext = { projects: PROJECTS, people: PEOPLE, wbs: WBS, calendars: CALENDARS };
export const TASKS = RAW_TASKS.map((task) => normalizeTaskRecord({ ...task, wbsId: TASK_WBS_BY_ID[task.id] || null }, taskContext));

export const BASELINES = PROJECTS.map((project) => ({
  id: `baseline-${project.id}-initial`,
  projectId: project.id,
  name: 'Başlangıç Baz Planı',
  createdAt: rel(-45),
  isPrimary: true
}));

const primaryBaselineByProjectId = new Map(BASELINES.map((baseline) => [baseline.projectId, baseline]));
const projectById = new Map(PROJECTS.map((project) => [project.id, project]));

export const TASK_BASELINE_SNAPSHOTS = TASKS.map((task) => ({
  baselineId: primaryBaselineByProjectId.get(task.projectId).id,
  taskId: task.id,
  plannedStart: task.plannedStart,
  plannedFinish: task.plannedFinish,
  plannedDurationDays: task.plannedDurationDays,
  calendarId: task.calendarId || projectById.get(task.projectId)?.calendarId || null
}));
