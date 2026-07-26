# MERGEN Rota — Keycloak Kimlik Doğrulama

Bu belge MERGEN Rota'nın Keycloak entegrasyonunu açıklar: akış, ortam
değişkenleri, IT'nin kaydetmesi gereken adresler, oturum davranışı ve sorun
giderme.

Tüm örnekler **maskelenmiştir**. Gerçek konak adı, istemci kimliği, sicil, ad,
e-posta veya jeton bu depoda hiçbir dosyada yer almaz.

MERGEN Rota **8008** portunda çalışır. **8009** portu ayrı bir uygulama olan
MERGEN Bilge'ye aittir ve MERGEN Rota yapılandırmasında kullanılmaz.

---

## 1. Özet

Kimlik doğrulama, kullanıcının **kim olduğunu** belirler. Kullanıcının **neye
erişebileceğini** MERGEN Rota'nın mevcut yetkilendirme modeli belirlemeye devam
eder (`docs/AUTHORIZATION-MODEL.md`). Keycloak entegrasyonu yalnızca
`CurrentUserProvider` katmanını değiştirmiştir:

```text
Keycloak (doğrulanmış jeton)
    → sicil claim'i  (ya da preferred_username → HR02 → Sicil)
    → HttpOnly MERGEN Rota oturum çerezi
    → getTrustedCurrentSicil()
    → loadAuthorizationContext()  (MR_UserRoles, HR09, MR_ProjectAccess, ...)
```

SQL şeması, repository transaction modeli, yetkilendirme önceliği, yetkiye göre
süzülmüş anlık görüntüler ve kısmi proje CPM bastırması **değişmemiştir**.

---

## 2. Uçlar

| Uç | Yöntem | Görev |
| --- | --- | --- |
| `/api/mergen-rota/auth/login` | GET | PKCE üretir, Keycloak yetkilendirme adresine yönlendirir |
| `/api/mergen-rota/auth/callback` | GET | Kodu sunucuda jetonla takas eder, doğrular, oturum çerezini yazar |
| `/api/mergen-rota/auth/session` | POST | Uyumluluk: `Authorization: Bearer` jetonunu HttpOnly oturuma çevirir |
| `/api/mergen-rota/auth/logout` | POST/GET | MERGEN Rota oturumunu kapatır, Keycloak `end_session` adresini verir |

Korunan veri uçları değişmedi: `GET /api/mergen-rota/session`,
`GET /api/mergen-rota/snapshot`, `POST /api/mergen-rota/commit`. Her mutasyon
mevcut sunucu/transaction sınırı içinde yeniden yetkilendirilir.

### Oturum açma akışı (Authorization Code + PKCE)

1. Kullanıcı `GET /api/mergen-rota/auth/login` adresine gider.
2. Sunucu `code_verifier` + `state` üretir ve bunları **imzalı, HttpOnly, kısa
   ömürlü** bir işlem çerezinde saklar. Tarayıcıya yalnızca `code_challenge`
   gider.
3. Keycloak kullanıcıyı doğrular ve `callback` adresine `code` + `state` ile
   döner.
4. Sunucu `state` eşleşmesini doğrular, kodu **sunucu tarafında** jetonla takas
   eder, jetonun imzasını ve claim'lerini doğrular.
5. Doğrulanmış Sicil ve güvenli görüntüleme alanları HMAC ile imzalanmış
   HttpOnly oturum çerezine yazılır; kullanıcı `returnTo` yoluna döner.

`returnTo` yalnızca uygulama içi bir yol olabilir; açık yönlendirme (open
redirect) engellenir. `state` doğrulanamazsa akış reddedilir ve yönlendirme
döngüsü yerine açık bir hata yanıtı döner.

### Implicit jeton uyumluluğu

Bir istemci elinde yalnızca erişim jetonu varsa `POST /api/mergen-rota/auth/session`
ucuna `Authorization: Bearer <jeton>` başlığıyla başvurur. Jeton **sunucuda**
doğrulanır, yanıtta geri verilmez ve HttpOnly oturuma çevrilir. Erişim jetonu
`localStorage`'da saklanmaz.

---

## 3. Zorunlu Keycloak claim'leri

Doğrulanan standart claim'ler: `iss`, `exp`, `aud`, `azp`, `typ`, `nbf`, `iat`.
Kimlik için okunan claim'ler:

