// Effective app zoom (driven by the font-size control via body { zoom }).
// Tooltip / popover positioning divides cursor + rect coords by this so
// fixed-position overlays stay glued to the cursor when text is enlarged.
export function appZoom() {
  if (typeof document === 'undefined') return 1;
  const rawZoom = document.body?.style?.zoom;
  const parsedZoom = parseFloat(rawZoom);
  if (!Number.isFinite(parsedZoom) || parsedZoom <= 0) return 1;
  return typeof rawZoom === 'string' && rawZoom.trim().endsWith('%')
    ? parsedZoom / 100
    : parsedZoom;
}
