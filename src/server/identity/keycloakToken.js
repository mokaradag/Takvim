import { createPublicKey, createVerify } from 'node:crypto';

/**
 * Keycloak JWT doğrulaması. Bağımlılık eklemeden Node'un yerleşik `crypto`
 * modülüyle çalışır ve KAPALI BAŞARISIZLIK ilkesine uyar: imza, issuer, süre,
 * kitle veya yetkili taraf doğrulanamıyorsa token reddedilir.
 *
 * Modül saf tutulur (env okumaz, ağa çıkmaz); JWKS anahtarları dışarıdan
 * enjekte edilir. Böylece sahte anahtarlarla çevrimdışı test edilebilir.
 */

const ALGORITHM_DIGESTS = Object.freeze({ RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' });
const DEFAULT_ACCEPTED_TYPES = Object.freeze(['Bearer', 'ID', 'JWT']);

export class KeycloakTokenError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'KeycloakTokenError';
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new KeycloakTokenError(reason, message);
}

function decodeBase64Url(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment) {
  const buffer = decodeBase64Url(segment);
  if (!buffer || !buffer.length) return null;
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Yalnızca ayrıştırır; hiçbir güven kararı vermez. */
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (!header || !payload || !signature || !signature.length) return null;
  return { header, payload, signature, signingInput: `${parts[0]}.${parts[1]}` };
}

function assertAllowedAlgorithm(algorithm, allowedAlgorithms) {
  const allowed = Array.isArray(allowedAlgorithms) && allowedAlgorithms.length ? allowedAlgorithms : ['RS256'];
  // `none` ve HMAC (HS*) algoritma karışıklığı saldırısı burada kesilir: yalnızca
  // beyaz listedeki asimetrik RSA algoritmaları kabul edilir.
  if (typeof algorithm !== 'string' || !allowed.includes(algorithm) || !ALGORITHM_DIGESTS[algorithm]) {
    fail('ALGORITHM_NOT_ALLOWED', 'Token imza algoritması kabul edilmiyor.');
  }
  return ALGORITHM_DIGESTS[algorithm];
}

export function verifyJwtSignature({ signingInput, signature, algorithm, jwk, allowedAlgorithms }) {
  const digest = assertAllowedAlgorithm(algorithm, allowedAlgorithms);
  if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'RSA') {
    fail('KEY_UNUSABLE', 'Doğrulama anahtarı kullanılabilir değil.');
  }
  if (typeof jwk.alg === 'string' && jwk.alg && jwk.alg !== algorithm) {
    fail('KEY_UNUSABLE', 'Doğrulama anahtarı token algoritmasıyla uyuşmuyor.');
  }
  if (typeof jwk.use === 'string' && jwk.use && jwk.use !== 'sig') {
    fail('KEY_UNUSABLE', 'Doğrulama anahtarı imza için tanımlanmamış.');
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    fail('KEY_UNUSABLE', 'Doğrulama anahtarı okunamadı.');
  }
  const verifier = createVerify(digest);
  verifier.update(signingInput);
  verifier.end();
  let valid = false;
  try {
    valid = verifier.verify(publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) fail('SIGNATURE_INVALID', 'Token imzası doğrulanamadı.');
  return true;
}

function audienceList(value) {
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

export function validateKeycloakClaims(claims, {
  issuer,
  expectedAudience = [],
  expectedAuthorizedParty = '',
  acceptedTypes = DEFAULT_ACCEPTED_TYPES,
  clockToleranceSeconds = 30,
  now = Date.now()
} = {}) {
  const nowSeconds = Math.floor(now / 1000);
  if (!claims || typeof claims !== 'object') fail('CLAIMS_INVALID', 'Token içeriği okunamadı.');
  if (!issuer || claims.iss !== issuer) fail('ISSUER_MISMATCH', 'Token issuer değeri beklenen kimlik sağlayıcısına ait değil.');

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) fail('EXPIRY_INVALID', 'Token süre bilgisi geçersiz.');
  if (nowSeconds > claims.exp + clockToleranceSeconds) fail('TOKEN_EXPIRED', 'Token süresi dolmuş.');
  if (typeof claims.nbf === 'number' && nowSeconds + clockToleranceSeconds < claims.nbf) {
    fail('TOKEN_NOT_ACTIVE', 'Token henüz geçerli değil.');
  }
  if (typeof claims.iat === 'number' && nowSeconds + clockToleranceSeconds < claims.iat) {
    fail('TOKEN_NOT_ACTIVE', 'Token gelecekte üretilmiş görünüyor.');
  }

  if (Array.isArray(acceptedTypes) && acceptedTypes.length && claims.typ != null && !acceptedTypes.includes(claims.typ)) {
    fail('TOKEN_TYPE_INVALID', 'Token türü kabul edilmiyor.');
  }

  const audiences = audienceList(claims.aud);
  const expected = expectedAudience.filter(Boolean);
  if (expected.length) {
    const authorizedParty = typeof claims.azp === 'string' ? claims.azp : '';
    // Keycloak, tek istemcili akışlarda `aud` yerine yalnızca `azp` yazabilir.
    const audienceAccepted = audiences.some((item) => expected.includes(item))
      || (audiences.length === 0 && expected.includes(authorizedParty));
    if (!audienceAccepted) fail('AUDIENCE_MISMATCH', 'Token bu uygulama için düzenlenmemiş.');
  }

  if (expectedAuthorizedParty && claims.azp !== expectedAuthorizedParty) {
    fail('AUTHORIZED_PARTY_MISMATCH', 'Token başka bir istemci için düzenlenmiş.');
  }
  return claims;
}

/**
 * Tam doğrulama: imza + standart claim'ler. `resolveKey(kid, header)` JWKS
 * katmanından gelir ve bilinmeyen `kid` için anahtar döndürmemelidir.
 */
export async function verifyKeycloakToken(token, {
  resolveKey,
  issuer,
  expectedAudience = [],
  expectedAuthorizedParty = '',
  allowedAlgorithms = ['RS256'],
  acceptedTypes = DEFAULT_ACCEPTED_TYPES,
  clockToleranceSeconds = 30,
  now = Date.now()
}) {
  const decoded = decodeJwt(token);
  if (!decoded) fail('TOKEN_MALFORMED', 'Token biçimi geçersiz.');
  assertAllowedAlgorithm(decoded.header.alg, allowedAlgorithms);

  const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : '';
  let jwk = null;
  try {
    jwk = await resolveKey(kid, decoded.header);
  } catch (cause) {
    // JWKS getirilemiyorsa doğrulama yapılamaz; token kabul EDİLMEZ.
    fail('KEY_UNAVAILABLE', 'Kimlik sağlayıcısının imza anahtarları alınamadı.');
  }
  if (!jwk) fail('KEY_UNAVAILABLE', 'Token imza anahtarı bulunamadı.');

  verifyJwtSignature({
    signingInput: decoded.signingInput,
    signature: decoded.signature,
    algorithm: decoded.header.alg,
    jwk,
    allowedAlgorithms
  });

  return validateKeycloakClaims(decoded.payload, {
    issuer,
    expectedAudience,
    expectedAuthorizedParty,
    acceptedTypes,
    clockToleranceSeconds,
    now
  });
}
