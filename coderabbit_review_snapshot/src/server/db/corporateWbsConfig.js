import 'server-only';

// CN43N tablosu MERGEN Rota veritabanında değil, ayrı bir kurumsal veritabanında
// bulunur. Bu yüzden ikinci bir bağlantı tanımı gerekir. Yapılandırma yoksa
// kurumsal iş dağılım ağacı eşitlemesi tamamen devre dışı kalır ve uygulama
// yalnızca proje kök düğümüyle çalışmaya devam eder.
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function stringValue(name, fallback = '') {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function booleanValue(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

function integerValue(name, fallback, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim();
  const value = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    const upperBound = max < Number.MAX_SAFE_INTEGER ? ` no greater than ${max}` : '';
    throw new Error(`${name} must be a positive integer${upperBound}.`);
  }
  return value;
}

function identifier(name, fallback) {
  const value = stringValue(name, fallback);
  if (!IDENTIFIER_PATTERN.test(value)) {
    // Şema ve tablo adları sorgu metnine gömüldüğü için serbest metne izin verilmez.
    throw new Error(`${name} must be a plain SQL Server identifier.`);
  }
  return value;
}

/** Kurumsal WBS kaynağı yapılandırıldı mı? */
export function isCorporateWbsSourceConfigured() {
  return Boolean(stringValue('MERGEN_ROTA_WBS_DB_SERVER') && stringValue('MERGEN_ROTA_WBS_DB_DATABASE'));
}

export function getCorporateWbsDbConfig() {
  if (!isCorporateWbsSourceConfigured()) return null;
  return Object.freeze({
    server: stringValue('MERGEN_ROTA_WBS_DB_SERVER'),
    port: integerValue('MERGEN_ROTA_WBS_DB_PORT', 1433, { max: 65535 }),
    database: stringValue('MERGEN_ROTA_WBS_DB_DATABASE'),
    driver: stringValue('MERGEN_ROTA_WBS_DB_ODBC_DRIVER', 'ODBC Driver 18 for SQL Server'),
    schema: identifier('MERGEN_ROTA_WBS_DB_SCHEMA', 'dbo'),
    table: identifier('MERGEN_ROTA_WBS_DB_TABLE', 'CN43N'),
    projectBatchSize: integerValue('MERGEN_ROTA_WBS_SYNC_PROJECT_BATCH', 50, { max: 500 }),
    connectionTimeout: integerValue('MERGEN_ROTA_WBS_DB_CONNECTION_TIMEOUT_MS', 15000),
    requestTimeout: integerValue('MERGEN_ROTA_WBS_DB_REQUEST_TIMEOUT_MS', 60000),
    pool: { min: 0, max: 4, idleTimeoutMillis: 30000 },
    options: {
      trustedConnection: true,
      encrypt: booleanValue('MERGEN_ROTA_WBS_DB_ENCRYPT', true),
      trustServerCertificate: booleanValue('MERGEN_ROTA_WBS_DB_TRUST_SERVER_CERTIFICATE', false),
      useUTC: true
    }
  });
}
