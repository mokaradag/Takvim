/**
 * Bilgin yanıt ayrıntısı (Aşama 4E) — kullanıcının Ayarlar'daki tercihi; sunucu ile tarayıcının ortak kapalı sözlüğü.
 *
 * Ayrıntı yalnızca SUNUM sözleşmesini değiştirir (kaç doğrulanmış önermenin anlatılacağı, paragraf ve not sayısı,
 * gösterge/grafik tercihi); veri kapsamını, yetkiyi ya da doğrulamayı değiştirmez ve çıktı belirteci sınırı değildir.
 */
export const ANSWER_DETAILS = Object.freeze(['short', 'balanced', 'detailed']);
export const DEFAULT_ANSWER_DETAIL = 'balanced';

export const ANSWER_DETAIL_LABELS = Object.freeze({
  short: Object.freeze({ label: 'Kısa', description: 'Doğrudan yanıt; gerekirse tek tablo ya da grafik.' }),
  balanced: Object.freeze({ label: 'Dengeli', description: 'Önce sonuç, ardından bir-iki paragrafta destekleyici bulgular; uygunsa tablo, grafik ve göstergeler.' }),
  detailed: Object.freeze({ label: 'Ayrıntılı', description: 'Analitik sorularda daha fazla doğrulanmış gözlem, karşılaştırma ve dikkat noktası.' })
});

/** Ayrıntının anlatım sözleşmesi: paragrafta en az söylenecek önerme (mevcut önerme sayısıyla sınırlı) ve not kutusu sınırı. */
export const ANSWER_DETAIL_CONTRACT = Object.freeze({
  short: Object.freeze({ minNarrated: 1, maxNarrated: 3, maxNotes: 1 }),
  balanced: Object.freeze({ minNarrated: 3, maxNarrated: 6, maxNotes: 2 }),
  detailed: Object.freeze({ minNarrated: 5, maxNarrated: 8, maxNotes: 2 })
});

export function isAnswerDetail(value) {
  return ANSWER_DETAILS.includes(value);
}

export function normalizeAnswerDetail(value) {
  return isAnswerDetail(value) ? value : DEFAULT_ANSWER_DETAIL;
}
