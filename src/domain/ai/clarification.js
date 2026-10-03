import { canonicalActualId } from '../identity/actualId.js';

/**
 * Rota AI aday seçimi — sunucu ile tarayıcının ortak, saf kuralları.
 *
 * Belirsiz ad aramasının adayları sunucuda (en fazla on) tutulur; kullanıcının
 * sonraki turdaki numaralı seçimi ("2", "ikincisi", "ilki") modele bırakılmadan
 * kayıtlı aday kimliğine bağlanır. Kimlik her zaman Sicil, proje ya da görev
 * kimliğidir; ad eşleşmesi kimlik değildir.
 */

export const CLARIFICATION_LIMITS = Object.freeze({ maxCandidates: 10, maxReplyChars: 80, maxReplyTokens: 7 });

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

function fold(value) {
  return String(value ?? '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
}

const TURKISH_ORDINALS = Object.freeze([
  ['birinci', 1], ['ikinci', 2], ['ucuncu', 3], ['dorduncu', 4], ['besinci', 5],
  ['altinci', 6], ['yedinci', 7], ['sekizinci', 8], ['dokuzuncu', 9], ['onuncu', 10]
]);
const ENGLISH_ORDINALS = Object.freeze({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 });
const ORDINAL_SUFFIX = /^(?:si|su|yi|yu|sini|sunu|ni|nu|ye|ya|sine|suna|nin|nun|de|da|deki|daki)?$/;
const DIGIT_ORDINAL = /^(\d{1,2})(nci|inci|uncu|nu|ni|si|su|yi|yu|ye|ya|e|a|i|u)?$/;
const FIRST = new Set(['ilk', 'ilki', 'ilkini', 'ilkine', 'ilkinin', 'ilkindeki']);
const LAST = new Set(['son', 'sonuncu', 'sonuncusu', 'sonuncuyu', 'sonuncusunu', 'sonuncuya', 'sondaki', 'last']);
const AFFIRMATIVE = new Set(['evet', 'yes', 'dogru', 'aynen', 'tamam', 'ok', 'okay', 'onayliyorum', 'onay']);
/** Sayma sözcükleri ("ilk iki") seçimi belirsizleştirir. */
const CARDINAL = new Set(['bir', 'iki', 'uc', 'dort', 'bes', 'alti', 'yedi', 'sekiz', 'dokuz', 'on', 'two', 'three', 'both', 'hepsi', 'ikisi', 'tumu', 'all']);
const FILLER = new Set([
  'aday', 'adayi', 'adaydi', 'secenek', 'secenegi', 'numara', 'numarali', 'no', 'nolu', 'olan', 'olani', 'siradaki',
  'listedeki', 'lutfen', 'bu', 'su', 'o', 'kisi', 'kisiyi', 'proje', 'projeyi', 'gorev', 'gorevi', 'kayit', 'kaydi',
  'kastettim', 'kastediyorum', 'seciyorum', 'sectim', 'sec', 'istiyorum', 'olsun', 'option', 'number', 'the', 'one',
  'please', 'i', 'mean', 'meant', 'pick', 'choose', 'select', 'that'
]);

function ordinalWord(token) {
  if (FIRST.has(token)) return 1;
  if (Object.hasOwn(ENGLISH_ORDINALS, token)) return ENGLISH_ORDINALS[token];
  for (const [stem, value] of TURKISH_ORDINALS) {
    if (token.startsWith(stem) && ORDINAL_SUFFIX.test(token.slice(stem.length))) return value;
  }
  return null;
}

/**
 * Kullanıcının açıklama yanıtındaki aday seçimi: sıfırdan başlayan sıra ya da
 * `null`. Yalnızca kısa ve tek anlamlı yanıt seçimdir: sıra sözcüğü ("ikincisi",
 * "ilki", "sonuncusu") ya da sıra işaretli sayı ("2.", "#2", "2'yi") her yerde;
 * çıplak sayı yalnızca yanıtın tamamı seçimse. Tek aday onayında "evet" ilk
 * adaydır. Birden çok farklı sıra ya da aralık dışı sıra seçim değildir.
 */
export function selectedCandidateOrdinal(text, candidateCount) {
  const count = Number(candidateCount);
  if (!Number.isInteger(count) || count < 1 || count > CLARIFICATION_LIMITS.maxCandidates) return null;
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > CLARIFICATION_LIMITS.maxReplyChars) return null;
  const marked = new Set();
  const tokens = [];
  for (const part of fold(raw).replace(/['’`]/g, '').split(/\s+/).filter(Boolean)) {
    const ordinalMark = /^#\d|^\d{1,2}[.)]/.test(part);
    const token = part.replace(/^[#(]+/, '').replace(/[.,;:!?)]+$/, '').replace(/^(\d{1,2})\.(?=\p{L})/u, '$1');
    if (!token) continue;
    tokens.push(token);
    if (ordinalMark) marked.add(token);
  }
  if (!tokens.length || tokens.length > CLARIFICATION_LIMITS.maxReplyTokens) return null;
  const values = new Set();
  let bareNumber = false;
  let affirmed = false;
  let other = false;
  for (const token of tokens) {
    const digits = DIGIT_ORDINAL.exec(token);
    if (digits) {
      values.add(Number(digits[1]));
      if (!digits[2] && !marked.has(token)) bareNumber = true;
      continue;
    }
    const word = ordinalWord(token);
    if (word != null) { values.add(word); continue; }
    if (LAST.has(token)) { values.add(count); continue; }
    if (AFFIRMATIVE.has(token)) { affirmed = true; continue; }
    if (CARDINAL.has(token)) return null;
    if (!FILLER.has(token)) other = true;
  }
  if (values.size === 0) return affirmed && count === 1 && !other ? 0 : null;
  if (values.size !== 1 || (bareNumber && other)) return null;
  const value = [...values][0];
  return value >= 1 && value <= count ? value - 1 : null;
}
