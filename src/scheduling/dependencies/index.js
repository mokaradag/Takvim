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

export function dependencyLagDays(dependency, calendar = DEFAULT_CALENDAR) {
  const value = lagValueOf(dependency);
  const unit = lagUnitOf(dependency);
  const workdaysPerWeek = Math.max(1, calendar?.workingDays?.length || 5);
  if (unit === 'week') return Math.trunc(value * workdaysPerWeek);
  if (unit === 'month') return Math.trunc(value * workdaysPerWeek * 4);
  return Math.trunc(value);
}

export function normalizeDependency(dependency) {
  const predecessorId = depId(dependency);
  const type = relTypeOf(dependency);
  const lagUnit = lagUnitOf(dependency);
  const lagValue = lagValueOf(dependency);
  const lagDays = dependencyLagDays({ lagValue, lagUnit });
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
