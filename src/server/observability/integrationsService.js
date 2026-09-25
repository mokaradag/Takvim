import 'server-only';
import { HEALTH_STATES } from '../../domain/observability/healthModel.js';
import { getCorporateWbsPool } from '../db/corporateWbsPool.js';
import { isCorporateWbsSourceConfigured } from '../db/corporateWbsConfig.js';
import { verifyMailConnection } from '../mail/mailService.js';
import { smtpConfigurationProblem } from '../mail/smtpConfig.js';
import { isOutlookCalendarEnabled } from '../outlook/outlookConfig.js';
import { AUTH_MODES, keycloakConfigurationIssues, readKeycloakConfig, resolveAuthMode } from '../identity/keycloakConfig.js';
import { boundedExecutor, probeDeadline } from './boundedExecution.js';
import { aiIntegrationCard, testAiProviderConnection } from '../ai/aiHealth.js';
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
  OUTLOOK: 'outlook',
  AI: 'ai-provider'
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
    lastProbeOk: Boolean(ok),
    lastSuccessAt: ok ? at.toISOString() : previous.lastSuccessAt || null,
    lastFailureAt: ok ? previous.lastFailureAt || null : at.toISOString(),
    lastFailureCode: ok ? previous.lastFailureCode || null : code,
    lastDurationMs: durationMs ?? previous.lastDurationMs ?? null
  };
  cache().set(id, entry);
  return entry;
}

export function history(id) {
  return cache().get(id) || { lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null, lastDurationMs: null };
}

/** Başarılı bir bağlantı denemesinin "taze" sayıldığı süre. */
export const REACHABILITY_FRESHNESS_MS = 15 * 60 * 1000;

/**
 * YAPILANDIRMA eksiksizliği ERİŞİLEBİLİRLİK değildir.
 *
 * Yalnızca yapılandırmaya bakan bir kart, bağımlılık erişilemez hale geldikten
 * sonra da "sağlıklı" kalırdı. Bu yüzden erişilebilirlik son yoklama
 * sonucundan türetilir: hiç denenmediyse ya da son başarı bayatladıysa durum
 * BİLİNMİYOR olur, son deneme başarısızsa uyarı verilir.
 */
export function reachability(id, { now = Date.now(), freshnessMs = REACHABILITY_FRESHNESS_MS } = {}) {
  const entry = history(id);
  const successAt = entry.lastSuccessAt ? new Date(entry.lastSuccessAt).getTime() : null;
  const failureAt = entry.lastFailureAt ? new Date(entry.lastFailureAt).getTime() : null;
  if (entry.lastProbeOk === false || (failureAt != null && (successAt == null || failureAt > successAt))) {
    return { state: HEALTH_STATES.WARNING, note: 'Son bağlantı denemesi başarısız oldu.' };
  }
  if (successAt == null) return { state: HEALTH_STATES.UNKNOWN, note: 'Erişilebilirlik henüz denenmedi.' };
  if (!Number.isFinite(successAt) || now - successAt > freshnessMs) {
    return { state: HEALTH_STATES.UNKNOWN, note: 'Son başarılı bağlantı denemesi bayatladı.' };
  }
  return { state: HEALTH_STATES.HEALTHY, note: 'Son bağlantı denemesi başarılı.' };
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
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      // Süre sınırı SÜRE SINIRI olarak bildirilir: iptal `Error('PROBE_TIMEOUT')`
      // ile reddedilir ve hata adına bakan bir kod kartta `Error` gösterirdi.
      code: deadline.signal.aborted
        ? 'PROBE_TIMEOUT'
        : String(error?.code || error?.name || 'PROBE_FAILED').slice(0, 60)
    };
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
  if (issues.length) {
    return card(INTEGRATIONS.AUTHENTICATION, {
      label: 'Kimlik doğrulama (Keycloak)',
      kind: 'Kurumsal oturum açma',
      configured: false,
      state: HEALTH_STATES.CRITICAL,
      message: 'Yapılandırma eksik; kullanıcılar oturum açamaz.',
      // Eksik anahtarların ADLARI güvenlidir; değerleri hiçbir koşulda taşınmaz.
      detail: { missing: issues },
      testable: false
    });
  }
  const reach = reachability(INTEGRATIONS.AUTHENTICATION);
  return card(INTEGRATIONS.AUTHENTICATION, {
    label: 'Kimlik doğrulama (Keycloak)',
    kind: 'Kurumsal oturum açma',
    configured: true,
    state: reach.state,
    message: `Yapılandırma eksiksiz. ${reach.note}`,
    testable: true
  });
}

