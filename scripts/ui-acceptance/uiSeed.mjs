/**
 * Sentetik UI kabul verisi (gerçek kişi/proje yok). Tarihler çalıştırma gününe göredir (Türkiye günü).
 * Profiller: A sıradan çalışan, B ekip lideri, C yönetimi olmayan sistem yöneticisi, D ekip lideri + yönetici,
 * E proje odaklı (proje lideri, yönetim kapsamı yok), F kısıtlı görünüm, G görevsiz kullanıcı.
 */
export const P = Object.freeze({
  A: 920001, B: 920002, C: 920003, D: 920004, E: 920005, F: 920006, G: 920007,
  MEHMET_KAYA: 920011, MEHMET_YILDIZ: 920012, SELIN: 920013, BURAK: 920014,
  ECE: 920021, ONUR: 920022, ZEHRA: 920023, HAKAN: 920031, GIZEM: 920032, CEM: 920041
});
const pid = (n) => `11000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = (n) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const PROJ = Object.freeze({ ALTYAPI: pid(1), MOBIL: pid(2), AMBAR: pid(3), SIBER: pid(4), PORTAL: pid(5), EGITIM: pid(6), ARGE: pid(7) });
const CAL = '41000000-0000-4000-8000-000000000001';

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const d = (offset) => new Date(Date.parse(`${todayIso()}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

const TITLES = ['Gereksinim incelemesi', 'Sunucu kurulumu', 'Ağ yapılandırması', 'Test planı', 'Kullanıcı kabul testi', 'Veri taşıma betiği', 'Güvenlik taraması',
  'Dokümantasyon güncellemesi', 'Performans ölçümü', 'Yedekleme doğrulaması', 'Arayüz tasarımı', 'API entegrasyonu', 'Raporlama modülü', 'Eğitim materyali',
  'Lisans yenileme', 'Erişim gözden geçirmesi', 'Kapasite planı', 'Sürüm notları', 'Hata ayıklama oturumu', 'Tedarikçi toplantısı', 'Yük testi', 'Göç provası',
  'Politika taslağı', 'Denetim kanıtları', 'Mobil bildirimler', 'Oturum yönetimi', 'Veri kalitesi kontrolü', 'Pano tasarımı', 'Kurulum kılavuzu', 'Risk değerlendirmesi'];

/**
 * Görev tanımı: [proje, sorumlular, durum, öncelik, termin ofseti (gün), başlık sırası]. Durum: t yapılacak, p devam ediyor, d tamamlandı.
 */
