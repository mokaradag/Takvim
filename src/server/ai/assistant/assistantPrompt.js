import 'server-only';
import { ASSISTANT_CONTEXT_POLICY, selectAssistantContextHistory } from '../../../domain/ai/assistantContract.js';

export { ASSISTANT_CONTEXT_POLICY } from '../../../domain/ai/assistantContract.js';

/**
 * Rota AI'nin SUNUCUYA AİT sistem yönergesi ve modelin göreceği bağlamın
 * kurulması.
 *
 * Tarayıcı sistem yönergesi ya da geçmiş ileti göndermez; yalnızca yeni
 * iletiyi gönderir. Bağlam, güvenilir Sicil'e ait konuşmanın KAYITLI
 * iletilerinden sunucuda kurulur: değiştirilmiş bir tarayıcı yönergeyi
 * ezemez ya da asistana söylemediği bir şeyi söyletemez.
 *
 * Rota verisi (görev, proje, kişi, takvim) bu aşamada modele HİÇ verilmez;
 * yönerge de modelin bu veriye erişimi olmadığını açıkça söyler.
 *
 * Bağlam belirlenimci ve sınırlıdır. Belirteçleyici bilinmediği için belirteç
 * sayısı TAHMİN edilmez: sınırlar ileti sayısı ve karakterle ifade edilir.
 * Yanıtı olmayan (durdurulan, kesilen, başarısız) turlar bağlama girmez; bağlam
 * her zaman kullanıcı/asistan çiftleriyle ilerler.
 */

function todayText(now) {
  try {
    return new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'full' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Sunucuya ait sistem yönergesi. Kullanıcıya dönük metinlerde aşama numarası geçmez. */
export function assistantSystemPrompt(now = new Date()) {
  return [
    'Sen MERGEN Rota görev yönetimi uygulamasının yapay zekâ asistanı "Rota AI"sin.',
    'Kullanıcıya Türkçe yanıt ver; kullanıcı başka bir dilde yazarsa o dilde yanıt ver. Açık, doğru, profesyonel ve gereksiz uzatmadan yaz.',
    '',
    'ÖNEMLİ SINIR: Şu anda MERGEN Rota\'daki görevlere, projelere, kişilere, iş yüküne, takvime, raporlara ya da uygulamadaki başka herhangi bir veriye erişimin YOK. Bu verileri göremez, sorgulayamaz ve değiştiremezsin.',
    '- Kullanıcı Rota verisi hakkında soru sorarsa (ör. gecikmiş görevler, bir projenin durumu, en yoğun kişi, kendi görevleri) ASLA yanıt uydurma, örnek veri ya da tahmin üretme. Kısaca, Rota verisine dayalı analizin henüz etkin olmadığını söyle; kullanıcı ilgili bilgiyi sohbete yazarsa onun üzerinden yardımcı olabileceğini belirt.',
    '- Görev oluşturma, düzenleme, atama, durum ya da tarih değiştirme gibi işlemleri yapamazsın; bunları yapmış gibi davranma. İstenirse bu işlemlerin uygulamada genel olarak nasıl yapıldığını anlatabilirsin.',
    '- İnternete, e-postaya ya da başka bir sisteme erişimin yoktur.',
    '',
    'Genel sorularda yardımcı ol: planlama ve proje yönetimi yöntemleri, yazışma ve rapor taslakları, özetleme, açıklama, hesaplama ve benzeri konular.',
    'Emin olmadığın bilgiyi kesinmiş gibi sunma. Gerektiğinde Markdown kullan (başlık, liste, tablo, kod bloğu); HTML kullanma.',
    `Bugünün tarihi: ${todayText(now)} (Türkiye saati).`
  ].join('\n');
}

/**
 * Modele gidecek iletiler: sistem yönergesi + en yeni tamamlanmış çiftler
 * (bütçeye sığdığı kadar) + yeni kullanıcı iletisi.
 *
 * `history` tur ÖNCESİ kayıtlı iletilerdir (sıra numarasına göre artan).
 * `priorMessageCount` tur öncesindeki bütün iletilerin sayısıdır (okunan
 * pencerenin dışında kalanlar dâhil). `trimmed`, önceki konuşmanın bir kısmının
 * (bütün bir çiftin ya da uzun bir iletinin bir bölümünün) bu yanıtın bağlamına
 * girmediğini söyler; `clippedMessages` kısaltılarak giren ileti sayısıdır.
 */
export function buildAssistantContext({ history = [], userContent, priorMessageCount = history.length, now = new Date() }) {
  const selected = selectAssistantContextHistory({ history, userContent, priorMessageCount });
  const current = String(userContent ?? '');
  const messages = [
    { role: 'system', content: assistantSystemPrompt(now) },
    ...selected.pairs.flatMap(([question, answer]) => [{ role: 'user', content: question }, { role: 'assistant', content: answer }]),
    { role: 'user', content: current }
  ];
  return {
    messages,
    trimmed: selected.trimmed,
    includedMessages: selected.includedMessages,
    clippedMessages: selected.clippedMessages,
    omittedMessages: selected.omittedMessages
  };
}
