import { isValidEmailAddress } from './emailAddress.js';

/**
 * Hatırlatma alıcılarının çözümü.
 *
 * Zincir kurumsal kaynaklarla tanımlıdır:
 *
 *   görev sorumlusu (Sicil)
 *     → HR02.kullanici_adi   (MR_V_PeopleDirectory.Username)
 *     → DC01_userr.Name
 *     → DC01_userr.EmailAddress
 *
 * Modül SAFTIR: sorgu sonucu satırlarını alır, kurallara göre alıcı listesi
 * üretir. Böylece eksik kayıt, boş adres, bozuk adres ve yinelenen sorumlu
 * durumları veritabanı olmadan sınanabilir.
 *
 * `DC01_userr` yetkili kaynaktır: e-posta adresleri görev kayıtlarına
 * KOPYALANMAZ, her gönderimde yeniden okunur.
 */

/**
 * @param {Array<{sicil: (string|number), name?: string, username?: string|null,
 *   email?: string|null}>} rows sorumlu satırları
 * @returns {{recipients: string[], resolved: Array<object>, problems: Array<object>}}
 *   `recipients` TEKİLLEŞTİRİLMİŞ (harf duyarsız) geçerli adreslerdir.
 */
export function resolveReminderRecipients(rows = []) {
  const recipients = [];
  const seenAddresses = new Set();
  const seenSicils = new Set();
  const resolved = [];
  const problems = [];

  for (const row of rows || []) {
    if (!row) continue;
    const sicil = row.sicil == null ? '' : String(row.sicil).trim();
    // Aynı sorumlu göreve iki kez bağlanmış olabilir; kişi bir kez değerlendirilir.
    if (sicil && seenSicils.has(sicil)) continue;
    if (sicil) seenSicils.add(sicil);

    const name = String(row.name || '').trim();
    const username = String(row.username || '').trim();
    const email = String(row.email || '').trim();

    if (!username) {
      problems.push({ sicil, name, code: 'NO_USERNAME', message: `${name || sicil}: kurumsal kullanıcı adı tanımlı değil.` });
      continue;
    }
    if (!email) {
      problems.push({ sicil, name, username, code: 'NO_EMAIL', message: `${name || username}: DC01_userr kaydında e-posta adresi yok.` });
      continue;
    }
    if (!isValidEmailAddress(email)) {
      problems.push({ sicil, name, username, code: 'INVALID_EMAIL', message: `${name || username}: e-posta adresi geçerli değil.` });
      continue;
    }

    const key = email.toLocaleLowerCase('en-US');
    if (seenAddresses.has(key)) {
      // İki sorumlunun aynı posta kutusunu paylaşması kopya ileti üretmez.
      resolved.push({ sicil, name, username, email, duplicate: true });
      continue;
    }
    seenAddresses.add(key);
    recipients.push(email);
    resolved.push({ sicil, name, username, email, duplicate: false });
  }

  return { recipients, resolved, problems };
}

/** Alıcı bulunamadığında kullanıcıya gösterilecek açıklayıcı ileti. */
export function describeRecipientProblems(problems = []) {
  if (!problems.length) return 'Görevin sorumlusu bulunmuyor; hatırlatma gönderilecek kimse yok.';
  return `Hatırlatma gönderilemedi. ${problems.map((problem) => problem.message).join(' ')}`;
}
