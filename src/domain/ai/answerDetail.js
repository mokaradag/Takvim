/**
 * Bilgin yanıt ayrıntısı (Aşama 4E) — kullanıcının Ayarlar'daki tercihi; sunucu ile tarayıcının ortak kapalı sözlüğü.
 *
 * Ayrıntı SUNUM ve ANALİZ GENİŞLİĞİ sözleşmesidir; yetkiyi ya da doğrulamayı değiştirmez. Yalnızca önerme sayısı
 * değildir (Dengeli ile Ayrıntılı'nın aynı görünmesinin kök nedeni buydu):
 *   - `extraFocus`: analitik özete sunucunun eklediği bütünleyici yön sayısı (Ayrıntılı daha çok doğrulanmış okuma yapar);
 *   - `maxPropositions`: sayfadaki önerme sınırı (Ayrıntılı türetilmiş dağılım/uç/ortalama önermelerini de taşır);
 *   - `minNarrated`/`maxNarrated`: bölüm başına anlatılacak önerme (mevcut önerme sayısıyla sınırlı);
 *   - `paragraphs`: önerilen paragraf yapısı (yönergeye gider; dolgu için sözcük sayısı değildir);
 *   - `visuals`: sunucunun kendiliğinden ekleyebileceği grafik sayısı; `maxOutputTokens`: anlatım turunun çıktı sınırı.
 */
export const ANSWER_DETAILS = Object.freeze(['short', 'balanced', 'detailed']);
export const DEFAULT_ANSWER_DETAIL = 'balanced';

export const ANSWER_DETAIL_LABELS = Object.freeze({
  short: Object.freeze({ label: 'Kısa', description: 'Doğrudan sonuç: bir paragraf; gerekirse tek tablo ya da grafik.' }),
  balanced: Object.freeze({ label: 'Dengeli', description: 'Önce sonuç, ardından en önemli bulguları birbirine bağlayan iki-üç paragraf; uygun tablo ya da grafik.' }),
  detailed: Object.freeze({ label: 'Ayrıntılı', description: 'Daha geniş okuma: sürükleyici etkenler, dağılım ve karşılaştırmalar, zaman görünümü, emin olunamayan noktalar; tablo ve grafiklerle.' })
});

export const ANSWER_DETAIL_CONTRACT = Object.freeze({
  short: Object.freeze({ minNarrated: 1, maxNarrated: 2, maxNotes: 1, paragraphs: Object.freeze([1, 1]), extraFocus: 0, maxPropositions: 12, visuals: 1, maxOutputTokens: 800 }),
  balanced: Object.freeze({ minNarrated: 3, maxNarrated: 6, maxNotes: 2, paragraphs: Object.freeze([2, 3]), extraFocus: 0, maxPropositions: 16, visuals: 1, maxOutputTokens: 1800 }),
  detailed: Object.freeze({ minNarrated: 6, maxNarrated: 14, maxNotes: 2, paragraphs: Object.freeze([3, 5]), extraFocus: 1, maxPropositions: 24, visuals: 2, maxOutputTokens: 3000 })
});

export function isAnswerDetail(value) {
  return ANSWER_DETAILS.includes(value);
}

export function normalizeAnswerDetail(value) {
  return isAnswerDetail(value) ? value : DEFAULT_ANSWER_DETAIL;
}

/** "Biraz daha açar mısın?" takibi: bu turun sunumu bir düzey ayrıntılıdır (kullanıcının ayarı değişmez). */
export function expandedAnswerDetail(value) {
  const current = normalizeAnswerDetail(value);
  return current === 'short' ? 'balanced' : 'detailed';
}