const SPEC = [
  // A — Elif Arslan (sıradan çalışan): üç projede 12 görev
  [PROJ.ALTYAPI, [P.A], 'p', 'high', -16, 0], [PROJ.ALTYAPI, [P.A], 't', 'critical', -9, 1], [PROJ.ALTYAPI, [P.A], 'p', 'medium', 2, 2],
  [PROJ.ALTYAPI, [P.A], 't', 'medium', 5, 3], [PROJ.ALTYAPI, [P.A], 'd', 'medium', -6, 4], [PROJ.MOBIL, [P.A], 't', 'high', -2, 10],
  [PROJ.MOBIL, [P.A], 'p', 'medium', 3, 11], [PROJ.MOBIL, [P.A], 't', 'low', 18, 12], [PROJ.MOBIL, [P.A], 'd', 'high', -12, 13],
  [PROJ.AMBAR, [P.A], 't', 'high', 6, 5], [PROJ.AMBAR, [P.A], 't', 'medium', 24, 26], [PROJ.AMBAR, [P.A], 'd', 'low', -20, 7],
  // B — Kerem Aydın (ekip lideri) ve ekibi
  [PROJ.ALTYAPI, [P.B], 'p', 'high', 1, 16], [PROJ.ALTYAPI, [P.B], 't', 'medium', 9, 17], [PROJ.SIBER, [P.B], 't', 'high', -4, 6],
  [PROJ.ALTYAPI, [P.B], 'd', 'medium', -3, 18], [PROJ.PORTAL, [P.B], 't', 'low', 21, 19], [PROJ.ALTYAPI, [P.B], 'p', 'critical', 4, 29],
  [PROJ.ALTYAPI, [P.MEHMET_KAYA], 't', 'critical', -21, 20], [PROJ.ALTYAPI, [P.MEHMET_KAYA], 'p', 'high', -11, 21], [PROJ.ALTYAPI, [P.MEHMET_KAYA], 't', 'high', -5, 22],
  [PROJ.ALTYAPI, [P.MEHMET_KAYA], 'p', 'medium', 2, 8], [PROJ.SIBER, [P.MEHMET_KAYA], 't', 'medium', 6, 9], [PROJ.SIBER, [P.MEHMET_KAYA], 't', 'low', 15, 23],
  [PROJ.ALTYAPI, [P.MEHMET_KAYA], 'd', 'medium', -8, 24], [PROJ.PORTAL, [P.MEHMET_KAYA], 't', 'medium', 27, 25],
  [PROJ.MOBIL, [P.MEHMET_YILDIZ], 't', 'high', -7, 26], [PROJ.MOBIL, [P.MEHMET_YILDIZ], 'p', 'medium', 4, 27], [PROJ.MOBIL, [P.MEHMET_YILDIZ], 't', 'medium', 12, 28],
  [PROJ.MOBIL, [P.MEHMET_YILDIZ], 'd', 'low', -15, 0], [PROJ.PORTAL, [P.MEHMET_YILDIZ], 't', 'low', 30, 1],
  [PROJ.PORTAL, [P.SELIN], 'p', 'high', 1, 2], [PROJ.PORTAL, [P.SELIN], 't', 'medium', 3, 3], [PROJ.PORTAL, [P.SELIN], 't', 'medium', 6, 4],
  [PROJ.PORTAL, [P.SELIN], 'd', 'high', -2, 5], [PROJ.PORTAL, [P.SELIN], 'd', 'medium', -9, 6], [PROJ.AMBAR, [P.SELIN], 't', 'low', 20, 7],
  [PROJ.AMBAR, [P.BURAK], 't', 'medium', -1, 8], [PROJ.AMBAR, [P.BURAK], 'p', 'medium', 8, 9], [PROJ.AMBAR, [P.BURAK], 'd', 'low', -18, 10],
  [PROJ.ALTYAPI, [P.MEHMET_KAYA, P.SELIN], 't', 'high', 5, 11],
  // D — Murat Öztürk (ekip lideri + yönetici) ve ekibi
  [PROJ.SIBER, [P.D], 'p', 'high', 2, 12], [PROJ.SIBER, [P.D], 't', 'critical', -3, 13], [PROJ.SIBER, [P.D], 'd', 'medium', -10, 14], [PROJ.EGITIM, [P.D], 't', 'low', 19, 15],
  [PROJ.SIBER, [P.ECE], 't', 'critical', -13, 16], [PROJ.SIBER, [P.ECE], 'p', 'high', -6, 17], [PROJ.SIBER, [P.ECE], 't', 'high', 1, 18], [PROJ.SIBER, [P.ECE], 't', 'medium', 4, 19],
  [PROJ.SIBER, [P.ECE], 'p', 'medium', 9, 20], [PROJ.SIBER, [P.ECE], 'd', 'medium', -5, 21],
  [PROJ.EGITIM, [P.ONUR], 't', 'medium', 3, 22], [PROJ.EGITIM, [P.ONUR], 'd', 'low', -7, 23], [PROJ.EGITIM, [P.ONUR], 'p', 'medium', 13, 24], [PROJ.EGITIM, [P.ONUR], 't', 'low', 25, 25],
  [PROJ.SIBER, [P.ZEHRA], 't', 'high', -2, 26], [PROJ.SIBER, [P.ZEHRA], 'p', 'medium', 5, 27], [PROJ.EGITIM, [P.ZEHRA], 't', 'medium', 7, 28],
  [PROJ.EGITIM, [P.ZEHRA], 'd', 'medium', -11, 29], [PROJ.SIBER, [P.ZEHRA], 't', 'low', 16, 0],
  // E — Canan Er (proje lideri) ve kendi görevleri; projelerinde başkalarının işleri yukarıda
  [PROJ.MOBIL, [P.E], 'p', 'high', 2, 1], [PROJ.AMBAR, [P.E], 't', 'medium', 10, 2], [PROJ.PORTAL, [P.E], 'd', 'medium', -4, 3],
  [PROJ.AMBAR, [P.GIZEM], 't', 'critical', -14, 4], [PROJ.AMBAR, [P.GIZEM], 'p', 'high', -3, 5], [PROJ.MOBIL, [P.GIZEM], 't', 'medium', 8, 6],
  [PROJ.MOBIL, [P.HAKAN], 't', 'medium', -8, 7], [PROJ.PORTAL, [P.HAKAN], 'p', 'medium', 11, 8],
  // C — Ayla Demir (yönetici, yönetim kapsamı yok)
  [PROJ.EGITIM, [P.C], 't', 'medium', 6, 9], [PROJ.EGITIM, [P.C], 'd', 'low', -9, 10],
  // F — Okan Tekin (kısıtlı görünüm): gizli projede ortak sorumluluklu işler; astı Cem
  [PROJ.ARGE, [P.F, P.HAKAN], 'p', 'high', -5, 11], [PROJ.ARGE, [P.F], 't', 'medium', 4, 12], [PROJ.ARGE, [P.F, P.GIZEM], 't', 'medium', 14, 13],
  [PROJ.ARGE, [P.CEM, P.HAKAN], 't', 'high', -6, 14], [PROJ.ARGE, [P.CEM], 'p', 'medium', 2, 15], [PROJ.ARGE, [P.CEM, P.GIZEM], 't', 'medium', 9, 16],
  [PROJ.ARGE, [P.HAKAN], 't', 'critical', -10, 17], [PROJ.ARGE, [P.HAKAN], 'p', 'high', 3, 18], [PROJ.ARGE, [P.GIZEM], 't', 'medium', 7, 19],
  // Eğitim projesinde dağılım için ek işler
  [PROJ.EGITIM, [P.HAKAN], 't', 'medium', -4, 20], [PROJ.EGITIM, [P.HAKAN], 'd', 'medium', -14, 21]
];

