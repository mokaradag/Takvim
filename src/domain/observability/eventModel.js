import { HEALTH_STATES } from './healthModel.js';

/**
 * İşletim olayı ve uyarı sözleşmesi.
 *
 * Olaylar HAM GÜNLÜK SATIRI DEĞİLDİR: her olayın kararlı bir kodu, bileşeni,
 * ağırlığı ve yöneticinin okuyabileceği bir özeti vardır. Aynı sorunun binlerce
 * yinelenmesi tek bir uyarıda toplanır (bkz. `alertKey`).
 */

export const EVENT_SEVERITIES = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL'
});

const SEVERITY_WEIGHT = Object.freeze({
  [EVENT_SEVERITIES.INFO]: 1,
  [EVENT_SEVERITIES.WARNING]: 2,
  [EVENT_SEVERITIES.ERROR]: 3,
  [EVENT_SEVERITIES.CRITICAL]: 4
});

export const SEVERITY_LABELS = Object.freeze({
  [EVENT_SEVERITIES.INFO]: 'Bilgi',
  [EVENT_SEVERITIES.WARNING]: 'Uyarı',
  [EVENT_SEVERITIES.ERROR]: 'Hata',
  [EVENT_SEVERITIES.CRITICAL]: 'Kritik'
});

export const ALERT_STATES = Object.freeze({
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED'
});

export const ALERT_STATE_LABELS = Object.freeze({
  [ALERT_STATES.OPEN]: 'Açık',
  [ALERT_STATES.ACKNOWLEDGED]: 'Onaylandı',
  [ALERT_STATES.RESOLVED]: 'Çözüldü'
});

/** Gözlemlenen alt sistemler. Bileşen kimlikleri hem sağlık hem olay tarafında aynıdır. */
export const COMPONENTS = Object.freeze({
  APPLICATION: 'APPLICATION',
  DATABASE: 'DATABASE',
  CORPORATE_WBS: 'CORPORATE_WBS',
  DIRECTORY: 'DIRECTORY',
  AUTHENTICATION: 'AUTHENTICATION',
  SMTP: 'SMTP',
  OUTLOOK: 'OUTLOOK',
  REMINDER: 'REMINDER',
  API: 'API',
  RESOURCES: 'RESOURCES'
});

export const COMPONENT_LABELS = Object.freeze({
  [COMPONENTS.APPLICATION]: 'MERGEN Rota uygulaması',
  [COMPONENTS.DATABASE]: 'Ana SQL Server',
  [COMPONENTS.CORPORATE_WBS]: 'CN43N / kurumsal WBS',
  [COMPONENTS.DIRECTORY]: 'Kurumsal personel ve proje kaynağı',
  [COMPONENTS.AUTHENTICATION]: 'Kimlik doğrulama ve oturum',
  [COMPONENTS.SMTP]: 'SMTP posta sunucusu',
  [COMPONENTS.OUTLOOK]: 'Outlook takvim teslimatı',
  [COMPONENTS.REMINDER]: 'Hatırlatma hizmeti',
  [COMPONENTS.API]: 'Uygulama uçları',
  [COMPONENTS.RESOURCES]: 'Süreç kaynakları'
});

/** Sistem Yönetimi sekme kimlikleri; olay/bileşen tıklaması buraya götürür. */
export const ADMIN_TABS = Object.freeze({
  OVERVIEW: 'genel',
  PERFORMANCE: 'performans',
  QUEUES: 'kuyruklar',
  EVENTS: 'olaylar',
  INTEGRATIONS: 'entegrasyonlar',
  REMINDERS: 'hatirlatma'
});

const COMPONENT_TABS = Object.freeze({
  [COMPONENTS.APPLICATION]: ADMIN_TABS.OVERVIEW,
  [COMPONENTS.DATABASE]: ADMIN_TABS.INTEGRATIONS,
  [COMPONENTS.CORPORATE_WBS]: ADMIN_TABS.QUEUES,
  [COMPONENTS.DIRECTORY]: ADMIN_TABS.INTEGRATIONS,
  [COMPONENTS.AUTHENTICATION]: ADMIN_TABS.INTEGRATIONS,
  [COMPONENTS.SMTP]: ADMIN_TABS.INTEGRATIONS,
  [COMPONENTS.OUTLOOK]: ADMIN_TABS.QUEUES,
  [COMPONENTS.REMINDER]: ADMIN_TABS.REMINDERS,
  [COMPONENTS.API]: ADMIN_TABS.PERFORMANCE,
  [COMPONENTS.RESOURCES]: ADMIN_TABS.PERFORMANCE
});

/**
 * Kararlı olay kodları.
 *
 * Kodlar İSTEMCİYE kadar taşınır ve belgelenir; ileti metni değişse bile kod
 * aynı kalır. `action` alanı yöneticinin atabileceği somut adımı anlatır.
 */
