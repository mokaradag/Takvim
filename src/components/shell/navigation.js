export const NAV_ITEMS = [
  { id: 'ozet', label: 'Özet', icon: 'Dashboard' },
  { id: 'veri', label: 'Görevler', icon: 'Table' },
  { id: 'talepler', label: 'Talepler', icon: 'Bell' },
  { id: 'wbs', label: 'Proje Yapısı', icon: 'Layers' },
  { id: 'takvim', label: 'Takvim', icon: 'Calendar' },
  { id: 'gantt', label: 'Gantt', icon: 'Gantt' },
  { id: 'kanban', label: 'Kanban', icon: 'Kanban' },
  { id: 'rapor', label: 'Raporlar', icon: 'Chart' },
  { id: 'kisi', label: 'Ekip', icon: 'Users' },
  { id: 'yardim', label: 'Kullanım Rehberi', icon: 'Help' },
  { id: 'ayarlar', label: 'Ayarlar', icon: 'Settings' },
  // Yönetici sayfası: gezinmede YALNIZCA sistem yöneticisine gösterilir
  // (bkz. ADMIN_NAV_IDS). Asıl sınır sunucudadır; gizleme güvenlik değildir.
  // Hatırlatma yapılandırması bu sayfanın bir sekmesidir.
  { id: 'sistem', label: 'Sistem Yönetimi', icon: 'Activity' }
];

/** Yalnızca sistem yöneticisine gösterilen sayfalar. */
export const ADMIN_NAV_IDS = new Set(['sistem']);

/** Yönetim sayfası projeye değil, SİSTEME aittir: proje bağlamı gösterilmez. */
export const GLOBAL_NAV_IDS = new Set(['sistem', 'ayarlar', 'yardim']);

const SIMPLE_CALENDAR_TABS = ['calendar', 'entry'];

export function simpleCalendarTabId(tab) {
  return `simple-calendar-${tab}-tab`;
}

export function simpleCalendarPanelId(tab) {
  return `simple-calendar-${tab}-panel`;
}

/** Sekme ok tuşları uçlarda sarar; diğer tuşlar seçimi değiştirmez. */
export function nextSimpleCalendarTab(active, key) {
  if (!['ArrowLeft', 'ArrowRight'].includes(key)) return null;
  const currentIndex = Math.max(0, SIMPLE_CALENDAR_TABS.indexOf(active));
  const direction = key === 'ArrowRight' ? 1 : -1;
  return SIMPLE_CALENDAR_TABS[
    (currentIndex + direction + SIMPLE_CALENDAR_TABS.length) % SIMPLE_CALENDAR_TABS.length
  ];
}

/** Temel Kip Takvim'e giriş niyetini açılacak alt sekmeye dönüştürür. */
export function simpleCalendarTabForIntent(intent = null) {
  return intent === 'entry' ? 'entry' : 'calendar';
}

export const PAGE_META = {
  ozet: { title: 'Özet', sub: 'Genel görünüm ve metrikler' },
  veri: { title: 'Görevler', sub: 'Görevleri listele ve düzenle' },
  talepler: { title: 'Talepler', sub: 'Tarih değişikliği talepleri ve karar geçmişi' },
  wbs: { title: 'Proje Yapısı', sub: 'Proje tanımları, etiketler ve iş dağılım ağacı' },
  takvim: { title: 'Takvim', sub: 'Aylık görünüm' },
  gantt: { title: 'Gantt', sub: 'Zaman çizelgesi ve bağımlılıklar' },
  kanban: { title: 'Kanban', sub: 'Durum panosu' },
  rapor: { title: 'Raporlar', sub: 'Çevrim süresi, performans ve eğilimler' },
  kisi: { title: 'Ekip', tab: 'kisi', sub: 'Ekip üyeleri ve iş yükü' },
  yardim: { title: 'Kullanım Rehberi', sub: 'MERGEN Rota kullanım adımları ve sayfa açıklamaları' },
  ayarlar: { title: 'Ayarlar', sub: 'Görünüm ve tercihler' },
  sistem: { title: 'Sistem Yönetimi', sub: 'Sistem sağlığı, başarım, kuyruklar, olaylar ve entegrasyonlar' }
};

export const SIMPLE_NAV_IDS = new Set(['veri', 'takvim', 'talepler', 'yardim', 'ayarlar']);

export function navigationItems(simple, isSystemAdmin) {
  return NAV_ITEMS.filter((item) => (!simple || SIMPLE_NAV_IDS.has(item.id) || ADMIN_NAV_IDS.has(item.id))
    && (!ADMIN_NAV_IDS.has(item.id) || isSystemAdmin));
}
