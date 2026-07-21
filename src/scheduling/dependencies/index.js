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

export function depId(dependency) {
  if (typeof dependency === 'string') return dependency;
  return dependency?.predecessorId || dependency?.id || null;
}

export function relTypeOf(dependency) {
  if (typeof dependency === 'string') return 'FS';
  const type = dependency?.type || 'FS';
  return REL_TYPES[type] ? type : 'FS';
}

export function normalizeDependency(dependency) {
  const predecessorId = depId(dependency);
  const type = relTypeOf(dependency);
  const lagDays = typeof dependency === 'object' && Number.isFinite(dependency?.lagDays) ? dependency.lagDays : 0;
  return { id: predecessorId, predecessorId, type, lagDays };
}

export function applyDependencyLag(value, dependency, calendar = DEFAULT_CALENDAR) {
  return addWorkingDays(value, normalizeDependency(dependency).lagDays, calendar);
}
