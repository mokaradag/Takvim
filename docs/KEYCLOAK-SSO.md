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
| `/api/mergen-rota/auth/login` | GET | Seçili akışa göre Keycloak yetkilendirme adresine yönlendirir |
| `/api/mergen-rota/auth/callback` | GET | **(Authorization Code)** Kodu sunucuda jetonla takas eder, doğrular, oturum çerezini yazar |
| `/auth/implicit-callback` | GET | **(Implicit köprü)** URL parçasını okuyup hemen silen küçük geri dönüş sayfası |
| `/api/mergen-rota/auth/implicit-session` | POST | **(Implicit köprü)** İşlem çerezi + `state` + `Bearer` jetonunu doğrulayıp HttpOnly oturuma çevirir |
| `/api/mergen-rota/auth/session` | POST | Genel uyumluluk: `Authorization: Bearer` jetonunu HttpOnly oturuma çevirir |
| `/api/mergen-rota/auth/logout` | POST/GET | MERGEN Rota oturumunu kapatır, Keycloak `end_session` adresini verir |

Korunan veri uçları değişmedi: `GET /api/mergen-rota/session`,
`GET /api/mergen-rota/snapshot`, `POST /api/mergen-rota/commit`. Her mutasyon
mevcut sunucu/transaction sınırı içinde yeniden yetkilendirilir.

### Akış seçimi

Oturum açma akışı yalnızca sunucu yapılandırmasından, `MERGEN_ROTA_KEYCLOAK_FLOW`
ile seçilir. Tarayıcı akışı değiştiremez. Kabul edilen değerler **tam olarak**:

```ini
MERGEN_ROTA_KEYCLOAK_FLOW=authorization-code
MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge
```

Değer boşsa `authorization-code` varsayılır. **Tanınmayan veya bozuk bir değer
yapılandırma hatasıdır**: uygulama açık bir hata döndürür, sessizce başka bir
akışa düşmez.

| | `authorization-code` | `implicit-bridge` |
| --- | --- | --- |
| Durum | **Tercih edilen, varsayılan** | Uyumluluk kipi |
| `response_type` | `code` | `token` |
| `response_mode` | (varsayılan) | `fragment` |
| PKCE | `S256`, zorunlu | Yok (kullanılmaz) |
| Jeton endpoint'i | Kullanılır | **Kullanılmaz** |
| İstemci secret'ı | Gizli istemcide gerekir | **Gerekmez** |
| Jeton tarayıcıya ulaşır mı? | Hayır | Kısa süreliğine, URL parçasında |
| Sunucu tarafı JWT + Sicil doğrulaması | Evet | Evet, **aynı kod** |
| Oturum çerezi | `mergen_rota_session` | `mergen_rota_session` (aynı) |

Authorization Code + PKCE tercih edilen akış olmayı sürdürür. Yalnızca, mevcut
Keycloak istemcisi gizli (confidential) olduğunda, jeton takasının **geçerli bir
istemci kimlik doğrulaması** gerektirdiğini bilmek gerekir.

> **Gözlenen dağıtım:** Yetkilendirme isteği kabul edilmiş (istemci kimliği,
> geri dönüş adresi, Standard Flow ve PKCE S256 doğrulanmış; etkileşimsiz
> `prompt=none` sondası beklendiği gibi `login_required` dönmüş), ancak jeton
> takası reddedilmiştir: `HTTP 401`, `error=unauthorized_client`,
> `error_description=Invalid client or Invalid client credentials` ve gönderilen
> bir istemci secret'ı yok. Bu, Standard Flow'un kapalı olduğu anlamına gelmez;
> jeton ucunun geçerli bir gizli istemci kimlik doğrulaması beklediği anlamına
> gelir. Secret elde edilemediği sürece Authorization Code takası tamamlanamaz.
> Implicit köprü, hâlihazırda `response_type=token` ile çalışan mevcut istemci
> için bu nedenle açık bir uyumluluk kipi olarak eklenmiştir.

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

### Oturum açma akışı (implicit köprü)

`MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge` seçiliyken:

1. Kullanıcı **aynı** kurumsal oturum açma eylemine tıklar
   (`GET /api/mergen-rota/auth/login`).
2. Sunucu kriptografik rastgele bir `state` üretir. **PKCE üretilmez.**
3. Sunucu imzalı, HttpOnly ve kısa ömürlü işlem çerezini yazar:
   `{ flow: 'implicit-bridge', state, returnTo, exp }`.
4. Tarayıcı Keycloak'a yönlendirilir: `response_type=token`,
   `response_mode=fragment`, `client_id`, implicit geri dönüş adresi, kapsam,
   `state`. İstemci secret'ı bu adrese **hiçbir koşulda** yazılmaz.
5. Keycloak jetonu ve `state`'i **URL parçasında** döndürür.
6. `GET /auth/implicit-callback` küçük bir HTML yanıtıdır (hidratlanan uygulama
   sayfası değil): parçayı okur, `history.replaceState` ile **derhâl siler** ve
   jetonu tek bir POST isteğiyle köprü ucuna gönderir.
