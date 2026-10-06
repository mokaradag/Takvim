import { FACT_LIMITS, createEvidenceFacts, fieldPatternCovers } from './evidenceFacts.js';
import { factRow, verifyRequestedFacts } from './requestContract.js';
import { renderVerifiedNarrative } from './evidenceNarrative.js';

/**
 * Kanıta dayalı son yanıtın BELİRLENİMCİ doğrulaması.
 *
 * Model olguları yalnızca SEÇER: `{"kind":"rota","facts":["R1:data.visibleTasks.total"]}`.
 * Başvuru, bu turdaki kanıt kimliği ve o kanıtta iddia edilebilir bir alan
 * yoludur (dizi indisi yerine `*` bütün satırları seçer). Değer, tür, özne ve
 * köken sunucunun kendi kanıt kaydından okunur; model değer yazmaz, bu yüzden
 * olgu uyduramaz. Önceki iddia biçimi (`claims`: kanıt, olgu, özne, alan,
 * işlem ve değerin birebir kopyası) de aynı doğrulamayla kabul edilir.
 *
 * Seçimin soruyla uyumu kullanıcı cümlesinden çıkarılmaz: sunucu turu,
 * modelin veri okumadan bildirdiği türlü isteği (`request`) ve kanıtın
 * sunucuda hesaplanan nüfusunu (`evidence`) verir; uyum bunlarla denetlenir.
 */

const FACT_REFERENCE = /^(R[1-9]\d?):((?:data(?:\.(?:[A-Za-z][A-Za-z0-9]*|\d+|\*))+)|returnedCount|totalCount|complete|truncated)$/;
const LAYOUTS = new Set(['auto', 'prose', 'list', 'table']);

function exactKeys(value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return keys.every((key) => Object.hasOwn(value, key)) && present.every((key) => keys.includes(key) || optional.includes(key));
}

