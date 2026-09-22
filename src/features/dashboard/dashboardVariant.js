import { SIMPLE_TASK_COLUMNS } from '../tasks/simpleTaskColumns.js';
import { taskActivityWindow, taskTargetWindow } from '../shared/dateRangeFilter.js';
import { SIMPLE_QUALITY_CHECK_IDS } from './planHealth.js';

/**
 * Özet panosunun kip profilleri.
 *
 * Pano TEKTİR; Temel ve Kapsamlı Kip aynı hesapları, aynı bileşenleri ve aynı
 * kanonik durum sınıflandırmasını kullanır. Kipler arasındaki tek fark bu
 * dosyadadır: hangi kartların açıldığı, tarih aralığının hangi alanı okuduğu ve
 * kullanıcıya hangi dilin gösterildiği.
 *
 * Temel profili yalnızca Görev + Durum + Sorumlu + Öncelik + Termin ile
 * anlaşılabilen kavramları açar. Plan bütünlüğü, bağımlılık riski, iş dağılım
 * ağacı ve planlanan/gerçekleşen tarih dili Kapsamlı Kipte kalır.
 */

const ADVANCED_KPI_COLUMNS = Object.freeze([
  Object.freeze({ key: 'task', label: 'Görev', filterType: 'text' }),
  Object.freeze({ key: 'proje', label: 'Proje', filterType: 'multi' }),
  Object.freeze({ key: 'sorumlu', label: 'Sorumlu', filterType: 'multi' }),
  Object.freeze({ key: 'status', label: 'Durum', filterType: 'multi' }),
  // Öncelik, Görevler tablosuyla AYNI kanonik modeli ve görsel dili kullanır;
  // ikinci bir öncelik uygulaması yoktur (bkz. domain/constants · PRIORITIES).
  Object.freeze({ key: 'priority', label: 'Öncelik', filterType: 'multi' }),
  Object.freeze({ key: 'plannedStart', label: 'Başlangıç', filterType: 'date' }),
  Object.freeze({ key: 'plannedFinish', label: 'Bitiş', filterType: 'date' }),
  Object.freeze({ key: 'targetFinish', label: 'Hedef', filterType: 'date' })
]);

const SIMPLE_KPI_FILTER_TYPES = Object.freeze({ task: 'text', targetFinish: 'date' });

// Temel sütun sözleşmesi Görevler sayfasıyla AYNI kaynaktan türetilir; ayrıca
// elde tutulan ikinci bir liste iki yüzey arasında sessizce ayrışırdı.
const SIMPLE_KPI_COLUMNS = Object.freeze(SIMPLE_TASK_COLUMNS.map((column) => Object.freeze({
  key: column.field,
  label: column.label,
  filterType: SIMPLE_KPI_FILTER_TYPES[column.field] || 'multi'
})));

const ADVANCED = Object.freeze({
  id: 'advanced',
  simple: false,
  dateRangeLabel: 'Tarih aralığı',
  dateWindow: taskActivityWindow,
  kpiColumns: ADVANCED_KPI_COLUMNS,
  kpiDateMode: 'effective',
  kpiDateLegend: true,
  // Varsayılan sıralama HEDEF tarihe göre eskiden yeniye; tarihi olmayan görev
  // en altta kalır (bkz. KpiTaskModal · KPI_DEFAULT_SORT).
  kpiDefaultSortKey: 'targetFinish',
  kpiSearchPlaceholder: 'Görev, proje veya sorumlu…',
  hygieneCheckIds: null,
  hygieneTitle: 'Plan bütünlüğü',
  hygieneIntro: 'Açık görevlerde eksik kalan planlama alanları. Yalnızca tamamlanmamış görevler denetlenir.',
  hygieneDetail: 'Sorumlusu, termini veya planlanan tarihi olmayan bir görev iş yükü, gecikme ve kritik yol hesaplarının hiçbirine girmez; sessizce kaybolur.',
  showDependencyRisks: true,
  showQuickTaskAction: false,
  projectCompletionLabel: 'İlerleme',
  healthTitle: 'Portföy sağlığı',
  healthSubtitle: (count) => `${count} proje · RAG değerlendirmesi`,
  healthStatusLabel: 'RAG',
  text: Object.freeze({
    totalTip: 'Sistemdeki tüm aktif ve kapanmış görevlerin sayısı. Projeler, sorumlular ve tarih aralıklarına göre filtrelenebilir.',
    doneTip: "Durumu 'Tamamlandı' olarak işaretlenmiş görev sayısı. Bu sayı tamamlanma oranını ve hız göstergelerini besler.",
    progressTip: 'Üzerinde çalışılan ve hedef tarihi henüz geçmemiş görevler. Hedefi geçmiş olanlar “Geciken” kartında sayılır; Yapılacak, Devam eden, Geciken ve Tamamlanan kartlarının toplamı her zaman toplam görev sayısına eşittir.',
    todoTip: 'Henüz başlanmamış ve hedef tarihi geçmemiş görevler. Halka grafiğindeki “Yapılacak” dilimiyle aynı kovadır.',
    overdueTip: 'Hedef tarihi geçmiş ve hâlâ tamamlanmamış görevler.',
    completionTrendInfo: 'Son 14 gün içinde tamamlanan görev sayısının birikimli değişimi. Bir görev, gerçekleşen bitiş tarihinde sayılır.',
    lateTaskLabel: 'Hedef tarihi geçmiş görevler',
    upcomingSubtitle: (limit) => `Hedef tarihi en yakın ${limit} görev`,
    upcomingInfo: 'Hedef tarihi en yakın olan, henüz tamamlanmamış görevler. Acil işlere bakmak için kullanın.',
    agingInfo: 'Geciken görevler, hedef tarihinin ÜZERİNDEN geçen gün sayısına göre gruplanır.',
    agingEmpty: 'Hedef tarihi geçmiş görev yok.'
  })
});

