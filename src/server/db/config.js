import 'server-only';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function stringValue(name, fallback) {
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

export function getSqlServerConfig() {
  return Object.freeze({
    server: required('MERGEN_ROTA_DB_SERVER'),
    port: integerValue('MERGEN_ROTA_DB_PORT', 1433, { max: 65535 }),
    database: required('MERGEN_ROTA_DB_DATABASE'),
    driver: stringValue('MERGEN_ROTA_DB_ODBC_DRIVER', 'ODBC Driver 18 for SQL Server'),
    connectionTimeout: integerValue('MERGEN_ROTA_DB_CONNECTION_TIMEOUT_MS', 15000),
    requestTimeout: integerValue('MERGEN_ROTA_DB_REQUEST_TIMEOUT_MS', 30000),
    pool: { min: 0, max: 10, idleTimeoutMillis: 30000 },
    options: {
      trustedConnection: true,
      encrypt: booleanValue('MERGEN_ROTA_DB_ENCRYPT', true),
      trustServerCertificate: booleanValue('MERGEN_ROTA_DB_TRUST_SERVER_CERTIFICATE', false),
      useUTC: true
    }
  });
}
