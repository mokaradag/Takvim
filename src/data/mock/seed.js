import { normalizeProjectReferences, normalizeTaskReferences } from '../../domain/validation';
import { normalizeDependency } from '../../scheduling/dependencies';
import { addDays, fmtISO, today } from '../../scheduling/dates';
import { CALENDARS } from './calendars';

const RAW_PROJECTS = [
  { id: 'p-web', name: 'Web Sitesi Yenileme', color: 'blue', lead: 'Ahmet Yılmaz', calendarId: 'cal-tr-standard-2026' },
  { id: 'p-mobile', name: 'Mobil Uygulama', color: 'purple', lead: 'Mehmet Demir', calendarId: 'cal-tr-standard-2026' },
  { id: 'p-social', name: 'Sosyal Medya', color: 'rose', lead: 'Ayşe Kaya', calendarId: 'cal-tr-standard-2026' },
  { id: 'p-db', name: 'Veritabanı Göçü', color: 'amber', lead: 'Can Özkan', calendarId: 'cal-tr-standard-2026' },
  { id: 'p-infra', name: 'Altyapı', color: 'cyan', lead: 'Can Özkan', calendarId: 'cal-tr-operations-2026' },
  { id: 'p-brand', name: 'Marka Kimliği', color: 'emerald', lead: 'Elif Yıldız', calendarId: 'cal-tr-standard-2026' }
];

const RAW_PEOPLE = [
  { id: 'u-ahmet', name: 'Ahmet Yılmaz', role: 'Senior Designer', team: 'Tasarım', color: 'blue' },
  { id: 'u-mehmet', name: 'Mehmet Demir', role: 'Backend Lead', team: 'Mühendislik', color: 'purple' },
  { id: 'u-ayse', name: 'Ayşe Kaya', role: 'Frontend Engineer', team: 'Mühendislik', color: 'emerald' },
  { id: 'u-elif', name: 'Elif Yıldız', role: 'QA Engineer', team: 'Mühendislik', color: 'rose' },
  { id: 'u-can', name: 'Can Özkan', role: 'DevOps Engineer', team: 'Operasyon', color: 'amber' },
  { id: 'u-zeynep', name: 'Zeynep Aydın', role: 'Product Manager', team: 'Ürün', color: 'cyan' },
  { id: 'u-burak', name: 'Burak Şahin', role: 'Content Strategist', team: 'Pazarlama', color: 'purple' }
];

function rel(days) {
  return fmtISO(addDays(today(), days));
}

