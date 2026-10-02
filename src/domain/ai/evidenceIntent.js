export const TURN_ROUTES = Object.freeze({ UNDECIDED: 'undecided', GENERAL: 'general', ROTA: 'rota' });

export function requiresRotaEvidence(_text, { route = TURN_ROUTES.UNDECIDED, dataIntent = false } = {}) {
  return route === TURN_ROUTES.ROTA || dataIntent === true;
}

export function parseTurnRoute(response) {
  return response && Object.keys(response).length === 2 && response.kind === 'route'
    && [TURN_ROUTES.GENERAL, TURN_ROUTES.ROTA].includes(response.intent) ? response.intent : null;
}
