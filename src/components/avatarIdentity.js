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
  const ambiguousIds = new Set();
  const addIdentity = (rawId, person) => {
    const id = text(rawId);
    if (!id || ambiguousIds.has(id)) return;
    const previous = byId.get(id);
    // İç kimlik ile Sicil farklı kişilere işaret ediyorsa tahmin yapılmaz.
    if (previous && previous !== person) {
      byId.delete(id);
      ambiguousIds.add(id);
    } else if (!previous) {
      byId.set(id, person);
    }
  };

  // Önce iç kimlikler, sonra iki Sicil alanı kaydedilir; çakışmalar belirsizdir.
  for (const person of people) {
    if (!person) continue;
    addIdentity(person.id, person);
    const name = text(person.name);
    if (!name) continue;
    byName.set(name, byName.has(name) ? null : person);
  }
  for (const person of people) {
    if (!person) continue;
    addIdentity(person.employeeNo, person);
    addIdentity(person.sicil, person);
  }

  return {
    byId(value) {
      const key = text(value);
      return key ? (byId.get(key) || null) : null;
    },
    // Çakışan anahtar, görev kapsamında bile başka bir kişiye tahminle bağlanamaz.
    isAmbiguousId(value) {
      const key = text(value);
      return key ? ambiguousIds.has(key) : false;
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
  // Ad başına KAÇ KEZ çözüldüğü sayılır: küme kullanmak, aynı görünen ada sahip
  // iki çalışandan yalnızca biri kimlikle çözüldüğünde ötekini de eliyor ve
  // sorumlu, baş harf yedeğine düşmek yerine yığından tümüyle kayboluyordu.
  const resolvedNameCounts = new Map();
  for (const id of Array.isArray(personIds) ? personIds : []) {
    const person = lookup.byId(id);
    if (!person) continue;
    const resolvedName = text(person.name);
    resolvedNameCounts.set(resolvedName, (resolvedNameCounts.get(resolvedName) || 0) + 1);
    push(person, person.name);
  }

  // Kimlikle çözülemeyen sorumlular kaybolmaz: ad üzerinden eklenir. Ad birden
  // çok çalışanla eşleşiyorsa kişi belirsizdir ve baş harf yedeği kullanılır.
  for (const name of Array.isArray(names) ? names : []) {
    const key = text(name);
    const remaining = resolvedNameCounts.get(key) || 0;
    if (remaining > 0) {
      resolvedNameCounts.set(key, remaining - 1);
      continue;
    }
    push(lookup.byName(name), name);
  }
  return entries;
}
