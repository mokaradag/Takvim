import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { readKeycloakConfig } from './keycloakConfig.js';
import { SESSION_COOKIE_NAME, readSessionPayload } from './keycloakSessionCookie.js';

/**
 * Keycloak kimlik sağlayıcısı.
 *
 * Güvenilen kimlik YALNIZCA sunucunun imzaladığı HttpOnly oturum çerezinden
 * okunur. İstek gövdesi, sorgu dizesi, tarayıcı başlıkları, localStorage veya
 * görüntüleme alanları kimlik kaynağı DEĞİLDİR. Çerez yoksa, imzası bozuksa
 * veya süresi dolmuşsa UNAUTHORIZED döner; yönetici veya Demo kimliğine
 * sessizce düşülmez.
 */

async function readCookieFromNextHeaders(name) {
  // `next/headers` yalnızca istek bağlamında çözülür; düz Node testleri bu
  // modülü hiç yüklemez (okuyucu enjekte edilir).
  const { cookies } = await import('next/headers');
  const store = await cookies();
  return store.get(name)?.value || null;
}

export class KeycloakIdentityProvider {
  constructor({ readSessionCookie = readCookieFromNextHeaders, config = null, now = () => Date.now() } = {}) {
    this.readSessionCookie = readSessionCookie;
    this.configOverride = config;
    this.now = now;
  }

  config() {
    return this.configOverride || readKeycloakConfig();
  }

  async getSessionIdentity() {
    const config = this.config();
    if (typeof config.sessionSecret !== 'string' || config.sessionSecret.length < 32) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Oturum doğrulaması yapılandırılmamış. Sistem yöneticinizle görüşün.');
    }
    let cookieValue = null;
    try {
      cookieValue = await this.readSessionCookie(SESSION_COOKIE_NAME);
    } catch {
      cookieValue = null;
    }
    const payload = readSessionPayload(cookieValue, config.sessionSecret, { now: this.now() });
    if (!payload) {
      throw new ServerPersistenceError('SESSION_REQUIRED', 'Oturum bulunamadı veya süresi doldu. Lütfen yeniden oturum açın.');
    }
    return payload;
  }

  async getCurrentSicil() {
    return (await this.getSessionIdentity()).sicil;
  }
}
