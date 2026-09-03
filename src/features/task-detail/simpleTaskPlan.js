/**
 * Basit Modun görev planı üzerindeki sahipliği.
 *
 * Modül SAFTIR: React ve durum bağımlılığı yoktur, bu yüzden kural tek başına
 * sınanabilir ve hem panelde hem de ileride başka bir Basit Mod ekranında aynı
 * biçimde uygulanabilir.
 */

/**
 * Basit Modun sahibi olduğu bir plan mı?
 *
 * Basit Mod plan başlangıcını, bitişini ve termini AYNI güne yazar. Üç tarih
 * hâlâ eşitse plan bu ekranda kurulmuş demektir ve termin değişikliği üçünü
 * birlikte taşıyabilir. Ayrıştılarsa plan GELİŞMİŞ Modda kurulmuştur; Basit
 * Moddaki bir düzenleme onu sessizce ezmemelidir — yalnızca "Termin tarihi"ni
 * değiştirmek görevin Gantt/CPM sonuçlarını belirleyen gizli planını yok
 * ediyordu.
 *
 * Kural bir SEZGİDİR ve sınırı bilinçlidir: Gelişmiş Modda kurulmuş TEK GÜNLÜK
 * geçerli bir görevin de üç tarihi eşittir, dolayısıyla Basit Mod onu kendi
 * planı sayar ve termin değiştiğinde üçünü birlikte taşır. Tek günlük bir
 * görevde başlangıç/bitiş/terminin birlikte kalması tutarlı sonuçtur; asıl
 * kaçınılan hata — çok günlük bir planın sessizce tek güne çökmesi —
 * gerçekleşemez. Sezgiyi kaldırmak planın KAYNAĞINI kalıcı bir alanda tutmayı
 * gerektirir (şema + ürün kararı); bu yapılana kadar burada yanlış yön, veri
 * kaybettirmeyen yöndür.
 */
export function ownsSimpleModePlan(task) {
  if (!task?.plannedStart && !task?.plannedFinish) return true;
  return task.plannedStart === task.plannedFinish && task.plannedFinish === task.targetFinish;
}
