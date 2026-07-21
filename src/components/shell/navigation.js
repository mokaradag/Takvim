export const NAV_ITEMS = [
  { id: 'ozet', label: 'Özet', icon: 'Dashboard' },
  { id: 'veri', label: 'Görevler', icon: 'Table' },
  { id: 'wbs', label: 'İş Kırılım Yapısı', icon: 'Layers' },
  { id: 'takvim', label: 'Takvim', icon: 'Calendar' },
  { id: 'gantt', label: 'Gantt', icon: 'Gantt' },
  { id: 'kanban', label: 'Kanban', icon: 'Kanban' },
  { id: 'rapor', label: 'Raporlar', icon: 'Chart' },
  { id: 'kisi', label: 'Ekip', icon: 'Users' },
  { id: 'ayarlar', label: 'Ayarlar', icon: 'Settings' }
];

export const PAGE_META = {
  ozet: { title: 'Özet', sub: 'Genel görünüm ve metrikler' },
  veri: { title: 'Görevler', sub: 'Görevleri listele ve düzenle' },
  wbs: { title: 'İş Kırılım Yapısı', sub: 'Proje hiyerarşisi ve aktivite kapsamı' },
  takvim: { title: 'Takvim', sub: 'Aylık görünüm' },
  gantt: { title: 'Gantt', sub: 'Zaman çizelgesi ve bağımlılıklar' },
  kanban: { title: 'Kanban', sub: 'Durum panosu' },
  rapor: { title: 'Raporlar', sub: 'Çevrim süresi, performans ve trendler' },
  kisi: { title: 'Ekip', tab: 'kisi', sub: 'Ekip üyeleri ve iş yükü' },
  ayarlar: { title: 'Ayarlar', sub: 'Görünüm ve tercihler' }
};
