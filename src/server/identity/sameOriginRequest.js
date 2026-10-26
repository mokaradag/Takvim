import 'server-only';
import { ServerPersistenceError } from '../errors.js';

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
 * Kaynak ŞEMA + ana bilgisayar olarak karşılaştırılır. Vekil
 * `X-Forwarded-Proto` ile istemciye dönük şemayı AÇIKÇA bildiriyorsa şema
 * bire bir eşleşmelidir (`http` bildirilen hedefe `https` kaynağı da aynı
 * kaynak değildir). Başlık yoksa şema isteğin kendi adresinden bilinir:
 * `https` hedefe `http` kaynağından gelen istek reddedilir; TLS'i sonlandıran
 * ve başlığı iletmeyen bir vekilin arkasında uygulama isteği `http` olarak
 * gördüğü için yalnızca bu durumda tarayıcının `https` kaynağı da kabul
 * edilir. Vekil zincirinde virgülle eklenen başlıkların yalnızca ilk
 * (istemciye dönük) değeri kullanılır.
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
  if (forwardedProto) {
    if (claimed.protocol !== `${forwardedProto}:`) return false;
  } else {
    if (!WEB_PROTOCOLS.has(target?.protocol)) return false;
    if (target.protocol === 'https:' && claimed.protocol !== 'https:') return false;
  }

  const expected = new Set([
    firstValue(request.headers.get('x-forwarded-host')),
    firstValue(request.headers.get('host')),
    target?.host
  ].filter(Boolean).map((value) => canonicalHost(claimed.protocol, value)).filter(Boolean));
  return expected.has(claimed.host);
}

/** Ortam türünün özü (`tür/alt tür`); parametreler ve büyük/küçük harf yok sayılır. */
function mediaTypeEssence(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase();
}

/**
 * Oturum çereziyle kimliği doğrulanan DURUM DEĞİŞTİREN isteğin kullanıcı
 * niyetini rota sınırında, her yan etkiden ÖNCE kanıtlar.
 *
 * İstek aynı kaynaktan gelmelidir (`isSameOriginRequest`). JSON gövdeli uçlar
 * ayrıca `application/json` ister: `text/plain` gövdeli basit bir POST CORS ön
 * denetimi olmadan gönderilebiliyor ve gövde sonradan JSON olarak
 * ayrıştırılıyordu. Zamanlayıcı anahtarı gibi çerez dışı kimlikler bu
 * denetimin konusu değildir.
 */
export function assertBrowserMutationIntent(request, { json = false } = {}) {
  if (!isSameOriginRequest(request)) {
    throw new ServerPersistenceError('FORBIDDEN', 'İstek aynı kaynaktan gelmelidir.');
  }
  if (json && mediaTypeEssence(request.headers.get('content-type')) !== 'application/json') {
    throw new ServerPersistenceError('MUTATION_FAILED', 'İstek gövdesi application/json olmalıdır.', { status: 415 });
  }
}
