/**
 * Sütun sayı süzgeci eşleşmesi.
 *
 * `dateMatchesFilter` ile aynı gerekçeyle AYRI bir modüldedir: işlev saftır ve
 * JSX içermez, ama JSX taşıyan `ui-extras.jsx` içinde durduğu sürece düz Node
 * ile içe aktarılamıyor ve yalnızca kaynak metni üzerinden sınanabiliyordu.
 */
export function numericMatchesFilter(val, spec) {
  if (!spec) return true;
  const value = (val == null || val === '') ? null : Number(val);
  if (value == null || Number.isNaN(value)) return false;
  if (spec.mode === 'between') {
    if (spec.from != null && value < spec.from) return false;
    if (spec.to != null && value > spec.to) return false;
    return true;
  }
  if (spec.mode === 'before') return spec.to == null || value < spec.to;
  if (spec.mode === 'after') return spec.from == null || value > spec.from;
  if (spec.mode === 'equals') return value === spec.eq;
  return true;
}
