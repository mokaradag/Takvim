/**
 * Rota AI panelinin saf etkileşim kuralları: yazma alanı tuşları, akışı
 * izleyen kaydırma, yerleşim kipi ve panoya kopyalama. Kurallar tarayıcı
 * olmadan sınanır; bileşenler yalnızca uygular.
 */

/**
 * Dar ekranda panel tam ekran bir sayfa (kipli iletişim kutusu) olur. Aynı
 * sorgu `assistant.css` içindeki `@media` kuralıyla ortaktır.
 */
export const ASSISTANT_SHEET_QUERY = '(max-width: 760px)';

/** Kullanıcı en alta bu kadar yakınsa yeni metin izlenir (piksel, ölçekli çerçevede). */
export const ASSISTANT_FOLLOW_THRESHOLD_PX = 48;

/**
 * Yazma alanında basılan tuşun anlamı: `send`, `blocked` (gönderim şu an
 * yapılamaz; satır da eklenmez) ya da `null` (tarayıcının kendi davranışı).
 *
 * Enter gönderir, Shift+Enter satır ekler. Giriş yöntemi (IME) birleştirmesi
 * sürerken Enter karakter seçimini onaylar; gönderim sayılmaz.
 */
export function composerKeyAction(event, { canSubmit = true } = {}) {
  if (event?.key !== 'Enter') return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey || event.altKey) return null;
  return canSubmit ? 'send' : 'blocked';
}

/** Kaydırma kabı en alta yakın mı? */
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = ASSISTANT_FOLLOW_THRESHOLD_PX) {
  if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) return true;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Akışın izlenip izlenmeyeceği. Kullanıcı yukarı kaydırdıysa her yeni parçada
 * en alta çekilmez; en alta döndüğünde izleme kendiliğinden sürer. Yeni ileti
 * gönderen ya da konuşma değiştiren kullanıcı her zaman en alta götürülür.
 */
export function followState({ following, reason, metrics = null }) {
  if (reason === 'send' || reason === 'open' || reason === 'jump') return true;
  if (reason === 'scroll' && metrics) return isNearBottom(metrics);
  return following;
}

/**
 * Metni panoya kopyalar. Güvenli bağlamda (HTTPS) Clipboard API; kurumsal ağda
 * düz HTTP üzerinden açılan uygulamada bu API yoktur, gizli bir metin alanı ve
 * `copy` komutu kullanılır. Başarıyı döndürür; hiçbir hata fırlatmaz.
 */
export async function copyTextToClipboard(text, {
  clipboard = globalThis.navigator?.clipboard,
  document: doc = globalThis.document
} = {}) {
  const value = String(text ?? '');
  if (!value) return false;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Güvenli olmayan bağlam ya da izin reddi: eski yönteme düşülür.
    }
  }
  if (!doc?.body || typeof doc.createElement !== 'function') return false;
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  const previous = doc.activeElement;
  doc.body.appendChild(area);
  try {
    area.select();
    return Boolean(doc.execCommand?.('copy'));
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.({ preventScroll: true });
  }
}
