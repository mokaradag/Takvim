/**
 * Üst katman ölçümü.
 *
 * Yerleşim hesabı kutunun DOĞAL ölçüsünü ister. Önceki yerleşim aynı öğeye
 * `max-height`/`max-width` uyguladığı için sonraki `getBoundingClientRect()`
 * çağrısı KIRPILMIŞ ölçüyü döndürür: kutu bir kez daraldıktan sonra yer açılsa
 * bile bir daha büyüyemez (kısa süzgeç kipinden uzun kipe geçildiğinde denetimler
 * kırpık kalırdı). Bu yüzden ölçüm sırasında sınırlar geçici olarak kaldırılır.
 *
 * @param {HTMLElement|null} element
 * @returns {{width:number, height:number}|null}
 */
export function measureNaturalRect(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return null;
  const style = element.style;
  const previousMaxHeight = style?.maxHeight ?? '';
  const previousMaxWidth = style?.maxWidth ?? '';
  if (style) {
    style.maxHeight = 'none';
    style.maxWidth = 'none';
  }
  const rect = element.getBoundingClientRect();
  if (style) {
    style.maxHeight = previousMaxHeight;
    style.maxWidth = previousMaxWidth;
  }
  return { width: rect.width, height: rect.height };
}
