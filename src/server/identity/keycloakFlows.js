/**
 * Keycloak oturum açma akışının SEÇİMİ.
 *
 * MERGEN Rota iki akıştan yalnızca birini çalıştırır ve bu seçim AÇIKÇA
 * yapılandırmadan gelir:
 *
 *   • `authorization-code` (varsayılan, tercih edilen): Authorization Code +
 *     PKCE. Erişim jetonu tarayıcıya hiç ulaşmaz; kod → jeton takası sunucuda
 *     yapılır. Keycloak istemcisi gizli (confidential) ise bu takas geçerli bir
 *     istemci kimlik doğrulaması gerektirir.
 *
 *   • `implicit-bridge` (uyumluluk): Hâlihazırda implicit akışla çalışan bir
 *     Keycloak istemcisi için köprü. Jeton endpoint'i KULLANILMAZ, istemci
 *     secret'ı GEREKMEZ; jeton yine sunucuda doğrulanır ve aynı imzalı HttpOnly
 *     oturum çerezine çevrilir.
 *
 * Bu modül SAFTIR: ortam okumaz, ağa çıkmaz. Böylece hem sunucu yapılandırması
 * hem de saf yardımcılar aynı akış sabitlerini paylaşır.
 */

export const KEYCLOAK_FLOWS = Object.freeze({
  AUTHORIZATION_CODE: 'authorization-code',
  IMPLICIT_BRIDGE: 'implicit-bridge'
});

export const SUPPORTED_KEYCLOAK_FLOWS = Object.freeze([
  KEYCLOAK_FLOWS.AUTHORIZATION_CODE,
  KEYCLOAK_FLOWS.IMPLICIT_BRIDGE
]);

export const DEFAULT_KEYCLOAK_FLOW = KEYCLOAK_FLOWS.AUTHORIZATION_CODE;

/** Implicit köprünün tarayıcı tarafı geri dönüş yolu (uygulama içi). */
export const IMPLICIT_CALLBACK_PATH = '/auth/implicit-callback';

/** Doğrulanmış jetonu HttpOnly oturuma çeviren adanmış uç. */
export const IMPLICIT_SESSION_ENDPOINT = '/api/mergen-rota/auth/implicit-session';

/** Başarısız köprüden sonra kullanılan güvenli yeniden deneme adresi. */
export const LOGIN_ENDPOINT = '/api/mergen-rota/auth/login';

/**
 * Boş değer varsayılan akışa (Authorization Code) düşer. Tanınmayan veya bozuk
 * bir değer `null` döner: sessizce BAŞKA bir akışa geçilmez, yapılandırma
 * doğrulaması bunu açık bir hataya çevirir.
 */
export function parseKeycloakFlow(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_KEYCLOAK_FLOW;
  return SUPPORTED_KEYCLOAK_FLOWS.includes(raw) ? raw : null;
}
