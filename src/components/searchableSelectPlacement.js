export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 620;
export const PANEL_GAP = 6;
export const VIEWPORT_MARGIN = 12;
/** Listenin görünüm alanı elverdiğinde hedeflediği yükseklik. */
export const PREFERRED_LIST_HEIGHT = 320;
export const MAX_LIST_HEIGHT = 360;
/**
 * Liste bu değerin altına inemez; daha küçüğü listeyi kullanılamaz kılar.
 * Yer bu kadar bile değilse panel görünüm alanına sıkıştırılır (bkz.
 * `panelMaxHeight`) ve içerik panelin içinde kayar.
 */
export const MIN_LIST_HEIGHT = 96;
/**
 * Listenin ÜSTÜNDEKİ ve altındaki sabit panel parçaları: arama satırı, isteğe
 * bağlı "seçimi temizle" düğmesi, sonuç sayısı dipnotu ve panel dolgusu.
 * Yerleşim hesabı bu payı düşmezse panel, listeye ayrılan yerin dışına taşar.
 */
export const PANEL_CHROME_HEIGHT = 104;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Tetikleyici düğmenin ekran konumundan açılır panelin sabit (fixed) yerleşimini
 * hesaplar. Panel gövdeye taşındığı için kenar çubuğunun `overflow: hidden`
 * kırpması ve yığın bağlamı (stacking context) sınırlamaları listeyi etkilemez;
 * yerleşimin görünüm alanı içinde kalmasını bu saf işlev güvence altına alır.
 *
 * Yerleşim iki değer üretir:
 *  - `panelMaxHeight`: PANELİN tamamının kaplayabileceği en fazla yükseklik.
 *    Seçilen yönde gerçekte var olan boşluktan asla büyük olmaz.
 *  - `listMaxHeight`: liste alanının yüksekliği; panel çerçevesi (arama satırı,
 *    dipnot) düşüldükten sonra kalan yer.
 *
 * Daha önce boş yer az olduğunda bile listeye taban bir yükseklik veriliyor,
 * panel çerçevesi ise hiç hesaba katılmıyordu; ekranın altına yakın açılan
 * listelerin bir bölümü görünüm alanının dışında kalıyordu.
 *
 * @param {DOMRect|{top:number,bottom:number,left:number,width:number}} triggerRect
 * @param {{width:number, height:number}} viewport
 */
export function computePopoverPlacement(triggerRect, viewport = {}) {
  if (!triggerRect) return null;
  const viewportWidth = viewport.width || 0;
  const viewportHeight = viewport.height || 0;

  // Genişlik ALT SINIRI da görünüm alanına uyar. Her iki uç `MIN_PANEL_WIDTH`
  // ile zorlandığında 304 pikselden dar bir görünüm alanında (dar mobil ekran
  // ya da yazı ölçeği normalizasyonu sonrası) panel 280 pikselde kalıyor,
  // `left` ise kenar boşluğuna yapışıyordu: sağ kenar hâlâ ekranın dışındaydı.
  const availableWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);
  const upperBound = availableWidth > 0 ? Math.min(MAX_PANEL_WIDTH, availableWidth) : MIN_PANEL_WIDTH;
  const lowerBound = Math.min(MIN_PANEL_WIDTH, upperBound);
  const width = clamp(triggerRect.width, lowerBound, upperBound);
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
  const left = clamp(triggerRect.left, VIEWPORT_MARGIN, maxLeft);

  // Gerçekte var olan boşluklar. Tetikleyici görünüm alanının dışına kaymışsa
  // negatif çıkabilir; sıfıra çekilir.
  const spaceBelow = Math.max(0, viewportHeight - triggerRect.bottom - PANEL_GAP - VIEWPORT_MARGIN);
  const spaceAbove = Math.max(0, triggerRect.top - PANEL_GAP - VIEWPORT_MARGIN);

  // Aşağısı tercih edilir; yalnızca panel oraya sığmıyorken ve yukarısı DAHA
  // GENİŞKEN yukarı açılır.
  const preferredPanelHeight = PREFERRED_LIST_HEIGHT + PANEL_CHROME_HEIGHT;
  const openUp = spaceBelow < preferredPanelHeight && spaceAbove > spaceBelow;
  const available = openUp ? spaceAbove : spaceBelow;

  // Panel hiçbir koşulda seçilen yöndeki boşluğu aşamaz.
  const panelMaxHeight = Math.max(0, Math.min(available, MAX_LIST_HEIGHT + PANEL_CHROME_HEIGHT));
  // Taban liste yüksekliği yalnızca panel ÇERÇEVESİ sığdığında söz verilir.
  // Aksi hâlde 60 piksellik bir panelde listeye 96 piksel ayrılır, sabit arama
  // ve dipnot satırları bu payı tüketir ve seçenekler `overflow: hidden` altında
  // erişilemez kalırdı. O durumda panelin TAMAMI kaydırılır.
  const fitsChrome = panelMaxHeight >= PANEL_CHROME_HEIGHT + MIN_LIST_HEIGHT;
  const listMaxHeight = fitsChrome
    ? clamp(panelMaxHeight - PANEL_CHROME_HEIGHT, MIN_LIST_HEIGHT, MAX_LIST_HEIGHT)
    : Math.max(0, panelMaxHeight - PANEL_CHROME_HEIGHT);

  // Dikey konum görünüm alanına hapsedilir: tetikleyici yukarı kaydığında
  // `bottom + gap` negatif olur ve panel ekranın üstünde kaybolurdu.
  const verticalLimit = Math.max(VIEWPORT_MARGIN, viewportHeight - panelMaxHeight - VIEWPORT_MARGIN);
  const top = clamp(triggerRect.bottom + PANEL_GAP, VIEWPORT_MARGIN, verticalLimit);
  const bottom = clamp(viewportHeight - triggerRect.top + PANEL_GAP, VIEWPORT_MARGIN, verticalLimit);

  return {
    left: Math.round(left),
    width: Math.round(width),
    openUp,
    top: openUp ? null : Math.round(top),
    bottom: openUp ? Math.round(bottom) : null,
    panelMaxHeight: Math.round(panelMaxHeight),
    listMaxHeight: Math.round(listMaxHeight),
    // Panel çerçevesi bile sığmıyorsa panelin kendisi kaydırılmalıdır.
    scrollPanel: !fitsChrome
  };
}
