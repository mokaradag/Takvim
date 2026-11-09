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
export const CLARIFY_REASONS = Object.freeze(['missing_referent', 'ambiguous', 'analysis_budget']);

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

/** Kayıt defterindeki aracın sunucuya ait konu adı (ör. eksik bölümün konusu); tanınmayan konu `null`. */
export function plannerTopicLabel(topic, locale = 'tr') {
  return TOPIC_LABELS[topic]?.[localeIndex(locale)] || null;
}

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
  if (reason === 'analysis_budget') return index
    ? 'The requested analysis cannot be completed in one response within the read budget. Which analysis directions should I prioritize? Please ask again with the scope and the directions you want first.'
    : 'İstenen analiz tek yanıtta okuma bütçesine sığmıyor. Hangi analiz yönlerine öncelik vermemi istersiniz? Kapsamı ve önce görmek istediğiniz yönleri belirterek yeniden sorabilirsiniz.';
  if (reason === 'missing_referent') {
    return index ? 'It is not clear which record your question refers to. Could you ask again with the name or code of the task, project or person?'
      : 'Sorunuzda hangi kaydı kastettiğiniz belli değil. Görevin, projenin ya da kişinin adını veya kodunu yazarak sorunuzu yeniden sorar mısınız?';
  }
  const labels = [...new Set(topics.map((topic) => TOPIC_LABELS[topic]?.[index]).filter(Boolean))].slice(0, PLANNER_LIMITS.maxClarifyTopics);
  if (labels.length >= 2) {
    return index ? `Your question could refer to several Rota topics: ${joined(labels, locale)}. Please ask the full question again, including the record name or code and which topic you mean.`
      : `Sorunuz birden çok Rota konusuna uyuyor: ${joined(labels, locale)}. Kaydın adını veya kodunu ve hangi konuyu kastettiğinizi belirterek sorunun tamamını yeniden yazar mısınız?`;
  }
  return index ? 'Your question could refer to several Rota topics. Please ask the full question again, including the record name or code and which topic you mean.'
    : 'Sorunuz birden çok Rota konusuna uyabilir. Kaydın adını veya kodunu ve hangi konuyu kastettiğinizi belirterek sorunun tamamını yeniden yazar mısınız?';
}

/** Çekimserlik metni; tanınmayan neden güvenlik metnine düşer. */
export function renderPlannerAbstention({ reason, locale = 'tr' }) {
  return (ABSTAIN_TEXT[reason] || ABSTAIN_TEXT.security)[localeIndex(locale)];
}

/** Bağımlı bölümün yalnızca ilk kayıtlar için okunduğunu bildiren sunucu notu. */
export function renderDependentLimit({ shown, locale = 'tr' }) {
  return locale === 'en' ? `_Follow-up is limited to the first ${shown} source records._` : `_Takip bölümü kaynaktaki ilk ${shown} kayıtla sınırlıdır._`;
}

/**
 * İstenen kurumsal kapsam (ekip, birim, bölüm, direktörlük) kullanıcının yetki bağlamında yok: sabit sunucu metni.
 * Metin yalnızca kullanıcının KENDİ yönetim kapsamını anlatır; başka kişi ya da kaydın varlığını açıklamaz.
 */
export function renderScopeUnavailable({ locale = 'tr' } = {}) {
  return locale === 'en'
    ? 'You do not have a management scope for this team or organizational level, so Bilgin cannot analyze it. You can ask about your own tasks or about projects you can access.'
    : 'Bu ekip ya da kurumsal düzey için yönetim kapsamınız bulunmuyor; Bilgin bu kapsamı analiz edemez. Kendi görevleriniz ya da erişiminiz olan projeler hakkında sorabilirsiniz.';
}

/** Açık görselleştirme isteği doğrulanmış veriden güvenle karşılanamadığında kısa sunucu notu. */
export function renderChartUnavailable({ locale = 'tr', substituted = null, type = null } = {}) {
  const requested = CHART_TYPE_NAMES[type]?.[locale === 'en' ? 1 : 0];
  const other = CHART_TYPE_NAMES[substituted]?.[locale === 'en' ? 1 : 0];
  if (requested) return locale === 'en' ? `_The requested ${requested} could not be drawn safely; ${other ? `the data is shown as a ${other} instead` : 'the results are shown as text and tables'}._`
    : `_İstenen ${requested} güvenle çizilemedi; ${other ? `veri ${other} olarak gösterildi` : 'sonuçlar metin ve tablo olarak gösterildi'}._`;
  if (other) return locale === 'en' ? `_The requested chart could not be drawn safely; the data is shown as a ${other} instead._`
    : `_İstenen grafik güvenle çizilemedi; veri ${other} olarak gösterildi._`;
  return locale === 'en' ? '_A chart could not be drawn safely from this verified data; the results are shown as text and tables._'
    : '_Bu doğrulanmış veriden güvenle grafik çizilemedi; sonuçlar metin ve tablo olarak gösterildi._';
}

const CHART_TYPE_NEEDS = Object.freeze({
  bar: ['karşılaştırılabilir en az iki değer', 'at least two comparable values'],
  donut: ['birbirini dışlayan tam bir dağılım', 'a complete, mutually exclusive distribution'],
  line: ['ardışık aylara göre bir zaman dizisi', 'a time series over consecutive months'],
  stacked: ['satır başına tam bir durum kırılımı', 'a complete status breakdown per row'],
  kpi: ['en az üç başlık göstergesi', 'at least three headline figures'],
  timeline: ['tarihli görev satırları', 'dated task rows']
});
const CHART_TYPE_NAMES = Object.freeze({ bar: ['çubuk grafik', 'bar chart'], donut: ['halka grafik', 'donut chart'], line: ['çizgi grafik', 'line chart'],
  stacked: ['yığılmış çubuk grafik', 'stacked bar chart'], kpi: ['gösterge kartları', 'KPI card set'], timeline: ['zaman çizelgesi', 'timeline'] });

/**
 * İstenen grafik TÜRÜ doğrulanmış kanıttan çizilemediğinde türün gerektirdiği veriyi söyleyen kısa not; başka uygun bir
 * grafik çizildiyse bunu da söyler (yanlış grafik sessizce istenenin yerine geçmez).
 */
export function renderChartTypeUnavailable({ type, substituted = null, locale = 'tr' } = {}) {
  const en = locale === 'en';
  const need = CHART_TYPE_NEEDS[type];
  const name = CHART_TYPE_NAMES[type];
  if (!need || !name) return renderChartUnavailable({ locale });
  const other = substituted && CHART_TYPE_NAMES[substituted] ? CHART_TYPE_NAMES[substituted][en ? 1 : 0] : null;
  return en
    ? `_A ${name[1]} needs ${need[1]}, which this verified result does not contain${other ? `; the data is shown as a ${other} instead` : ''}._`
    : `_${name[0].charAt(0).toLocaleUpperCase('tr-TR')}${name[0].slice(1)} için ${need[0]} gerekir; bu doğrulanmış sonuçta bu veri yok${other ? `, bu yüzden veri ${other} olarak gösterildi` : ''}._`;
}

/** Tamamlanamayan bölüm için içeriksiz, sabit sunucu notu. */
export function renderPartUnavailable({ locale = 'tr' } = {}) {
  return locale === 'en' ? 'A requested section could not be completed safely. Please ask that section separately, including the record name or code.'
    : 'İstenen bir bölüm güvenle tamamlanamadı. Kaydın adını veya kodunu belirterek o bölümü ayrı bir soruyla yeniden sorabilirsiniz.';
}
