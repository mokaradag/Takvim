import 'server-only';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function booleanValue(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

function integerValue(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function getSqlServerConfig() {
  return Object.freeze({
    server: required('MERGEN_ROTA_DB_SERVER'),
    port: integerValue('MERGEN_ROTA_DB_PORT', 1433),
    database: required('MERGEN_ROTA_DB_DATABASE'),
    user: required('MERGEN_ROTA_DB_USER'),
    password: required('MERGEN_ROTA_DB_PASSWORD'),
    connectionTimeout: integerValue('MERGEN_ROTA_DB_CONNECTION_TIMEOUT_MS', 15000),
    requestTimeout: integerValue('MERGEN_ROTA_DB_REQUEST_TIMEOUT_MS', 30000),
    pool: { min: 0, max: 10, idleTimeoutMillis: 30000 },
    options: {
      encrypt: booleanValue('MERGEN_ROTA_DB_ENCRYPT', true),
      trustServerCertificate: booleanValue('MERGEN_ROTA_DB_TRUST_SERVER_CERTIFICATE', false),
      enableArithAbort: true
    }
  });
}
