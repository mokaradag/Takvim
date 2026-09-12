import 'server-only';
import { COMPONENTS, COMPONENT_LABELS, componentTab } from '../../domain/observability/eventModel.js';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { isCorporateWbsSourceConfigured } from '../db/corporateWbsConfig.js';
import { smtpConfigurationProblem } from '../mail/smtpConfig.js';
import { isOutlookCalendarEnabled, outlookMaxAttempts } from '../outlook/outlookConfig.js';
import { outlookQueueStatus } from '../outlook/outlookStore.js';
import { outlookWorkerStatus } from '../outlook/outlookWorker.js';
import { loadReminderSettings } from '../reminders/reminderStore.js';
import { AUTH_MODES, keycloakConfigurationIssues, readKeycloakConfig, resolveAuthMode } from '../identity/keycloakConfig.js';
import {
  getCorporateWbsSyncTtlMs,
  hasCorporateWbsSyncedOnce
} from '../repository/corporateWbsSyncSchedule.js';
import {
  corporateSyncStaleHours,
  queueAgeAlertMinutes
} from './observabilityConfig.js';
import { boundedExecutor, probeDeadline } from './boundedExecution.js';
import { readResourceMetrics } from './resourceMetrics.js';
import {
  CORPORATE_PROJECT_PROBE_SQL,
  CORPORATE_WBS_STATE_SQL,
  DATABASE_PROBE_SQL,
  DIRECTORY_PROBE_SQL,
  OUTLOOK_QUEUE_AGE_SQL,
  REMINDER_RUN_STATE_SQL
} from './telemetryQueries.js';

/**
 * Bileşen sağlık yoklamaları.
 *
 * Her yoklama şunu ayırt eder: ÖLÇÜLDÜ VE İYİ / ÖLÇÜLDÜ VE KÖTÜ / ÖLÇÜLEMEDİ.
 * Üçüncü durum asla "sağlıklı" sayılmaz; son başarılı ölçüm anı ayrıca
 * taşınır ki yönetici "en son ne zaman çalışıyordu" sorusunu yanıtlayabilsin.
 */

const CACHE_KEY = Symbol.for('mergen-rota.health-probe-cache');
const DATABASE_SLOW_MS = 1000;

function cache() {
  globalThis[CACHE_KEY] ||= new Map();
  return globalThis[CACHE_KEY];
}

function rememberSuccess(key, at = new Date()) {
  cache().set(key, { lastSuccessAt: at.toISOString() });
  return cache().get(key).lastSuccessAt;
}

function lastSuccessAt(key) {
  return cache().get(key)?.lastSuccessAt || null;
}

export function resetHealthProbeCacheForTests() {
  globalThis[CACHE_KEY] = new Map();
}

function component(key, state, message, extra = {}) {
  return {
    key,
    label: COMPONENT_LABELS[key] || key,
    state,
    message,
    tab: componentTab(key),
    lastSuccessAt: extra.lastSuccessAt ?? lastSuccessAt(key),
    lastCheckedAt: extra.lastCheckedAt ?? new Date().toISOString(),
    durationMs: extra.durationMs ?? null,
    detail: extra.detail ?? null
  };
}

function ageMs(timestamp, now) {
  if (!timestamp) return null;
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) ? Math.max(0, now - value) : null;
}

