import { createHash } from 'node:crypto';
import { AI_CAPABILITIES, AI_PROFILES } from './aiModelRegistry.js';
import { normalizeAssistantMessageText } from './assistantContract.js';

/**
 * Rota AI anlamsal katman sözleşmesi — saf ve belirlenimci kurallar.
 *
 * Gömme (embedding) ve yeniden sıralama (rerank) modellerinin çıktısı
 * GÜVENİLMEZ dış veridir; burada doğrulanmadan hiçbir sıralamaya giremez.
 * Anlamsal yakınlık yalnızca sunucuya ait katalog öğelerini (Rota yetenekleri)
 * sıralar: kimlik, yetki, görünürlük ve kanıt buradan türemez. Sorgu metni
 * yorumlanmaz; anahtar sözcük, eş anlamlı ya da kalıp tablosu yoktur.
 * Ayrıntı: docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md
 */

export const SEMANTIC_CONTRACT_VERSION = 1;

export const SEMANTIC_LIMITS = Object.freeze({
  maxQueryChars: 2000,
  maxItemTextChars: 4000,
  maxCatalogueItems: 256,
  maxCandidates: 20,
  maxDimensions: 8192
});

/** Katalog öğe türleri KAPALIDIR: yalnızca sunucuya ait yetenek tanımları; veritabanı kaydı türü yoktur. */
export const SEMANTIC_ITEM_KINDS = Object.freeze({ TOOL: 'tool' });

export const SEMANTIC_FAILURES = Object.freeze({
  QUERY_EMPTY: 'QUERY_EMPTY',
  QUERY_TOO_LONG: 'QUERY_TOO_LONG',
  RESPONSE_SHAPE: 'RESPONSE_SHAPE',
  COUNT_MISMATCH: 'COUNT_MISMATCH',
  INDEX_INVALID: 'INDEX_INVALID',
  INDEX_DUPLICATE: 'INDEX_DUPLICATE',
  DIMENSION_INVALID: 'DIMENSION_INVALID',
  DIMENSION_MISMATCH: 'DIMENSION_MISMATCH',
  VALUE_NOT_FINITE: 'VALUE_NOT_FINITE',
  ZERO_VECTOR: 'ZERO_VECTOR',
  SPACE_MISMATCH: 'SPACE_MISMATCH'
});

const KINDS = new Set(Object.values(SEMANTIC_ITEM_KINDS));
const ITEM_ID = /^[a-z][a-z0-9_.-]{0,79}$/;
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PREPROCESSING = /^[a-z0-9][a-z0-9.:-]{0,63}$/;
const INVISIBLE = /[\u00AD\u200B\u2060\uFEFF]/g;
const MAX_ISSUES = 25;
const PROFILE_CAPABILITY = Object.freeze({
  [AI_PROFILES.EMBEDDING]: AI_CAPABILITIES.EMBEDDING,
  [AI_PROFILES.RERANK]: AI_CAPABILITIES.RERANK
});

// Yalnızca bu modülün kurduğu nesneler kabul edilir: dışarıda taklit edilen
// katalog, uzay, dizin ya da aday listesi doğrulamayı atlayamaz.
const CATALOGUES = new WeakSet();
const SPACES = new WeakSet();
const CANDIDATE_LISTS = new WeakSet();
const INDEX_VECTORS = new WeakMap();

const failure = (reason) => ({ ok: false, reason });
const token = (value, pattern) => typeof value === 'string' && pattern.test(value);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Sürüm ve geçersizlik kararlarının parmak izi: kanonik JSON üzerinde SHA-256. */
export function semanticFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Modele giden metnin yapısal normalleştirmesi: denetim ve görünmez karakterler
 * atılır, Unicode NFC'ye getirilir, boşluklar tekleşir. Büyük/küçük harf
 * katlanmaz (Türkçe I/ı/İ/i korunur); aksan, ek ya da sözcük değiştirilmez.
 * NFC temizlikten SONRA uygulanır: silinen karakterin yan yana getirdiği harf
 * ve birleşen işaret de birleşir; sonuç tekrar normalleştirmede değişmez.
 */