const STATUS = { t: 'planned', p: 'in-progress', d: 'done' };

export function uiSeed() {
  const tasks = [];
  const taskAssignees = [];
  SPEC.forEach(([projectId, sicils, status, priority, offset, title], index) => {
    const id = tid(index + 1);
    const done = status === 'd';
    tasks.push({
      TaskId: id, ProjectId: projectId, Title: TITLES[title % TITLES.length], Status: STATUS[status], Priority: priority,
      TargetFinish: d(offset), PlannedStart: d(offset - 10), PlannedFinish: d(offset), CalendarId: CAL,
      ...(done ? { ActualStart: d(offset - 8), ActualFinish: d(Math.min(offset, 0)), Progress: 100 } : { Progress: status === 'p' ? 40 : 0 }),
      PlannedHours: 8 + (index % 5) * 4
    });
    for (const sicil of sicils) taskAssignees.push({ TaskId: id, Sicil: sicil });
  });
  const person = (Sicil, DisplayName, Username, Unit = 'BT', Department = 'Teknoloji', Directorate = 'Bilgi Sistemleri') => ({ Sicil, DisplayName, Username, Unit, Department, Directorate });
  return {
    people: [
      person(P.A, 'Elif Arslan', 'earslan'), person(P.B, 'Kerem Aydın', 'kaydin'), person(P.C, 'Ayla Demir', 'ademir', 'Yönetim'),
      person(P.D, 'Murat Öztürk', 'mozturk', 'Güvenlik'), person(P.E, 'Canan Er', 'cer', 'PMO'), person(P.F, 'Okan Tekin', 'otekin', 'Ar-Ge'),
      person(P.G, 'Deniz Yalın', 'dyalin'), person(P.MEHMET_KAYA, 'Mehmet Kaya', 'mkaya'), person(P.MEHMET_YILDIZ, 'Mehmet Yıldız', 'myildiz'),
      person(P.SELIN, 'Selin Çelik', 'scelik'), person(P.BURAK, 'Burak Şahin', 'bsahin'), person(P.ECE, 'Ece Tan', 'etan', 'Güvenlik'),
      person(P.ONUR, 'Onur Aksoy', 'oaksoy', 'Güvenlik'), person(P.ZEHRA, 'Zehra Uçar', 'zucar', 'Güvenlik'), person(P.HAKAN, 'Hakan Polat', 'hpolat', 'Ar-Ge'),
      person(P.GIZEM, 'Gizem Er', 'ger', 'Ar-Ge'), person(P.CEM, 'Cem Bulut', 'cbulut', 'Ar-Ge')
    ],
    systemAdminSicils: [P.C, P.D],
    executiveScope: [
      ...[P.MEHMET_KAYA, P.MEHMET_YILDIZ, P.SELIN, P.BURAK].map((EmployeeSicil) => ({ ManagerSicil: P.B, EmployeeSicil })),
      ...[P.ECE, P.ONUR, P.ZEHRA, P.MEHMET_KAYA].map((EmployeeSicil) => ({ ManagerSicil: P.D, EmployeeSicil })),
      { ManagerSicil: P.F, EmployeeSicil: P.CEM }
    ],
    calendars: [{ CalendarId: CAL, Name: 'Türkiye Standart', TimeZone: 'Europe/Istanbul', IsDefault: 1, IsActive: 1, WorkingDays: [1, 2, 3, 4, 5], Holidays: [] }],
    projects: [
      { ProjectId: PROJ.ALTYAPI, SourceType: 'MANUAL', ProjectCode: 'ALT', ProjectName: 'Altyapı Yenileme', LeadSicil: P.B, CalendarId: CAL },
      { ProjectId: PROJ.MOBIL, SourceType: 'MANUAL', ProjectCode: 'MOB', ProjectName: 'Mobil Uygulama', LeadSicil: P.E, CalendarId: CAL },
      { ProjectId: PROJ.AMBAR, SourceType: 'MANUAL', ProjectCode: 'VAG', ProjectName: 'Veri Ambarı Göçü', LeadSicil: P.E, CalendarId: CAL },
      { ProjectId: PROJ.SIBER, SourceType: 'MANUAL', ProjectCode: 'SGD', ProjectName: 'Siber Güvenlik Denetimi', LeadSicil: P.D, CalendarId: CAL },
      { ProjectId: PROJ.PORTAL, SourceType: 'MANUAL', ProjectCode: 'MPO', ProjectName: 'Müşteri Portalı', LeadSicil: P.E, CalendarId: CAL },
      { ProjectId: PROJ.EGITIM, SourceType: 'MANUAL', ProjectCode: 'EGP', ProjectName: 'Eğitim Programı', LeadSicil: P.HAKAN, CalendarId: CAL },
      { ProjectId: PROJ.ARGE, SourceType: 'MANUAL', ProjectCode: 'ARG', ProjectName: 'Gizli Ar-Ge', LeadSicil: P.HAKAN, CalendarId: CAL }
    ],
    projectAccess: [],
    tasks,
    taskAssignees
  };
}
