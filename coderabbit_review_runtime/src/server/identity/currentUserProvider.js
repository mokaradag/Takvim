import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { parseDevelopmentSicil } from './parseDevelopmentSicil.js';
import { AUTH_MODES, resolveAuthMode } from './keycloakConfig.js';
import { KeycloakIdentityProvider } from './keycloakIdentityProvider.js';

/**
 * Geçici yerel geliştirme kimliği.
 *
 * Yalnızca `MERGEN_ROTA_AUTH_MODE=development` VE
 * `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true` birlikte verildiğinde çalışır.
 * Üretim yapılandırmasında bu yola sessizce düşülmez.
 */
export class DevelopmentIdentityProvider {
  async getCurrentSicil() {
    return (await this.getSessionIdentity()).sicil;
  }

  async getSessionIdentity() {
    if (resolveAuthMode() !== AUTH_MODES.DEVELOPMENT) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçici geliştirme kimliği yalnızca MERGEN_ROTA_AUTH_MODE=development yapılandırmasında kullanılabilir.');
    }
    if (!/^(1|true|yes)$/i.test(process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED || '')) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Gerçek Sistem kimliği yapılandırılmamış. Geçici geliştirme kimliğini açıkça etkinleştirin.');
    }
    const sicil = parseDevelopmentSicil(process.env.MERGEN_ROTA_DEV_SICIL);
    if (sicil == null) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış.');
    }
    return { sicil, username: null, name: null, email: null, sid: null };
  }
}

function createProviderForMode(mode) {
  return mode === AUTH_MODES.DEVELOPMENT ? new DevelopmentIdentityProvider() : new KeycloakIdentityProvider();
}

let providerOverride = null;
let cachedProvider = null;
let cachedMode = null;

/**
 * Etkin sağlayıcı SUNUCU yapılandırmasından seçilir; varsayılan Keycloak'tır.
 * Kip çalışma zamanında değişirse (testler) önbellek tazelenir.
 */
function activeProvider() {
  if (providerOverride) return providerOverride;
  const mode = resolveAuthMode();
  if (!cachedProvider || cachedMode !== mode) {
    cachedProvider = createProviderForMode(mode);
    cachedMode = mode;
  }
  return cachedProvider;
}

/** Yalnızca sunucu tarafı kurulum/test içindir; istemciden erişilemez. */
export function setCurrentUserProvider(nextProvider) {
  providerOverride = nextProvider || null;
  cachedProvider = null;
  cachedMode = null;
}

export async function getTrustedCurrentSicil() {
  return activeProvider().getCurrentSicil();
}

/**
 * Kimlik doğrulamasından gelen güvenli görüntüleme alanları. Yetkilendirme
 * kararlarında KULLANILMAZ; kurumsal rehber kaydı önceliklidir.
 */
export async function getTrustedSessionIdentity() {
  const provider = activeProvider();
  if (typeof provider.getSessionIdentity !== 'function') {
    return { sicil: await provider.getCurrentSicil() };
  }
  return provider.getSessionIdentity();
}
