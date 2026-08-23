/**
 * Kurumsal kullanıcı fotoğrafı URL üretimi — TEK merkez.
 *
 * Fotoğraf adresi `<TABAN_URL>/<SICIL>.jpg` biçimindedir. Taban adres
 * tarayıcıdan istendiği için `NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL`
 * ortam değişkeninden okunur; bu değer bir SIR DEĞİLDİR ve istemci paketine
 * gömülür (kurum içi görsel dizini adresi). Gerçek adres yalnızca `.env.local`
 * içinde tutulur, depoya işlenmez.
 *
 * Fotoğraf tamamen sunum verisidir: üretilen URL hiçbir yerde saklanmaz ve
 * yüklenemeyen bir görsel uygulamanın veri akışını etkilemez (baş harflere
 * düşülür).
 */

const EMPLOYEE_NUMBER_PATTERN = /^\d{1,20}$/;

/** Sondaki eğik çizgiler temizlenir; boş/geçersiz taban adres `''` döner. */
export function normalizeUserPhotoBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

/**
 * Yapılandırılmış taban adres. `process.env.NEXT_PUBLIC_...` referansı Next.js
 * tarafından derleme sırasında satır içine alınabilmesi için birebir yazılır.
 */
export function userPhotoBaseUrl() {
  return normalizeUserPhotoBaseUrl(process.env.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL);
}

/** Sicil yalnızca rakamlardan oluşmalı ve tamamen sıfır olmamalıdır. */
export function isPhotographableEmployeeNo(value) {
  const raw = String(value ?? '').trim();
  return EMPLOYEE_NUMBER_PATTERN.test(raw) && Number(raw) > 0;
}

/**
 * `buildUserPhotoUrl(employeeNo)` → `<TABAN_URL>/<KODLANMIS_SICIL>.jpg`
 * Taban adres yoksa veya Sicil eksik/bozuksa `null` döner; çağıran taraf baş
 * harf yedeğini gösterir.
 */
export function buildUserPhotoUrl(employeeNo, baseUrl = userPhotoBaseUrl()) {
  const base = normalizeUserPhotoBaseUrl(baseUrl);
  if (!base) return null;
  const raw = String(employeeNo ?? '').trim();
  if (!isPhotographableEmployeeNo(raw)) return null;
  return `${base}/${encodeURIComponent(raw)}.jpg`;
}

/** Person benzeri bir nesneden fotoğraf adresi üretir. */
export function personPhotoUrl(person, baseUrl = userPhotoBaseUrl()) {
  return buildUserPhotoUrl(person?.employeeNo ?? person?.sicil ?? person?.id, baseUrl);
}