export function normalizeSemanticText(value) {
  return normalizeAssistantMessageText(value).replace(INVISIBLE, '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function normalizeSemanticQuery(value) {
  const text = normalizeSemanticText(value);
  if (!text) return failure(SEMANTIC_FAILURES.QUERY_EMPTY);
  if (text.length > SEMANTIC_LIMITS.maxQueryChars) return failure(SEMANTIC_FAILURES.QUERY_TOO_LONG);
  return { ok: true, value: text };
}

/** Araç kayıt defteri künyesinden katalog tanımı; metin aracın sunucuya ait açıklamasıdır. */
export function semanticToolDefinitions(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    id: tool?.name,
    kind: SEMANTIC_ITEM_KINDS.TOOL,
    version: tool?.version,
    text: tool?.description
  }));
}

// Tanım alanları bir kez okunur; doğrulanan değer katalogda kullanılan değerdir.
function catalogueEntry(definition, path, ids) {
  if (!isRecord(definition)) return { issues: [`${path}:shape`] };
  const { id, kind, version } = definition;
  const text = normalizeSemanticText(definition.text);
  const issues = [];
  if (!token(id, ITEM_ID)) issues.push(`${path}.id:invalid`);
  else if (ids.has(id)) issues.push(`${path}.id:duplicate`);
  ids.add(id);
  if (!KINDS.has(kind)) issues.push(`${path}.kind:unknown`);
  if (!Number.isSafeInteger(version) || version < 1) issues.push(`${path}.version:invalid`);
  if (!text) issues.push(`${path}.text:empty`);
  else if (text.length > SEMANTIC_LIMITS.maxItemTextChars) issues.push(`${path}.text:too-long`);
  return { issues, item: { id, kind, version, text } };
}

/**
 * Sunucuya ait anlamsal katalog. Öğe parmak izi tür, kimlik, sürüm ve metne;
 * katalog parmak izi öğelerin SIRASINA da bağlıdır (eşit skorda sıra belirler).
 */
export function createSemanticCatalogue(definitions) {
  // Uzunluk bir kez okunur ve yakalanan değer doğrulanır: negatif, kesirli ya da değişen uzunluk boş katalog damgalayamaz.
  const count = Array.isArray(definitions) ? definitions.length : 0;
  if (!Number.isSafeInteger(count) || count < 1 || count > SEMANTIC_LIMITS.maxCatalogueItems) return { ok: false, issues: ['$:count'] };
  const ids = new Set();
  // Seyrek dizinin boşluğu da denetlenir: her konum tam bir kez okunur.
  const entries = Array.from({ length: count }, (_, position) => catalogueEntry(definitions[position], `items[${position}]`, ids));
  const issues = entries.flatMap((entry) => entry.issues);
  if (issues.length) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };
  const items = entries.map(({ item: { id, kind, version, text } }) => Object.freeze({
    id, kind, version, text,
    fingerprint: semanticFingerprint([SEMANTIC_CONTRACT_VERSION, kind, id, version, text])
  }));
  const catalogue = Object.freeze({
    fingerprint: semanticFingerprint(items.map((item) => [item.id, item.fingerprint])),
    items: Object.freeze(items)
  });
  CATALOGUES.add(catalogue);
  return { ok: true, catalogue };
}

/** Yalnızca bu modülün kurduğu katalog doğrudur; aynı biçimli taklit nesne katalog sayılmaz. */
export function isSemanticCatalogue(value) {
  return CATALOGUES.has(value);
}

/**
 * Model rotasının künyesinden model kökeni; profilin yeteneğini taşımayan rota
 * kabul edilmez. Rotanın model kaydından çözülmesi çağıranın işidir (4B'de
 * `resolveModelProfile`); köken yetki taşımaz, yalnızca uzayı adlandırır.
 */
export function semanticModelProvenance(route, profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILE_CAPABILITY, profile) || !isRecord(route)) return null;
  // Alanlar bir kez okunur: doğrulanan değer kökene yazılan değerdir.
  const { profile: routeProfile, capabilities, model, provider } = route;
  if (routeProfile !== profile || !Array.isArray(capabilities) || !capabilities.includes(PROFILE_CAPABILITY[profile])) return null;
  if (!token(model, MODEL_TOKEN) || !token(provider, MODEL_TOKEN)) return null;
  return Object.freeze({ profile, model, provider });
}

/**
 * Gömme uzayı: yalnızca aynı model, sağlayıcı ve ön işlemeyle üretilmiş vektörler
 * karşılaştırılabilir. Uzay değişirse onunla kurulmuş dizin geçersizdir.
 */