| Claim | Kullanım |
| --- | --- |
| `sicil` | **Güvenilen kimlik anahtarı.** Tüm yetkilendirme bu değerle çalışır |
| `preferred_username` | Görüntüleme + isteğe bağlı Sicil yedeği |
| `name`, `given_name`, `family_name` | Görüntüleme |
| `email`, `email_verified` | Görüntüleme |
| `department` | Kenar çubuğunda ad altında gösterilen değer |
| `sektor`, `mudurluk` | Görüntüleme |
| `sub`, `sid`, `session_state` | Oturum ilişkilendirme |
| `resource_access` | **Yalnızca bilgi.** MERGEN Rota yetkisi üretmez |

### Sicil eşlemesi

1. Doğrulanmış `sicil` claim'i kullanılır. Biçim kuralı geliştirme kimliğiyle
   aynıdır: yalnızca pozitif tam sayı, `int` sınırı içinde. `900001abc`, `0`,
   `-1`, `900001.5` gibi değerler reddedilir.
2. `sicil` yoksa ve `MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK=true` ise
   `preferred_username` değeri `dbo.MR_V_PeopleDirectory` üzerinde parametreli
   bir sorguyla aranır. Sonuç **tam olarak bir** kayıt olmalıdır.
3. Hiçbiri çözülemezse **UNAUTHORIZED** döner. Yönetici, Demo veya geliştirme
   kimliğine sessizce düşülmez.

---

## 4. Sunucu tarafı jeton doğrulama

- Doğrulama Next.js sunucusunda yapılır; istemci hiçbir doğrulama yapmaz.
- İmza, Keycloak realm **JWKS** ucundaki genel anahtarla doğrulanır.
- Kabul edilen algoritmalar sınırlıdır (varsayılan `RS256`; `RS384`/`RS512`
  yapılandırılabilir). `alg: none` ve HMAC (`HS*`) algoritma karışıklığı
  saldırıları reddedilir.
- JWKS anahtarları bellekte TTL ile önbelleklenir. Bilinmeyen bir `kid`
  görüldüğünde (anahtar rotasyonu) tek bir yenileme yapılır; bu yenileme hız
  sınırlıdır.
- **Kapalı başarısızlık**: JWKS alınamıyorsa, anahtar bilinmiyorsa, imza
  geçersizse, süre dolmuşsa, issuer/kitle/istemci doğrulaması başarısızsa veya
  Sicil çözülemiyorsa istek reddedilir.

---

## 5. Uygulama oturumu

- Çerez adı: `mergen_rota_session`
- Nitelikler: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
- İçerik: HMAC-SHA256 ile imzalanmış; doğrulanmış Sicil + güvenli görüntüleme
  alanları + süre. **Erişim jetonu veya yenileme jetonu içermez.**
- İmza `MERGEN_ROTA_SESSION_SECRET` ile üretilir. İmzası bozulmuş, süresi dolmuş
  veya Sicil'i geçersiz bir çerez kimlik üretmez.

`GET /api/mergen-rota/session` yanıtındaki `currentUser` nesnesi kurumsal rehber
kaydı ile doğrulanmış claim'lerin birleşimidir: `sicil`, `employeeNo`, `name`,
`username`, `givenName`, `familyName`, `email`, `department`, `sector`,
`managementUnit`, `subject`, `role`, `team`, `organization`. Ham jeton yanıtta
bulunmaz.

> **Not — iki farklı "departman":** `currentUser.department` Keycloak
> `department` claim'idir (kenar çubuğunda görünen değer).
> `currentUser.organization.department` ise HR02 `mudurluk` alanından türetilen
> kurumsal rehber değeridir. İkisi karıştırılmamalıdır.

### Oturum kapatma

`POST /api/mergen-rota/auth/logout` her durumda MERGEN Rota çerezini temizler
(Keycloak yapılandırması eksik olsa bile) ve `endSessionUrl` döndürür. İstemci
yönlendirmeyi kendisi yapar; bu, fetch tabanlı çıkışta yönlendirme döngüsünü
önler. `GET` sürümü doğrudan Keycloak `end_session` adresine yönlendirir.

---

## 6. UNAUTHORIZED / FORBIDDEN ayrımı

| Durum | Yanıt |
| --- | --- |
| Oturum yok, çerez bozuk, süresi dolmuş, jeton geçersiz, Sicil çözülemedi | `401 UNAUTHORIZED` |
| Kimlik geçerli ama uygulama yetkisi yetersiz | `403 FORBIDDEN` |

