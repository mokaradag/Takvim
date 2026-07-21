export const COLOR_MAP = Object.freeze({
  blue: 'var(--c-blue)',
  emerald: 'var(--c-emerald)',
  purple: 'var(--c-purple)',
  amber: 'var(--c-amber)',
  rose: 'var(--c-rose)',
  cyan: 'var(--c-cyan)'
});

const PROJECT_COLOR_KEYS = Object.freeze({
  'Web Sitesi Yenileme': 'blue',
  'Mobil Uygulama': 'purple',
  'Sosyal Medya': 'rose',
  'Veritabanı Göçü': 'amber',
  'Altyapı': 'cyan',
  'Marka Kimliği': 'emerald'
});

const PERSON_COLOR_KEYS = Object.freeze({
  'Ahmet Yılmaz': 'blue',
  'Mehmet Demir': 'purple',
  'Ayşe Kaya': 'emerald',
  'Elif Yıldız': 'rose',
  'Can Özkan': 'amber',
  'Zeynep Aydın': 'cyan',
  'Burak Şahin': 'purple'
});

const FALLBACK_KEYS = Object.keys(COLOR_MAP);
function deterministicColorKey(value) {
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return FALLBACK_KEYS[Math.abs(hash) % FALLBACK_KEYS.length] || 'blue';
}

export function projectColorKey(name) {
  return PROJECT_COLOR_KEYS[name] || deterministicColorKey(name);
}

export function projectColorVar(name) {
  return COLOR_MAP[projectColorKey(name)] || COLOR_MAP.blue;
}

export function personColorVar(name) {
  return COLOR_MAP[PERSON_COLOR_KEYS[name] || deterministicColorKey(name)] || COLOR_MAP.blue;
}

export function personInitials(name) {
  return String(name || '').split(' ').filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}