/** Ana veritabanı: bağlanabiliyor mu, ne kadar sürede yanıtlıyor? */
export async function probeDatabase(executor, { now = Date.now(), timeoutMs = 3000 } = {}) {
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    await boundedExecutor(executor, deadline.signal).request().query(DATABASE_PROBE_SQL);
    const durationMs = Date.now() - startedAt;
    const successAt = rememberSuccess(COMPONENTS.DATABASE, new Date(now));
    if (durationMs > DATABASE_SLOW_MS) {
      return component(COMPONENTS.DATABASE, HEALTH_STATES.WARNING,
        `Veritabanı yanıt veriyor ancak yavaş (${durationMs} ms).`,
        { durationMs, lastSuccessAt: successAt });
    }
    return component(COMPONENTS.DATABASE, HEALTH_STATES.HEALTHY,
      `Bağlantı sağlıklı, yoklama ${durationMs} ms sürdü.`,
      { durationMs, lastSuccessAt: successAt });
  } catch {
    // Erişilemeyen veritabanı KRİTİKTİR: uygulamanın tamamı buna bağlıdır.
    return component(COMPONENTS.DATABASE, HEALTH_STATES.CRITICAL,
      'Ana veritabanına ulaşılamadı. Kalıcılaştırma ve oturum işlemleri çalışmaz.',
      { durationMs: Date.now() - startedAt });
  } finally {
    deadline.close();
  }
}

/** Kurumsal personel dizini ve proje kaynağı okunabiliyor mu? */
export async function probeCorporateDirectory(executor, { now = Date.now(), timeoutMs = 4000 } = {}) {
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const bounded = boundedExecutor(executor, deadline.signal);
    const people = await bounded.request().query(DIRECTORY_PROBE_SQL);
    const projects = await bounded.request().query(CORPORATE_PROJECT_PROBE_SQL);
    const peopleAvailable = Boolean(people.recordset?.length);
    const projectsAvailable = Boolean(projects.recordset?.length);
    const durationMs = Date.now() - startedAt;
    const detail = { peopleAvailable, projectsAvailable };
    if (!peopleAvailable) {
      return component(COMPONENTS.DIRECTORY, HEALTH_STATES.WARNING,
        'Kurumsal personel görünümü satır döndürmüyor. Kaynak tablo boş olabilir.',
        { durationMs, detail });
    }
    return component(COMPONENTS.DIRECTORY, HEALTH_STATES.HEALTHY,
      projectsAvailable
        ? 'Personel ve kurumsal proje kaynakları okunabiliyor.'
        : 'Personel kaynağı okunabiliyor; kurumsal proje görünümü satır döndürmedi.',
      { durationMs, detail, lastSuccessAt: rememberSuccess(COMPONENTS.DIRECTORY, new Date(now)) });
  } catch {
    return component(COMPONENTS.DIRECTORY, HEALTH_STATES.UNKNOWN,
      'Kurumsal personel/proje görünümleri bu yoklamada okunamadı.',
      { durationMs: Date.now() - startedAt });
  } finally {
    deadline.close();
  }
}

/** CN43N eşitlemesi: yapılandırılmış mı, en son ne zaman ve ne kadar taze? */
export async function probeCorporateWbs(executor, { now = Date.now(), timeoutMs = 4000 } = {}) {
  if (!isCorporateWbsSourceConfigured()) {
    return component(COMPONENTS.CORPORATE_WBS, HEALTH_STATES.NOT_CONFIGURED,
      'CN43N kaynağı yapılandırılmamış; kurumsal iş dağılım ağacı eşitlenmez.');
  }
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const result = await boundedExecutor(executor, deadline.signal).request().query(CORPORATE_WBS_STATE_SQL);
    const row = result.recordset?.[0] || {};
    const lastSyncedAt = row.LastSyncedAt ? new Date(row.LastSyncedAt).toISOString() : null;
    const detail = {
      lastSyncedAt,
      projectCount: Number(row.ProjectCount || 0),
      nodeCount: Number(row.NodeCount || 0),
      ttlMs: getCorporateWbsSyncTtlMs(),
      syncedInThisProcess: hasCorporateWbsSyncedOnce()
    };
    const durationMs = Date.now() - startedAt;
    if (!lastSyncedAt) {
      return component(COMPONENTS.CORPORATE_WBS, HEALTH_STATES.UNKNOWN,
        'Henüz kayıtlı bir CN43N eşitlemesi yok.', { durationMs, detail });
    }
    const staleAfterMs = corporateSyncStaleHours() * 3600000;
    const age = ageMs(lastSyncedAt, now);
    if (age != null && age > staleAfterMs) {
      return component(COMPONENTS.CORPORATE_WBS, HEALTH_STATES.WARNING,
        `Son başarılı eşitleme ${Math.round(age / 3600000)} saat önce; eşik ${corporateSyncStaleHours()} saat.`,
        { durationMs, detail, lastSuccessAt: lastSyncedAt });
    }
    return component(COMPONENTS.CORPORATE_WBS, HEALTH_STATES.HEALTHY,
      `${detail.projectCount} proje eşitlenmiş durumda.`,
      { durationMs, detail, lastSuccessAt: lastSyncedAt });
  } catch {
    return component(COMPONENTS.CORPORATE_WBS, HEALTH_STATES.UNKNOWN,
      'CN43N eşitleme durumu bu yoklamada okunamadı.', { durationMs: Date.now() - startedAt });
  } finally {
    deadline.close();
  }
}

