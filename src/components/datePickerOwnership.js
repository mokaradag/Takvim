/** Yalnızca bu kabın içindeki tarih girdisinin açık takvimini sahiplenir. */
export function isOwnedDatePickerEvent(container, target) {
  const panel = target?.closest?.('[data-date-input-owner]');
  if (panel) {
    const owner = panel.ownerDocument.getElementById(panel.getAttribute('data-date-input-owner'));
    return Boolean(owner && container?.contains(owner));
  }
  const input = target?.closest?.('[data-date-picker-open]');
  return Boolean(input && container?.contains(input));
}
