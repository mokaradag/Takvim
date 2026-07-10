/* ============================================================
   Data layer — sample tasks, projects, people + date utils
   ============================================================ */

// ── Date utilities (no date-fns dependency) ────────────────
const MS_DAY = 86400000;
export const TR_MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
export const TR_MONTHS_LONG = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const TR_DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export function parseDate(s) {
  if (s instanceof Date) return s;
  if (!s) return new Date();
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function fmtISO(d) {
  d = (d instanceof Date) ? d : parseDate(d);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function fmt(d, pattern = 'dd MMM') {
  d = parseDate(d);
  const day = String(d.getDate()).padStart(2, '0');
  const dayShort = d.getDate();
  if (pattern === 'dd MMM') return `${day} ${TR_MONTHS[d.getMonth()]}`;
  if (pattern === 'dd MMM yyyy') return `${day} ${TR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (pattern === 'MMM yyyy') return `${TR_MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  if (pattern === 'd') return String(dayShort);
  if (pattern === 'EEE d') return `${TR_DAYS[(d.getDay() + 6) % 7]} ${dayShort}`;
  return d.toLocaleDateString('tr-TR');
}
export function addDays(d, n) {
  d = parseDate(d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export function diffDays(a, b) {
  a = parseDate(a); b = parseDate(b);
  return Math.round((a.getTime() - b.getTime()) / MS_DAY);
}
export function startOfMonth(d) { d = parseDate(d); return new Date(d.getFullYear(), d.getMonth(), 1); }
export function endOfMonth(d) { d = parseDate(d); return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
export function startOfWeek(d) {
  d = parseDate(d);
  const day = (d.getDay() + 6) % 7; // Monday start
  return addDays(d, -day);
}
export function endOfWeek(d) { return addDays(startOfWeek(d), 6); }
export function isSameDay(a, b) {
  a = parseDate(a); b = parseDate(b);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
export function isWeekend(d) {
  d = parseDate(d);
  const day = d.getDay();
  return day === 0 || day === 6;
}
export function today() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
export function eachDay(start, end) {
  const out = [];
  let cur = parseDate(start);
  const last = parseDate(end);
  while (cur <= last) {
    out.push(new Date(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

// ── Sample data ────────────────────────────────────────────
export const PROJECTS = [
  { id: 'p-web', name: 'Web Sitesi Yenileme', color: 'blue', lead: 'Ahmet Yılmaz' },
  { id: 'p-mobile', name: 'Mobil Uygulama', color: 'purple', lead: 'Mehmet Demir' },
  { id: 'p-social', name: 'Sosyal Medya', color: 'rose', lead: 'Ayşe Kaya' },
  { id: 'p-db', name: 'Veritabanı Göçü', color: 'amber', lead: 'Can Özkan' },
  { id: 'p-infra', name: 'Altyapı', color: 'cyan', lead: 'Can Özkan' },
  { id: 'p-brand', name: 'Marka Kimliği', color: 'emerald', lead: 'Elif Yıldız' }
];

export const PEOPLE = [
  { id: 'u-ahmet', name: 'Ahmet Yılmaz', role: 'Senior Designer', team: 'Tasarım', color: 'blue' },
  { id: 'u-mehmet', name: 'Mehmet Demir', role: 'Backend Lead', team: 'Mühendislik', color: 'purple' },
  { id: 'u-ayse', name: 'Ayşe Kaya', role: 'Frontend Engineer', team: 'Mühendislik', color: 'emerald' },
  { id: 'u-elif', name: 'Elif Yıldız', role: 'QA Engineer', team: 'Mühendislik', color: 'rose' },
  { id: 'u-can', name: 'Can Özkan', role: 'DevOps Engineer', team: 'Operasyon', color: 'amber' },
  { id: 'u-zeynep', name: 'Zeynep Aydın', role: 'Product Manager', team: 'Ürün', color: 'cyan' },
  { id: 'u-burak', name: 'Burak Şahin', role: 'Content Strategist', team: 'Pazarlama', color: 'purple' }
];

// Helper to build a date around today (May 16, 2026)
function rel(days) { return fmtISO(addDays(today(), days)); }

// ── Turkish public holidays (MM-DD) + named events ─────────
export const HOLIDAYS = [
  { date: '01-01', name: 'Yılbaşı', short: 'Yılbaşı' },
  { date: '04-23', name: 'Ulusal Egemenlik ve Çocuk Bayramı', short: '23 Nisan' },
  { date: '05-01', name: 'Emek ve Dayanışma Günü', short: '1 Mayıs' },
  { date: '05-19', name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı', short: '19 Mayıs' },
  { date: '07-15', name: 'Demokrasi ve Milli Birlik Günü', short: '15 Temmuz' },
  { date: '08-30', name: 'Zafer Bayramı', short: '30 Ağustos' },
  { date: '10-29', name: 'Cumhuriyet Bayramı', short: '29 Ekim' },
  // Religious holidays — 2026 dates (approximate official)
  { date: '03-20', name: 'Ramazan Bayramı (1. Gün)', short: 'Ramazan B.' },
  { date: '03-21', name: 'Ramazan Bayramı (2. Gün)', short: 'Ramazan B.' },
  { date: '03-22', name: 'Ramazan Bayramı (3. Gün)', short: 'Ramazan B.' },
  { date: '05-27', name: 'Kurban Bayramı (1. Gün)', short: 'Kurban B.' },
  { date: '05-28', name: 'Kurban Bayramı (2. Gün)', short: 'Kurban B.' },
  { date: '05-29', name: 'Kurban Bayramı (3. Gün)', short: 'Kurban B.' },
  { date: '05-30', name: 'Kurban Bayramı (4. Gün)', short: 'Kurban B.' }
];
export function holidayFor(d) {
  d = parseDate(d);
  const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return HOLIDAYS.find(h => h.date === key) || null;
}

// ── Relationship type metadata ────────────────────────────
export const REL_TYPES = {
  FS: {
    code: 'FS', name: 'Bitiş → Başlangıç', short: 'Finish-to-Start',
    description: 'Önceki görev bitmeden bu görev başlayamaz. En sık kullanılan ilişki türüdür.',
    example: 'Tasarım onaylanmadan kodlama başlatılamaz.'
  },
  SS: {
    code: 'SS', name: 'Başlangıç → Başlangıç', short: 'Start-to-Start',
    description: 'Önceki görev başlamadan bu görev de başlayamaz. Görevler birlikte başlar, paralel ilerler.',
    example: 'Belgeleme, geliştirme ile birlikte başlar.'
  },
  FF: {
    code: 'FF', name: 'Bitiş → Bitiş', short: 'Finish-to-Finish',
    description: 'Önceki görev bitmeden bu görev de bitemez. Görevler birlikte tamamlanır.',
    example: 'Test, geliştirme ile birlikte tamamlanır.'
  },
  SF: {
    code: 'SF', name: 'Başlangıç → Bitiş', short: 'Start-to-Finish',
    description: 'Önceki görev başlamadan bu görev bitemez. Nadiren kullanılır; vardiya/devir senaryolarında görülür.',
    example: 'Yeni sistem devreye girene kadar eski sistem kapatılamaz.'
  }
};
export function relTypeOf(dep) {
  if (typeof dep === 'string') return 'FS';
  return (dep && dep.type) || 'FS';
}
export function depId(dep) { return typeof dep === 'string' ? dep : dep.id; }

export const TASKS = [
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

// ── Priority metadata ────────────────────────────────────
export const PRIORITIES = {
  critical: { id: 'critical', label: 'Kritik', color: 'var(--status-overdue)', order: 0 },
  high: { id: 'high', label: 'Yüksek', color: 'oklch(70% 0.16 50)', order: 1 },
  medium: { id: 'medium', label: 'Orta', color: 'oklch(70% 0.13 200)', order: 2 },
  low: { id: 'low', label: 'Düşük', color: 'var(--text-dim)', order: 3 }
};

// ── Color resolver ─────────────────────────────────────────
export const COLOR_MAP = {
  blue: 'var(--c-blue)',
  emerald: 'var(--c-emerald)',
  purple: 'var(--c-purple)',
  amber: 'var(--c-amber)',
  rose: 'var(--c-rose)',
  cyan: 'var(--c-cyan)'
};
export function projectColorVar(name) {
  const p = PROJECTS.find(p => p.name === name);
  return p ? COLOR_MAP[p.color] : COLOR_MAP.blue;
}
export function projectColorKey(name) {
  const p = PROJECTS.find(p => p.name === name);
  return p ? p.color : 'blue';
}
export function personColorVar(name) {
  const u = PEOPLE.find(u => u.name === name);
  return u ? COLOR_MAP[u.color] : COLOR_MAP.blue;
}
export function personInitials(name) {
  return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

// ── Status helpers ─────────────────────────────────────────
export function getStatus(t) {
  if (t.status === 'done') return { id: 'done', label: 'Tamamlandı', cls: 'status-done' };
  const overdue = !!t.hedefTarih && diffDays(t.hedefTarih, today()) < 0 && t.status !== 'done';
  if (overdue) return { id: 'overdue', label: 'Geciken', cls: 'status-overdue' };
  if (t.status === 'in_progress') return { id: 'in_progress', label: 'Devam ediyor', cls: 'status-progress' };
  return { id: 'todo', label: 'Yapılacak', cls: 'status-todo' };
}
