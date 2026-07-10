// Effective app zoom (driven by the font-size control via body { zoom }).
// Tooltip / popover positioning divides cursor + rect coords by this so
// fixed-position overlays stay glued to the cursor when text is enlarged.
export function appZoom() {
  if (typeof document === 'undefined') return 1;
  return parseFloat(document.body.style.zoom) || 1;
}