function smtpCard() {
  const problem = smtpConfigurationProblem();
  if (problem === 'SMTP_NOT_CONFIGURED') {
    return card(INTEGRATIONS.SMTP, {
      label: 'SMTP posta sunucusu',
      kind: 'Kurumsal posta',
      configured: false,
      state: HEALTH_STATES.NOT_CONFIGURED,
      message: 'SMTP yapılandırılmamış; hatırlatma ve takvim daveti gönderilemez.'
    });
  }
  if (problem) {
    return card(INTEGRATIONS.SMTP, {
      label: 'SMTP posta sunucusu',
      kind: 'Kurumsal posta',
      configured: false,
      state: HEALTH_STATES.WARNING,
      message: 'SMTP yapılandırması geçersiz.'
    });
  }
  const reach = reachability(INTEGRATIONS.SMTP);
  return card(INTEGRATIONS.SMTP, {
    label: 'SMTP posta sunucusu',
    kind: 'Kurumsal posta',
    configured: true,
    state: reach.state,
    message: `Yapılandırma eksiksiz. ${reach.note} Bağlantı testi ileti göndermez.`,
    testable: true
  });
}

function outlookCard() {
  const enabled = isOutlookCalendarEnabled();
  const smtpProblem = smtpConfigurationProblem();
  if (!enabled || smtpProblem) {
    return card(INTEGRATIONS.OUTLOOK, {
      label: 'Outlook takvim teslimatı',
      // Tümleştirme Graph/EWS DEĞİLDİR; davetler SMTP üzerinden iCalendar
      // eklentisiyle gönderilir.
      kind: 'SMTP + iCalendar',
      configured: false,
      state: !enabled ? HEALTH_STATES.NOT_CONFIGURED : HEALTH_STATES.WARNING,
      message: !enabled
        ? 'Outlook takvim tümleştirmesi kapalı.'
        : 'Tümleştirme açık ancak SMTP yapılandırması eksik; davet gönderilemez.',
      testable: false
    });
  }
  const reach = reachability(INTEGRATIONS.OUTLOOK);
  return card(INTEGRATIONS.OUTLOOK, {
    label: 'Outlook takvim teslimatı',
    kind: 'SMTP + iCalendar',
    configured: true,
    state: reach.state,
    message: `Davetler SMTP üzerinden iCalendar (METHOD:REQUEST/CANCEL) olarak gönderilir. ${reach.note}`,
    testable: true
  });
}

/**
 * Yapay zekâ kartının durumu sağlık bileşeninden gelir; ancak son bağlantı
 * testi, ondan sonra başarılı bir test olmadan ve tazeyken BAŞARISIZ olduysa
 * kart sağlıklı ya da bilinmiyor görünmez (ör. kurumsal anahtar doğrulanamadı).
 * Gecikme alanı son bağlantı testinin süresidir.
 */
function aiCard({ now = Date.now() } = {}) {
  const base = aiIntegrationCard();
  const entry = history(INTEGRATIONS.AI);
  const failureAt = entry.lastFailureAt ? new Date(entry.lastFailureAt).getTime() : null;
  const failedRecently = entry.lastProbeOk === false && Number.isFinite(failureAt) && now - failureAt <= REACHABILITY_FRESHNESS_MS;
  const downgrade = base.configured && failedRecently
    && (base.state === HEALTH_STATES.HEALTHY || base.state === HEALTH_STATES.UNKNOWN);
  return card(INTEGRATIONS.AI, {
    label: 'Yapay zekâ sağlayıcısı',
    kind: 'OpenAI uyumlu kurum içi uç',
    ...base,
    ...(downgrade ? {
      state: HEALTH_STATES.WARNING,
      message: `${base.message} Son bağlantı testi başarısız oldu${entry.lastFailureCode ? ` (${entry.lastFailureCode})` : ''}.`
    } : {}),
    durationMs: entry.lastDurationMs ?? null
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
  return [database, corporateWbs, directory, projects, responsibility, authenticationCard(), smtpCard(), outlookCard(), aiCard()];
}

async function probeSmtpConnection() {
  const deadline = probeDeadline(6000);
  const startedAt = Date.now();
  try {
    const outcome = await verifyMailConnection({ signal: deadline.signal });
    return {
      ok: outcome.ok, durationMs: Date.now() - startedAt,
      code: deadline.signal.aborted ? 'PROBE_TIMEOUT' : outcome.ok ? null : outcome.code,
      message: outcome.message
    };
  } finally {
    deadline.close();
  }
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
    return probeSmtpConnection();
  },
  [INTEGRATIONS.OUTLOOK]: async () => {
    if (!isOutlookCalendarEnabled()) return { ok: false, code: 'OUTLOOK_DISABLED', durationMs: 0 };
    return probeSmtpConnection();
  },
  // Yapay zekâ testi model ÜRETMEZ: süre sınırlı `GET /models` isteğidir ve
  // yöneticinin isteği kesilirse iptal edilir.
  [INTEGRATIONS.AI]: (executor, { signal } = {}) => testAiProviderConnection({ signal }),
  // Kimlik erişilebilirliği YIKICI OLMAYAN biçimde yoklanır: yalnızca ortak
  // anahtar kümesi (JWKS) okunur; oturum açma denenmez, kimlik bilgisi
  // gönderilmez, hesap kilitlenmez.
  [INTEGRATIONS.AUTHENTICATION]: async () => {
    const config = readKeycloakConfig();
    if (resolveAuthMode() === AUTH_MODES.DEVELOPMENT) return { ok: false, code: 'DEVELOPMENT_IDENTITY', durationMs: 0 };
    if (!config.jwksUri) return { ok: false, code: 'NOT_CONFIGURED', durationMs: 0 };
    return probeKeycloakJwks(config.jwksUri, 6000);
  }
});