/** SMTP: yapılandırma durumu. Yoklama posta GÖNDERMEZ. */
export function probeSmtp() {
  const problem = smtpConfigurationProblem();
  if (problem === 'SMTP_NOT_CONFIGURED') {
    return component(COMPONENTS.SMTP, HEALTH_STATES.NOT_CONFIGURED,
      'SMTP yapılandırılmamış; hatırlatma ve Outlook daveti gönderilemez.');
  }
  if (problem === 'SMTP_CONFIG_INVALID') {
    return component(COMPONENTS.SMTP, HEALTH_STATES.WARNING,
      'SMTP yapılandırması geçersiz. Sunucu, bağlantı noktası ve gönderen adresi değerlerini denetleyin.');
  }
  return component(COMPONENTS.SMTP, HEALTH_STATES.HEALTHY, 'SMTP yapılandırması eksiksiz.', {
    lastSuccessAt: lastSuccessAt(COMPONENTS.SMTP)
  });
}

/** Kimlik doğrulama: yapılandırma bütünlüğü. Gizli değer taşınmaz. */
export function probeAuthentication() {
  const mode = resolveAuthMode();
  if (mode === AUTH_MODES.DEVELOPMENT) {
    return component(COMPONENTS.AUTHENTICATION, HEALTH_STATES.WARNING,
      'Geliştirme kimliği etkin. Üretimde kurumsal oturum açma kullanılmalıdır.',
      { detail: { mode } });
  }
  const issues = keycloakConfigurationIssues(readKeycloakConfig());
  if (issues.length) {
    return component(COMPONENTS.AUTHENTICATION, HEALTH_STATES.CRITICAL,
      'Kurumsal oturum açma yapılandırması eksik; kullanıcılar oturum açamaz.',
      // Yalnızca eksik anahtar ADLARI taşınır; değerleri asla.
      { detail: { mode, missing: issues } });
  }
  return component(COMPONENTS.AUTHENTICATION, HEALTH_STATES.HEALTHY,
    'Kurumsal oturum açma yapılandırması eksiksiz.', { detail: { mode } });
}

/**
 * Outlook teslimatı: çalışan durumu + kuyruk sağlığı.
 *
 * DOLU kuyruk tek başına sorun değildir; YAŞLANAN ya da tıkanan kuyruk
 * sorundur. Bu yüzden hem sayımlar hem de yaş ölçüleri okunur.
 */
