// Senaryonun açık beklentileri görülmüş metin ve bu turun sunucu sonucu üzerinde denetlenir; dil yorumu yapılmaz.
function semanticFailures(expected, rendered, trace) {
  // Bu paket Rota senaryolarıdır; farklı bir sonuç açıkça belirtilmedikçe kanıtlı yanıt gerekir.
  expected = { outcome: 'grounded', ...expected };
  const failures = [];
  if (expected.table === true && !rendered.tables?.some((table) => table.rows > 0 && table.visible)) failures.push('istenen tablo gösterilmedi');
  // Belirli bir tablo (ör. ayrıca istenen görev listesi): başlıkları verilen sütunların hepsini taşıyan, satırlı ve görünür tablo gerekir;
  // başka bir tablonun (ör. özetin kişi tablosu) varlığı bu beklentiyi karşılamaz.
  if (Array.isArray(expected.tableHead) && !rendered.tables?.some((table) => table.rows > 0 && table.visible
    && expected.tableHead.every((head) => (table.head || []).includes(head)))) failures.push(`istenen tablo gösterilmedi: ${expected.tableHead.join(' | ')}`);
  if (expected.outcome && trace?.outcome !== expected.outcome) failures.push(`beklenen sonuç alınmadı: ${expected.outcome}`);
  if (expected.maxEvidence != null && (!Number.isSafeInteger(trace?.evidence) || trace.evidence > expected.maxEvidence)) failures.push('beklenen kanıt sınırı aşıldı');
  for (const text of expected.requires || []) if (!String(rendered.text || '').includes(text)) failures.push(`zorunlu görünür metin yok: ${text}`);
  for (const text of expected.forbids || []) if (String(rendered.text || '').includes(text)) failures.push(`yasak görünür metin var: ${text}`);
  return failures;
}
// Tamamlanmamış ürün yanıtı, senaryonun anlamsal beklentisi olmasa da kabul kanıtı değildir.
function completionFailures(rendered, trace) {
  const failures = [];
  if (rendered.status !== 'complete') failures.push('tarayıcı turu tamamlanamadı');
  if (['failed', 'error'].includes(trace?.outcome)) failures.push('sunucu turu başarısız');
  return failures;
}
// Sunucu yeniden yürütmesinin sözleşmesi (yeni planlayıcı çağrısı yok, kanıtlı doğrulanmış yanıt): betikli ve canlı kipte aynı uygulanır.
function replayFailures(expected, trace, calls) {
  if (expected?.serverReplay !== true) return [];
  const plan = calls.some((call) => call.ok && call.purpose === 'plan' && call.toolCalls?.includes('rota_plan'));
  return plan || trace?.outcome !== 'grounded' || !(trace?.evidence > 0) ? ['sunucu yeniden yürütme sözleşmesi sağlanmadı'] : [];
}
// Model yolunda gerçek plan çağrısı zorunludur; aday seçiminin sunucu yeniden yürütmesi açıkça belirtilir.
function modelFailures(expected, trace, calls) {
  const failures = [];
  const plan = calls.some((call) => call.ok && call.purpose === 'plan' && call.toolCalls?.includes('rota_plan'));
  if (expected?.serverReplay === true) failures.push(...replayFailures(expected, trace, calls));
  else if (!plan) failures.push('planlayıcı model çağrısı kanıtı yok');
  if (trace?.presentation?.mode === 'composed' && !trace.presentation.server && !calls.some((call) => call.ok && call.purpose === 'compose')) failures.push('model düzeni çağrı kanıtı yok');
  if (calls.some((call) => !call.ok || call.thinking !== 'off' || call.thinkingTokens !== 0 || !call.models?.length || call.models.some((model) => model !== 'claude-haiku-4-5-20251001'))) failures.push('model çağrısı kabul sözleşmesini sağlamadı');
  return failures;
}
module.exports = { semanticFailures, completionFailures, modelFailures, replayFailures };
