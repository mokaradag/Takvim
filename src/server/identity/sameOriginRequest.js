import 'server-only';

/**
 * İSTEĞİN aynı kaynaktan geldiğini doğrular (CSRF savunması).
 *
 * Oturum çerezi `SameSite=Lax`'tır: aynı sitedeki kardeş bir kaynağın ya da
 * üçüncü taraf bir sayfanın gönderdiği basit bir `<form method="POST">`
 * CORS ön denetimi olmadan çerezi taşıyabilir. Tarayıcı `POST` isteklerinde
 * `Origin` başlığını her zaman gönderir; başlık varsa isteğin kendi kaynağıyla
 * eşleşmelidir. `Sec-Fetch-Site` varsa yalnızca `same-origin` ya da `none`
 * kabul edilir. İki başlık da yoksa istek tarayıcıdan gelmiyordur (betik,
 * test, sunucudan sunucuya) ve CSRF vektörü oluşmaz.
 *
 * Kaynak ŞEMA + ana bilgisayar olarak karşılaştırılır. İsteğin istemciye
 * dönük şeması `X-Forwarded-Proto` (yoksa isteğin kendi adresi) ile bilinir:
 * `https` hedefe `http` kaynağından gelen istek aynı kaynak değildir. TLS'i
 * sonlandıran ve bu başlığı iletmeyen bir vekilin arkasında uygulama isteği
 * `http` olarak görür; bu durumda tarayıcının `https` kaynağı kabul edilir
 * (yalnızca şema düşürme reddedilir). Vekil zincirinde virgülle eklenen
 * başlıkların yalnızca ilk (istemciye dönük) değeri kullanılır.
 */

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

function firstValue(value) {
  return String(value ?? '').split(',')[0].trim();
}

function parseOrigin(value) {
  try {
    const url = new URL(String(value));
    return WEB_PROTOCOLS.has(url.protocol) ? { protocol: url.protocol, host: url.host.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/** Ana bilgisayar değeri, kaynağın şemasına göre (varsayılan kapı atılarak) kanonikleştirilir. */
function canonicalHost(protocol, value) {
  try {
    return new URL(`${protocol}//${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isSameOriginRequest(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const origin = request.headers.get('origin');
  if (!origin) return true;
  const claimed = parseOrigin(origin);
  if (!claimed) return false;

  const target = parseOrigin(request.url);
  const forwardedProto = firstValue(request.headers.get('x-forwarded-proto')).toLowerCase();
  const targetProtocol = forwardedProto ? `${forwardedProto}:` : target?.protocol;
  if (!WEB_PROTOCOLS.has(targetProtocol)) return false;
  if (targetProtocol === 'https:' && claimed.protocol !== 'https:') return false;

  const expected = new Set([
    firstValue(request.headers.get('x-forwarded-host')),
    firstValue(request.headers.get('host')),
    target?.host
  ].filter(Boolean).map((value) => canonicalHost(claimed.protocol, value)).filter(Boolean));
  return expected.has(claimed.host);
}
