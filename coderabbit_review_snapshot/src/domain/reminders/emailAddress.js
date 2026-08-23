/**
 * E-posta adresi doğrulaması.
 *
 * Tek bir tanım kullanılır: alıcı çözümü (alan modeli) ve MIME katmanı aynı
 * kuralı uygular. Aksi hâlde biri kabul edip öteki reddeder ve "gönderildi"
 * denen bir ileti hiç yola çıkmazdı.
 *
 * Kural bilinçli olarak DAR: boşluk, satır sonu ve başlık ayracı içeren bir
 * değer başlık enjeksiyonu yüzeyidir ve geçemez.
 */
const EMAIL_PATTERN = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]{2,}$/;

export function isValidEmailAddress(value) {
  const address = String(value ?? '').trim();
  return address.length > 0 && address.length <= 254 && EMAIL_PATTERN.test(address);
}
