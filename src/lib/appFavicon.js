/**
 * MERGEN Rota sekme simgesi — pusula.
 *
 * Simge ana pusula logosunun (bkz. components/shell/AppLogo.jsx) sadeleşmiş
 * hâlidir: aynı gövde çemberi, aynı ibre açısı ve aynı merkez noktası. 16 ve 32
 * piksel boyutlarında okunaklı kalması için ayrıntı bilinçli olarak azdır:
 * derece çizgisi, gölge ve eğim yoktur.
 *
 * Kendi zemini olduğu için açık ve koyu sekme çubuğunda da aynı karşıtlıkla
 * görünür. Veri URI'si olarak gömülür: ek ağ isteği, ayrı dosya ve derleme
 * adımı gerekmez.
 */
const COMPASS_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>`
  + `<defs><linearGradient id='rotaMark' x1='0' y1='0' x2='1' y2='1'>`
  + `<stop offset='0' stop-color='%234f8bf9'/><stop offset='1' stop-color='%232c5fd9'/>`
  + `</linearGradient></defs>`
  + `<rect width='32' height='32' rx='8' fill='url(%23rotaMark)'/>`
  + `<circle cx='16' cy='16' r='9' fill='none' stroke='white' stroke-width='2'/>`
  + `<path d='M21.6 10.4 17.7 18.3 9.8 21.2 13.7 13.3Z' fill='white'/>`
  + `<circle cx='16' cy='16' r='1.7' fill='%232c5fd9'/>`
  + `</svg>`;

export const APP_FAVICON_DATA_URI = `data:image/svg+xml;utf8,${COMPASS_SVG}`;
