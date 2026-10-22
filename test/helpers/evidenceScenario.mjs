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
  return JSON.stringify({ name: 'rota_plan', arguments: { intent: 'rota', language, request: window ? { ...request, filters: { ...request.filters, ...window } } : request } });
}

/** Senaryo bildirimi sahte sağlayıcıda yerel araç çağrısı olarak üretilir; eski route metni çevrilmez. */
export function nativeDeclaration(response) {
  let value;
  try { value = JSON.parse(response.text || 'null'); } catch { return response; }
  if (value?.name !== 'rota_plan' || !value.arguments) return response;
  return { ...response, text: '', toolCalls: [{ id: 'declaration', name: 'rota_plan', arguments: JSON.stringify(value.arguments) }, ...(response.toolCalls || [])] };
}

/** Modele giden bütün sistem iletileri: sabit yönerge ve dökümün sonuna eklenen sunucu notları. */
export function systemText(messages) {
  return messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
}