export function createEmbeddingSpace(provenance, preprocessing) {
  if (!isRecord(provenance)) return null;
  // Köken alanları bir kez okunur: doğrulanan değer uzaya yazılan değerdir.
  const { profile, model, provider } = provenance;
  if (profile !== AI_PROFILES.EMBEDDING || !token(preprocessing, PREPROCESSING)) return null;
  if (!token(model, MODEL_TOKEN) || !token(provider, MODEL_TOKEN)) return null;
  const space = Object.freeze({
    profile, model, provider, preprocessing,
    key: semanticFingerprint([SEMANTIC_CONTRACT_VERSION, profile, model, provider, preprocessing])
  });
  SPACES.add(space);
  return space;
}

function isVector(value) {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
}

/**
 * Tek vektörü doğrular ve birim uzunluğa getirir; ölçekleme taşma ve alttaşmaya
 * karşı güvenlidir. Her değer bir kez okunur: doğrulanan değer kullanılan değerdir.
 */
function unitVector(value, dimensions) {
  if (!isVector(value)) return failure(SEMANTIC_FAILURES.RESPONSE_SHAPE);
  const { length } = value;
  // Uzunluk da model verisidir (Proxy): ayırmadan önce tam sayı ve sınır denetlenir.
  if (!Number.isSafeInteger(length) || length < 1 || length > SEMANTIC_LIMITS.maxDimensions) return failure(SEMANTIC_FAILURES.DIMENSION_INVALID);
  if (dimensions != null && length !== dimensions) return failure(SEMANTIC_FAILURES.DIMENSION_MISMATCH);
  const unit = new Float64Array(length);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const x = value[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) return failure(SEMANTIC_FAILURES.VALUE_NOT_FINITE);
    unit[i] = x;
    peak = Math.max(peak, Math.abs(x));
  }
  if (peak === 0) return failure(SEMANTIC_FAILURES.ZERO_VECTOR);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += (unit[i] / peak) ** 2;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < length; i += 1) unit[i] = unit[i] / peak / norm;
  return { ok: true, vector: unit };
}

// Model yanıtını okurken fırlayan erişimci (getter/Proxy) doğrulamadan kaçamaz; biçim hatası sayılır.
function readModelOutput(read) {
  try {
    return read();
  } catch {
    return failure(SEMANTIC_FAILURES.RESPONSE_SHAPE);
  }
}

/**
 * Dizin adresli gömme yanıtı `[{ index, vector }]`: her giriş tam bir kez, bütün
 * vektörler aynı boyutta. Girişler konumla okunur (yineleyiciye güvenilmez);
 * `count` giriş yinelenmeyen dizinle geldiğinde her yuva dolmuştur.
 */
function validateEmbeddingBatch(raw, count, dimensions = null) {
  return readModelOutput(() => readEmbeddingBatch(raw, count, dimensions));
}

function readEmbeddingBatch(raw, count, dimensions) {
  if (!Array.isArray(raw)) return failure(SEMANTIC_FAILURES.RESPONSE_SHAPE);
  if (raw.length !== count) return failure(SEMANTIC_FAILURES.COUNT_MISMATCH);
  const vectors = new Array(count);
  let size = dimensions;
  for (let position = 0; position < count; position += 1) {
    const entry = raw[position];
    if (!isRecord(entry)) return failure(SEMANTIC_FAILURES.RESPONSE_SHAPE);
    const { index, vector } = entry;
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) return failure(SEMANTIC_FAILURES.INDEX_INVALID);
    if (vectors[index]) return failure(SEMANTIC_FAILURES.INDEX_DUPLICATE);
    const unit = unitVector(vector, size);
    if (!unit.ok) return unit;
    size = unit.vector.length;
    vectors[index] = unit.vector;
  }
  return { ok: true, vectors, dimensions: size };
}

/** Dizin kimliği: sözleşme sürümü, katalog, uzay ve boyutun parmak izi. */
export function semanticIndexIdentity(catalogueFingerprint, spaceKey, dimensions) {
  return semanticFingerprint([SEMANTIC_CONTRACT_VERSION, catalogueFingerprint, spaceKey, dimensions]);
}

