// Senaryonun açık beklentileri görülmüş metin ve bu turun sunucu sonucu üzerinde denetlenir; dil yorumu yapılmaz.
function semanticFailures(expected, rendered, trace) {
  if (!expected) return [];
  const failures = [];
  if (expected.outcome && trace?.outcome !== expected.outcome) failures.push(`beklenen sonuç alınmadı: ${expected.outcome}`);
  if (expected.maxEvidence != null && (!Number.isSafeInteger(trace?.evidence) || trace.evidence > expected.maxEvidence)) failures.push('beklenen kanıt sınırı aşıldı');
  for (const text of expected.requires || []) if (!String(rendered.text || '').includes(text)) failures.push(`zorunlu görünür metin yok: ${text}`);
  for (const text of expected.forbids || []) if (String(rendered.text || '').includes(text)) failures.push(`yasak görünür metin var: ${text}`);
  return failures;
}
module.exports = { semanticFailures };
