export const TWEAK_DEFAULTS = {
  accent: '#3b82f6',
  density: 'balanced',
  theme: 'dark',
  fontScale: 1,
  landingView: 'ozet',
  showArchivedProjects: false,
  appMode: 'advanced',
  calLarge: false,
  reduceMotion: true,
  showEmblem: true,
  // Tarih gösterimi kurumsal alışkanlığa göre seçilir; varsayılan gg/aa/yyyy.
  dateFormat: 'dd/mm/yyyy',
  // Yüksek karşıtlık: sınırlar ve ikincil metin koyulaştırılır. Açık temada
  // ve parlak ortamlarda okunabilirliği belirgin biçimde artırır.
  highContrast: false,
};

export function mergeTweakPreferences(defaults, overrides) {
  const values = { ...defaults };
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return values;
  for (const key of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const value = overrides[key];
    if (typeof value !== typeof defaults[key]) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    values[key] = value;
  }
  return values;
}
