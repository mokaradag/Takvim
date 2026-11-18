// Senaryonun açık beklentileri görülmüş metin ve bu turun sunucu sonucu üzerinde denetlenir; dil yorumu yapılmaz.
// `now`: turun gönderildiği an; dönem etiketi ekran görüntüsü sonrasındaki saatle değil, sunucunun dönemi çözdüğü günle beklenir.
function semanticFailures(expected, rendered, trace, now = new Date()) {
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
  // Seçenekli zorunlu metin (`matches`: düzenli ifade kaynakları): ör. kapsamın hareket sayısı YA DA açık kayıt sınırı.
  for (const source of expected.matches || []) if (!new RegExp(source, 'u').test(String(rendered.text || ''))) failures.push(`zorunlu görünür ifade yok: ${source}`);
  for (const source of expected.rejects || []) if (new RegExp(source, 'iu').test(String(rendered.text || ''))) failures.push('yasak görünür ifade var: ' + source);
  // Bugün dâhil son N günün aralığı (Türkiye günü) yanıtta görünmelidir: daha kısa bir dönemin grafiği dönem denetimini geçmez.
  // Dönem etiketi bütün olarak aranır: "13 Temmuz – 30 Eylül" metni "3 Temmuz – 30 Eylül" beklentisini sonek eşleşmesiyle geçmez.
  if (Number.isSafeInteger(expected.periodDays) && !new RegExp(`(^|[^0-9])${periodLabel(expected.periodDays, now).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(String(rendered.text || ''))) failures.push(`istenen dönem görünmüyor: ${periodLabel(expected.periodDays, now)}`);
  // Grafik beklentileri AYNI görünür grafikte aranır: başlıktaki ölçü (`chartTitle`), bütün etiketler (`chartItems`) ve en az nokta sayısı
  // (`chartMinItems`, ör. 90 günlük haftalık dizinin kovaları). Düzyazıda doğru olup başka bir grafik çizen yanıt geçmez.
  const chartExpected = expected.chartTitle || Array.isArray(expected.chartItems) || Number.isSafeInteger(expected.chartMinItems);
  if (chartExpected && !(rendered.charts || []).some((chart) => chart.visible
    && (!expected.chartTitle || String(chart.title || '').includes(expected.chartTitle))
    && (!Array.isArray(expected.chartItems) || expected.chartItems.every((label) => (chart.items || []).some((item) => String(item).includes(label))))
    && (!Number.isSafeInteger(expected.chartMinItems) || (chart.items || []).length >= expected.chartMinItems))) {
    failures.push(`istenen grafik içeriği görünmüyor: ${[expected.chartTitle, ...(expected.chartItems || []), expected.chartMinItems].filter((item) => item != null).join(' | ')}`);
  }
  return failures;
}
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
/** Sunucunun aralık yazımıyla aynı biçim (`rangeLabel`): "2 Temmuz – 30 Eylül 2026", yıl sınırında iki yıl. */
function periodLabel(days, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const part = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  if (from === today) return `${part(today)} ${today.slice(0, 4)}`;
  const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  if (from.slice(0, 7) === today.slice(0, 7) && from.endsWith('-01') && Number(today.slice(8, 10)) === lastDay) return `${MONTHS[Number(today.slice(5, 7)) - 1]} ${today.slice(0, 4)}`;
  if (from.slice(0, 7) === today.slice(0, 7)) return `${Number(from.slice(8, 10))}–${part(today)} ${today.slice(0, 4)}`;
  return from.slice(0, 4) === today.slice(0, 4) ? `${part(from)} – ${part(today)} ${today.slice(0, 4)}` : `${part(from)} ${from.slice(0, 4)} – ${part(today)} ${today.slice(0, 4)}`;
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
  if (expected?.serverReplay !== true) return calls.some((call) => call.ok && call.purpose === 'plan' && call.toolCalls?.includes('rota_plan')) ? [] : ['planlayıcı model çağrısı kanıtı yok'];
  const plan = calls.some((call) => call.purpose === 'plan');
  return plan || trace?.outcome !== 'grounded' || !(trace?.evidence > 0) ? ['sunucu yeniden yürütme sözleşmesi sağlanmadı'] : [];
}
// Model düzeniyle (sunucu düzeni değil) çizilen yanıt, başarılı bir düzen çağrısı kaydı gerektirir: betikli ve canlı kipte aynı uygulanır.
function compositionFailures(trace, calls) {
  return trace?.presentation?.mode === 'composed' && !trace.presentation.server && !calls.some((call) => call.ok && call.purpose === 'compose')
    ? ['model düzeni çağrı kanıtı yok'] : [];
}
// Betikli kip: yalnızca canlı model kimliği ve düşünme gereksinimleri atlanır; yeniden yürütme ve düzen çağrısı kanıtı denetlenir.
function scriptedFailures(expected, trace, calls) {
  return [...replayFailures(expected, trace, calls), ...compositionFailures(trace, calls)];
}
// Model yolunda gerçek plan çağrısı zorunludur; aday seçiminin sunucu yeniden yürütmesi açıkça belirtilir.
function modelFailures(expected, trace, calls) {
  const failures = [];
  const plan = calls.some((call) => call.ok && call.purpose === 'plan' && call.toolCalls?.includes('rota_plan'));
  if (expected?.serverReplay === true) failures.push(...replayFailures(expected, trace, calls));
  else if (!plan) failures.push('planlayıcı model çağrısı kanıtı yok');
  failures.push(...compositionFailures(trace, calls));
  if (calls.some((call) => !call.ok || call.thinking !== 'off' || call.thinkingTokens !== 0 || !call.models?.length || call.models.some((model) => model !== 'claude-haiku-4-5-20251001'))) failures.push('model çağrısı kabul sözleşmesini sağlamadı');
  return failures;
}
module.exports = { periodLabel, semanticFailures, completionFailures, modelFailures, replayFailures, scriptedFailures };
