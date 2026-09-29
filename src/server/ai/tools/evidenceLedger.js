import 'server-only';
import {
  EVIDENCE_LIMITS,
  evidenceIdFor,
  evidenceOrdinal,
  normalizeEvidenceSummary
} from '../../../domain/ai/evidenceContract.js';

/**
 * Bir turun kanıt defteri.
 *
 * Yalnızca BAŞARILI araç sonuçları kanıt olur ve turda sırayla R1, R2…
 * kimliği alır. Kayıt, modele verilen güvenli görünümün kendisidir (araç
 * sonucu JSON'u); SQL, yetki ayrıntısı, anahtar ya da ham sağlayıcı akışı
 * içermez. Yanıtta atfedilen kanıtlar yanıtla aynı işlemde kalıcılaştırılır.
 */

const MAX_EVIDENCE_TEXT_CHARS = 32 * 1024;
const MAX_SUMMARY_JSON_CHARS = 4000;

function highlightPairs(highlights = []) {
  return highlights
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => {
      const separator = item.indexOf(': ');
      return separator > 0
        ? { label: item.slice(0, separator), value: item.slice(separator + 2) }
        : { label: 'Ayrıntı', value: item };
    });
}

export function createEvidenceLedger({ maxEntries = EVIDENCE_LIMITS.maxEvidenceOrdinal } = {}) {
  const entries = [];

  return Object.freeze({
    /** Başarılı araç sonucunu kaydeder; kimlik (R<n>) döner. Defter doluysa `null`. */
    register({ tool, kind, label, entity = null, generatedAt, complete, truncated, partial, counts, highlights = [] }) {
      if (entries.length >= maxEntries) return null;
      const id = evidenceIdFor(entries.length + 1);
      const summary = normalizeEvidenceSummary({
        id, kind, label, entity, generatedAt, complete, truncated, partial, counts, highlights: highlightPairs(highlights)
      });
      if (!summary) return null;
      entries.push({ id, tool, kind, summary, payload: null });
      return id;
    },
    /**
     * Modele verilen sonuç metni (kimliği içerir) kayda bağlanır. Sınırı aşan
     * metin kesilmez (kesik JSON geçersiz olurdu); yerine geçerli bir not saklanır.
     */
    attachPayload(id, text) {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      const payload = String(text);
      entry.payload = payload.length <= MAX_EVIDENCE_TEXT_CHARS
        ? payload
        : JSON.stringify({ evidenceId: id, payloadOmitted: 'size' });
    },
    ids() {
      return entries.map((entry) => entry.id);
    },
    size() {
      return entries.length;
    },
    has(id) {
      return entries.some((entry) => entry.id === id);
    },
    /** Belirlenimci yanıt doğrulaması için modele verilen güvenli yükler. */
    payloads(ids = null) {
      const wanted = ids ? new Set(ids) : null;
      return entries
        .filter((entry) => (!wanted || wanted.has(entry.id)) && entry.payload)
        .map((entry) => ({ id: entry.id, payload: entry.payload }));
    },
    /** Verilen kimliklerin özetleri, kanıt sırasına göre. */
    summaries(ids = null) {
      const wanted = ids ? new Set(ids) : null;
      return entries.filter((entry) => !wanted || wanted.has(entry.id)).map((entry) => entry.summary);
    },
    /** Kalıcılık satırları (0018): yalnızca atfedilen kanıtlar. */
    persistable(ids) {
      const wanted = new Set(ids);
      return entries
        .filter((entry) => wanted.has(entry.id) && entry.payload)
        .slice(0, EVIDENCE_LIMITS.maxEvidencePerAnswer)
        .map((entry) => {
          const summaryJson = JSON.stringify(entry.summary);
          return {
            ordinal: evidenceOrdinal(entry.id),
            toolName: entry.tool,
            evidenceType: entry.kind,
            label: entry.summary.label,
            entityType: entry.summary.entity?.type ?? null,
            entityId: entry.summary.entity?.id ?? null,
            generatedAt: entry.summary.generatedAt,
            isComplete: entry.summary.complete,
            isTruncated: entry.summary.truncated,
            summaryJson: summaryJson.length <= MAX_SUMMARY_JSON_CHARS
              ? summaryJson
              : JSON.stringify({ ...entry.summary, highlights: [] }),
            evidenceJson: entry.payload
          };
        });
    }
  });
}
