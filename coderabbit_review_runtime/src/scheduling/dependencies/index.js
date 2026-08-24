import { addWorkingDays, DEFAULT_CALENDAR } from '../calendars/index.js';

export const REL_TYPES = Object.freeze({
  FS: {
    code: 'FS', name: 'Bitiş → Başlangıç', short: 'Finish-to-Start',
    description: 'Önceki görev bitmeden bu görev başlayamaz. En sık kullanılan ilişki türüdür.',
    example: 'Tasarım onaylanmadan kodlama başlatılamaz.'
  },
  SS: {
    code: 'SS', name: 'Başlangıç → Başlangıç', short: 'Start-to-Start',
    description: 'Önceki görev başlamadan bu görev de başlayamaz. Görevler birlikte başlar, paralel ilerler.',
    example: 'Belgeleme, geliştirme ile birlikte başlar.'
  },
  FF: {
    code: 'FF', name: 'Bitiş → Bitiş', short: 'Finish-to-Finish',
    description: 'Önceki görev bitmeden bu görev de bitemez. Görevler birlikte tamamlanır.',
    example: 'Test, geliştirme ile birlikte tamamlanır.'
  },
  SF: {
    code: 'SF', name: 'Başlangıç → Bitiş', short: 'Start-to-Finish',
    description: 'Önceki görev başlamadan bu görev bitemez. Nadiren kullanılır; vardiya/devir senaryolarında görülür.',
    example: 'Yeni sistem devreye girene kadar eski sistem kapatılamaz.'
  }
});

export const LAG_UNITS = Object.freeze({
  day: { id: 'day', label: 'Gün', short: 'gün' },
  week: { id: 'week', label: 'Hafta', short: 'hafta' },
  month: { id: 'month', label: 'Ay', short: 'ay' }
});

export function depId(dependency) {
  if (typeof dependency === 'string') return dependency;
  return dependency?.predecessorId || dependency?.id || null;
}

export function relTypeOf(dependency) {
  if (typeof dependency === 'string') return 'FS';
  const type = dependency?.type || 'FS';
  return REL_TYPES[type] ? type : 'FS';
}

export function lagUnitOf(dependency) {
  if (typeof dependency !== 'object') return 'day';
  const unit = dependency?.lagUnit || 'day';
  return LAG_UNITS[unit] ? unit : 'day';
}

export function lagValueOf(dependency) {
  if (typeof dependency !== 'object') return 0;
  if (Number.isFinite(dependency?.lagValue)) return dependency.lagValue;
  if (Number.isFinite(dependency?.lagDays)) return dependency.lagDays;
  return 0;
}

/**
 * Birimi yazılı ama DEĞERİ yazılmamış eski kaydı açık biçime taşır.
 *
 * KOPYA döner. Daha önce bu tamamlama `dependencyLagDays` içinde, yani bir OKUMA
 * yolunda yapılıyor ve girdinin kendisini değiştiriyordu: bağımlılık nesneleri
 * uygulama durumundaki görev kayıtlarından gelir, yerinde yazma indirgeyici
 * dışında durum değiştirir ve `task.deps` eşitlik denetimleri içerik değişmişken
 * "değişmedi" der. Tamamlama artık YALNIZCA düzenleyici yazma yolunda,
 * açıkça çağrılır.
 */
export function materializeDependencyLag(dependency) {
  if (typeof dependency !== 'object' || dependency === null) return dependency;
  if (dependency.lagValue != null || dependency.lagUnit == null || !Number.isFinite(dependency.lagDays)) {
    return dependency;
  }
  return { ...dependency, lagValue: dependency.lagDays, lagUnit: lagUnitOf(dependency) };
}

export function dependencyLagDays(dependency, calendar = DEFAULT_CALENDAR) {
  const value = lagValueOf(dependency);
  const unit = lagUnitOf(dependency);
  const workdaysPerWeek = Math.max(1, calendar?.workingDays?.length || 5);
  if (unit === 'week') return Math.trunc(value * workdaysPerWeek);
  if (unit === 'month') return Math.trunc(value * workdaysPerWeek * 4);
  return Math.trunc(value);
}

/**
 * @param {object|string} dependency
 * @param {object} [calendar] gecikmenin uygulanacağı takvim. Hafta ve ay
 *   birimleri iş gününe bu takvimle çevrilir; varsayılanla çevrilen `lagDays`,
 *   altı günlük bir takvimde zamanlamanın uyguladığı tarihle uyuşmuyordu ve
 *   `lagDays` alanını doğrudan okuyan tüketiciler (çapraz proje bağımlılık
 *   raporu gibi) plandan farklı bir gecikme bildiriyordu.
 */
export function normalizeDependency(dependency, calendar = DEFAULT_CALENDAR) {
  const predecessorId = depId(dependency);
  const type = relTypeOf(dependency);
  const hasExplicitUnit = typeof dependency === 'object' && (dependency?.lagValue != null || dependency?.lagUnit != null);
  if (!hasExplicitUnit) {
    const lagDays = typeof dependency === 'object' && Number.isFinite(dependency?.lagDays) ? dependency.lagDays : 0;
    return { id: predecessorId, predecessorId, type, lagDays };
  }
  const lagUnit = lagUnitOf(dependency);
  const lagValue = lagValueOf(dependency);
  const lagDays = dependencyLagDays({ lagValue, lagUnit }, calendar);
  return { id: predecessorId, predecessorId, type, lagValue, lagUnit, lagDays };
}

export function formatDependencyLag(dependency) {
  const value = lagValueOf(dependency);
  if (!value) return '';
  const unit = LAG_UNITS[lagUnitOf(dependency)]?.short || 'gün';
  return `${value > 0 ? '+' : ''}${value} ${unit}`;
}

export function applyDependencyLag(value, dependency, calendar = DEFAULT_CALENDAR) {
  return addWorkingDays(value, dependencyLagDays(dependency, calendar), calendar);
}
