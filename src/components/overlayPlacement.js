/**
 * Görünüm alanına hapsedilmiş üst katman (popover / süzgeç kutusu) yerleşimi.
 *
 * Sütun süzgeci kutuları, ipuçları ve açılır paneller `position: fixed` ile
 * gövdeye taşınır. Daha önce her biri kendi yerleşimini hesaplıyor, çoğu
 * yalnızca yatay taşmayı kırpıyordu; sayfanın altına yakın açılan bir kutunun
 * alt kısmı ekranın dışında kalıyor ve düğmelerine erişilemiyordu.
 *
 * Modül saftır: bir çapa dikdörtgeni, kutunun ölçüsü ve görünüm alanı verilir,
 * kutunun sığdığı konum döner. Tek başına sınanabilir.
 */

export const OVERLAY_MARGIN = 8;
export const OVERLAY_GAP = 4;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * @param {{left:number, top:number, bottom:number, width:number}} anchorRect
 *   Çapa öğesinin görünüm alanına göre (ölçekten arındırılmış) dikdörtgeni.
 * @param {{width:number, height:number}} size Kutunun ölçüsü.
 * @param {{width:number, height:number}} viewport Görünüm alanı ölçüsü.
 * @param {{margin?:number, gap?:number}} [options]
 * @returns {{left:number, top:number, maxWidth:number, maxHeight:number, flipped:boolean}}
 *   `maxHeight` kutunun kaplayabileceği en fazla yükseklik; kutu bu değerden
 *   uzunsa kendi içinde kaymalıdır. `maxWidth` aynı kuralın yatay karşılığıdır:
 *   görünüm alanı kutudan darsa kutu DARALTILIR. Yalnızca `left` kırpılsaydı
 *   kutunun sağ kenarı ekran dışında kalır ve denetimleri erişilemez olurdu.
 */
export function clampOverlayToViewport(anchorRect, size, viewport, options = {}) {
  const margin = options.margin ?? OVERLAY_MARGIN;
  const gap = options.gap ?? OVERLAY_GAP;
  const viewportWidth = viewport?.width || 0;
  const viewportHeight = viewport?.height || 0;
  const height = size?.height || 0;

  const availableWidth = Math.max(0, viewportWidth - margin * 2);
  const maxWidth = Math.min(size?.width || 0, availableWidth);
  const maxLeft = Math.max(margin, viewportWidth - maxWidth - margin);
  const left = clamp(anchorRect?.left ?? 0, margin, maxLeft);

  const spaceBelow = Math.max(0, viewportHeight - (anchorRect?.bottom ?? 0) - gap - margin);
  const spaceAbove = Math.max(0, (anchorRect?.top ?? 0) - gap - margin);
  // Aşağı açmak varsayılandır; yalnızca kutu aşağı sığmıyorken ve yukarısı
  // daha genişken yukarı çevrilir.
  const flipped = height > spaceBelow && spaceAbove > spaceBelow;
  const available = Math.max(0, flipped ? spaceAbove : spaceBelow);
  const maxHeight = Math.max(0, Math.min(height || available, available));

  // Dikey konum İKİ YANDAN da sınırlanır. Çapa görünüm alanının üstüne
  // kaydırılmışsa `bottom + gap` negatif olabilir ve kutu ekranın üstünde
  // kaybolurdu; altına kaydırılmışsa çevrilen dal aynı biçimde taşardı.
  const minTop = margin;
  const maxTop = Math.max(margin, viewportHeight - maxHeight - margin);
  const preferredTop = flipped
    ? (anchorRect?.top ?? 0) - gap - maxHeight
    : (anchorRect?.bottom ?? 0) + gap;

  return {
    left: Math.round(left),
    top: Math.round(clamp(preferredTop, minTop, maxTop)),
    maxWidth: Math.round(maxWidth),
    maxHeight: Math.round(maxHeight),
    flipped
  };
}
