/**
 * Düz metnin güvenli HTML karşılığı.
 *
 * Modül SAFTIR: DOM ve React bağımlılığı yoktur; kaçış ile satır yapısı kuralı
 * tek başına sınanabilir.
 */

/**
 * Düz metni güvenli HTML'e çevirir.
 *
 * Metin ÖNCE kaçırılır (yapıştırılan `<script>` yalnızca metin üretir), sonra
 * satır sonları `<br />`, boş satırlar paragraf ayrımı olarak yazılır.
 *
 * Satır sonlarının açıkça yazılması gerekir: HTML yüzeyinde ham `\n`
 * daraltılabilir boşluktur ve çok satırlı bir şablon yapıştırıldığında paragraf
 * yapısı tek akışa çöküyor, aynı çökmüş metin postalanıyordu.
 */
export function plainTextToHtml(value) {
  const escaped = String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\r\n?/g, '\n');
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').join('<br />'))
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join('');
}
