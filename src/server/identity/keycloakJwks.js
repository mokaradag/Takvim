/**
 * Keycloak realm JWKS istemcisi.
 *
 * Anahtarlar bellekte TTL ile önbelleklenir. Bilinmeyen bir `kid` görüldüğünde
 * anahtar döndürmesi (rotasyon) için tek bir yenileme denenir; bu yenileme
 * `minRefreshIntervalMs` ile hız sınırlıdır, böylece geçersiz token akını JWKS
 * ucunu yormaz. Ağ hatası veya bozuk yanıt durumunda hata fırlatılır; token
 * doğrulaması sessizce başarılı sayılmaz.
 */

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

export class KeycloakJwksError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'KeycloakJwksError';
    if (cause) this.cause = cause;
  }
}

function usableSigningKeys(document) {
  const keys = Array.isArray(document?.keys) ? document.keys : [];
  return keys.filter((key) => key
    && typeof key === 'object'
    && key.kty === 'RSA'
    && (key.use == null || key.use === 'sig')
    && typeof key.n === 'string'
    && typeof key.e === 'string');
}

export function createKeycloakJwksClient({
  jwksUri,
  fetchImpl,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  minRefreshIntervalMs = DEFAULT_MIN_REFRESH_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  let cachedKeys = [];
  let fetchedAt = 0;
  let inFlight = null;

  const request = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function fetchKeys() {
    if (!jwksUri) throw new KeycloakJwksError('JWKS adresi yapılandırılmamış.');
    let response;
    try {
      response = await request(jwksUri, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
      });
    } catch (cause) {
      throw new KeycloakJwksError('Kimlik sağlayıcısının imza anahtarlarına ulaşılamadı.', { cause });
    }
    if (!response?.ok) throw new KeycloakJwksError('Kimlik sağlayıcısı imza anahtarlarını döndürmedi.');
    let document;
    try {
      document = await response.json();
    } catch (cause) {
      throw new KeycloakJwksError('İmza anahtarı yanıtı okunamadı.', { cause });
    }
    const keys = usableSigningKeys(document);
    if (!keys.length) throw new KeycloakJwksError('Kullanılabilir imza anahtarı bulunamadı.');
    cachedKeys = keys;
    fetchedAt = now();
    return cachedKeys;
  }

  function refresh() {
    if (!inFlight) {
      inFlight = fetchKeys().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function findKey(keys, kid) {
    if (kid) return keys.find((key) => key.kid === kid) || null;
    // `kid` yoksa yalnızca tek anahtarlı realm'lerde belirsizlik oluşmaz.
    return keys.length === 1 ? keys[0] : null;
  }

  return {
    async getSigningKey(kid) {
      const fresh = cachedKeys.length && (now() - fetchedAt) < cacheTtlMs;
      const keys = fresh ? cachedKeys : await refresh();
      const match = findKey(keys, kid);
      if (match) return match;
      // Anahtar rotasyonu: önbellek eskimemiş olsa bile bir kez yenile.
      if ((now() - fetchedAt) < minRefreshIntervalMs) return null;
      return findKey(await refresh(), kid);
    }
  };
}
