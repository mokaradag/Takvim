export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 620;
export const PANEL_GAP = 6;
export const VIEWPORT_MARGIN = 12;
export const MIN_LIST_HEIGHT = 180;
export const MAX_LIST_HEIGHT = 360;

/**
 * Tetikleyici düğmenin ekran konumundan açılır panelin sabit (fixed) yerleşimini
 * hesaplar. Panel gövdeye taşındığı için kenar çubuğunun `overflow: hidden`
 * kırpması ve yığın bağlamı (stacking context) sınırlamaları listeyi etkilemez;
 * yerleşimin görünüm alanı içinde kalmasını bu saf işlev güvence altına alır.
 */
export function computePopoverPlacement(triggerRect, viewport = {}) {
  if (!triggerRect) return null;
  const viewportWidth = viewport.width || 0;
  const viewportHeight = viewport.height || 0;
  const width = Math.min(
    Math.max(triggerRect.width, MIN_PANEL_WIDTH),
    Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2))
  );
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(triggerRect.left, VIEWPORT_MARGIN), maxLeft);

  const spaceBelow = viewportHeight - triggerRect.bottom - PANEL_GAP - VIEWPORT_MARGIN;
  const spaceAbove = triggerRect.top - PANEL_GAP - VIEWPORT_MARGIN;
  const openUp = spaceBelow < MIN_LIST_HEIGHT && spaceAbove > spaceBelow;
  const available = Math.max(MIN_LIST_HEIGHT, openUp ? spaceAbove : spaceBelow);

  return {
    left: Math.round(left),
    width: Math.round(width),
    openUp,
    top: openUp ? null : Math.round(triggerRect.bottom + PANEL_GAP),
    bottom: openUp ? Math.round(viewportHeight - triggerRect.top + PANEL_GAP) : null,
    listMaxHeight: Math.round(Math.min(MAX_LIST_HEIGHT, available))
  };
}
