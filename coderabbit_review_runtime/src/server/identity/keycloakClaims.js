import { parseSicil } from './sicil.js';

/**
 * Doğrulanmış Keycloak claim'lerinin MERGEN Rota kimliğine saf dönüşümü.
 *
 * Bu modül GÜVEN KARARI VERMEZ: yalnızca imzası ve standart claim'leri
 * doğrulanmış bir token'dan alanları okur. Sicil, güvenilen tek anahtardır;
 * diğer alanlar salt görüntüleme içindir ve yetkilendirmede kullanılmaz.
 */

export const KEYCLOAK_CLAIM_MAP = Object.freeze({
  username: 'preferred_username',
  fullName: 'name',
  firstName: 'given_name',
  lastName: 'family_name',
  email: 'email',
  emailVerified: 'email_verified',
  sicil: 'sicil',
  sector: 'sektor',
  department: 'department',
  mudurluk: 'mudurluk',
  subject: 'sub',
  sessionId: 'sid',
  sessionState: 'session_state'
});

function text(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

/** Keycloak `resource_access` rollerini yalnızca bilgi amaçlı düzleştirir. */
export function extractResourceRoles(claims, clientId) {
  const access = claims?.resource_access;
  if (!access || typeof access !== 'object') return [];
  const entry = clientId ? access[clientId] : null;
  const roles = Array.isArray(entry?.roles) ? entry.roles : [];
  return [...new Set(roles.filter((role) => typeof role === 'string' && role.trim()).map((role) => role.trim()))].sort();
}

export function extractKeycloakIdentity(claims, { clientId = '' } = {}) {
  const map = KEYCLOAK_CLAIM_MAP;
  const username = text(claims?.[map.username]);
  const firstName = text(claims?.[map.firstName]);
  const lastName = text(claims?.[map.lastName]);
  const fullName = text(claims?.[map.fullName]) || [firstName, lastName].filter(Boolean).join(' ');

  return {
    // Sicil claim'i yalnızca katı biçim kuralını geçerse kimlik üretir.
    sicil: parseSicil(claims?.[map.sicil]),
    username,
    name: fullName,
    firstName,
    lastName,
    email: text(claims?.[map.email]),
    emailVerified: claims?.[map.emailVerified] === true,
    sector: text(claims?.[map.sector]),
    department: text(claims?.[map.department]),
    mudurluk: text(claims?.[map.mudurluk]),
    subject: text(claims?.[map.subject]),
    sessionId: text(claims?.[map.sessionId]) || text(claims?.[map.sessionState]),
    // Roller MERGEN Rota yetkilendirmesini ETKİLEMEZ; SYSTEM_ADMIN yalnızca
    // MR_UserRoles tablosundan gelir. Burada yalnızca teşhis için taşınır.
    resourceRoles: extractResourceRoles(claims, clientId)
  };
}

function maskText(value, keep = 1) {
  const raw = text(value);
  if (!raw) return '';
  return raw.length <= keep ? '*'.repeat(raw.length) : `${raw.slice(0, keep)}${'*'.repeat(Math.min(raw.length - keep, 6))}`;
}

/** E-posta yerel bölümü maskelenir, alan adı korunur: `m****@ornek.internal`. */
export function maskEmail(value) {
  const raw = text(value);
  const at = raw.lastIndexOf('@');
  if (at <= 0) return raw ? maskText(raw) : '';
  return `${maskText(raw.slice(0, at))}${raw.slice(at)}`;
}

export function maskSicil(value) {
  const raw = text(value);
  return raw.length <= 2 ? '*'.repeat(raw.length) : `${'*'.repeat(raw.length - 2)}${raw.slice(-2)}`;
}

/**
 * Günlüklere yalnızca maskelenmiş kimlik yazılır: ham token, tam ad, tam
 * e-posta veya tam sicil hiçbir zaman günlüğe düşmez.
 */
export function maskIdentityForLog(identity) {
  return {
    sicil: identity?.sicil == null ? null : maskSicil(identity.sicil),
    username: maskText(identity?.username),
    email: maskEmail(identity?.email),
    hasName: Boolean(text(identity?.name)),
    subject: maskText(identity?.subject, 4),
    sessionId: maskText(identity?.sessionId, 4)
  };
}

/**
 * Oturum yanıtında paylaşılabilecek güvenli görüntüleme alanları. Yetki
 * kararları bu alanlardan ASLA türetilmez.
 */
export function safeDisplayIdentity(identity) {
  return {
    username: text(identity?.username) || null,
    name: text(identity?.name) || null,
    email: text(identity?.email) || null,
    sector: text(identity?.sector) || null,
    department: text(identity?.department) || null,
    mudurluk: text(identity?.mudurluk) || null
  };
}
