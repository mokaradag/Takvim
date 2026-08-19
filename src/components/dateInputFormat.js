import { TR_MONTHS, TR_MONTHS_LONG, fmt, fmtDisplayDate, getAppDateDisplayFormat } from '../scheduling/dates/index.js';

/**
 * Düzenlenebilir tarih alanının biçimlendirme ve okuma kuralları.
 *
 * Modül React'ten BAĞIMSIZDIR: aynı kural hem kutuda hem de doğrudan sınanır.
 * Ayarlar sayfasındaki *Tarih biçimi* seçeneği yalnızca pasif etiketleri
 * değiştiriyor, düzenlenebilir alanlar `gg/aa/yyyy` biçiminde kalıyordu; aynı
 * ekranda `18 Ağu 2026` yazan bir etiketin yanında `18/08/2026` bekleyen bir
 * kutu duruyordu.
 *
 * YAZMA tercihe uyar, OKUMA bilerek daha geniştir: kullanıcı biçimi
 * değiştirdiğinde yarım kalmış bir giriş ya da kopyalanmış eski bir metin
 * reddedilmemelidir.
 */

const trLower = (value) => String(value).toLocaleLowerCase('tr');

const MONTH_INDEX = new Map();
TR_MONTHS.forEach((name, index) => MONTH_INDEX.set(trLower(name), index));
TR_MONTHS_LONG.forEach((name, index) => MONTH_INDEX.set(trLower(name), index));

export const PATTERN_PLACEHOLDER = '18 Ağu 2026';
export const SLASH_PLACEHOLDER = 'gg/aa/yyyy';

/** Yürürlükteki tercihin yer tutucusu; hata iletisi de bundan türetilir. */
export function dateInputHint(dateFormat = getAppDateDisplayFormat()) {
  return dateFormat === 'dd/mm/yyyy' ? SLASH_PLACEHOLDER : PATTERN_PLACEHOLDER;
}

function isoFromParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Metni ISO tarihe çevirir.
 *
 * @returns {string|null} ISO tarih, boş giriş için `''`, çözülemeyen giriş için `null`
 */
export function parseDisplayDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // ISO biçimli metin de TAKVİM DOĞRULAMASINDAN geçer. Tireli metin
  // `maskDateDraft` süzgecini atladığı için `2026-02-31` doğrudan kabul
  // ediliyor, `parseDate()` onu mart ayına yuvarlıyor ya da imkânsız tarih
  // kalıcı kayda düşüyordu.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isoFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return isoFromParts(Number(slash[3]), Number(slash[2]), Number(slash[1]));

  // `18 Ağu 2026` / `18 Ağustos 2026`. Ay adı Türkçe kurallarıyla küçültülür:
  // `Ağu` ile `AĞU` aynı aya çözülmelidir.
  const named = text.match(/^(\d{1,2})\s+([^\s\d]+)\s+(\d{4})$/);
  if (named) {
    const month = MONTH_INDEX.get(trLower(named[2]));
    if (month == null) return null;
    return isoFromParts(Number(named[3]), month + 1, Number(named[1]));
  }
  return null;
}

/** Tercihe göre düzenlenebilir metin. */
export function formatEditableDate(value) {
  if (!value) return '';
  // `fmt` zaten tercihe duyarlıdır: `dd/mm/yyyy` seçiliyken eğik çizgili
  // biçimi, `pattern` seçiliyken `18 Ağu 2026` biçimini verir.
  return getAppDateDisplayFormat() === 'dd/mm/yyyy' ? fmtDisplayDate(value) : fmt(value, 'dd MMM yyyy');
}

/**
 * Yalnızca RAKAM yazan kullanıcıya eğik çizgileri kendiliğinden ekler.
 *
 * Maske harf içeren girişe uygulanmaz: `18 Ağu 2026` yazılırken rakamlar
 * ayıklanıp `18/20/26` üretilirdi.
 */
export function maskDateDraft(value) {
  const text = String(value || '');
  if (!/^[\d/]*$/.test(text)) return text;
  const digits = text.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
