import assert from 'node:assert/strict';
import { createEvidenceFacts } from '../../src/domain/ai/evidenceFacts.js';

export function claimFor(envelope, field, changes = {}) {
  const fact = createEvidenceFacts(envelope, { prefix: envelope.factScope, subject: envelope.subject || 'Rota' })
    .find((item) => item.field === field);
  assert.ok(fact, `Kanıt alanı yok: ${field}`);
  return { evidenceId: envelope.evidenceId, factId: fact.factId, subjectId: fact.subjectId, field: fact.field,
    operator: 'eq', value: fact.value, ...changes };
}

export function evidenceReply(...claims) {
  return JSON.stringify({ kind: 'rota', claims });
}

/**
 * Veri okunmadan önceki türlü istek bildirimi: modelin araç çağrısıyla aynı
 * yanıttaki (ya da ayrı) metni. Sunucu cümleyi yorumlamaz; bu bildirimi doğrular.
 */
export function declared(request, { language = 'tr', window = null } = {}) {
  return JSON.stringify({ kind: 'route', intent: 'rota', language, ...(window ? { window } : {}), request });
}
