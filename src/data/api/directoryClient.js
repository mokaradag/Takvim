import { requestJson } from './scheduleChangeClient.js';

/**
 * Kurum dışı personel aramasının istemcisi.
 *
 * Dizin uygulama anlık görüntüsüne KONULMAZ: arama yalnızca kullanıcı
 * "Diğer birimlerden personel göster" anahtarını açtığında, en az
 * {@link DIRECTORY_MIN_QUERY_LENGTH} karakterle ve gecikmeli (debounce)
 * gönderilir.
 */

export const DIRECTORY_MIN_QUERY_LENGTH = 2;
export const DIRECTORY_SEARCH_DEBOUNCE_MS = 250;

export function searchDirectory(query) {
  const text = String(query ?? '').trim();
  if (text.length < DIRECTORY_MIN_QUERY_LENGTH) {
    return Promise.resolve({ ok: true, value: { items: [], query: text } });
  }
  return requestJson(`/api/mergen-rota/directory/search?q=${encodeURIComponent(text)}`, { method: 'GET' });
}