export async function probeOutlook(executor, { now = Date.now(), timeoutMs = 4000 } = {}) {
  if (!isOutlookCalendarEnabled()) {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.NOT_CONFIGURED,
      'Outlook takvim tümleştirmesi kapalı.', { detail: { enabled: false } });
  }
  const worker = outlookWorkerStatus();
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  let queue = null;
  let age = null;
  try {
    const bounded = boundedExecutor(executor, deadline.signal);
    queue = await outlookQueueStatus(bounded, outlookMaxAttempts());
    const result = await bounded.request().query(OUTLOOK_QUEUE_AGE_SQL);
    const row = result.recordset?.[0] || {};
    age = {
      oldestUnattemptedAt: row.OldestUnattemptedAt ? new Date(row.OldestUnattemptedAt).toISOString() : null,
      oldestPendingChangeAt: row.OldestPendingChangeAt ? new Date(row.OldestPendingChangeAt).toISOString() : null,
      maxAttemptCount: row.MaxAttemptCount == null ? 0 : Number(row.MaxAttemptCount),
      nextAttemptAt: row.NextAttemptAt ? new Date(row.NextAttemptAt).toISOString() : null,
      lastDeliveredAt: row.LastDeliveredAt ? new Date(row.LastDeliveredAt).toISOString() : null,
      lastFailureAt: row.LastFailureAt ? new Date(row.LastFailureAt).toISOString() : null
    };
  } catch {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.UNKNOWN,
      'Outlook kuyruk durumu bu yoklamada okunamadı.',
      { durationMs: Date.now() - startedAt, detail: { worker } });
  } finally {
    deadline.close();
  }

  const durationMs = Date.now() - startedAt;
  const detail = { worker, queue, age };
  if (age.lastDeliveredAt) rememberSuccess(COMPONENTS.OUTLOOK, new Date(age.lastDeliveredAt));
  const successAt = age.lastDeliveredAt || lastSuccessAt(COMPONENTS.OUTLOOK);

  // Çalışan bu süreçte hiç rapor vermediyse "çalışıyor" VARSAYILMAZ.
  const heartbeatAge = ageMs(worker.lastFinishedAt, now);
  const heartbeatLimit = Math.max(60000, Number(worker.intervalMs || 5000) * 12);
  if (!worker.started) {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.CRITICAL,
      'Otomatik Outlook çalışanı bu sunucuda başlamamış; kuyruk işlenmiyor.',
      { durationMs, detail, lastSuccessAt: successAt });
  }
  if (heartbeatAge != null && heartbeatAge > heartbeatLimit) {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.CRITICAL,
      'Outlook çalışanı beklenen aralıkta tur tamamlamadı.',
      { durationMs, detail, lastSuccessAt: successAt });
  }
  if (queue.exhausted > 0) {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.CRITICAL,
      `${queue.exhausted} teslimat deneme eşiğini aştı ve elle inceleme bekliyor.`,
      { durationMs, detail, lastSuccessAt: successAt });
  }
  const waitingAge = ageMs(age.oldestUnattemptedAt, now);
  const ageLimitMs = queueAgeAlertMinutes() * 60000;
  if (waitingAge != null && waitingAge > ageLimitMs) {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.WARNING,
      `En eski bekleyen teslimat ${Math.round(waitingAge / 60000)} dakikadır işlenmedi.`,
      { durationMs, detail, lastSuccessAt: successAt });
  }
  if (queue.failed > 0) {
    return component(COMPONENTS.OUTLOOK, HEALTH_STATES.WARNING,
      `${queue.failed} teslimat hata aldı ve yeniden denenecek.`,
      { durationMs, detail, lastSuccessAt: successAt });
  }
  return component(COMPONENTS.OUTLOOK, HEALTH_STATES.HEALTHY,
    queue.pending > 0 ? `${queue.pending} teslimat sırada, kuyruk akıyor.` : 'Kuyruk boş; teslimat bekleyen kayıt yok.',
    { durationMs, detail, lastSuccessAt: successAt });
}