export const EVENT_CODES = Object.freeze({
  APP_STARTED: {
    severity: EVENT_SEVERITIES.INFO,
    component: COMPONENTS.APPLICATION,
    summary: 'Uygulama başlatıldı'
  },
  DATABASE_UNAVAILABLE: {
    severity: EVENT_SEVERITIES.CRITICAL,
    component: COMPONENTS.DATABASE,
    summary: 'Ana veritabanına ulaşılamıyor',
    action: 'SQL Server erişimini ve bağlantı yapılandırmasını denetleyin.'
  },
  DATABASE_SLOW: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.DATABASE,
    summary: 'Veritabanı yanıt süresi yükseldi',
    action: 'Sunucu yükünü ve uzun süren sorguları inceleyin.'
  },
  CORPORATE_WBS_SYNC_FAILED: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.CORPORATE_WBS,
    summary: 'CN43N eşitlemesi başarısız',
    action: 'Kurumsal WBS kaynağının erişilebilirliğini denetleyin.'
  },
  CORPORATE_WBS_STALE: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.CORPORATE_WBS,
    summary: 'CN43N eşitlemesi beklenenden eski',
    action: 'Kuyruklar ve İşler sekmesinden eşitlemeyi yeniden çalıştırın.'
  },
  SMTP_NOT_CONFIGURED: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.SMTP,
    summary: 'SMTP yapılandırılmamış',
    action: 'Sunucudaki ortam dosyasına SMTP_HOST ve SMTP_FROM değerlerini ekleyin.'
  },
  SMTP_CONFIG_INVALID: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.SMTP,
    summary: 'SMTP yapılandırması geçersiz',
    action: 'Sunucu adresi, bağlantı noktası ve gönderen adresi değerlerini denetleyin.'
  },
  SMTP_DELIVERY_FAILED: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.SMTP,
    summary: 'SMTP teslimatı başarısız',
    action: 'Posta sunucusu erişimini ve kimlik doğrulama ayarlarını denetleyin.'
  },
  AUTHENTICATION_MISCONFIGURED: {
    severity: EVENT_SEVERITIES.CRITICAL,
    component: COMPONENTS.AUTHENTICATION,
    summary: 'Kurumsal oturum açma yapılandırması eksik',
    action: 'Eksik kimlik doğrulama ayarlarını tamamlayın; kullanıcılar oturum açamaz.'
  },
  OUTLOOK_WORKER_STALE: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.OUTLOOK,
    summary: 'Outlook çalışanı beklenen aralıkta rapor vermedi',
    action: 'Sunucu başlatma günlüğünü ve çalışan durumunu inceleyin.'
  },
  OUTLOOK_QUEUE_AGING: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.OUTLOOK,
    summary: 'Outlook kuyruğundaki en eski kayıt eşiği aştı',
    action: 'Kuyruklar ve İşler sekmesinden turu çalıştırın ve hataları inceleyin.'
  },
  OUTLOOK_DELIVERY_FAILED: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.OUTLOOK,
    summary: 'Outlook teslimatları başarısız',
    action: 'Başarısız kayıtların hata kodunu inceleyip yeniden deneyin.'
  },
  REMINDER_RUN_FAILED: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.REMINDER,
    summary: 'Hatırlatma turu başarısız',
    action: 'Hatırlatma E-postaları sekmesindeki gönderim geçmişini inceleyin.'
  },
  API_ERROR_RATE_HIGH: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.API,
    summary: 'Uç hata oranı eşiği aştı',
    action: 'Hatalar ve Olaylar sekmesinde ilgili uç kodlarını inceleyin.'
  },
  API_LATENCY_HIGH: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.API,
    summary: 'P95 yanıt süresi eşiği aştı',
    action: 'Performans sekmesinde yavaş işlemleri inceleyin.'
  },
  MEMORY_PRESSURE: {
    severity: EVENT_SEVERITIES.WARNING,
    component: COMPONENTS.RESOURCES,
    summary: 'Süreç bellek kullanımı sürekli yüksek',
    action: 'Süreç belleğini ve eşzamanlı istek sayısını izleyin.'
  },
  ADMIN_ACTION_EXECUTED: {
    severity: EVENT_SEVERITIES.INFO,
    component: COMPONENTS.APPLICATION,
    summary: 'Yönetici eylemi çalıştırıldı'
  },
  OPERATION_FAILED: {
    severity: EVENT_SEVERITIES.ERROR,
    component: COMPONENTS.API,
    summary: 'İşlem tamamlanamadı'
  }
});

export function isEventSeverity(value) {
  return Object.hasOwn(SEVERITY_WEIGHT, String(value ?? ''));
}

export function normalizeSeverity(value) {
  return isEventSeverity(value) ? String(value) : EVENT_SEVERITIES.INFO;
}

export function severityLabel(value) {
  return SEVERITY_LABELS[normalizeSeverity(value)];
}

export function severityWeight(value) {
  return SEVERITY_WEIGHT[normalizeSeverity(value)];
}

export function componentLabel(value) {
  return COMPONENT_LABELS[String(value ?? '')] || String(value ?? '');
}

export function componentTab(value) {
  return COMPONENT_TABS[String(value ?? '')] || ADMIN_TABS.OVERVIEW;
}

/** Kod kataloğundaki tanım; bilinmeyen kod güvenli bir yedeğe düşer. */
export function eventDefinition(code) {
  return EVENT_CODES[String(code ?? '')] || EVENT_CODES.OPERATION_FAILED;
}

export function eventSummary(code, fallback = '') {
  return fallback || eventDefinition(code).summary;
}

export function eventAction(code) {
  return eventDefinition(code).action || null;
}

/** Olay ağırlığının sağlık durumu karşılığı. */
export function severityToHealthState(severity) {
  const normalized = normalizeSeverity(severity);
  if (normalized === EVENT_SEVERITIES.CRITICAL) return HEALTH_STATES.CRITICAL;
  if (normalized === EVENT_SEVERITIES.ERROR || normalized === EVENT_SEVERITIES.WARNING) return HEALTH_STATES.WARNING;
  return HEALTH_STATES.HEALTHY;
}

/**
 * Aynı sorunun tek bir uyarıda toplanmasını sağlayan kararlı anahtar.
 *
 * 800 özdeş SMTP hatası 800 uyarı üretmez: aynı anahtar altında sayaç artar.
 */
export function alertKey(component, code, scope = null) {
  const suffix = scope == null || scope === '' ? '' : `:${String(scope).slice(0, 80)}`;
  return `${String(component || COMPONENTS.APPLICATION)}:${String(code || 'OPERATION_FAILED')}${suffix}`.slice(0, 200);
}