/** Kataloğun gömme dizini; kimliği katalog, uzay ve boyutun parmak izidir. */
export function createSemanticIndex(catalogue, space, embeddings) {
  if (!CATALOGUES.has(catalogue) || !SPACES.has(space)) throw new TypeError('SEMANTIC_INDEX_INPUT');
  const batch = validateEmbeddingBatch(embeddings, catalogue.items.length);
  if (!batch.ok) return batch;
  const index = Object.freeze({
    identity: semanticIndexIdentity(catalogue.fingerprint, space.key, batch.dimensions),
    catalogue,
    space,
    dimensions: batch.dimensions
  });
  INDEX_VECTORS.set(index, batch.vectors);
  return { ok: true, index };
}

function candidateList(candidates) {
  const list = Object.freeze(candidates);
  CANDIDATE_LISTS.add(list);
  return list;
}

/**
 * Sorgu vektörünü dizindeki öğelerle kosinüs benzerliğine göre sıralar ve en
 * fazla `limit` aday döndürür. Eşit skorda katalog sırası belirleyicidir. Başka
 * uzayda ya da boyutta üretilmiş sorgu karşılaştırılmaz.
 */
export function rankSemanticIndex(index, { space, embeddings, limit = SEMANTIC_LIMITS.maxCandidates } = {}) {
  const vectors = INDEX_VECTORS.get(index);
  if (!vectors) throw new TypeError('SEMANTIC_INDEX_REQUIRED');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_LIMITS.maxCandidates) throw new RangeError('SEMANTIC_LIMIT');
  if (!SPACES.has(space) || space.key !== index.space.key) return failure(SEMANTIC_FAILURES.SPACE_MISMATCH);
  const batch = validateEmbeddingBatch(embeddings, 1, index.dimensions);
  if (!batch.ok) return batch;
  const [query] = batch.vectors;
  const scored = index.catalogue.items.map((item, position) => {
    let dot = 0;
    for (let i = 0; i < query.length; i += 1) dot += query[i] * vectors[position][i];
    return { item, position, similarity: Math.min(1, Math.max(-1, dot)) };
  });
  scored.sort((left, right) => right.similarity - left.similarity || left.position - right.position);
  return {
    ok: true,
    candidates: candidateList(scored.slice(0, limit).map(({ item, similarity }, rank) => Object.freeze({
      id: item.id, kind: item.kind, rank: rank + 1, similarity
    })))
  };
}

/**
 * Yeniden sıralama yanıtı dizin adreslidir: `[{ index, score }]`. Model yalnızca
 * sunucunun verdiği adayları yeniden DİZER; aday ekleyemez ya da çıkaramaz. Her
 * aday tam bir sonlu skor almalıdır; aksi hâlde yanıt reddedilir ve ilk aşamanın
 * sırası geçerli kalır. Eşit skorda ilk aşama sırası korunur.
 */
export function applyRerankScores(candidates, scores) {
  if (!CANDIDATE_LISTS.has(candidates)) throw new TypeError('SEMANTIC_CANDIDATES_REQUIRED');
  return readModelOutput(() => rerankCandidates(candidates, scores));
}

function rerankCandidates(candidates, scores) {
  if (!Array.isArray(scores)) return failure(SEMANTIC_FAILURES.RESPONSE_SHAPE);
  if (scores.length !== candidates.length) return failure(SEMANTIC_FAILURES.COUNT_MISMATCH);
  const relevance = new Array(candidates.length);
  for (let position = 0; position < candidates.length; position += 1) {
    const entry = scores[position];
    if (!isRecord(entry)) return failure(SEMANTIC_FAILURES.RESPONSE_SHAPE);
    const { index, score } = entry;
    if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length) return failure(SEMANTIC_FAILURES.INDEX_INVALID);
    if (relevance[index] !== undefined) return failure(SEMANTIC_FAILURES.INDEX_DUPLICATE);
    if (typeof score !== 'number' || !Number.isFinite(score)) return failure(SEMANTIC_FAILURES.VALUE_NOT_FINITE);
    relevance[index] = score;
  }
  const ordered = candidates
    .map((candidate, position) => ({ candidate, position, score: relevance[position] }))
    .sort((left, right) => right.score - left.score || left.position - right.position);
  return {
    ok: true,
    candidates: candidateList(ordered.map(({ candidate, score }, rank) => Object.freeze({
      id: candidate.id, kind: candidate.kind, rank: rank + 1, similarity: candidate.similarity, relevance: score
    })))
  };
}
