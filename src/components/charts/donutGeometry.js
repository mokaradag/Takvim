/**
 * Halka grafiği dilim geometrisi.
 *
 * Görünümden ayrı tutulur: bir dilimin nereden nereye çizileceği saf bir
 * dönüşümdür ve tek başına sınanabilir.
 *
 * Dilimler daha önce `stroke-dasharray` + `stroke-dashoffset` ile çiziliyordu.
 * O yaklaşımda kesik deseni halkanın çevresi boyunca TEKRARLANIR: ondalık
 * yuvarlama toplamı çevrenin bir kıl payı üstüne çıkardığında desen başa
 * sarıyor ve aynı dilim halkanın iki ayrı yerinde parça parça görünüyordu.
 * Seçili dilimin dışarı ötelenmesi (patlatma) de dilimi halkadan kopararak
 * aynı "bölünmüş" izlenimini veriyordu.
 *
 * Burada her dilim KENDİ yay yolu olarak üretilir: dilimler birbirinden
 * bağımsızdır, hiçbiri halkayı aşamaz ve aradaki boşluk bilinçli, eşit ve
 * ölçülebilir bir değerdir.
 */

/** Dilimler arasındaki bilinçli boşluk (derece). */
export const DONUT_SLICE_GAP_DEGREES = 1.6;
/** Vurgulanan dilimin kalınlık artışı (piksel). */
export const DONUT_EMPHASIS = 3;
/** Halka her zaman 12 yönünden başlar. */
const START_ANGLE = -90;

function polarPoint(cx, cy, radius, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Bir halka dilimini kapalı bir SVG yolu olarak üretir.
 *
 * Yol dış yay → iç yay şeklinde kapatılır; `stroke` yerine `fill` kullanıldığı
 * için kalınlık artışı dilimi asla halkanın dışına taşırmaz.
 */
export function donutSlicePath(cx, cy, outerRadius, innerRadius, startDegrees, endDegrees) {
  const sweep = endDegrees - startDegrees;
  if (!(sweep > 0) || !(outerRadius > innerRadius)) return '';

  // Tam tur bir yayla ifade edilemez (başlangıç ve bitiş noktası çakışır);
  // halka iki yarım turla kapatılır.
  if (sweep >= 359.999) {
    const [ox1, oy1] = polarPoint(cx, cy, outerRadius, startDegrees);
    const [ox2, oy2] = polarPoint(cx, cy, outerRadius, startDegrees + 180);
    const [ix1, iy1] = polarPoint(cx, cy, innerRadius, startDegrees);
    const [ix2, iy2] = polarPoint(cx, cy, innerRadius, startDegrees + 180);
    return [
      `M ${round(ox1)} ${round(oy1)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(ox2)} ${round(oy2)}`,
      `A ${round(outerRadius)} ${round(outerRadius)} 0 1 1 ${round(ox1)} ${round(oy1)}`,
      `M ${round(ix1)} ${round(iy1)}`,
      `A ${round(innerRadius)} ${round(innerRadius)} 0 1 0 ${round(ix2)} ${round(iy2)}`,
      `A ${round(innerRadius)} ${round(innerRadius)} 0 1 0 ${round(ix1)} ${round(iy1)}`,
      'Z'
    ].join(' ');
  }

  const largeArc = sweep > 180 ? 1 : 0;
  const [outerStartX, outerStartY] = polarPoint(cx, cy, outerRadius, startDegrees);
  const [outerEndX, outerEndY] = polarPoint(cx, cy, outerRadius, endDegrees);
  const [innerEndX, innerEndY] = polarPoint(cx, cy, innerRadius, endDegrees);
  const [innerStartX, innerStartY] = polarPoint(cx, cy, innerRadius, startDegrees);

  return [
    `M ${round(outerStartX)} ${round(outerStartY)}`,
    `A ${round(outerRadius)} ${round(outerRadius)} 0 ${largeArc} 1 ${round(outerEndX)} ${round(outerEndY)}`,
    `L ${round(innerEndX)} ${round(innerEndY)}`,
    `A ${round(innerRadius)} ${round(innerRadius)} 0 ${largeArc} 0 ${round(innerStartX)} ${round(innerStartY)}`,
    'Z'
  ].join(' ');
}

/**
 * Değer listesini halka dilimlerine böler.
 *
 * Güvenceler:
 *  - Sayı olmayan ve negatif değerler sıfıra çekilir; bir dilim halkadan
 *    "çalamaz".
 *  - Açıların toplamı her zaman tam 360 derecedir: son dilim kalan açıyı alır,
 *    böylece ondalık yuvarlama halkada boşluk ya da bindirme bırakmaz.
 *  - Boşluk yalnızca BİRDEN ÇOK dilim varken uygulanır ve dilimin kendi
 *    açısından büyük olamaz; küçük dilimler boşluk yüzünden kaybolmaz.
 *
 * @param {Array<{value: number}>} data
 * @param {{gapDegrees?: number}} [options]
 * @returns {Array<{index: number, value: number, share: number,
 *   startAngle: number, endAngle: number, midAngle: number}>}
 *   Yalnızca değeri sıfırdan büyük dilimler döner.
 */
export function donutSegments(data, { gapDegrees = DONUT_SLICE_GAP_DEGREES } = {}) {
  const values = (Array.isArray(data) ? data : [])
    .map((item) => (Number.isFinite(item?.value) && item.value > 0 ? item.value : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];

  const positive = values.filter((value) => value > 0).length;
  const gap = positive > 1 ? Math.max(0, gapDegrees) : 0;

  const segments = [];
  let consumed = 0;
  let remaining = positive;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value <= 0) continue;
    remaining -= 1;
    // Son dilim kalan açının tamamını alır: yuvarlama artığı halkada iz bırakmaz.
    const sweep = remaining === 0 ? 360 - consumed : (value / total) * 360;
    const start = START_ANGLE + consumed;
    consumed += sweep;
    // Boşluk dilimin kendisini yutamaz; en fazla açının yarısı kadar kırpılır.
    const inset = Math.min(gap, sweep / 2) / 2;
    segments.push({
      index,
      value,
      share: value / total,
      startAngle: start + inset,
      endAngle: start + sweep - inset,
      midAngle: start + sweep / 2
    });
  }
  return segments;
}
