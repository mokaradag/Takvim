# MERGEN Rota — `/rota` reverse-proxy deployment

This deployment model keeps Next.js internally mounted at `/` on port `8008`, while Nginx exposes it publicly at:

```text
https://<MERGEN_HOST>/rota/
```

Nginx strips `/rota` before forwarding. MERGEN Rota therefore does **not** use Next.js `basePath`; it uses a browser-visible public prefix plus `assetPrefix`.

## Compatible Nginx rule

The existing prefix-stripping form is supported:

```nginx
location /rota {
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

## Production `.env.local`

Use masked values as a template:

```ini
NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH=/rota

MERGEN_ROTA_AUTH_MODE=keycloak
MERGEN_ROTA_KEYCLOAK_FLOW=implicit-bridge
MERGEN_ROTA_KEYCLOAK_CLIENT_ID=<CLIENT_ID>
MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET=
MERGEN_ROTA_KEYCLOAK_IMPLICIT_REDIRECT_URI=https://<MERGEN_HOST>/rota/auth/implicit-callback
MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI=https://<MERGEN_HOST>/rota/
MERGEN_ROTA_SESSION_COOKIE_SECURE=true
```

The implicit callback URI must be permitted by the existing Keycloak client exactly as written.

`NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH` is embedded into the browser bundle, so changing it requires a rebuild:

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