7. `POST /api/mergen-rota/auth/implicit-session` işlem çerezinin imzasını,
   süresini ve `flow === 'implicit-bridge'` işaretini doğrular; `state`
   değerlerini sabit zamanlı karşılaştırır; jetonu **mevcut kanonik**
   `authenticateAccessToken()` sınırında doğrular; Sicil'i mevcut güvenilen
   mantıkla çözer; `mergen_rota_session` çerezini yazar; işlem çerezini temizler
   ve yalnızca `{ authenticated: true, returnTo }` döndürür.
8. Sayfa `window.location.replace(returnTo)` ile uygulamaya döner.

Erişim jetonunun yaşam alanı **yalnızca** şunlardır: Keycloak URL parçası (hemen
silinir), geri dönüş betiğinin yerel değişkeni ve tek bir kimlikli POST isteği.
Jeton `localStorage`, `sessionStorage`, `IndexedDB`, çerez, sorgu dizesi, React
durumu veya uygulama durumunda **saklanmaz** ve hiçbir günlük çağrısına verilmez.

Geri dönüş sayfası yanıtı `Cache-Control: no-store, max-age=0`, `Pragma:
no-cache`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` ve yanıt başına üretilen rastgele bir nonce ile katı bir
`Content-Security-Policy` taşır (`default-src 'none'`, `script-src 'nonce-…'`,
`style-src 'nonce-…'`, `connect-src 'self'`, `base-uri 'none'`,
`frame-ancestors 'none'`, `form-action 'none'`). Üçüncü taraf betik, stil, yazı
tipi, görsel veya ölçümleme yüklenmez.

**Akış ayrımı:** İşlem çerezi her zaman bir `flow` işareti taşır. Authorization
Code geri dönüşü bir implicit işlemi, implicit köprü ucu da bir Authorization
Code işlemini **kabul etmez**.

### Genel implicit jeton uyumluluğu

Bu uç **değişmedi**. Elinde yalnızca erişim jetonu olan bir istemci
`POST /api/mergen-rota/auth/session` ucuna `Authorization: Bearer <jeton>`
başlığıyla başvurur. Jeton **sunucuda** doğrulanır, yanıtta geri verilmez ve
HttpOnly oturuma çevrilir. Erişim jetonu `localStorage`'da saklanmaz.

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
| `MERGEN_ROTA_KEYCLOAK_FLOW` | `authorization-code` (varsayılan) veya `implicit-bridge`; başka değer hata verir |
| `MERGEN_ROTA_KEYCLOAK_BASE_URL` | `https://<KEYCLOAK_HOST>` ya da doğrudan realm issuer adresi |
| `MERGEN_ROTA_KEYCLOAK_REALM` | Realm adı |
| `MERGEN_ROTA_KEYCLOAK_CLIENT_ID` | MERGEN Rota istemci kimliği (MERGEN Bilge'ninkiyle aynı olmak zorunda değildir) |
| `MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET` | Yalnızca gizli istemci kimlik doğrulaması gerektiğinde; public istemcide ve implicit köprüde boş |
| `MERGEN_ROTA_KEYCLOAK_AUDIENCE` | Beklenen `aud`; boşsa istemci kimliği |
| `MERGEN_ROTA_KEYCLOAK_AUTHORIZED_PARTY` | Beklenen `azp`; boşsa istemci kimliği |
| `MERGEN_ROTA_KEYCLOAK_REDIRECT_URI` | **Yalnızca Authorization Code**: `https://<MERGEN_ROTA_HOST>:8008/api/mergen-rota/auth/callback` |
| `MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI` | **Yalnızca implicit köprü**: `https://<MERGEN_ROTA_HOST>:8008/auth/implicit-callback`; boşsa istek kökünden türetilir |
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

MERGEN Rota istemcisi için (tercih edilen `authorization-code` akışı):

- **Valid redirect URI:** `https://<MERGEN_ROTA_HOST>:8008/api/mergen-rota/auth/callback`
- **Valid post logout redirect URI:** `https://<MERGEN_ROTA_HOST>:8008/`
- **Web origin:** `https://<MERGEN_ROTA_HOST>:8008`
- **Standard flow (Authorization Code):** açık
- **PKCE (S256):** zorunlu
- **İstemci türü:** public tercih edilir. Gizli (confidential) istemcide jeton
  takası geçerli bir istemci kimlik doğrulaması ister; secret elde edilemiyorsa
  bu akış tamamlanamaz.
- **Claim'ler:** `sicil`, `sektor`, `department`, `mudurluk` erişim jetonuna
  eklenmelidir (diğerleri standart `profile`/`email` kapsamlarından gelir)

`implicit-bridge` kipi kullanılacaksa, hâlihazırda implicit akışla çalışan
istemci için ek olarak:

- **Implicit flow:** açık (bu istemcide zaten açıktır)
- **Valid redirect URI:** `https://<MERGEN_ROTA_HOST>:8008/auth/implicit-callback`
  — `.env.local` içindeki `MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI` ile
  **birebir aynı** olmalıdır
- **Web origin:** `https://<MERGEN_ROTA_HOST>:8008`
- **İstemci secret'ı:** gerekmez (jeton endpoint'i kullanılmaz)

