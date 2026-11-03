/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string|null} [leadId]
 * @property {string|null} [calendarId]
 * @property {string|null} dataDate Proje durum ve kesim tarihi; kayıtlı proje denetim verisidir, tarayıcı bugünü veya hesaplanan bitiş değildir.
 * @property {string[]} [tags] Denetimli proje etiket kataloğu; görev bu listeden açıkça değer seçer.
 * @property {string} [lead] Mevcut arayüz için korunan eski görünüm alanı.
 */

/**
 * @typedef {Object} Person
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string} team
 * @property {string} color
 */

/**
 * İş dağılım ağacı düğümü; çizelge toplamı alt görevden türetilir ve burada saklanmaz.
 * @typedef {Object} WbsNode
 * @property {string} id Genel kararlı ilişki anahtarı.
 * @property {string} projectId Sahip proje kimliği.
 * @property {string|null} parentId Aynı projede üst WBS kimliği; kökte boş değer.
 * @property {string} code Belirlenimci projeye özgü görünüm kodu.
 * @property {string} name
 * @property {number} [sortOrder] Kod ve ad sırasından önce kullanılan belirlenimci kardeş sırası.
 */

/**
 * Proje ve görev çizelgeleme takvimi. JavaScript gün numarası kullanılır:
 * pazar sıfır, cumartesi altıdır. Tatiller açık ISO tarihleridir; hareketli
 * tatiller sonraki yıllarda sessizce yinelenmez.
 * @typedef {Object} SchedulingCalendar
 * @property {string} id
 * @property {string} name
 * @property {string} timezone
 * @property {number[]} workingDays
 * @property {{date:string,name:string,short?:string}[]} holidays
 */

/**
 * Kanonik bağımlılık biçimi; eski id alanı sahte bağdaştırıcıda korunur.
 * Arayüz geçişi sürerken predecessorId kararlı ilişki anahtarıdır.
 * lagDays çizelgeleme motorunun kullandığı normal iş günü değeridir.
 * lagValue ve lagUnit kullanıcının seçtiği öne alma ve gecikme gösterimini korur.
 * @typedef {Object} Dependency
 * @property {string} predecessorId
 * @property {'FS'|'SS'|'FF'|'SF'} type
 * @property {number} lagDays
 * @property {number} [lagValue]
 * @property {'day'|'week'|'month'} [lagUnit]
 * @property {string} [id]
 */

/**
 * Kanonik görev ve faaliyet kaydı. Güncel plan, hedef, gerçekleşen ve kalan iş
 * değerleri kayıtlı veridir. CPM erken ve geç tarihi, bolluk ve kritik durum görev alanı değildir.
 * @typedef {Object} Task
 * @property {string} id
 * @property {string|null} projectId
 * @property {string[]} assigneeIds
 * @property {string|null} wbsId Kararlı WBS ilişkisi; varsa projectId sahibi düğüme başvurmalıdır.
 * @property {string|null} [calendarId] Proje takviminin isteğe bağlı görev düzeyi değişimi.
 * @property {Dependency[]} deps
 * @property {string} task
 * @property {string} status
 * @property {string|null} plannedStart Değişebilir güncel plan başlangıcı.
 * @property {string|null} plannedFinish Değişebilir güncel plan bitişi.
 * @property {number|null} plannedDurationDays Güncel plan tarihinden normalleştirilmiş iş günü süresi; kilometre taşı sıfırdır.
 * @property {string|null} targetFinish Yönetim hedefi ve termin; kendiliğinden CPM kısıtı değildir.
 * @property {string|null} actualStart Gerçekleşen başlangıç; yaşam döngüsü kuralıyla tamamlanır, plandan türetilmez.
 * @property {string|null} actualFinish Gerçekleşen bitiş; tamamlanma niyetiyle doldurulur, ilerlemeden türetilmez.
 * @property {number|null} remainingDurationDays Gelecekteki kullanım için korunan nullable uyumluluk alanı.
 * @property {string} [proje] Mevcut arayüz için korunan eski görünüm alanı.
 * @property {string[]} [sorumlu] Mevcut arayüz için korunan eski görünüm alanı.
 */

/**
 * Değişmez baz plan başlığı; görev görüntüsü ayrı saklanır ve güncel plan düzenlemesi geçmişi değiştirmez.
 * @typedef {Object} Baseline
 * @property {string} id
 * @property {string} projectId
 * @property {string} name
 * @property {string} createdAt
 * @property {boolean} isPrimary
 */

/**
 * @typedef {Object} TaskBaselineSnapshot
 * @property {string} baselineId
 * @property {string} taskId
 * @property {string|null} plannedStart
 * @property {string|null} plannedFinish
 * @property {number|null} plannedDurationDays
 * @property {string|null} calendarId
 */

/**
 * Türetilmiş CPM sonucu; hesaplanmış izdüşümler kanonik görev kaydına kopyalanmaz.
 * @typedef {Object} CpmTaskResult
 * @property {string} id
 * @property {string} calendarId
 * @property {number} durationDays Bu CPM hesabında kullanılan iş günü süresi.
 * @property {string} earlyStart
 * @property {string} earlyFinish
 * @property {string} lateStart
 * @property {string} lateFinish
 * @property {number} totalFloatDays
 * @property {number} freeFloatDays
 * @property {boolean} isCritical
 */

export const DOMAIN_MODEL_VERSION = 5;
