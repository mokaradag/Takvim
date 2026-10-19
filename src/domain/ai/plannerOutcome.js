/**
 * Rota AI planlayıcı sonuçları (Aşama 4C) — saf sözleşme ve SUNUCUYA AİT metinler.
 *
 * Planlayıcı veri okumadan önce türlü bir karar verir: yanıtla (`rota`), genel
 * sohbete yönlendir (`general`), gerçek belirsizlikte açıklama iste (`clarify`)
 * ya da desteklenmeyen/güvensiz istekte çekimser kal (`abstain`). Açıklama ve
 * çekimserlik sonlandırıcıdır: Rota verisi okunmaz, kullanıcı aşağıdaki sabit
 * metni görür. Model metni gösterilmez; model yalnızca kapalı kümeden neden
 * (ve açıklamada en çok dört yetenek konusu) seçer.
 */

export const PLANNER_INTENTS = Object.freeze({ ROTA: 'rota', GENERAL: 'general', CLARIFY: 'clarify', ABSTAIN: 'abstain' });

/** Açıklama nedenleri: soruda göndergesi belirsiz kayıt ya da birden çok Rota yeteneğine eşit uyan istek. */
export const CLARIFY_REASONS = Object.freeze(['missing_referent', 'ambiguous']);

/** Çekimserlik nedenleri: yazma, desteklenmeyen hesap, Rota dışı veri, kimlik/yetki/ham sorgu girişimi, genel bilgi. */
export const ABSTAIN_REASONS = Object.freeze(['write', 'calculation', 'outside_data', 'security', 'general']);

export const PLANNER_LIMITS = Object.freeze({ maxRequests: 3, maxClarifyTopics: 4, maxDependentRows: 3 });

const TOPIC_LABELS = Object.freeze({
  tasks: ['görevler', 'tasks'],
  projects: ['projeler', 'projects'],
  portfolio: ['proje portföyü', 'project portfolio'],
  wbs: ['iş dağılım yapısı', 'work breakdown structure'],
  workload: ['iş yükü', 'workload'],
  people: ['kişiler', 'people'],
  activity: ['görev hareketleri', 'task activity'],
  requests: ['talepler', 'requests'],
  notifications: ['bildirimler', 'notifications'],
  baseline: ['baz plan', 'baseline'],
  dependencies: ['bağımlılıklar', 'dependencies'],
  recurrence: ['tekrarlayan görevler', 'recurring tasks'],
  calendar: ['çalışma takvimi', 'working calendar'],
  outlook: ['Outlook takvimi', 'Outlook calendar'],
  quality: ['plan veri kalitesi', 'plan data quality']
});

const ABSTAIN_TEXT = Object.freeze({
  write: [
    'Bilgin Rota verisini yalnızca okuyabilir: görev oluşturamaz, düzenleyemez ya da atayamaz; durum veya tarih değiştiremez, talebi karara bağlayamaz ve bildirimleri okundu olarak işaretleyemez. Bu işlemi Rota ekranlarından yapabilirsiniz.',
    'Bilgin can only read Rota data: it cannot create, edit or assign tasks, change a status or date, decide a request or mark notifications as read. Please use the Rota screens for this action.'
  ],
  calculation: [
    'Bu hesap Rota araçlarının ürettiği sonuçlardan biri değil (ör. kritik yol, bolluk süresi ya da kapasite); Bilgin bunu hesaplayamaz ya da tahmin edemez.',
    'This calculation is not produced by the Rota tools (for example critical path, float or capacity); Bilgin cannot calculate or estimate it.'
  ],
  outside_data: [
    "Bu bilgi Rota'da tutulmuyor. Bilgin yalnızca Rota'daki görev, proje, iş akışı ve takvim verisini, görmeye yetkili olduğunuz ölçüde okuyabilir.",
    'This information is not kept in Rota. Bilgin can only read the Rota task, project, workflow and calendar data you are authorized to see.'
  ],
  security: [
    'Bu istek yerine getirilemez. Bilgin yalnızca oturumunuzdaki kimlikle, görmeye yetkili olduğunuz veriyi sabit ve salt okunur araçlarla okur; başka bir kimlik, ham sorgu ya da yetki dışı erişim kullanılamaz.',
    'This request cannot be carried out. Bilgin reads only the data you are authorized to see, with your signed-in identity and fixed read-only tools; another identity, a raw query or unauthorized access cannot be used.'
  ],
  general: [
    'Genel açıklama için Genel sohbet seçeneğini seçin. Rota verisi yanıtları güncel kanıt gerektirir.',
    'Select General chat for a general explanation. Rota data answers require current evidence.'
  ]
});

const localeIndex = (locale) => (locale === 'en' ? 1 : 0);

/** Plan geçerli ama yalnızca kullanıcının açmadığı kayıtlı serbest metni gerektiriyor: veri okunmaz. */
export function renderTextFieldsRequired({ locale = 'tr' } = {}) {
  return localeIndex(locale)
    ? 'This question needs saved free text (a description, a request or decision message, or change text). Turn on "Notes and messages" in the chat box and ask again.'
    : 'Bu soru kayıtlı serbest metni (açıklama, talep ya da karar iletisi, değişiklik metni) gerektiriyor. Sohbet kutusundaki "Notlar ve iletiler" anahtarını açıp sorunuzu yeniden sorabilirsiniz.';
}

function joined(labels, locale) {
  if (labels.length < 2) return labels.join('');
  const last = labels.at(-1);
  return `${labels.slice(0, -1).join(', ')} ${locale === 'en' ? 'or' : 'ya da'} ${last}`;
}

/** Açıklama metni; konular kayıt defterindeki araçların sunucuya ait konularıdır (yinelenen etiket bir kez yazılır). */
export function renderPlannerClarification({ reason, topics = [], locale = 'tr' }) {
  const index = localeIndex(locale);
  if (reason === 'missing_referent') {
    return index ? 'It is not clear which record your question refers to. Could you ask again with the name or code of the task, project or person?'
      : 'Sorunuzda hangi kaydı kastettiğiniz belli değil. Görevin, projenin ya da kişinin adını veya kodunu yazarak sorunuzu yeniden sorar mısınız?';
  }
  const labels = [...new Set(topics.map((topic) => TOPIC_LABELS[topic]?.[index]).filter(Boolean))].slice(0, PLANNER_LIMITS.maxClarifyTopics);
  if (labels.length >= 2) {
    return index ? `Your question could refer to several Rota topics: ${joined(labels, locale)}. Could you say which one you mean, with a little more detail?`
      : `Sorunuz birden çok Rota konusuna uyuyor: ${joined(labels, locale)}. Hangisini kastettiğinizi biraz daha ayrıntılı yazar mısınız?`;
  }
  return index ? 'Your question could refer to several Rota topics. Could you say which one you mean, with a little more detail?'
    : 'Sorunuz birden çok Rota konusuna uyabilir. Hangisini kastettiğinizi biraz daha ayrıntılı yazar mısınız?';
}

/** Çekimserlik metni; tanınmayan neden güvenlik metnine düşer. */
export function renderPlannerAbstention({ reason, locale = 'tr' }) {
  return (ABSTAIN_TEXT[reason] || ABSTAIN_TEXT.security)[localeIndex(locale)];
}

/** Bağımlı bölümün yalnızca ilk kayıtlar için okunduğunu bildiren sunucu notu. */
export function renderDependentLimit({ shown, locale = 'tr' }) {
  return locale === 'en' ? `_Details are shown for the first ${shown} records._` : `_Ayrıntılar ilk ${shown} kayıt için gösterildi._`;
}
