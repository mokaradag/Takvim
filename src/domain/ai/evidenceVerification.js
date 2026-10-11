import { claimableContract, metricEntry, semanticCarrierKey } from './claimableEvidence.js';
import { FACT_LIMITS, createEvidenceFacts, fieldPatternCovers } from './evidenceFacts.js';
import { canonicalField } from './evidencePopulation.js';
import { factRow, metricAllowedForRow, rowFieldState, rowMetricFields, verifyRequestedFacts } from './requestContract.js';
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

/** Metnin başındaki tek JSON nesnesinin sonu (dizgelerdeki ayraçlar sayılmaz); yoksa -1. */
function leadingObjectEnd(text) {
  if (text[0] !== '{') return -1;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) === 0) return index + 1;
  }
  return -1;
}

/**
 * Modelin yapılandırılmış yanıtı: tek JSON değeri, tek kod çiti içinde de gelebilir.
 * Modelin JSON'un yanına yazdığı açıklama hiçbir zaman gösterilmez (yanıt doğrulanmış
 * olgulardan çizilir); bu yüzden tek kod çiti ya da baştaki tek nesne dışındaki metin
 * yok sayılır. Birden çok kod çiti belirsizdir ve kabul edilmez.
 */
export function parseEvidenceResponse(text) {
  if (typeof text !== 'string' || text.length > FACT_LIMITS.maxAnswerChars) return null;
  const trimmed = text.trim();
  const parse = (body) => { try { return JSON.parse(body); } catch { return null; } };
  const whole = parse(trimmed.replace(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/, '$1'));
  if (whole !== null) return whole;
  const fences = [...trimmed.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)\n?```/g)];
  if (fences.length === 1) return parse(fences[0][1].trim());
  if (fences.length > 1) return null;
  const end = leadingObjectEnd(trimmed);
  return end > 0 ? parse(trimmed.slice(0, end)) : null;
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
  // Planda bildirilen dilin seçimde yinelenmesi zararsızdır: yanıt dili planın bildirimidir, seçim onu değiştiremez.
  if (exactKeys(answer, ['kind', 'facts'], ['layout', 'language']) && answer.kind === 'rota') {
    if (!Array.isArray(answer.facts) || !answer.facts.length || answer.facts.length > FACT_LIMITS.maxClaims) return failure('FACT_SELECTION_REQUIRED');
    if (answer.layout != null && !LAYOUTS.has(answer.layout)) return failure('INVALID_FACT_REFERENCE');
    if (answer.language != null && !['tr', 'en'].includes(answer.language)) return failure('INVALID_FACT_REFERENCE');
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
        // Kayıtlı bir yolun joker deseni, bütün satırlarda boş olan çok değerli alanda hiçbir olgu seçmeyebilir.
        if (!matched.length && !(pattern.includes('*') && claimableContract(envelope.tool).paths.includes(canonicalField(pattern).slice(5)))) {
          return failure('UNKNOWN_FACT_REFERENCE');
        }
      }
    }
    // Seçim sırası korunur: başvuru sırası, joker içinde kanıttaki sıra.
    for (const { evidenceId, pattern } of references) {
      for (const fact of factsOf(envelopes.get(evidenceId), [pattern]).filter((item) => fieldPatternCovers(pattern, item.field))) add(evidenceId, fact);
      if (selected.length > FACT_LIMITS.maxFacts) return failure('ANSWER_TOO_LARGE');
    }
    if (!selected.length) return failure('FACT_SELECTION_REQUIRED');
    return { ok: true, facts: selected, layout: answer.layout ?? null, issues: [] };
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
  return { ok: true, facts: selected, layout: null, issues: [] };
}

/**
 * `request` verildiğinde seçim bildirilen isteğe uymalıdır (bkz.
 * requestContract.js); sunucu turu isteği her zaman verir.
 */
function renderableFacts(request, items, evidence, answer) {
  const rendered = [...items];
  const rows = new Map();
  for (const item of items) {
    const source = evidence.get(item.evidenceId);
    const row = source && factRow(source.tool, item.fact.field);
    if (row?.kind === 'row') rows.set(`${item.evidenceId}|${row.path}`, { item, source, row });
  }
  for (const { item, source, row } of rows.values()) {
    const object = row.path.split('.').slice(1).reduce((value, key) => value?.[key], source.envelope.data);
    for (const metric of request.metrics) {
      if (!metricAllowedForRow(request, metric, source, object, row.canonical)) continue;
      const bindings = (request.fields || []).filter((field) => field.metric === metric && field.tool === source.tool);
      const candidates = rowMetricFields(source.tool, row.canonical, metric);
      const references = (answer.facts || []).filter((reference) => reference.startsWith(`${item.evidenceId}:`)).map((reference) => reference.slice(reference.indexOf(':') + 1));
      const chosen = [...references, ...items.filter((other) => other.evidenceId === item.evidenceId).map((other) => other.fact.field)]
        .map((field) => semanticCarrierKey(source.tool, field));
      const fields = candidates.filter((field) => bindings.length
        ? bindings.some((binding) => binding.path === `data.${row.canonical}.*.${field}`)
        : candidates.length === 1 || chosen.includes(semanticCarrierKey(source.tool, `data.${row.canonical}.*.${field}`)));
      for (const field of fields) {
        if (rowFieldState(source.tool, row.canonical, object, field) !== 'empty') continue;
        const concrete = `${row.path}.${field.replace(/\*/g, '0')}`;
        if (rendered.some((other) => other.evidenceId === item.evidenceId && other.fact.field === concrete)) continue;
        const semantic = metricEntry(source.tool, `${row.canonical}.*.${field}`);
        rendered.push({ evidenceId: item.evidenceId, fact: { ...item.fact, field: concrete, value: null,
          semantic: { ...item.fact.semantic, ...semantic, metric, displayValue: null } } });
      }
    }
  }
  return rendered;
}

export function analyzeGroundedAnswer(text, { evidenceIds = [], evidencePayloads = [], locale = 'tr', request = null, evidence = new Map() } = {}) {
  const answer = parseEvidenceResponse(text);
  const selection = resolveEvidenceSelection(answer, { evidenceIds, evidencePayloads });
  if (!selection.ok) return { ok: false, citedIds: [], issues: selection.issues };
  // Bildirilen düzen veri okunmadan önce bağlanmıştır: seçim onu yinelemek zorunda değildir, yalnızca çelişemez.
  const layout = selection.layout ?? (request?.layout || 'auto');
  let emptyProofs = [];
  let emptyRank = [];
  if (request) {
    if (request.layout && request.layout !== 'auto' && layout !== request.layout) return { ok: false, citedIds: [], issues: [{ code: 'LAYOUT_MISMATCH' }] };
    const verdict = verifyRequestedFacts(request, selection.facts, evidence);
    if (!verdict.ok) return { ok: false, citedIds: [], issues: verdict.issues };
    emptyProofs = verdict.empty || [];
    emptyRank = verdict.emptyRank || [];
    if (verdict.rankOrder) {
      const positions = new Map(verdict.rankOrder.map((row, index) => [`${row.evidenceId}|${row.path}`, index]));
      const position = (item) => {
        const source = evidence.get(item.evidenceId);
        const row = source && factRow(source.tool, item.fact.field);
        return row?.kind === 'row' ? positions.get(`${item.evidenceId}|${row.path}`) : undefined;
      };
      const ranked = selection.facts.filter((item) => position(item) !== undefined).sort((left, right) => position(left) - position(right));
      let offset = 0;
      selection.facts = selection.facts.map((item) => position(item) !== undefined ? ranked[offset++] : item);
    }
  }
  const citedIds = [...new Set(selection.facts.map((item) => item.evidenceId))];
  const rendered = request ? renderableFacts(request, selection.facts, evidence, answer) : selection.facts;
  const normalized = renderVerifiedNarrative(rendered, { locale, layout, operation: request?.operation || null, empty: emptyProofs, emptyRank });
  if (normalized.length > FACT_LIMITS.maxAnswerChars) return { ok: false, citedIds: [], issues: [{ code: 'ANSWER_TOO_LARGE' }] };
  return { ok: true, normalized, citedIds, facts: selection.facts, issues: [] };
}
