// Senaryonun açık beklentileri görülmüş metin ve bu turun sunucu sonucu üzerinde denetlenir; dil yorumu yapılmaz.
// `now`: turun gönderildiği an; dönem etiketi ekran görüntüsü sonrasındaki saatle değil, sunucunun dönemi çözdüğü günle beklenir.
function semanticFailures(expected, rendered, trace, now = new Date(), expectedChart = null) {
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
  // İstenen takvim dönemi (ör. bu hafta ya da bu ay/geçen ay) çözülen takvim aralığıyla doğrulanır; göreli etiket tek başına yetmez.
  if (expected.periodKind) {
    const text = String(rendered.text || '');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    const en = expected.language === 'en';
    if (expected.periodKind === 'this_week' || expected.periodKind === 'last_week') {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      const offset = expected.periodKind === 'last_week' ? dow + 7 : dow;
      const mon = new Date(Date.parse(`${today}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
      const sun = new Date(Date.parse(`${mon}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
      const weekLabel = formatRangeLabel(mon, sun, en);
      if (!new RegExp(`(^|[^0-9])${weekLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) failures.push(`istenen hafta dönemi görünmüyor: ${expected.periodKind}`);
    } else if (expected.periodKind === 'this_month_vs_last_month') {
      const curName = (en ? EN_MONTHS : MONTHS)[m - 1];
      const prevName = (en ? EN_MONTHS : MONTHS)[prevM - 1];
      // Her ay etiketi ya tek başına tam ay adı (`Ekim 2026`) ya da 1–son gün tam aralığı (`1–31 Ekim 2026`) olmalıdır.
      // Kısmi bir gün aralığı (`1–10 Ekim 2026`) metnin başka yerindeki yalın ay adıyla geçersiz kılınamaz.
      const validMonth = (year, month, name) => {
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const escaped = `${name} ${year}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = [...text.matchAll(new RegExp(`(?:(\\d{1,2})\\s*[–-]\\s*(\\d{1,2})|(\\d{1,2}))?\\s*${escaped}`, 'gu'))];
        if (!matches.length) return false;
        const hasPartial = matches.some((match) => {
          const [, start, end, single] = match;
          if (single) return true;
          if (start && end) return !(Number(start) === 1 && Number(end) === lastDay);
          return false;
        });
        return !hasPartial;
      };
      // "Geçen ay" / "bu ay" (veya "Last month" / "this month") birlikte geçiyorsa her ay kendi ifadesine bağlı olmalıdır (yer değiştirmiş aylar reddedilir).
      const prevClause = en ? new RegExp(`Last month[^\\n;]*${prevName} ${prevY}`, 'iu') : new RegExp(`Geçen ay[^\\n;]*${prevName} ${prevY}`, 'iu');
      const curClause = en ? new RegExp(`this month[^\\n.]*${curName} ${y}`, 'iu') : new RegExp(`bu ay[^\\n.]*${curName} ${y}`, 'iu');
      const hasBothClauses = en ? (/Last month/iu.test(text) && /this month/iu.test(text)) : (/Geçen ay/iu.test(text) && /bu ay/iu.test(text));
      const boundClauses = !hasBothClauses || (prevClause.test(text) && curClause.test(text));
      if (!validMonth(prevY, prevM, prevName) || !validMonth(y, m, curName) || !boundClauses) failures.push('istenen ay karşılaştırma dönemleri görünmüyor');
    }
  }
  // Grafik türü ve içerik beklentileri AYNI görünür grafikte aranır: başlıktaki ölçü (`chartTitle`), bütün etiketler (`chartItems`),
  // en az nokta sayısı (`chartMinItems`) ve istenen grafik türü (`expectedChart` / `chartType`).
  const chartType = expectedChart || expected.chartType || null;
  const chartExpected = chartType || expected.chartTitle || Array.isArray(expected.chartItems) || Number.isSafeInteger(expected.chartMinItems);
  if (chartExpected && !(rendered.charts || []).some((chart) => chart.visible
    && (!chartType || chartType === 'any' || chart.type === chartType)
    && (!expected.chartTitle || String(chart.title || '').includes(expected.chartTitle))
    && (!Array.isArray(expected.chartItems) || expected.chartItems.every((label) => (chart.items || []).some((item) => String(item).includes(label))))
    && (!Number.isSafeInteger(expected.chartMinItems) || (chart.items || []).length >= expected.chartMinItems))) {
    failures.push(`istenen grafik içeriği görünmüyor: ${[chartType, expected.chartTitle, ...(expected.chartItems || []), expected.chartMinItems].filter((item) => item != null).join(' | ')}`);
  }
  return failures;
}
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Sunucunun aralık yazımıyla aynı biçim (`rangeLabel`): aynı ayda "16–22 Kasım 2026", ay sınırında "2 Temmuz – 30 Eylül 2026", yıl sınırında iki yıl. */
function formatRangeLabel(from, to, en = false) {
  const months = en ? EN_MONTHS : MONTHS;
  const part = (day) => `${Number(day.slice(8, 10))} ${months[Number(day.slice(5, 7)) - 1]}`;
  if (from === to) return `${part(to)} ${to.slice(0, 4)}`;
  const lastDay = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0)).getUTCDate();
  if (from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && Number(to.slice(8, 10)) === lastDay) return `${months[Number(to.slice(5, 7)) - 1]} ${to.slice(0, 4)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))}–${part(to)} ${to.slice(0, 4)}`;
  return from.slice(0, 4) === to.slice(0, 4) ? `${part(from)} – ${part(to)} ${to.slice(0, 4)}` : `${part(from)} ${from.slice(0, 4)} – ${part(to)} ${to.slice(0, 4)}`;
}
function periodLabel(days, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  return formatRangeLabel(from, today, false);
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
// Betikli kip: yalnızca canlı model kimliği ve düşünme gereksinimleri atlanır; yeniden yürütme, düzen ve gün devri denetlenir.
function scriptedFailures(expected, trace, calls) {
  const rollover = calls.some((call) => call.error === 'day_rollover' || call.status === 409) ? ['betikli uç gün devri nedeniyle 409 döndürdü'] : [];
  return [...rollover, ...replayFailures(expected, trace, calls), ...compositionFailures(trace, calls)];
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
