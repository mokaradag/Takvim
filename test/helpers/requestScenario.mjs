/**
 * Türlü istekle olgu doğrulaması: sunucu turunun son doğrulamasıyla aynı yol
 * (bildirimin ayrıştırılması, varlık bağlama, kanıt dizini, seçim doğrulaması).
 * Güven kaynağı (kullanıcı metni ya da sunucu seçimi) ayrıca sınanır; burada
 * varsayılan olarak her metin ve kimlik güvenilir sayılır.
 */
import { registerServerOnlyShim } from './serverOnlyShim.mjs';

registerServerOnlyShim();

const { analyzeGroundedAnswer } = await import('../../src/domain/ai/evidenceVerification.js');
const { bindRequestEntities, parseRequestDeclaration, requestEvidence } = await import('../../src/server/ai/tools/requestDeclaration.js');

/** Fikstür saatinin (NOW) Türkiye iş günü. */
export const REQUEST_TODAY = '2026-09-30';

export function parsedRequest(raw, { today = REQUEST_TODAY, textTrusted = () => true, identityTrusted = () => true } = {}) {
  return parseRequestDeclaration(raw, { textTrusted, identityTrusted, today });
}

/** `fields` olgu yollarıdır; kanıt kimliği yazılmazsa R1 varsayılır. */
export function verifyRequested(ledger, fields, raw, { today = REQUEST_TODAY, selection = null, locale = 'tr', layout = null } = {}) {
  const request = parsedRequest(raw, { today });
  const entries = ledger.requestEntries();
  const facts = fields.map((field) => (/^R\d+:/.test(field) ? field : `R1:${field}`));
  return analyzeGroundedAnswer(JSON.stringify({ kind: 'rota', facts, ...(layout ? { layout } : {}) }), {
    evidenceIds: ledger.ids(),
    evidencePayloads: ledger.payloads(),
    locale,
    request: { ...request, entities: bindRequestEntities(request, entries, selection) },
    evidence: requestEvidence(request, entries, today)
  });
}