/** JWKS adresine süre sınırlı, salt okunur bir istek. */
async function probeKeycloakJwks(jwksUri, timeoutMs) {
  const deadline = probeDeadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await globalThis.fetch(jwksUri, { method: 'GET', signal: deadline.signal, cache: 'no-store' });
    const durationMs = Date.now() - startedAt;
    if (!response.ok) return { ok: false, durationMs, code: `HTTP_${response.status}` };
    const document = await response.json().catch(() => null);
    if (!Array.isArray(document?.keys) || document.keys.length === 0) {
      return { ok: false, durationMs: Date.now() - startedAt, code: deadline.signal.aborted ? 'PROBE_TIMEOUT' : 'INVALID_JWKS' };
    }
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      code: deadline.signal.aborted ? 'PROBE_TIMEOUT' : String(error?.code || error?.name || 'PROBE_FAILED').slice(0, 60)
    };
  } finally {
    deadline.close();
  }
}

export function isTestableIntegration(id) {
  return Object.hasOwn(TESTS, String(id));
}

/**
 * Testin örnekler arası SQL kilidiyle mi korunacağı. Yapay zekâ testi
 * veritabanı gerektirmeyen bir dış istektir: sağlayıcı beklenirken yönetim
 * kilidinin SQL işlemi ve havuz bağlantısı tutulmaz (yapay zekâ yalıtımı).
 */
export function integrationTestNeedsDatabaseLock(id) {
  return String(id) !== INTEGRATIONS.AI;
}

/**
 * Bağlantı testi — HİÇBİRİ yıkıcı değildir.
 *
 * Veritabanı testleri `SELECT 1` düzeyindedir; SMTP testi ileti göndermeden
 * yalnızca el sıkışmayı dener. `signal` yöneticinin isteğidir; iptal edilen
 * test (`cancelled`) bir bağlantı sonucu olmadığı için geçmişe yazılmaz.
 */
export async function testIntegration(executor, id, { signal = null } = {}) {
  const run = TESTS[String(id)];
  if (!run) return { ok: false, code: 'UNKNOWN_INTEGRATION', message: 'Tanınmayan entegrasyon.' };
  // Yoklamanın kendisi FIRLATABİLİR (ör. ikincil havuz kurulamadığında). Bu,
  // testin sonucudur; ucun iç hatası değil. Sonuç sınırlı bir kodla bildirilir.
  let outcome;
  try {
    outcome = await run(executor, { signal });
  } catch (error) {
    outcome = {
      ok: false,
      durationMs: null,
      code: String(error?.code || error?.name || 'PROBE_FAILED').slice(0, 60)
    };
  }
  if (!outcome.cancelled) remember(String(id), { ok: outcome.ok, durationMs: outcome.durationMs, code: outcome.code || null });
  return {
    ok: Boolean(outcome.ok),
    durationMs: outcome.durationMs ?? null,
    code: outcome.code || null,
    message: outcome.message || (outcome.ok
      ? `Bağlantı doğrulandı${outcome.durationMs != null ? ` (${outcome.durationMs} ms)` : ''}.`
      : 'Bağlantı kurulamadı.')
  };
}
