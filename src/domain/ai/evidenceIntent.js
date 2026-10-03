export const TURN_ROUTES = Object.freeze({ UNDECIDED: 'undecided', GENERAL: 'general', ROTA: 'rota' });

export function requiresRotaEvidence(_text, { route = TURN_ROUTES.UNDECIDED, dataIntent = false } = {}) {
  return route === TURN_ROUTES.ROTA || dataIntent === true;
}

const WINDOW_KEYS = Object.freeze(['period', 'dateFrom', 'dateTo']);

function windowOf(response) {
  const window = response?.window;
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null;
  const keys = Object.keys(window);
  return keys.length && keys.every((key) => WINDOW_KEYS.includes(key) && typeof window[key] === 'string') ? window : null;
}

/**
 * Veri okunmadan önceki yönlendirme bildirimi: {"kind":"route","intent":…}.
 * Rota niyetinde isteğe bağlı `window` (period/dateFrom/dateTo) sorunun
 * dönemini bildirir.
 */
export function parseTurnRoute(response) {
  if (!response || response.kind !== 'route' || ![TURN_ROUTES.GENERAL, TURN_ROUTES.ROTA].includes(response.intent)) return null;
  const keys = Object.keys(response).length;
  if (keys === 2) return response.intent;
  return keys === 3 && response.intent === TURN_ROUTES.ROTA && windowOf(response) ? response.intent : null;
}

/** Rota yönlendirme bildirimindeki dönem; yoksa `null`. */
export function parseTurnWindow(response) {
  return parseTurnRoute(response) === TURN_ROUTES.ROTA ? windowOf(response) : null;
}
