# MERGEN Rota — `/rota` Ters Vekil Dağıtımı

Bu dağıtım modelinde Next.js içeride `8008` portunun `/` yolunda çalışır; Nginx ise dışarıya şu adresten sunar:

```text
https://<MERGEN_HOST>/rota/
```

Nginx iletmeden önce `/rota` bölümünü kaldırır. Bu nedenle MERGEN Rota, Next.js `basePath` **kullanmaz**; tarayıcıya görünen dış erişim öneki ile `assetPrefix` kullanır.

## Uyumlu Nginx kuralı

Mevcut önek kaldırma biçimi desteklenir. `^~ /rota/` sınırına dikkat edin: tek başına `location /rota` bir *önek* eşleşmesidir; `/rota-admin` ve `/rotavirus` gibi ilgisiz yolları da yakalayıp kendi işleyicileri (veya 404) yerine Rota arka sunucusuna iletir. Tam eşleşen `= /rota` konumu, son eğik çizgi olmadan da yolun çalışmasını sağlar.

```nginx
location = /rota {
    # `$is_args$args` ZORUNLUDUR: `return` yönergesi, `rewrite`'ın aksine
    # özgün sorgu dizesini kendiliğinden eklemez. Bunlar olmadan
    # `/rota?mode=actual` adresi `/rota/` olarak yeniden yazılır ve sorgu
    # parametreleri sessizce düşerdi.
    return 308 /rota/$is_args$args;
}

location ^~ /rota/ {
    proxy_pass http://<ROTA_SERVER>:8008;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;

    proxy_read_timeout 100000;
    proxy_connect_timeout 100000;
    proxy_send_timeout 100000;
    send_timeout 100000;

    rewrite ^/rota(/.*)$ $1 break;
}
```

Uygulama tam `/rota` yolunu `/rota/` yoluna yönlendirir. `/rota/` altındaki isteklerin öneki daha sonra Nginx tarafından kaldırılır ve iç kök rotaya iletilir.

Örnekler:

```text
/rota/                                      -> /
/rota/_next/static/...                      -> /_next/static/...
/rota/api/mergen-rota/snapshot              -> /api/mergen-rota/snapshot
/rota/auth/implicit-callback                 -> /auth/implicit-callback
/rota/api/mergen-rota/auth/implicit-session  -> /api/mergen-rota/auth/implicit-session
```

## Akış ve kaynak bilgisinin iletilmesi (Rota AI)

Rota AI yanıtları `POST /api/mergen-rota/ai/assistant/turns` üzerinden `text/event-stream` olarak akar. Uygulama zaten `Cache-Control: no-cache, no-store, no-transform` ve `X-Accel-Buffering: no` göndererek bu yanıt için Nginx yanıt arabelleğini kapatır. Yavaş model henüz metin üretmemişken her 15 saniyede bir SSE yorumu da gönderir; 15 saniyeden uzun boşta okuma zaman aşımı, nabız iletileriyle bağlantının açık kalmasını sağlar. Aşağıdakileri `location ^~ /rota/` bloğuyla birleştirin (TEST `/bilge` ve diğer önekler için de geçerlidir). `proxy_http_version`, `proxy_read_timeout`, `proxy_send_timeout` ve eşleşen bütün `proxy_set_header` adları (özellikle `Host`) dahil mevcut yönergeleri çoğaltmak yerine DEĞİŞTİRİN. Nginx, tek değerli yönergelerin tekrarını reddeder; yinelenen Host başlıkları iletimi bozar:

```nginx
    proxy_http_version 1.1;
    # Akış: her parçayı hemen iletin.
    proxy_buffering off;
    proxy_cache off;
    # text/event-stream değerini gzip_types dışında tutun (sıkıştırma akışı arabelleğe alır).
    # Bunlar boşta kalma zaman aşımlarıdır; toplam akış ömrü sınırı değildir.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    # Özgün ana makine ve şema: durum değiştiren AI isteklerinin (turlar,
    # silmeler, anahtar yönetimi) aynı-kaynak denetimi bunları `Origin` ile karşılaştırır.
    # `$http_host`, varsayılan dışı dış erişim portunu korur (`$host` kaldırır).
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Daha uzun mevcut zaman aşımları (yukarıdaki `100000` değerleri gibi) uyumludur. Uygulamanın kendi AI zaman aşımları vekile uyum sağlamak için gevşetilmez: yanıtın tamamını arabelleğe alan veya bağlantıyı erken kesen vekilde düzeltme yapılmalıdır. Benzer biçimde vekil özgün ana makineyi ve şemayı iletmezse durum değiştiren AI istekleri tasarım gereği `403 FORBIDDEN` ile reddedilir; çözüm aynı-kaynak denetimini zayıflatmak değil, yukarıdaki iletim başlıklarıdır. Bkz. `docs/YAPAY-ZEKA-PLATFORMU.md` §18.11.

### Sahada doğrulanan aynı-kaynak tanısı — 28 Eylül 2026

TEST dağıtımında `/bilge` → 8009 yönlendirmesinde `GET
/api/mergen-rota/ai/credential` 200 dönerken `PUT /credential` ve `POST
/probe` istekleri `403 FORBIDDEN` ile reddedildi. Tarayıcıdaki `Origin` ve
`Host` aynı kaynağı gösteriyordu. Nginx atlanıp 8009'a doğrudan, özgün
`Host`/`Origin` ile birlikte `X-Forwarded-Host` ve
`X-Forwarded-Proto` verilerek yapılan tanı isteği aynı-kaynak denetimini geçti
ve beklenen `401 SESSION_REQUIRED` sonucuna ulaştı. Bu karşılaştırma sorunun
uygulama kodunda değil vekilin kaynak bilgisini eksik iletmesinde olduğunu
kanıtladı.

Yönetici TEST bloğuna özgün ana makine ve şema iletimini ekledikten sonra
tarayıcıdan kurumsal anahtarlı gerçek `chat.fast` sınaması başarıyla
tamamlandı; ardından kişisel anahtar kaydetme/doğrulama/kaldırma akışları da
çalıştı. Bu nedenle `/rota`, `/bilge` veya gelecekteki başka bir önek için
aşağıdaki başlıklar **zorunlu dağıtım sözleşmesi** olarak ele alınmalıdır:

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
```

