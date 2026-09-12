import 'server-only';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { getCorporateWbsPool } from '../db/corporateWbsPool.js';
import { isCorporateWbsSourceConfigured } from '../db/corporateWbsConfig.js';
import { verifyMailConnection } from '../mail/mailService.js';
import { smtpConfigurationProblem } from '../mail/smtpConfig.js';
import { isOutlookCalendarEnabled } from '../outlook/outlookConfig.js';
import { AUTH_MODES, keycloakConfigurationIssues, readKeycloakConfig, resolveAuthMode } from '../identity/keycloakConfig.js';
import { boundedExecutor, probeDeadline } from './boundedExecution.js';
import {
  CORPORATE_PROJECT_PROBE_SQL,
  CORPORATE_RESPONSIBILITY_PROBE_SQL,
  DATABASE_PROBE_SQL,
  DIRECTORY_PROBE_SQL
} from './telemetryQueries.js';

/**
 * Entegrasyon sağlığı.
 *
 * Soru tektir: "MERGEN Rota bağımlılıklarına ULAŞABİLİYOR ve onları
 * KULLANABİLİYOR mu?" Kart hiçbir koşulda parola, jeton, bağlantı dizesi ya da
 * adres bilgisi taşımaz — yalnızca `Yapılandırılmış` / `Yapılandırılmamış`
 * bilgisi, durum ve gecikme.
 *
 * Outlook tümleştirmesi Graph/EWS DEĞİLDİR: MERGEN Rota takvim davetlerini
 * SMTP + iCalendar ile gönderir ve kart bunu açıkça söyler.
 */

export const INTEGRATIONS = Object.freeze({
  DATABASE: 'database',
  CORPORATE_WBS: 'corporate-wbs',
  DIRECTORY: 'directory',
  CORPORATE_PROJECTS: 'corporate-projects',
  PROJECT_RESPONSIBILITY: 'project-responsibility',
  AUTHENTICATION: 'authentication',
  SMTP: 'smtp',
  OUTLOOK: 'outlook'
});

const CACHE_KEY = Symbol.for('mergen-rota.integration-cache');

function cache() {
  globalThis[CACHE_KEY] ||= new Map();
  return globalThis[CACHE_KEY];
}

export function resetIntegrationCacheForTests() {
  globalThis[CACHE_KEY] = new Map();
}

function remember(id, { ok, durationMs = null, code = null, at = new Date() }) {
  const previous = cache().get(id) || {};
  const entry = {
    lastSuccessAt: ok ? at.toISOString() : previous.lastSuccessAt || null,
    lastFailureAt: ok ? previous.lastFailureAt || null : at.toISOString(),
    lastFailureCode: ok ? previous.lastFailureCode || null : code,
    lastDurationMs: durationMs ?? previous.lastDurationMs ?? null
  };
  cache().set(id, entry);
  return entry;
}

function history(id) {
  return cache().get(id) || { lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null, lastDurationMs: null };
}

function card(id, { label, kind, configured, state, message, testable = false, durationMs = null, detail = null }) {
  return { id, label, kind, configured, state, message, testable, durationMs, detail, ...history(id) };
}

async function probeQuery(executor, statement, timeoutMs = 4000) {
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const result = await boundedExecutor(executor, deadline.signal).request().query(statement);
    return { ok: true, durationMs: Date.now() - startedAt, rows: result.recordset?.length || 0 };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - startedAt, code: String(error?.code || error?.name || 'PROBE_FAILED').slice(0, 60) };
  } finally {
    deadline.close();
  }
}

async function databaseCard(executor) {
  const probe = await probeQuery(executor, DATABASE_PROBE_SQL, 3000);
  remember(INTEGRATIONS.DATABASE, probe);
  return card(INTEGRATIONS.DATABASE, {
    label: 'MERGEN Rota SQL Server',
    kind: 'Ana veritabanı',
    configured: true,
    state: probe.ok ? HEALTH_STATES.HEALTHY : HEALTH_STATES.CRITICAL,
    message: probe.ok ? `Bağlantı sağlıklı (${probe.durationMs} ms).` : 'Ana veritabanına ulaşılamadı.',
    testable: true,
    durationMs: probe.durationMs
  });
}

