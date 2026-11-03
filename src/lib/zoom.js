// Yazı boyutu denetiminin body zoom ile belirlediği etkin uygulama yakınlaştırması.
// İpucu ve açılır konumu imleç ve dikdörtgen koordinatını bu değere böler;
// böylece metin büyürken sabit katman imlecin yanında kalır.
export function appZoom() {
  if (typeof document === 'undefined') return 1;
  const rawZoom = document.body?.style?.zoom;
  const parsedZoom = parseFloat(rawZoom);
  if (!Number.isFinite(parsedZoom) || parsedZoom <= 0) return 1;
  return typeof rawZoom === 'string' && rawZoom.trim().endsWith('%')
    ? parsedZoom / 100
    : parsedZoom;
}
