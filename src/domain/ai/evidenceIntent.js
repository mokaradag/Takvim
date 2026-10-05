export const TURN_ROUTES = Object.freeze({ UNDECIDED: 'undecided', GENERAL: 'general', ROTA: 'rota' });

export function requiresRotaEvidence(_text, { route = TURN_ROUTES.UNDECIDED, dataIntent = false } = {}) {
  return route === TURN_ROUTES.ROTA || dataIntent === true;
}

/** Sunucunun oluşturduğu yanıt dilleri; dili model bildirir, sunucu yalnızca değeri doğrular. */
export const REPLY_LANGUAGES = Object.freeze(['tr', 'en']);

const WINDOW_KEYS = Object.freeze(['period', 'dateFrom', 'dateTo']);
const ROTA_KEYS = Object.freeze(['window', 'request']);

function windowOf(response) {
  const window = response?.window;
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null;
  const keys = Object.keys(window);
  return keys.length && keys.every((key) => WINDOW_KEYS.includes(key) && typeof window[key] === 'string') ? window : null;
}

/**
 * Veri okunmadan önceki yönlendirme bildirimi: {"kind":"route","intent":…}.
 * Her niyet yanıt dilini (`language`) taşıyabilir; Rota niyeti türlü isteği
 * (`request`) ve isteğe bağlı dönemi (`window`) de taşır. İsteğin içeriğini
 * sunucu ayrıca doğrular.
 */
export function parseTurnRoute(response) {
  if (!response || response.kind !== 'route' || ![TURN_ROUTES.GENERAL, TURN_ROUTES.ROTA].includes(response.intent)) return null;
  const extra = Object.keys(response).filter((key) => key !== 'kind' && key !== 'intent');
  if (extra.includes('language') && !REPLY_LANGUAGES.includes(response.language)) return null;
  const rotaKeys = extra.filter((key) => key !== 'language');
  if (rotaKeys.length && (response.intent !== TURN_ROUTES.ROTA || rotaKeys.some((key) => !ROTA_KEYS.includes(key)))) return null;
  if (rotaKeys.includes('window') && !windowOf(response)) return null;
  return response.intent;
}

/** Bildirilen yanıt dili; yoksa `null`. */
export function parseTurnLanguage(response) {
  return parseTurnRoute(response) && REPLY_LANGUAGES.includes(response.language) ? response.language : null;
}

/** Rota yönlendirme bildirimindeki dönem; yoksa `null`. */
export function parseTurnWindow(response) {
  return parseTurnRoute(response) === TURN_ROUTES.ROTA ? windowOf(response) : null;
}

/** Rota yönlendirme bildirimindeki ham istek; yoksa `null`. */
export function parseTurnRequest(response) {
  return parseTurnRoute(response) === TURN_ROUTES.ROTA && Object.hasOwn(response, 'request') ? response.request : null;
}
