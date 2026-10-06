/**
 * Rota AI ölçülerinin kullanıcıya gösterilen, sunucuya ait tanımları.
 *
 * Araç sonucu bu metinleri ölçüyle birlikte taşır ve doğrulanmış yanıt bunları
 * olgu olarak gösterebilir. Metinler şema anahtarı içermez.
 */
export const METRIC_DEFINITIONS = Object.freeze({
  taskTotals: Object.freeze({
    overdue: 'Tamamlanmamış ve termini bugünden önce olan görev.',
    dueNext7Days: 'Tamamlanmamış ve termini bugün dahil yedi takvim günü içinde olan görev.',
    completionRatePercent: 'Tamamlanan görevlerin bütün görevlere oranı.'
  }),
  assigneeGrouping: 'Yalnızca kimliği görünür sorumlular gruplanır; birden çok görünür sorumlusu olan görev her sorumluda ayrı sayılır. Sorumlu bilgisi açıklanamayan görevler, atama olsun ya da olmasın, tek bir grupta sayılır.',
  completeTaskView: 'Tam görev görünümü yoksa projede yalnızca yetkili olduğunuz görevler sayılmıştır.',
  baseline: Object.freeze({
    varianceDays: 'Güncel planlanan bitiş ile baz plandaki planlanan bitiş arasındaki takvim günü farkı; pozitif değer kaymadır.',
    removedSinceBaseline: 'Baz planda kaydı olup artık projede bulunmayan (silinmiş ya da taşınmış) görev.',
    addedSinceBaseline: 'Baz plan alındıktan sonra projeye eklenen görev.',
    comparisonBasis: 'Termin baz planda tutulmaz; karşılaştırma planlanan tarihler üzerindedir.'
  })
});
