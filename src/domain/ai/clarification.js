import { canonicalActualId } from '../identity/actualId.js';

/**
 * Rota AI aday seçimi — sunucu ile tarayıcının ortak, saf kuralları.
 *
 * Belirsiz ad aramasının adayları sunucuda (en fazla on) tutulur; kullanıcının
 * sonraki turdaki numaralı seçimi ("2") modele bırakılmadan kayıtlı aday
 * kimliğine bağlanır. Kimlik her zaman Sicil, proje ya da görev kimliğidir; ad
 * eşleşmesi kimlik değildir.
 */

export const CLARIFICATION_LIMITS = Object.freeze({ maxCandidates: 10 });

/** Kayıtlı aday başvurusu: `{ ordinal, projectId | taskId | personSicil }`; geçersizse `null`. */
export function clarificationReference(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const ordinal = candidate.ordinal;
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= CLARIFICATION_LIMITS.maxCandidates) return null;
  const projectId = canonicalActualId(candidate.projectId);
  if (projectId) return { ordinal, projectId };
  const taskId = canonicalActualId(candidate.taskId);
  if (taskId) return { ordinal, taskId };
  const personSicil = Number(candidate.personSicil);
  return Number.isSafeInteger(personSicil) && personSicil > 0 ? { ordinal, personSicil } : null;
}

export function clarificationReferences(candidates) {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set();
  return candidates.map(clarificationReference).filter((reference) => {
    if (!reference || seen.has(reference.ordinal)) return false;
    seen.add(reference.ordinal);
    return true;
  }).sort((left, right) => left.ordinal - right.ordinal);
}

/** Yanıtın tamamı tek bir aday numarasıdır: "2", "2.", "#2", "(2)". */
const CHOICE_NUMBER = /^#?\(?([1-9]\d?)[.)]?$/;

/**
 * Kullanıcının açıklama yanıtındaki aday seçimi: sıfırdan başlayan sıra ya da
 * `null`. Sunucu adayları numaralı sunar ve numarayla seçim ister; yalnızca
 * tamamı tek bir aday numarası olan yanıt seçimdir. Sözcükle anlatılan seçim
 * sunucuda yorumlanmaz: model kullanıcıya yeniden sorar ya da kullanıcının
 * yazdığı adla arar (doğal dil çıkarımı Aşama 4'ün işidir).
 */
export function selectedCandidateOrdinal(text, candidateCount) {
  const count = Number(candidateCount);
  if (!Number.isInteger(count) || count < 1 || count > CLARIFICATION_LIMITS.maxCandidates) return null;
  const match = CHOICE_NUMBER.exec(String(text ?? '').trim());
  const value = match ? Number(match[1]) : null;
  return value != null && value <= count ? value - 1 : null;
}
