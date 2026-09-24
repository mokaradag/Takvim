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
 */

function hostOf(value) {
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return null;
  }
}

export function isSameOriginRequest(request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const origin = request.headers.get('origin');
  if (!origin) return true;
  const originHost = hostOf(origin);
  if (!originHost) return false;

  const expected = new Set([
    request.headers.get('x-forwarded-host'),
    request.headers.get('host'),
    hostOf(request.url)
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  return expected.has(originHost);
}