Aynı belirti görülürse önce vekil başlıklarını doğrulayın; çözüm
`isSameOriginRequest` denetimini gevşetmek veya kaldırmak değildir. Tanı,
üretim 8008/`/rota` örneğine dokunmadan TEST 8009/`/bilge` üzerinde
tamamlanmıştır.

## Üretim `.env.local` dosyası

Maskelenmiş değerleri şablon olarak kullanın:

```ini
NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH=/rota
NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS=60000

MERGEN_ROTA_AUTH_MODE=keycloak
MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge
MERGEN_ROTA_KEYCLOAK_CLIENT_ID=<CLIENT_ID>
MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET=
MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI=https://<MERGEN_HOST>/rota/auth/implicit-callback
MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI=https://<MERGEN_HOST>/rota/
MERGEN_ROTA_SESSION_COOKIE_SECURE=true
```

Mevcut Keycloak istemcisi, implicit geri çağrı URI'sine tam yazıldığı biçimiyle izin vermelidir.

`NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH` ve `NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS` tarayıcı paketine gömülür; ikisinden birini değiştirmek yeniden derleme gerektirir. Yenileme aralığı varsayılan olarak 60 saniyedir, 30 saniyenin altındaki değerleri reddeder, gizli sekmelerde duraklar ve Demo Kipinde kullanılmaz:

```cmd
npm run build
npm run start -- -H 0.0.0.0 -p 8008
```

Realm JWKS sertifika zinciri özel kurumsal CA kullanıyorsa `NODE_EXTRA_CA_CERTS` yine Node başlamadan önce ayarlanmalıdır.

## 8008 portuna doğrudan erişim

Önekli derleme ayrıca `/rota/:path*` yolundan `/:path*` yoluna iç yeniden yazım içerir; bu, şu adresten doğrudan tanı erişimine izin verir:

```text
http://<ROTA_SERVER>:8008/rota/
```

Esas üretim adresi, dış HTTPS URL'si olarak kalır.

### Rota AI için tek süreç zorunluluğu

Aynı konuşma veritabanına bağlı `/api/mergen-rota/ai/assistant` ve tüm alt
uçlarını tek bir Node.js sürecine yönlendirin. Bu uçlarda çok sunuculu upstream,
PM2 cluster veya worker dağıtımı kullanmayın; yalnız oturum yapışkanlığı yeterli
değildir. Silme ve tur istekleri farklı süreçlere gidemez. Dağıtım geçişinde eski
süreci durdurmadan yeni sürece AI trafiği açmayın. Ayrıntılar: `YAPAY-ZEKA-PLATFORMU.md` §18.14.

## Aşama 2 gerçek akış kabulü — 29.09.2026

PR #92 sonrasında gerçek TEST `/bilge` yolu üzerinden Rota AI kullanıcı kabulü
tamamlandı. Tarayıcıda yanıt, model üretimi bitmeden parça parça görünmeye
başladı; Nginx yanıtı sonuna kadar ara belleğe almadı. Uzun ama geçerli
üretimlerde bağlantı canlı kaldı ve **Durdur** işlemi sağlayıcı akışını
sonlandırdı. Aynı sırada olağan Rota anlık görüntü, görev ve kayıt işlemleri
beklemedi.

Bu kabul, Aşama 1'de doğrulanan özgün başlık iletimine ek olarak Aşama 2 için şu
vekil sözleşmesini dondurur: `Host`, `X-Forwarded-Host` ve
`X-Forwarded-Proto` korunur; AI akışında `proxy_buffering off` uygulanır ve
okuma zaman aşımı geçerli uzun üretimleri kesecek kadar kısa tutulmaz.

