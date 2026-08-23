import { implicitCallbackResponse } from '../../../server/identity/implicitCallbackPage.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Kimlik akışı hiçbir katmanda önbelleklenmez.
export const fetchCache = 'force-no-store';

/**
 * Implicit köprünün tarayıcı geri dönüş adresi.
 *
 * Bilinçli olarak hidratlanan bir uygulama sayfası DEĞİL, küçük bir route
 * handler yanıtıdır: URL parçası tam uygulama paketi beklenmeden işlenip
 * silinmelidir. Yanıt her istekte yeni bir CSP nonce'u ile üretilir.
 *
 * Sunucu bu adreste hiçbir jeton görmez; jeton yalnızca tarayıcının kendi
 * belleğindedir ve tek bir POST isteğiyle köprü ucuna gönderilir.
 */
export async function GET() {
  return implicitCallbackResponse();
}
