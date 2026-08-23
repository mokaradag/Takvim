/**
 * Avatar kimlik çözümü — saf yardımcılar.
 *
 * Görev satırları hem kanonik `assigneeIds` (Sicil) hem de görüntüleme amaçlı
 * `sorumlu` adlarını taşır. Fotoğraf için Sicil gerekir; bu nedenle ÖNCE kimlik
 * üzerinden eşleştirme yapılır, ad eşleşmesi yalnızca son çare olarak kullanılır.
 *
 * AYNI ADA SAHİP iki çalışan varsa ad eşleşmesi TAHMİN YAPMAZ: kişi çözülemez
 * ve baş harf yedeğine düşülür. Bu, yanlış kişinin fotoğrafını göstermeyi
 * engeller.
 */

function text(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Kişi listesinden kimlik/Sicil/ad dizinleri kurar. Ad dizininde çakışma varsa
 * o ad `null` ile işaretlenir (belirsiz).
 */
export function createPersonLookup(people = []) {
  const byId = new Map();
  const byName = new Map();

  for (const person of people) {
    if (!person) continue;
    const id = text(person.id);
    const employeeNo = text(person.employeeNo);
    if (id) byId.set(id, person);
    // Sicil de kimlik anahtarı olarak kabul edilir: Gerçek Sistem'de
    // `assigneeIds` Sicil değerlerini taşır.
    if (employeeNo && !byId.has(employeeNo)) byId.set(employeeNo, person);

    const name = text(person.name);
    if (!name) continue;
    byName.set(name, byName.has(name) ? null : person);
  }

  return {
    byId(value) {
      const key = text(value);
      return key ? (byId.get(key) || null) : null;
    },
    byName(value) {
      const key = text(value);
      return key ? (byName.get(key) || null) : null;
    },
    size: byId.size
  };
}

export const EMPTY_PERSON_LOOKUP = createPersonLookup([]);

/**
 * Avatar yığını için görüntülenecek girdileri üretir.
 * Girdi sırası: `people` → `personIds` → `names`.
 */
export function resolveAvatarEntries({ people = null, personIds = null, names = null, lookup = EMPTY_PERSON_LOOKUP } = {}) {
  const entries = [];
  const seen = new Set();

  const push = (person, fallbackName) => {
    const resolvedName = text(person?.name) || text(fallbackName);
    if (!resolvedName && !person) return;
    const key = text(person?.id) || text(person?.employeeNo) || resolvedName;
    if (!key || seen.has(key)) return;
    seen.add(key);
    entries.push({ key, name: resolvedName, person: person || null });
  };

  if (Array.isArray(people) && people.length) {
    for (const person of people) push(person, person?.name);
    return entries;
  }

  // Önce kanonik kimlikler çözülür (fotoğraf için Sicil gerekir).
  const resolvedNames = new Set();
  for (const id of Array.isArray(personIds) ? personIds : []) {
    const person = lookup.byId(id);
    if (!person) continue;
    resolvedNames.add(text(person.name));
    push(person, person.name);
  }

  // Kimlikle çözülemeyen sorumlular kaybolmaz: ad üzerinden eklenir. Ad birden
  // çok çalışanla eşleşiyorsa kişi belirsizdir ve baş harf yedeği kullanılır.
  for (const name of Array.isArray(names) ? names : []) {
    if (resolvedNames.has(text(name))) continue;
    push(lookup.byName(name), name);
  }
  return entries;
}
