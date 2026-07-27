import { randomBytes } from 'node:crypto';
import { IMPLICIT_SESSION_ENDPOINT, LOGIN_ENDPOINT } from './keycloakFlows.js';

/**
 * Implicit köprünün tarayıcı tarafı geri dönüş sayfası.
 *
 * Bu sayfa BİLİNÇLİ olarak sıradan bir uygulama sayfası değildir: URL parçası
 * (fragment) tam uygulama paketi yüklenmeden, ilk satırda işlenip SİLİNMELİDİR.
 * Bu yüzden route handler tek bir küçük HTML gövdesi döndürür.
 *
 * Jetonun yaşam alanı üçtür ve üçü de geçicidir:
 *   1. Keycloak'ın döndürdüğü URL parçası (hemen silinir),
 *   2. bu betiğin yerel değişkeni,
 *   3. köprü ucuna yapılan TEK kimlikli POST isteği.
 *
 * Jeton `localStorage`, `sessionStorage`, `IndexedDB`, çerez, sorgu dizesi veya
 * uygulama durumunda SAKLANMAZ ve hiçbir günlük çağrısına verilmez.
 */

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** `</script>` kaçışı ve satır ayırıcıları dâhil güvenli JavaScript dizgesi. */
export function escapeJsString(value) {
  return JSON.stringify(String(value ?? ''))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Yanıt başına kriptografik rastgele nonce (satır içi script + stil için). */
export function createCspNonce() {
  return randomBytes(18).toString('base64url');
}

export function contentSecurityPolicy(nonce) {
  const safeNonce = escapeHtml(nonce);
  return [
    "default-src 'none'",
    `script-src 'nonce-${safeNonce}'`,
    `style-src 'nonce-${safeNonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ].join('; ');
}

export function implicitCallbackHeaders(nonce) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': contentSecurityPolicy(nonce)
  };
}

const STYLES = `
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #12151c;
    color: #e6e9f0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .kutu {
    max-width: 32rem;
    padding: 2rem;
    text-align: center;
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { margin: 0.5rem 0; line-height: 1.5; }
  .ipucu { color: #9aa3b5; font-size: 0.875rem; }
  .hata-basligi { color: #ff9d8a; font-weight: 600; }
  a { color: #7db2ff; }
  [hidden] { display: none; }
`.trim();

/**
 * Sayfa betiği. Sıra bilinçlidir: parça ÖNCE okunur, HEMEN silinir, ancak ondan
 * SONRA ağ isteği yapılır. Böylece jeton adres çubuğunda, geçmişte, `Referer`
 * başlığında veya yer imlerinde kalmaz.
 */
function callbackScript({ sessionEndpoint }) {
  return `
(function () {
  'use strict';

  var SESSION_ENDPOINT = ${escapeJsString(sessionEndpoint)};

  function node(id) {
    return document.getElementById(id);
  }

  function showFailure(message) {
    var loading = node('rota-yukleniyor');
    var failure = node('rota-hata');
    var text = node('rota-hata-metni');
    if (loading) loading.hidden = true;
    if (failure) failure.hidden = false;
    if (text) text.textContent = message;
  }

  function safeReturnTo(value) {
    if (typeof value !== 'string') return '/';
    if (value.charAt(0) !== '/' || value.charAt(1) === '/') return '/';
    if (value.indexOf('\\\\') >= 0) return '/';
    return value;
  }

  var hash = window.location.hash || '';
  var fragment = new URLSearchParams(hash.charAt(0) === '#' ? hash.slice(1) : hash);
  var accessToken = fragment.get('access_token') || '';
  var state = fragment.get('state') || '';
  var providerError = fragment.get('error') || '';
  var providerErrorDescription = fragment.get('error_description') || '';

  // Parça DERHÂL silinir: ağ isteğinden, günlükten ve geçmişten önce.
  try {
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
  } catch (ignored) {
    // Geçmiş yazılamıyorsa da jeton yalnızca bellekte kalır.
  }
  fragment = null;
  hash = '';

  if (providerError) {
    var detail = String(providerErrorDescription).slice(0, 200);
    showFailure('Kimlik sağlayıcısı oturum açma isteğini reddetti.' + (detail ? ' (' + detail + ')' : ''));
    return;
  }
  if (!accessToken) {
    showFailure('Kimlik sağlayıcısından erişim jetonu alınamadı.');
    return;
  }
  if (!state) {
    showFailure('Oturum açma isteği doğrulanamadı: durum değeri alınamadı.');
    return;
  }

  fetch(SESSION_ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ state: state })
  }).then(function (response) {
    // Jeton gönderildi; yerel kopya hemen bırakılır.
    accessToken = '';
    state = '';
    if (!response.ok) {
      showFailure('Kurumsal oturum doğrulanamadı. Lütfen yeniden oturum açın.');
      return null;
    }
    return response.json();
  }).then(function (payload) {
    if (!payload) return;
    if (payload.authenticated !== true) {
      showFailure('Kurumsal oturum doğrulanamadı. Lütfen yeniden oturum açın.');
      return;
    }
    window.location.replace(safeReturnTo(payload.returnTo));
  }).catch(function () {
    accessToken = '';
    state = '';
    showFailure('Kurumsal oturum sunucusuna ulaşılamadı. Lütfen yeniden deneyin.');
  });
})();
`.trim();
}

export function renderImplicitCallbackPage({
  nonce = createCspNonce(),
  sessionEndpoint = IMPLICIT_SESSION_ENDPOINT,
  loginPath = LOGIN_ENDPOINT
} = {}) {
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>MERGEN Rota — Kurumsal oturum</title>
<style nonce="${safeNonce}">
${STYLES}
</style>
</head>
<body>
<main class="kutu">
<h1>MERGEN Rota</h1>
<p id="rota-yukleniyor">Kurumsal oturumunuz doğrulanıyor, lütfen bekleyin…</p>
<div id="rota-hata" hidden>
<p class="hata-basligi">Kurumsal oturum açılamadı.</p>
<p id="rota-hata-metni"></p>
<p><a id="rota-yeniden" href="${escapeHtml(loginPath)}">Yeniden oturum aç</a></p>
</div>
<p class="ipucu">Bu sayfa yalnızca oturum açma sırasında görünür.</p>
</main>
<script nonce="${safeNonce}">
${callbackScript({ sessionEndpoint })}
</script>
</body>
</html>
`;
}

export function implicitCallbackResponse(options = {}) {
  const nonce = options.nonce || createCspNonce();
  return new Response(renderImplicitCallbackPage({ ...options, nonce }), {
    status: 200,
    headers: implicitCallbackHeaders(nonce)
  });
}