Bu belge Keycloak'ta herhangi bir değişikliğin **yapıldığını** iddia etmez;
yalnızca ilgili akışın çalışması için hangi kaydın gerektiğini listeler.

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
kapalıdır ve üretimde kullanılmaz. Geliştirme kimliği **bir üretim yedeği
değildir**: Keycloak akışı çalışmıyorsa çözüm, akışı ve yapılandırmayı
düzeltmektir.

Üretimde HTTPS zorunludur ve `MERGEN_ROTA_SESSION_COOKIE_SECURE=true` kalmalıdır.
`false` değeri yalnızca düz HTTP üzerinde yapılan doğrudan port 8008 testi
içindir (tarayıcı `http://` üzerinde `Secure` çerez yazmaz).

### Doğrudan port 8008 testi (implicit köprü)

Yalnızca yer tutuculu örnek; gerçek değerler yalnızca işlenmeyen `.env.local`
dosyasındadır:

```ini
MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge
MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET=
MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI=http://<TEST_HOST>:8008/auth/implicit-callback
MERGEN_ROTA_SESSION_COOKIE_SECURE=false
```

`NODE_EXTRA_CA_CERTS` implicit köprüde de gerekebilir: sunucu jeton imzasını
doğrulamak için realm JWKS ucunu çekmeye devam eder. Değer Node başlatılmadan
önce ortamda bulunmalıdır; sertifika yolu depoya işlenmez.

### Teşhis betiği

`diagnose-keycloak.cjs` seçili akışa duyarlıdır ve `run-keycloak-diagnosis.cmd`
ile kendi depo dizininden çalışır (`cd /d "%~dp0"`); dosyada dağıtım yolu, ağ
paylaşımı, konak adı veya sertifika konumu tutulmaz. Betik `authorization-code`
kipinde keşif/TLS, yetkilendirme isteği ve jeton ucu sondasını çalıştırır;
`implicit-bridge` kipinde jeton ucunu **hiç kullanmaz**, `response_type=token` +
`response_mode=fragment` isteğini `prompt=none` ile sınar ve çalışan uygulamanın
gerçekten bu parametreleri (ve PKCE'siz olduğunu) yayıp yaymadığını denetler.
Hiçbir gerçek jeton yakalanmaz; sır, jeton, URL parçası veya sertifika içeriği
yazdırılmaz.

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
| Jeton takasında `HTTP 401` + `unauthorized_client` + `Invalid client or Invalid client credentials` | Gizli istemci kimlik doğrulaması eksik/yanlış. Standard Flow kapalı **değildir**; yetkilendirme isteği kabul edilmektedir. Secret sağlanamıyorsa `MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge` kullanılabilir |
| "Implicit köprü kipi etkin değil" | `MERGEN_ROTA_KEYCLOAK_FLOW` `implicit-bridge` değil; köprü ucu yalnızca o kipte çalışır |
| "Oturum açma işlemi bulunamadı / süresi doldu" | İşlem çerezi yok veya 10 dakikayı aştı. Eski bir geri dönüş adresini yeniden kullanmayın; oturum açmayı baştan başlatın |
| "Oturum açma işlemi bu akışa ait değil" | Çerez öteki akışa ait. Sunucu yeniden başlatıldıysa veya akış değiştirildiyse tek çözüm taze oturum açmadır |
| "Oturum açma durumu eşleşmedi" | Geri dönen `state` çerezdekiyle aynı değil (CSRF koruması); taze oturum açın |
| `MERGEN_ROTA_KEYCLOAK_FLOW` hatası | Değer `authorization-code` veya `implicit-bridge` dışında bir şey; sessiz yedek yoktur |

---

## 12. Test kapsamı

- `test/keycloak-authentication-e2e.test.mjs` — imza, issuer, kitle, `azp`,
  algoritma, süre, bozuk jeton, Sicil biçimi, kullanıcı adı yedeği, PKCE,
  oturum açma/kapatma, çerez kurcalama, günlük gizliliği
- `test/keycloak-implicit-bridge-e2e.test.mjs` — akış seçimi ve doğrulaması,
  Authorization Code gerilemesi, implicit oturum açma isteği, geri dönüş
  sayfası ve başlıkları, köprü ucunun tüm ret yolları, başarılı köprü, akış
  ayrımı
- `test/keycloak-flow-diagnostics-contract.test.mjs` — teşhis betiklerinde
  dağıtım yolu/sır bulunmaması, akışa duyarlı sondalar, düzeltilmiş
  `unauthorized_client` yorumu
- `test/keycloak-authorization-boundary-e2e.test.mjs` — kimlik doğrulaması
  değişse de yetkilendirme önceliğinin korunması, UNAUTHORIZED/FORBIDDEN ayrımı
- `test/user-photo-and-sidebar-e2e.test.mjs` — fotoğraf URL'si, baş harf yedeği,
  kenar çubuğu kimliği
- `test/deployment-and-secrets-contract.test.mjs` — port 8008, `.env.example`
  yer tutucuları, gizli değer taraması
