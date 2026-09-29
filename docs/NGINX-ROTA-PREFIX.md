# MERGEN Rota — `/rota` reverse-proxy deployment

This deployment model keeps Next.js internally mounted at `/` on port `8008`, while Nginx exposes it publicly at:

```text
https://<MERGEN_HOST>/rota/
```

Nginx strips `/rota` before forwarding. MERGEN Rota therefore does **not** use Next.js `basePath`; it uses a browser-visible public prefix plus `assetPrefix`.

## Compatible Nginx rule

The existing prefix-stripping form is supported. Note the `^~ /rota/` boundary:
a bare `location /rota` is a *prefix* match, so it also captures unrelated paths
such as `/rota-admin` and `/rotavirus` and forwards them to the Rota upstream
instead of their intended handler (or a 404). The exact `= /rota` location keeps
the bare path working.

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

The application redirects the exact path `/rota` to `/rota/`. Requests below `/rota/` are then stripped by Nginx and forwarded to the internal root route.

Examples:

```text
/rota/                                      -> /
/rota/_next/static/...                      -> /_next/static/...
/rota/api/mergen-rota/snapshot              -> /api/mergen-rota/snapshot
/rota/auth/implicit-callback                 -> /auth/implicit-callback
/rota/api/mergen-rota/auth/implicit-session  -> /api/mergen-rota/auth/implicit-session
```

## Streaming and origin forwarding (Rota AI)

Rota AI answers stream from `POST /api/mergen-rota/ai/assistant/turns` as
`text/event-stream`. The application already sends `Cache-Control: no-cache,
no-store, no-transform` and `X-Accel-Buffering: no`, which disables Nginx
response buffering for that response. It also sends an SSE comment every 15
seconds while a slow model has not produced text yet, so an idle-read timeout
larger than 15 seconds allows heartbeats to keep the connection open. Merge the
following into the `location ^~ /rota/` block (also for TEST `/bilge` or other
prefixes). REPLACE existing directives, rather than appending duplicates,
including `proxy_http_version`, `proxy_read_timeout`, `proxy_send_timeout` and
all matching `proxy_set_header` names (especially `Host`). nginx rejects duplicate
single-value directives and repeated Host headers break forwarding:

```nginx
    proxy_http_version 1.1;
    # Streaming: forward each chunk immediately.
    proxy_buffering off;
    proxy_cache off;
    # Keep text/event-stream out of gzip_types (compression buffers the stream).
    # Idle timeouts, not a total stream lifetime limit.
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    # Original host and scheme: the same-origin check of state-changing AI
    # requests (turns, deletes, key management) compares them with `Origin`.
    # `$http_host` keeps a non-default public port (`$host` drops it).
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Longer existing timeouts (such as the `100000` values above) are compatible.
The application's own AI timeouts are not relaxed to accommodate a proxy: a
proxy that buffers the whole answer or cuts the connection early must be fixed in
the proxy. Likewise, if the proxy does not forward the original host and scheme,
state-changing AI requests are rejected with `403 FORBIDDEN` by design; the fix
is the forwarding headers above, never a weaker same-origin check. See
`docs/AI-PLATFORM.md` §18.11.

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

## Production `.env.local`

Use masked values as a template:

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

The implicit callback URI must be permitted by the existing Keycloak client exactly as written.

Both `NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH` and `NEXT_PUBLIC_MERGEN_ROTA_AUTO_REFRESH_INTERVAL_MS` are embedded into the browser bundle, so changing either requires a rebuild. The refresh interval defaults to 60 seconds, rejects values below 30 seconds, pauses in hidden tabs and is unused in Demo Mode:

```cmd
npm run build
npm run start -- -H 0.0.0.0 -p 8008
```

`NODE_EXTRA_CA_CERTS` must still be set before Node starts when the realm JWKS certificate chain uses a private corporate CA.

## Direct port-8008 access

A prefixed build also includes an internal rewrite from `/rota/:path*` to `/:path*`, which allows direct diagnostic access at:

```text
http://<ROTA_SERVER>:8008/rota/
```

The canonical production address remains the external HTTPS URL.

### Rota AI için tek süreç zorunluluğu

Aynı konuşma veritabanına bağlı `/api/mergen-rota/ai/assistant` ve tüm alt
uçlarını tek bir Node.js sürecine yönlendirin. Bu uçlarda çok sunuculu upstream,
PM2 cluster veya worker dağıtımı kullanmayın; yalnız oturum yapışkanlığı yeterli
değildir. Silme ve tur istekleri farklı süreçlere gidemez. Dağıtım geçişinde eski
süreci durdurmadan yeni sürece AI trafiği açmayın. Ayrıntılar: `AI-PLATFORM.md` §18.14.

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