async function corporateWbsCard() {
  if (!isCorporateWbsSourceConfigured()) {
    return card(INTEGRATIONS.CORPORATE_WBS, {
      label: 'CN43N / kurumsal WBS kaynağı',
      kind: 'İkincil SQL Server',
      configured: false,
      state: HEALTH_STATES.NOT_CONFIGURED,
      message: 'Kaynak yapılandırılmamış; kurumsal iş dağılım ağacı eşitlenmez.'
    });
  }
  const startedAt = Date.now();
  try {
    const pool = await getCorporateWbsPool();
    if (!pool) throw new Error('CORPORATE_WBS_POOL_UNAVAILABLE');
    const probe = await probeQuery(pool, DATABASE_PROBE_SQL, 5000);
    remember(INTEGRATIONS.CORPORATE_WBS, probe);
    return card(INTEGRATIONS.CORPORATE_WBS, {
      label: 'CN43N / kurumsal WBS kaynağı',
      kind: 'İkincil SQL Server',
      configured: true,
      state: probe.ok ? HEALTH_STATES.HEALTHY : HEALTH_STATES.CRITICAL,
      message: probe.ok ? `Kaynağa bağlanıldı (${probe.durationMs} ms).` : 'Kurumsal WBS kaynağına bağlanılamadı.',
      testable: true,
      durationMs: probe.durationMs
    });
  } catch (error) {
    remember(INTEGRATIONS.CORPORATE_WBS, { ok: false, durationMs: Date.now() - startedAt, code: String(error?.code || 'CONNECT_FAILED').slice(0, 60) });
    return card(INTEGRATIONS.CORPORATE_WBS, {
      label: 'CN43N / kurumsal WBS kaynağı',
      kind: 'İkincil SQL Server',
      configured: true,
      state: HEALTH_STATES.CRITICAL,
      message: 'Kurumsal WBS kaynağına bağlanılamadı.',
      testable: true
    });
  }
}

async function corporateViewCard(executor, id, { label, kind, statement }) {
  const probe = await probeQuery(executor, statement, 5000);
  remember(id, probe);
  return card(id, {
    label,
    kind,
    configured: true,
    state: probe.ok ? (probe.rows ? HEALTH_STATES.HEALTHY : HEALTH_STATES.WARNING) : HEALTH_STATES.UNKNOWN,
    message: probe.ok
      ? (probe.rows ? `Kaynak okunabiliyor (${probe.durationMs} ms).` : 'Kaynak okunabiliyor ancak satır döndürmedi.')
      : 'Kaynak bu denemede okunamadı.',
    testable: true,
    durationMs: probe.durationMs
  });
}

function authenticationCard() {
  const mode = resolveAuthMode();
  if (mode === AUTH_MODES.DEVELOPMENT) {
    return card(INTEGRATIONS.AUTHENTICATION, {
      label: 'Kimlik doğrulama (Keycloak)',
      kind: 'Kurumsal oturum açma',
      configured: false,
      state: HEALTH_STATES.WARNING,
      message: 'Geliştirme kimliği etkin; kurumsal oturum açma kullanılmıyor.'
    });
  }
  const issues = keycloakConfigurationIssues(readKeycloakConfig());
  return card(INTEGRATIONS.AUTHENTICATION, {
    label: 'Kimlik doğrulama (Keycloak)',
    kind: 'Kurumsal oturum açma',
    configured: issues.length === 0,
    state: issues.length ? HEALTH_STATES.CRITICAL : HEALTH_STATES.HEALTHY,
    message: issues.length
      ? 'Yapılandırma eksik; kullanıcılar oturum açamaz.'
      : 'Yapılandırma eksiksiz. Oturumlar sunucuda doğrulanıyor.',
    // Eksik anahtarların ADLARI güvenlidir; değerleri hiçbir koşulda taşınmaz.
    detail: issues.length ? { missing: issues } : null
  });
}

function smtpCard() {
  const problem = smtpConfigurationProblem();
  return card(INTEGRATIONS.SMTP, {
    label: 'SMTP posta sunucusu',
    kind: 'Kurumsal posta',
    configured: problem === null,
    state: problem === null ? HEALTH_STATES.HEALTHY
      : problem === 'SMTP_NOT_CONFIGURED' ? HEALTH_STATES.NOT_CONFIGURED : HEALTH_STATES.WARNING,
    message: problem === null
      ? 'Yapılandırma eksiksiz. Bağlantı testi ileti göndermez.'
      : problem === 'SMTP_NOT_CONFIGURED'
        ? 'SMTP yapılandırılmamış; hatırlatma ve takvim daveti gönderilemez.'
        : 'SMTP yapılandırması geçersiz.',
    testable: problem === null
  });
}

