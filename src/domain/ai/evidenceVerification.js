import { FACT_LIMITS, createEvidenceFacts, renderEvidenceFact } from './evidenceFacts.js';

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parseEvidenceResponse(text) {
  if (typeof text !== 'string' || text.length > FACT_LIMITS.maxAnswerChars) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function analyzeGroundedAnswer(text, { evidenceIds = [], evidencePayloads = [], locale = 'tr' } = {}) {
  const failure = (code) => ({ ok: false, citedIds: [], issues: [{ code }] });
  const answer = parseEvidenceResponse(text);
  if (!exactKeys(answer, ['kind', 'claims']) || answer.kind !== 'rota'
    || !Array.isArray(answer.claims) || !answer.claims.length || answer.claims.length > FACT_LIMITS.maxClaims) {
    return failure('STRUCTURED_CLAIMS_REQUIRED');
  }
  if (answer.claims.some((claim) => !exactKeys(claim, ['evidenceId', 'factId', 'subjectId', 'field', 'operator', 'value'])
    || claim.operator !== 'eq' || typeof claim.field !== 'string')) return failure('INVALID_STRUCTURED_CLAIM');
  const available = new Set(evidenceIds);
  const factsById = new Map();
  for (const item of evidencePayloads) {
    let payload;
    try { payload = JSON.parse(item.payload); } catch { continue; }
    if (!payload || !available.has(item.id) || typeof payload.factScope !== 'string'
      || !payload.factScope.endsWith(`_${item.id}`) || payload.ok !== true || payload.evidenceId !== item.id) continue;
    const fields = answer.claims.filter((claim) => claim.evidenceId === item.id).map((claim) => claim.field);
    factsById.set(item.id, new Map(createEvidenceFacts(payload, { prefix: payload.factScope, subject: payload.subject || 'Rota', fields }).map((fact) => [fact.factId, fact])));
  }
  const lines = [], citedIds = [], seen = new Set();
  for (const claim of answer.claims) {
    if (!available.has(claim.evidenceId)) return failure('UNKNOWN_CITATION');
    const fact = factsById.get(claim.evidenceId)?.get(claim.factId);
    if (!fact || fact.subjectId !== claim.subjectId || fact.field !== claim.field
      || !Object.is(fact.value, claim.value)) return failure('UNSUPPORTED_EVIDENCE_VALUE');
    const key = `${claim.evidenceId}:${claim.factId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!citedIds.includes(claim.evidenceId)) citedIds.push(claim.evidenceId);
    lines.push(renderEvidenceFact(fact, claim.evidenceId, locale));
  }
  const normalized = lines.join('\n');
  if (normalized.length > FACT_LIMITS.maxAnswerChars) return failure('ANSWER_TOO_LARGE');
  return { ok: true, normalized, citedIds, issues: [] };
}