export function parseEvidenceResponse(text) {
  if (typeof text !== 'string' || text.length > FACT_LIMITS.maxAnswerChars) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Bu turun geçerli kanıt yükleri: kimlik → zarf. */
function evidenceEnvelopes({ evidenceIds, evidencePayloads }) {
  const available = new Set(evidenceIds);
  const envelopes = new Map();
  for (const item of evidencePayloads) {
    let payload;
    try { payload = JSON.parse(item.payload); } catch { continue; }
    if (!payload || !available.has(item.id) || typeof payload.factScope !== 'string'
      || !payload.factScope.endsWith(`_${item.id}`) || payload.ok !== true || payload.evidenceId !== item.id) continue;
    envelopes.set(item.id, payload);
  }
  return { available, envelopes };
}

function factsOf(envelope, fields) {
  return createEvidenceFacts(envelope, { prefix: envelope.factScope, subject: envelope.subject || 'Rota', fields });
}

/**
 * Model seçimini doğrulanmış olgulara çevirir: `{ ok, facts: [{ evidenceId, fact }] }`
 * ya da `{ ok: false, issues }`.
 */
export function resolveEvidenceSelection(answer, { evidenceIds = [], evidencePayloads = [] } = {}) {
  const failure = (code) => ({ ok: false, facts: [], issues: [{ code }] });
  const { available, envelopes } = evidenceEnvelopes({ evidenceIds, evidencePayloads });
  const selected = [];
  const seen = new Set();
  const add = (evidenceId, fact) => {
    const key = `${evidenceId}:${fact.field}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push({ evidenceId, fact });
  };
  if (exactKeys(answer, ['kind', 'facts'], ['layout']) && answer.kind === 'rota') {
    if (!Array.isArray(answer.facts) || !answer.facts.length || answer.facts.length > FACT_LIMITS.maxClaims) return failure('FACT_SELECTION_REQUIRED');
    if (answer.layout != null && !LAYOUTS.has(answer.layout)) return failure('INVALID_FACT_REFERENCE');
    const references = [];
    for (const reference of answer.facts) {
      const match = typeof reference === 'string' ? FACT_REFERENCE.exec(reference.trim()) : null;
      if (!match) return failure('INVALID_FACT_REFERENCE');
      if (!available.has(match[1])) return failure('UNKNOWN_CITATION');
      if (!envelopes.has(match[1])) return failure('UNKNOWN_FACT_REFERENCE');
      references.push({ evidenceId: match[1], pattern: match[2] });
    }
    for (const [evidenceId, envelope] of envelopes) {
      const patterns = references.filter((reference) => reference.evidenceId === evidenceId).map((reference) => reference.pattern);
      if (!patterns.length) continue;
      const facts = factsOf(envelope, patterns);
      for (const pattern of patterns) {
        const matched = facts.filter((fact) => fieldPatternCovers(pattern, fact.field));
        if (!matched.length) return failure('UNKNOWN_FACT_REFERENCE');
      }
    }
    // Seçim sırası korunur: başvuru sırası, joker içinde kanıttaki sıra.
    for (const { evidenceId, pattern } of references) {
      for (const fact of factsOf(envelopes.get(evidenceId), [pattern]).filter((item) => fieldPatternCovers(pattern, item.field))) add(evidenceId, fact);
      if (selected.length > FACT_LIMITS.maxFacts) return failure('ANSWER_TOO_LARGE');
    }
    return { ok: true, facts: selected, layout: answer.layout || 'auto', issues: [] };
  }
  if (!exactKeys(answer, ['kind', 'claims']) || answer.kind !== 'rota'
    || !Array.isArray(answer.claims) || !answer.claims.length || answer.claims.length > FACT_LIMITS.maxClaims) {
    return failure('STRUCTURED_CLAIMS_REQUIRED');
  }
  if (answer.claims.some((claim) => !exactKeys(claim, ['evidenceId', 'factId', 'subjectId', 'field', 'operator', 'value'])
    || claim.operator !== 'eq' || typeof claim.field !== 'string')) return failure('INVALID_STRUCTURED_CLAIM');
  const factsById = new Map();
  for (const [id, envelope] of envelopes) {
    const fields = answer.claims.filter((claim) => claim.evidenceId === id).map((claim) => claim.field);
    if (fields.length) factsById.set(id, new Map(factsOf(envelope, fields).map((fact) => [fact.factId, fact])));
  }
  for (const claim of answer.claims) {
    if (!available.has(claim.evidenceId)) return failure('UNKNOWN_CITATION');
    const fact = factsById.get(claim.evidenceId)?.get(claim.factId);
    if (!fact || fact.subjectId !== claim.subjectId || fact.field !== claim.field
      || !Object.is(fact.value, claim.value)) return failure('UNSUPPORTED_EVIDENCE_VALUE');
    add(claim.evidenceId, fact);
  }
  return { ok: true, facts: selected, layout: 'auto', issues: [] };
}

/**
 * `request` verildiğinde seçim bildirilen isteğe uymalıdır (bkz.
 * requestContract.js); sunucu turu isteği her zaman verir.
 */
export function analyzeGroundedAnswer(text, { evidenceIds = [], evidencePayloads = [], locale = 'tr', request = null, evidence = new Map() } = {}) {
  const answer = parseEvidenceResponse(text);
  const selection = resolveEvidenceSelection(answer, { evidenceIds, evidencePayloads });
  if (!selection.ok) return { ok: false, citedIds: [], issues: selection.issues };
  if (request) {
    const verdict = verifyRequestedFacts(request, selection.facts, evidence);
    if (!verdict.ok) return { ok: false, citedIds: [], issues: verdict.issues };
    if (verdict.rankOrder) {
      const { evidenceId, collection, indexes } = verdict.rankOrder;
      const positions = new Map(indexes.map((index, position) => [index, position]));
      const rowOf = (item) => item.evidenceId === evidenceId ? factRow(evidence.get(evidenceId).tool, item.fact.field) : null;
      const ranked = selection.facts.filter((item) => rowOf(item)?.collection === collection)
        .sort((left, right) => positions.get(rowOf(left).index) - positions.get(rowOf(right).index));
      let offset = 0;
      selection.facts = selection.facts.map((item) => rowOf(item)?.collection === collection ? ranked[offset++] : item);
    }
  }
  const citedIds = [...new Set(selection.facts.map((item) => item.evidenceId))];
  const normalized = renderVerifiedNarrative(selection.facts, { locale, layout: selection.layout, operation: request?.operation || null });
  if (normalized.length > FACT_LIMITS.maxAnswerChars) return { ok: false, citedIds: [], issues: [{ code: 'ANSWER_TOO_LARGE' }] };
  return { ok: true, normalized, citedIds, facts: selection.facts, issues: [] };
}
