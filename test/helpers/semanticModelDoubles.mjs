/**
 * Anlamsal model sınırının belirlenimci ikizleri (gömme ve yeniden sıralama).
 *
 * Bunlar model DEĞİLDİR ve anlam çıkarmaz: metni yorumlamaz, yalnızca testin
 * verdiği sabit eşlemeye (metin → vektör, sorgu + belge → skor) bakar. Her
 * çağrı sıradaki davranışı uygular: olağan yanıt, ham (bozuk) yanıt, hata,
 * sinyale uyan takılma (`hang`) ya da sinyali yok sayan takılma (`stall`).
 * Çağrılar kaydedilir; testler model sınırına ne gittiğini doğrular.
 */

function respond(behavior, signal, normal) {
  switch (behavior.type) {
    case 'raw':
      return behavior.value;
    case 'throw':
      throw behavior.error;
    case 'hang':
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    case 'stall':
      return new Promise(() => {});
    default:
      return normal();
  }
}

/** Sabit gömme: `vectorFor(text, purpose)` dizin adresli yanıta çevrilir. */
export function createEmbeddingDouble({ vectorFor, behaviors = [] }) {
  const calls = [];
  const queue = [...behaviors];
  async function embed(texts, { purpose, signal }) {
    calls.push({ purpose, texts: [...texts] });
    return respond(queue.shift() ?? { type: 'vectors' }, signal,
      () => texts.map((text, index) => ({ index, vector: vectorFor(text, purpose) })));
  }
  return { embed, calls };
}

/** Sabit yeniden sıralama: `scoreFor(query, document)` dizin adresli yanıta çevrilir. */
export function createRerankDouble({ scoreFor, behaviors = [] }) {
  const calls = [];
  const queue = [...behaviors];
  async function rerank(query, documents, { signal }) {
    calls.push({ query, documents: [...documents] });
    return respond(queue.shift() ?? { type: 'scores' }, signal,
      () => documents.map((document, index) => ({ index, score: scoreFor(query, document) })));
  }
  return { rerank, calls };
}

export function oneHot(size, position, weight = 1) {
  return Array.from({ length: size }, (_, index) => (index === position ? weight : 0));
}
