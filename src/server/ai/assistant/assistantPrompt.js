import 'server-only';

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

export const ASSISTANT_CONTEXT_POLICY = Object.freeze({
  /** Veritabanından okunan en fazla önceki ileti (tur öncesi). */
  historyWindow: 40,
  /** Modele verilen en fazla önceki ileti (çift sayısı × 2). */
  maxHistoryMessages: 20,
  /** Önceki iletiler + yeni ileti için toplam karakter bütçesi. */
  maxContextChars: 48000,
  /** Bağlama giren tek bir önceki iletinin en büyük uzunluğu; uzunsa baştan kısaltılır. */
  maxMessageChars: 12000
});

const CLIPPED_SUFFIX = '\n[…ileti bağlam için kısaltıldı]';

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

function clip(content) {
  const text = String(content ?? '');
  const limit = ASSISTANT_CONTEXT_POLICY.maxMessageChars;
  return text.length <= limit ? text : `${text.slice(0, limit - CLIPPED_SUFFIX.length)}${CLIPPED_SUFFIX}`;
}

/**
 * Modele gidecek iletiler: sistem yönergesi + en yeni tamamlanmış çiftler
 * (bütçeye sığdığı kadar) + yeni kullanıcı iletisi.
 *
 * `history` tur ÖNCESİ kayıtlı iletilerdir (sıra numarasına göre artan).
 * `priorMessageCount` tur öncesindeki bütün iletilerin sayısıdır (okunan
 * pencerenin dışında kalanlar dâhil). `trimmed`, önceki konuşmanın bir kısmının
 * bu yanıtın bağlamına girmediğini söyler.
 */
export function buildAssistantContext({ history = [], userContent, priorMessageCount = history.length, now = new Date() }) {
  const answers = new Map(history.filter((message) => message.role === 'assistant').map((message) => [message.replyToId, message]));
  const pairs = history
    .filter((message) => message.role === 'user' && answers.has(message.id))
    .map((message) => [message, answers.get(message.id)]);
  const current = String(userContent ?? '');
  let budget = ASSISTANT_CONTEXT_POLICY.maxContextChars - current.length;
  const included = [];
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    if ((included.length + 1) * 2 > ASSISTANT_CONTEXT_POLICY.maxHistoryMessages) break;
    const [question, answer] = pairs[index];
    const pair = [clip(question.content), clip(answer.content)];
    const size = pair[0].length + pair[1].length;
    if (size > budget) break;
    budget -= size;
    included.unshift(pair);
  }
  const messages = [
    { role: 'system', content: assistantSystemPrompt(now) },
    ...included.flatMap(([question, answer]) => [{ role: 'user', content: question }, { role: 'assistant', content: answer }]),
    { role: 'user', content: current }
  ];
  const includedMessages = included.length * 2;
  const completedMessages = pairs.length * 2;
  return {
    messages,
    trimmed: included.length < pairs.length || priorMessageCount > history.length,
    includedMessages,
    omittedMessages: Math.max(0, completedMessages - includedMessages) + Math.max(0, priorMessageCount - history.length)
  };
}