const SIMPLE = Object.freeze({
  id: 'simple',
  simple: true,
  dateRangeLabel: 'Termin aralığı',
  dateWindow: taskTargetWindow,
  kpiColumns: SIMPLE_KPI_COLUMNS,
  kpiDateMode: 'planned',
  kpiDateLegend: false,
  // Temel Kipte kanonik hedef bitiş alanı TERMİN olarak adlandırılır; sıralama
  // anahtarı aynı alandır.
  kpiDefaultSortKey: 'targetFinish',
  kpiSearchPlaceholder: 'Görev, proje, sorumlu veya kısa açıklama…',
  hygieneCheckIds: SIMPLE_QUALITY_CHECK_IDS,
  hygieneTitle: 'Görev kalitesi',
  hygieneIntro: 'Açık görevlerde eksik kalan alanlar. Kısa açıklama isteğe bağlıdır ve eksiklik sayılmaz.',
  hygieneDetail: 'Sorumlusu olmayan görev ekip iş yükünde görünmez. Termini olmayan görev gecikme ve yaklaşan teslim hesaplarına girmez.',
  showDependencyRisks: false,
  showQuickTaskAction: true,
  projectCompletionLabel: 'Tamamlanma',
  healthTitle: 'Proje durumu',
  healthSubtitle: (count) => `${count} proje · tamamlanan ve geciken görevler`,
  healthStatusLabel: 'Durum',
  text: Object.freeze({
    totalTip: 'Seçili Termin aralığındaki tüm görevlerin sayısı. Kurumsal süzgeç ve Termin aralığı bu sayıyı daraltır.',
    doneTip: "Durumu 'Tamamlandı' olarak işaretlenmiş görev sayısı. Tamamlanma oranını besler.",
    progressTip: 'Üzerinde çalışılan ve termini henüz geçmemiş görevler. Termini geçmiş olanlar “Geciken” kartında sayılır; Yapılacak, Devam eden, Geciken ve Tamamlanan kartlarının toplamı her zaman toplam görev sayısına eşittir.',
    todoTip: 'Henüz başlanmamış ve termini geçmemiş görevler. Halka grafiğindeki “Yapılacak” dilimiyle aynı kovadır.',
    overdueTip: 'Termini geçmiş ve hâlâ tamamlanmamış görevler.',
    completionTrendInfo: 'Son 14 günde tamamlanan görev sayısının birikimli değişimi. Görev, tamamlandığı gün grafiğe eklenir.',
    lateTaskLabel: 'Termini geçmiş görevler',
    upcomingSubtitle: (limit) => `Termini en yakın ${limit} görev`,
    upcomingInfo: 'Termini en yakın olan, henüz tamamlanmamış görevler. Acil işlere bakmak için kullanın.',
    agingInfo: 'Geciken görevler, termininin ÜZERİNDEN geçen gün sayısına göre gruplanır.',
    agingEmpty: 'Termini geçmiş görev yok.'
  })
});

export const DASHBOARD_VARIANTS = Object.freeze({ advanced: ADVANCED, simple: SIMPLE });

/** Bilinmeyen değer Kapsamlı profile düşer: Temel sınırı kazayla açılmaz. */
export function resolveDashboardVariant(variant) {
  return DASHBOARD_VARIANTS[variant] || ADVANCED;
}