/** Hatırlatma hizmeti: zamanlayıcı durumu ve son turun sonucu. */
export async function probeReminders(executor, { now = Date.now(), timeoutMs = 4000 } = {}) {
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const bounded = boundedExecutor(executor, deadline.signal);
    const settings = await loadReminderSettings(bounded);
    let lastRun = null;
    try {
      const result = await bounded.request().query(REMINDER_RUN_STATE_SQL);
      const row = result.recordset?.[0];
      if (row) {
        lastRun = {
          status: String(row.Status || ''),
          startedAt: row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null,
          completedAt: row.CompletedAt ? new Date(row.CompletedAt).toISOString() : null,
          failureCode: row.FailureCode || null
        };
      }
    } catch {
      lastRun = null;
    }
    const durationMs = Date.now() - startedAt;
    const detail = {
      automaticEnabled: Boolean(settings.automaticEnabled),
      schemaReady: settings.schemaReady !== false,
      lastRun
    };
    if (settings.schemaReady === false) {
      return component(COMPONENTS.REMINDER, HEALTH_STATES.WARNING,
        'Hatırlatma tabloları bulunamadı; varsayılan şablonla çalışılıyor.', { durationMs, detail });
    }
    if (!settings.automaticEnabled) {
      return component(COMPONENTS.REMINDER, HEALTH_STATES.NOT_CONFIGURED,
        'Otomatik hatırlatma kapalı. Elle gönderim etkilenmez.', { durationMs, detail });
    }
    if (lastRun?.status === 'FAILED') {
      return component(COMPONENTS.REMINDER, HEALTH_STATES.WARNING,
        `Son otomatik hatırlatma turu başarısız (${lastRun.failureCode || 'bilinmeyen kod'}).`,
        { durationMs, detail });
    }
    const successAt = lastRun?.status === 'SENT' ? (lastRun.completedAt || lastRun.startedAt) : lastSuccessAt(COMPONENTS.REMINDER);
    if (successAt) rememberSuccess(COMPONENTS.REMINDER, new Date(successAt));
    return component(COMPONENTS.REMINDER, HEALTH_STATES.HEALTHY,
      'Otomatik hatırlatma etkin.', { durationMs, detail, lastSuccessAt: successAt });
  } catch {
    return component(COMPONENTS.REMINDER, HEALTH_STATES.UNKNOWN,
      'Hatırlatma yapılandırması bu yoklamada okunamadı.', { durationMs: Date.now() - startedAt });
  } finally {
    deadline.close();
  }
}

/** Süreç kaynakları: bellek baskısı ölçülebiliyorsa değerlendirilir. */
export function probeResources({ memoryPressureRatio = 0.9 } = {}) {
  const metrics = readResourceMetrics();
  const ratio = metrics.heapUsedRatio;
  const detail = {
    rss: metrics.rss.value,
    heapUsed: metrics.heapUsed.value,
    heapTotal: metrics.heapTotal.value,
    uptimeSeconds: metrics.uptimeSeconds.value,
    runtimeVersion: metrics.runtimeVersion,
    platform: metrics.platform
  };
  if (!ratio.available) {
    return component(COMPONENTS.RESOURCES, HEALTH_STATES.UNKNOWN,
      'Süreç bellek oranı bu çalışma zamanında ölçülemiyor.', { detail });
  }
  if (ratio.value >= memoryPressureRatio) {
    return component(COMPONENTS.RESOURCES, HEALTH_STATES.WARNING,
      `Yığın kullanımı %${Math.round(ratio.value * 100)} düzeyinde.`, { detail });
  }
  return component(COMPONENTS.RESOURCES, HEALTH_STATES.HEALTHY,
    `Yığın kullanımı %${Math.round(ratio.value * 100)}.`, { detail, lastSuccessAt: new Date().toISOString() });
}

/** Uygulamanın kendisi: isteği yanıtlayabildiği için ölçülmüş sayılır. */
export function probeApplication({ startedAt = null } = {}) {
  const metrics = readResourceMetrics();
  return component(COMPONENTS.APPLICATION, HEALTH_STATES.HEALTHY,
    'Uygulama isteklere yanıt veriyor.',
    {
      lastSuccessAt: new Date().toISOString(),
      detail: {
        uptimeSeconds: metrics.uptimeSeconds.value,
        runtimeVersion: metrics.runtimeVersion,
        startedAt
      }
    });
}