function outlookCard() {
  const enabled = isOutlookCalendarEnabled();
  const smtpProblem = smtpConfigurationProblem();
  return card(INTEGRATIONS.OUTLOOK, {
    label: 'Outlook takvim teslimatı',
    // Tümleştirme Graph/EWS DEĞİLDİR; davetler SMTP üzerinden iCalendar
    // eklentisiyle gönderilir.
    kind: 'SMTP + iCalendar',
    configured: enabled && smtpProblem === null,
    state: !enabled ? HEALTH_STATES.NOT_CONFIGURED
      : smtpProblem ? HEALTH_STATES.WARNING : HEALTH_STATES.HEALTHY,
    message: !enabled
      ? 'Outlook takvim tümleştirmesi kapalı.'
      : smtpProblem
        ? 'Tümleştirme açık ancak SMTP yapılandırması eksik; davet gönderilemez.'
        : 'Davetler SMTP üzerinden iCalendar (METHOD:REQUEST/CANCEL) olarak gönderilir.',
    testable: enabled && smtpProblem === null
  });
}

/** Bütün entegrasyon kartları. */
export async function loadIntegrations(executor) {
  const [database, corporateWbs, directory, projects, responsibility] = await Promise.all([
    databaseCard(executor),
    corporateWbsCard(),
    corporateViewCard(executor, INTEGRATIONS.DIRECTORY, {
      label: 'Kurumsal personel kaynağı (HR02)',
      kind: 'Kurumsal görünüm',
      statement: DIRECTORY_PROBE_SQL
    }),
    corporateViewCard(executor, INTEGRATIONS.CORPORATE_PROJECTS, {
      label: 'Kurumsal proje kaynağı',
      kind: 'Kurumsal görünüm',
      statement: CORPORATE_PROJECT_PROBE_SQL
    }),
    corporateViewCard(executor, INTEGRATIONS.PROJECT_RESPONSIBILITY, {
      label: 'Kurumsal proje sorumluluk kaynağı',
      kind: 'Kurumsal görünüm',
      statement: CORPORATE_RESPONSIBILITY_PROBE_SQL
    })
  ]);
  return [database, corporateWbs, directory, projects, responsibility, authenticationCard(), smtpCard(), outlookCard()];
}

const TESTS = Object.freeze({
  [INTEGRATIONS.DATABASE]: (executor) => probeQuery(executor, DATABASE_PROBE_SQL, 5000),
  [INTEGRATIONS.DIRECTORY]: (executor) => probeQuery(executor, DIRECTORY_PROBE_SQL, 6000),
  [INTEGRATIONS.CORPORATE_PROJECTS]: (executor) => probeQuery(executor, CORPORATE_PROJECT_PROBE_SQL, 6000),
  [INTEGRATIONS.PROJECT_RESPONSIBILITY]: (executor) => probeQuery(executor, CORPORATE_RESPONSIBILITY_PROBE_SQL, 6000),
  [INTEGRATIONS.CORPORATE_WBS]: async () => {
    if (!isCorporateWbsSourceConfigured()) return { ok: false, code: 'NOT_CONFIGURED', durationMs: 0 };
    const pool = await getCorporateWbsPool();
    return pool ? probeQuery(pool, DATABASE_PROBE_SQL, 6000) : { ok: false, code: 'NOT_CONFIGURED', durationMs: 0 };
  },
  // SMTP testi YALNIZCA bağlantı ve el sıkışmadır; ileti gönderilmez.
  [INTEGRATIONS.SMTP]: async () => {
    const outcome = await verifyMailConnection();
    return { ok: outcome.ok, durationMs: outcome.durationMs ?? null, code: outcome.ok ? null : outcome.code, message: outcome.message };
  },
  [INTEGRATIONS.OUTLOOK]: async () => {
    if (!isOutlookCalendarEnabled()) return { ok: false, code: 'OUTLOOK_DISABLED', durationMs: 0 };
    const outcome = await verifyMailConnection();
    return { ok: outcome.ok, durationMs: outcome.durationMs ?? null, code: outcome.ok ? null : outcome.code, message: outcome.message };
  }
});

export function isTestableIntegration(id) {
  return Object.hasOwn(TESTS, String(id));
}

/**
 * Bağlantı testi — HİÇBİRİ yıkıcı değildir.
 *
 * Veritabanı testleri `SELECT 1` düzeyindedir; SMTP testi ileti göndermeden
 * yalnızca el sıkışmayı dener.
 */
export async function testIntegration(executor, id) {
  const run = TESTS[String(id)];
  if (!run) return { ok: false, code: 'UNKNOWN_INTEGRATION', message: 'Tanınmayan entegrasyon.' };
  const outcome = await run(executor);
  remember(String(id), { ok: outcome.ok, durationMs: outcome.durationMs, code: outcome.code || null });
  return {
    ok: Boolean(outcome.ok),
    durationMs: outcome.durationMs ?? null,
    code: outcome.code || null,
    message: outcome.message || (outcome.ok
      ? `Bağlantı doğrulandı${outcome.durationMs != null ? ` (${outcome.durationMs} ms)` : ''}.`
      : 'Bağlantı kurulamadı.')
  };
}