const RAW_TASKS = [
  // Web project
  { id: 't1', proje: 'Web Sitesi Yenileme', task: 'UI/UX tasarım sisteminin oluşturulması ve onayı', keyword: 'Tasarım', sorumlu: ['Ahmet Yılmaz'], status: 'done', priority: 'high', baslangicTarihi: rel(-32), bitisTarihi: rel(-20), hedefTarih: rel(-18), color: 'blue', plannedHours: 96, actualHours: 104, budget: 48000, spent: 51200, progress: 100 },
  { id: 't2', proje: 'Web Sitesi Yenileme', task: 'Frontend bileşenlerinin React + Tailwind ile kodlanması', keyword: 'Frontend', sorumlu: ['Ayşe Kaya'], status: 'in_progress', priority: 'critical', baslangicTarihi: rel(-18), bitisTarihi: rel(5), hedefTarih: rel(7), color: 'blue', deps: [{ id: 't1', type: 'FS' }], progress: 65, plannedHours: 184, actualHours: 132, budget: 92000, spent: 64500 },
  { id: 't3', proje: 'Web Sitesi Yenileme', task: 'CMS entegrasyonu ve içerik göçü', keyword: 'CMS', sorumlu: ['Mehmet Demir', 'Burak Şahin'], status: 'todo', priority: 'high', baslangicTarihi: rel(6), bitisTarihi: rel(18), hedefTarih: rel(20), color: 'blue', deps: [{ id: 't2', type: 'FS' }], plannedHours: 96, actualHours: 0, budget: 48000, spent: 0 },
  { id: 't4', proje: 'Web Sitesi Yenileme', task: 'SEO ve performans optimizasyonu', keyword: 'SEO', sorumlu: ['Ayşe Kaya'], status: 'todo', priority: 'medium', baslangicTarihi: rel(15), bitisTarihi: rel(22), hedefTarih: rel(25), color: 'blue', plannedHours: 56, actualHours: 0, budget: 28000, spent: 0 },
  { id: 't4m', proje: 'Web Sitesi Yenileme', task: 'Lansman: Yeni site yayında', keyword: 'Lansman', sorumlu: ['Zeynep Aydın'], status: 'todo', priority: 'critical', milestone: true, baslangicTarihi: rel(26), bitisTarihi: rel(26), hedefTarih: rel(26), color: 'blue', plannedHours: 0, actualHours: 0, budget: 0, spent: 0, deps: [{ id: 't4', type: 'FS' }] },

  // Mobile
  { id: 't5', proje: 'Mobil Uygulama', task: 'Kimlik doğrulama API uçlarının yazılması', keyword: 'Auth API', sorumlu: ['Mehmet Demir'], status: 'done', priority: 'critical', baslangicTarihi: rel(-26), bitisTarihi: rel(-12), hedefTarih: rel(-10), color: 'purple', plannedHours: 112, actualHours: 108, budget: 56000, spent: 54000, progress: 100 },
  { id: 't6', proje: 'Mobil Uygulama', task: 'Push notification altyapısının kurulması', keyword: 'Push', sorumlu: ['Mehmet Demir'], status: 'in_progress', priority: 'high', baslangicTarihi: rel(-8), bitisTarihi: rel(6), hedefTarih: rel(8), color: 'purple', progress: 40, plannedHours: 112, actualHours: 56, budget: 56000, spent: 24000 },
  { id: 't7', proje: 'Mobil Uygulama', task: 'Entegrasyon ve uçtan uca testlerin tamamlanması', keyword: 'Test', sorumlu: ['Elif Yıldız', 'Mehmet Demir'], status: 'todo', priority: 'high', baslangicTarihi: rel(7), bitisTarihi: rel(16), hedefTarih: rel(18), color: 'purple', deps: [{ id: 't6', type: 'FF' }], plannedHours: 72, actualHours: 0, budget: 36000, spent: 0 },
  { id: 't8', proje: 'Mobil Uygulama', task: 'App Store ve Play Store yayın hazırlığı', keyword: 'Store', sorumlu: ['Zeynep Aydın'], status: 'todo', priority: 'medium', baslangicTarihi: rel(17), bitisTarihi: rel(24), hedefTarih: rel(26), color: 'purple', deps: [{ id: 't7', type: 'FS' }], plannedHours: 56, actualHours: 0, budget: 28000, spent: 0 },
  { id: 't8m', proje: 'Mobil Uygulama', task: 'Sürüm 2.0 yayımlandı', keyword: 'Sürüm', sorumlu: ['Zeynep Aydın'], status: 'todo', priority: 'critical', milestone: true, baslangicTarihi: rel(27), bitisTarihi: rel(27), hedefTarih: rel(27), color: 'purple', deps: [{ id: 't8', type: 'FS' }], plannedHours: 0, actualHours: 0, budget: 0, spent: 0 },

  // Social
  { id: 't9', proje: 'Sosyal Medya', task: 'Haziran kampanya görsellerinin hazırlanması', keyword: 'Görseller', sorumlu: ['Ahmet Yılmaz'], status: 'in_progress', priority: 'medium', baslangicTarihi: rel(-6), bitisTarihi: rel(4), hedefTarih: rel(6), color: 'rose', progress: 50, plannedHours: 64, actualHours: 32, budget: 32000, spent: 14500 },
  { id: 't10', proje: 'Sosyal Medya', task: 'Influencer iş birlikleri ve içerik takvimi', keyword: 'Kampanya', sorumlu: ['Burak Şahin', 'Ayşe Kaya'], status: 'todo', priority: 'medium', baslangicTarihi: rel(2), bitisTarihi: rel(14), hedefTarih: rel(16), color: 'rose', plannedHours: 80, actualHours: 0, budget: 40000, spent: 0 },

  // DB
  { id: 't11', proje: 'Veritabanı Göçü', task: 'Mevcut kullanıcı verisinin yeni sunucuya taşınması', keyword: 'DB Göçü', sorumlu: ['Mehmet Demir', 'Can Özkan'], status: 'in_progress', priority: 'critical', baslangicTarihi: rel(-4), bitisTarihi: rel(3), hedefTarih: rel(2), color: 'amber', progress: 80, plannedHours: 56, actualHours: 48, budget: 28000, spent: 23000 },
  { id: 't12', proje: 'Veritabanı Göçü', task: 'İndeks ve sorgu optimizasyonu', keyword: 'Optimizasyon', sorumlu: ['Mehmet Demir'], status: 'todo', priority: 'high', baslangicTarihi: rel(4), bitisTarihi: rel(10), hedefTarih: rel(12), color: 'amber', deps: [{ id: 't11', type: 'FS' }], plannedHours: 48, actualHours: 0, budget: 24000, spent: 0 },
  { id: 't12m', proje: 'Veritabanı Göçü', task: 'Eski veritabanı devre dışı bırakıldı', keyword: 'Eski Sistem', sorumlu: ['Can Özkan'], status: 'todo', priority: 'high', milestone: true, baslangicTarihi: rel(13), bitisTarihi: rel(13), hedefTarih: rel(13), color: 'amber', deps: [{ id: 't12', type: 'FS' }], plannedHours: 0, actualHours: 0, budget: 0, spent: 0 },

  // Infra
  { id: 't13', proje: 'Altyapı', task: 'CI/CD pipeline yenilemesi', keyword: 'CI/CD', sorumlu: ['Can Özkan'], status: 'in_progress', priority: 'high', baslangicTarihi: rel(-10), bitisTarihi: rel(2), hedefTarih: rel(4), color: 'cyan', progress: 70, plannedHours: 80, actualHours: 64, budget: 40000, spent: 28500 },
  { id: 't14', proje: 'Altyapı', task: 'Sunucu işletim sistemi ve paket güncellemeleri', keyword: 'Sunucu', sorumlu: ['Can Özkan'], status: 'todo', priority: 'medium', baslangicTarihi: rel(3), bitisTarihi: rel(5), hedefTarih: rel(5), color: 'cyan', deps: [{ id: 't11', type: 'SS' }], plannedHours: 24, actualHours: 0, budget: 12000, spent: 0 },
  { id: 't15', proje: 'Altyapı', task: 'Felaket kurtarma planı dokümantasyonu', keyword: 'DR Plan', sorumlu: ['Can Özkan', 'Zeynep Aydın'], status: 'todo', priority: 'low', baslangicTarihi: rel(8), bitisTarihi: rel(20), hedefTarih: rel(22), color: 'cyan', plannedHours: 64, actualHours: 0, budget: 32000, spent: 0 },

  // Brand
  { id: 't16', proje: 'Marka Kimliği', task: 'Yeni logo varyasyonları ve kullanım kılavuzu', keyword: 'Logo', sorumlu: ['Ahmet Yılmaz', 'Elif Yıldız'], status: 'done', priority: 'medium', baslangicTarihi: rel(-40), bitisTarihi: rel(-22), hedefTarih: rel(-20), color: 'emerald', plannedHours: 88, actualHours: 92, budget: 44000, spent: 46000, progress: 100 },
  { id: 't17', proje: 'Marka Kimliği', task: 'Tipografi sisteminin yenilenmesi', keyword: 'Tipografi', sorumlu: ['Ahmet Yılmaz'], status: 'in_progress', priority: 'medium', baslangicTarihi: rel(-12), bitisTarihi: rel(1), hedefTarih: rel(3), color: 'emerald', progress: 85, plannedHours: 56, actualHours: 48, budget: 28000, spent: 23800 },
  { id: 't18', proje: 'Marka Kimliği', task: 'Marka rehberi PDF yayınlanması', keyword: 'Rehber', sorumlu: ['Elif Yıldız', 'Burak Şahin'], status: 'todo', priority: 'low', baslangicTarihi: rel(2), bitisTarihi: rel(9), hedefTarih: rel(11), color: 'emerald', deps: [{ id: 't17', type: 'FS' }], plannedHours: 40, actualHours: 0, budget: 20000, spent: 0 },

  // A late one
  { id: 't19', proje: 'Sosyal Medya', task: 'Q1 kampanya raporunun yöneticilere sunulması', keyword: 'Rapor', sorumlu: ['Zeynep Aydın'], status: 'in_progress', priority: 'high', baslangicTarihi: rel(-14), bitisTarihi: rel(-2), hedefTarih: rel(-3), color: 'rose', progress: 90, plannedHours: 24, actualHours: 26, budget: 12000, spent: 13000 }
];

export { CALENDARS };
export const PEOPLE = RAW_PEOPLE.map((person) => ({ ...person }));
export const PROJECTS = RAW_PROJECTS.map((project) => normalizeProjectReferences(project, PEOPLE));
export const WBS = PROJECTS.map((project, index) => ({
  id: `wbs-${project.id}-root`,
  projectId: project.id,
  parentId: null,
  code: String(index + 1),
  name: project.name
}));
export const TASKS = RAW_TASKS.map((task) => normalizeTaskReferences({
  ...task,
  deps: (task.deps || []).map(normalizeDependency)
}, { projects: PROJECTS, people: PEOPLE, wbs: WBS }));