Kimlik doğrulanmadığında istemci yarım yüklenmiş Gerçek Sistem verisi görmez;
açılış perdesinde açık bir "Kurumsal oturum aç" eylemi gösterilir. **Demo Modu
bir kimlik yedeği değildir**; yalnızca kullanıcının bilinçli seçimidir.

---

## 7. Ortam değişkenleri

Tümü sunucu tarafıdır ve `NEXT_PUBLIC_` ile **açığa çıkarılmaz**. Şablon:
`.env.example`. Gerçek değerler yalnızca `.env.local` içinde tutulur ve depoya
işlenmez.

| Değişken | Açıklama |
| --- | --- |
| `MERGEN_ROTA_AUTH_MODE` | `keycloak` (varsayılan) veya `development` |
| `MERGEN_ROTA_KEYCLOAK_BASE_URL` | `https://<KEYCLOAK_HOST>` ya da doğrudan realm issuer adresi |
| `MERGEN_ROTA_KEYCLOAK_REALM` | Realm adı |
| `MERGEN_ROTA_KEYCLOAK_CLIENT_ID` | MERGEN Rota istemci kimliği (MERGEN Bilge'ninkiyle aynı olmak zorunda değildir) |
| `MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET` | Yalnızca gizli istemcide; public istemcide boş |
| `MERGEN_ROTA_KEYCLOAK_AUDIENCE` | Beklenen `aud`; boşsa istemci kimliği |
| `MERGEN_ROTA_KEYCLOAK_AUTHORIZED_PARTY` | Beklenen `azp`; boşsa istemci kimliği |
| `MERGEN_ROTA_KEYCLOAK_REDIRECT_URI` | `https://<MERGEN_ROTA_HOST>:8008/api/mergen-rota/auth/callback` |
| `MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI` | `https://<MERGEN_ROTA_HOST>:8008/` |
| `MERGEN_ROTA_KEYCLOAK_SCOPE` | Varsayılan `openid profile email` |
| `MERGEN_ROTA_KEYCLOAK_JWKS_URL` | İsteğe bağlı JWKS geçersiz kılma |
| `MERGEN_ROTA_KEYCLOAK_JWKS_CACHE_TTL_MS` | JWKS önbellek ömrü (varsayılan 600000) |
| `MERGEN_ROTA_KEYCLOAK_JWKS_MIN_REFRESH_MS` | Bilinmeyen `kid` yenileme hız sınırı (varsayılan 30000) |
| `MERGEN_ROTA_KEYCLOAK_ALLOWED_ALGORITHMS` | Varsayılan `RS256` |
| `MERGEN_ROTA_KEYCLOAK_CLOCK_TOLERANCE_SECONDS` | Varsayılan 30 |
| `MERGEN_ROTA_KEYCLOAK_USERNAME_SICIL_FALLBACK` | `preferred_username → HR02 → Sicil` yedeği |
| `MERGEN_ROTA_AUTH_DEBUG` | Maskelenmiş kimlik günlüğü |
| `MERGEN_ROTA_SESSION_SECRET` | Oturum çerezi imza anahtarı (en az 32 karakter) |
| `MERGEN_ROTA_SESSION_TTL_SECONDS` | Oturum ömrü (varsayılan 28800) |
| `MERGEN_ROTA_SESSION_COOKIE_SECURE` | Üretimde `true` |
| `MERGEN_ROTA_DEV_IDENTITY_ENABLED` | Yalnızca `development` kipiyle birlikte |
| `MERGEN_ROTA_DEV_SICIL` | Yerel geliştirme Sicil değeri |

Oturum anahtarı üretimi:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### Kullanıcı fotoğrafı değişkeni

| Değişken | Açıklama |
| --- | --- |
| `NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL` | Kurumsal fotoğraf dizini taban adresi |

Bu değer **tarayıcıya açıktır** (istemci paketine gömülür) ve bir sır değildir;
`NEXT_PUBLIC_` öneki bu nedenle bilinçlidir. Fotoğraf adresi
`<TABAN_URL>/<SICIL>.jpg` biçiminde üretilir; sondaki eğik çizgiler normalize
edilir ve sicil URL için kodlanır. Değer boşsa veya sicil eksik/bozuksa avatar
baş harflere döner.

---

## 8. IT'nin Keycloak'ta kaydetmesi gerekenler

MERGEN Rota istemcisi için:

- **Valid redirect URI:** `https://<MERGEN_ROTA_HOST>:8008/api/mergen-rota/auth/callback`
- **Valid post logout redirect URI:** `https://<MERGEN_ROTA_HOST>:8008/`
- **Web origin:** `https://<MERGEN_ROTA_HOST>:8008`
- **Standard flow (Authorization Code):** açık
- **PKCE (S256):** zorunlu
- **Implicit flow:** gerekli değildir
- **Claim'ler:** `sicil`, `sektor`, `department`, `mudurluk` erişim jetonuna
  eklenmelidir (diğerleri standart `profile`/`email` kapsamlarından gelir)

MERGEN Bilge'nin istemci kimliği **varsayılmaz**; MERGEN Rota kendi istemci
kimliğini yapılandırmadan okur.

---

## 9. Yerel geliştirme kimliği

Keycloak'a erişimi olmayan geliştirme ortamı için:

```ini
MERGEN_ROTA_AUTH_MODE=development
MERGEN_ROTA_DEV_IDENTITY_ENABLED=true
MERGEN_ROTA_DEV_SICIL=<yerel test sicili>
```

Her iki anahtar birlikte verilmelidir. Varsayılan yapılandırmada bu yol
kapalıdır ve üretimde kullanılmaz.

---

## 10. Doğrulama adımları

1. `npm run build && npm run start:prod` ile uygulamayı 8008 portunda başlatın.
2. **Gerçek Sistem** seçin. Oturum yoksa açılış perdesinde "Kurumsal oturum aç"
   görünmelidir.
3. Oturum açın; Keycloak'a yönlendirildiğinizi ve geri döndüğünüzü doğrulayın.
4. Kenar çubuğunda kendi adınızı, fotoğrafınızı ve departmanınızı görün.
5. Tarayıcı geliştirici araçlarında `mergen_rota_session` çerezinin `HttpOnly`
   olduğunu ve `localStorage`'da jeton bulunmadığını doğrulayın.
6. Yetkiniz olmayan bir projede yazma denemesinin `FORBIDDEN`, oturumsuz bir
   isteğin `UNAUTHORIZED` döndüğünü doğrulayın.
7. Oturumu kapatın; korunan verinin artık gelmediğini doğrulayın.

---

## 11. Sorun giderme

Sorun giderirken **ham jeton yazdırmayın**. `MERGEN_ROTA_AUTH_DEBUG=true`
yalnızca maskelenmiş alanları günlüğe yazar.

| Belirti | Olası neden |
| --- | --- |
| Her istek `UNAUTHORIZED` | `MERGEN_ROTA_SESSION_SECRET` eksik/kısa, ya da çerez `Secure` iken site HTTP üzerinden açılıyor |
| "Kimlik doğrulanamadı" | İmza/issuer/kitle uyuşmazlığı; realm, istemci kimliği ve `aud`/`azp` yapılandırmasını karşılaştırın |
| "Kurumsal Sicil bilgisi çözülemedi" | Jetonda `sicil` claim'i yok ve kullanıcı adı HR02'de tekil eşleşmiyor |
| Oturum açma döngüsü | `redirect_uri` Keycloak kaydıyla birebir aynı değil (port 8008 dâhil) |
| Anahtar rotasyonu sonrası kısa süreli hata | JWKS yenileme hız sınırı; `MERGEN_ROTA_KEYCLOAK_JWKS_MIN_REFRESH_MS` ile ayarlanır |
| Avatarlar baş harf gösteriyor | `NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL` boş, ya da fotoğraf sunucusuna erişilemiyor |

---

## 12. Test kapsamı

- `test/keycloak-authentication-e2e.test.mjs` — imza, issuer, kitle, `azp`,
  algoritma, süre, bozuk jeton, Sicil biçimi, kullanıcı adı yedeği, PKCE,
  oturum açma/kapatma, çerez kurcalama, günlük gizliliği
- `test/keycloak-authorization-boundary-e2e.test.mjs` — kimlik doğrulaması
  değişse de yetkilendirme önceliğinin korunması, UNAUTHORIZED/FORBIDDEN ayrımı
- `test/user-photo-and-sidebar-e2e.test.mjs` — fotoğraf URL'si, baş harf yedeği,
  kenar çubuğu kimliği
- `test/deployment-and-secrets-contract.test.mjs` — port 8008, `.env.example`
  yer tutucuları, gizli değer taraması
