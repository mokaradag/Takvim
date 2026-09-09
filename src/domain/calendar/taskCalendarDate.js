/**
 * Takvim görünümünün TEK tarih kuralı.
 *
 * Takvim bir termin görünümüdür: her görev tek güne düşer. Kural burada, saf ve
 * katmansız bir yardımcıda durur; Takvim ızgarası da Outlook takvim daveti de
 * aynı işlevi çağırır. İkinci bir kopya, birinde düzeltilen bir davranışın
 * ötekinde kalmasına yol açardı.
 *
 * Temel Kip ile Kapsamlı Kip arasında AYRIM YOKTUR: Temel Kip planı terminle
 * birlikte yazar (bkz. SimpleTaskDrawer), Kapsamlı Kip ayrı bir termin taşır ve
 * her ikisinde de görünen gün budur.
 */
export function taskCalendarDate(task = {}) {
  return task?.targetFinish || task?.plannedFinish || null;
}
