export const TASK_STATUSES = Object.freeze({
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  DONE: 'done'
});

export const PRIORITIES = Object.freeze({
  critical: { id: 'critical', label: 'Kritik', color: 'var(--status-overdue)', order: 0 },
  high: { id: 'high', label: 'Yüksek', color: 'oklch(70% 0.16 50)', order: 1 },
  medium: { id: 'medium', label: 'Orta', color: 'oklch(70% 0.13 200)', order: 2 },
  low: { id: 'low', label: 'Düşük', color: 'var(--text-dim)', order: 3 }
});

/** Öncelik belirtilmediğinde kullanılan kanonik değer. */
export const DEFAULT_PRIORITY_ID = 'medium';

/**
 * Gerçek Sistem şeması `normal` önceliğini de kabul eder; arayüz kataloğunda ise
 * böyle bir giriş yoktur. Eşleme olmadan `PRIORITIES['normal']` `undefined`
 * döndüğü için Görevler/Kanban/Raporlar sayfaları ilk görev eklendiğinde
 * çöküyordu. Eski (ve bilinmeyen) değerler bu tablo üzerinden kanonikleştirilir.
 */
export const LEGACY_PRIORITY_ALIASES = Object.freeze({
  normal: DEFAULT_PRIORITY_ID,
  orta: DEFAULT_PRIORITY_ID,
  none: DEFAULT_PRIORITY_ID,
  '': DEFAULT_PRIORITY_ID
});

/** Herhangi bir kaynaktan gelen öncelik değerini katalogdaki kimliğe indirger. */
export function normalizePriorityId(value) {
  const text = String(value ?? '').trim().toLocaleLowerCase('en-US');
  if (PRIORITIES[text]) return text;
  return LEGACY_PRIORITY_ALIASES[text] || DEFAULT_PRIORITY_ID;
}

/**
 * Öncelik tanımını (etiket + renk) her zaman döndürür; bilinmeyen değerlerde de
 * `undefined` dönmez, böylece `prio.color` okuması hiçbir görev için çökemez.
 */
export function resolvePriority(value) {
  return PRIORITIES[normalizePriorityId(value)];
}

/**
 * Tek bir "Tekrarları oluştur" işleminde en fazla kaç yineleme kalıcılaştırılır.
 *
 * Kullanıcıya kaç görevin GERÇEKTEN oluşacağını söyleyebilmek için arayüz ve
 * üretim aynı sabiti okur; sayı iki yerde yazıldığında panel "12 yeni görev
 * oluşturulur" derken işlem 60'ta duruyordu.
 */
export const TASK_SERIES_BATCH_LIMIT = 60;
