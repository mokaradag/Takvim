import { parseSicil } from './sicil.js';

/**
 * Geçici geliştirme kimliği, Keycloak Sicil claim'iyle birebir aynı ayrıştırma
 * kuralını kullanır. Kural `sicil.js` içinde tek kaynaktan yönetilir.
 */
export function parseDevelopmentSicil(value) {
  return parseSicil(value);
}
