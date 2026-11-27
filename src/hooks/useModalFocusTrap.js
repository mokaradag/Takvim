'use client';
import { useEffect, useId, useRef } from 'react';

const activeTraps = [];

/**
 * Açık odak tuzaklarının (kipli pencerelerin) yalnızca SAYISI. Kendi Esc
 * dinleyicisini kuran tuzaksız bir yüzey (açılır kart, tarih atlama paneli)
 * açılırken bu sayıyı kaydeder; sayı sonradan arttıysa (ör. Ctrl/Cmd+K ile
 * açılan komut paleti) Esc'i artık açık tuzaklardan biri işler ve yüzey olayı
 * tüketmez. Hangi tuzağın işleyeceği sayıdan çıkarılmaz: klavye sahibi her zaman
 * görsel olarak en üstte boyanan tuzaktır (`keyboardOwner`).
 */
export function modalTrapDepth() {
  return activeTraps.length;
}

/**
 * Komut paletini engelleyen ya da kayıt yapan bir yüzey açık mı? Engel, görsel
 * katmandan (`priority`) AYRI bir sözleşmedir: kipli Bilgin paneli çekmece
 * katmanında çizilse de kısayolu engeller; aksi hâlde paletten açılan görev
 * çekmecesi tam ekran panelin arkasında kalırdı.
 */
export function hasBlockingModal() {
  return activeTraps.some((token) => token.blocksCommandPalette || token.blockedRef.current);
}

/**
 * `upper` yüzeyi `lower` yüzeyinin üstünde mi boyanır? Tarayıcının kök yığılma
 * bağlamındaki kuralı izlenir: önce katman (`priority`, yüzeyin `z-index`
 * katmanı), eşit katmanda DOM'da SONRA gelen kardeş. Böylece gövdeye taşınan
 * Bilgin sayfası, aynı katmandaki uygulama içi çekmecelerin üstünde boyandığı
 * gibi klavyenin de sahibidir. Ön koşul: eşit öncelikli yüzeyler aynı (kök)
 * yığılma bağlamındadır; kabuk ataları bağlam kurmaz ve tuzak yüzeyleri ya
 * uygulama ağacında ya da gövde portalındadır. Ancak o zaman DOM sırası boyama
 * sırasıdır (`test/notification-modal-layering.test.mjs` bu ön koşulu ve
 * önceliklerin CSS katmanlarına eşitliğini denetler). Kaplardan biri bağlı bir
 * DOM düğümü değilse sıra bilinemez (`undefined`); çağıran açılış sırasına düşer.
 */
function paintsAbove(upper, lower) {
  if (upper.priority !== lower.priority) return upper.priority > lower.priority;
  const upperElement = upper.containerRef.current;
  const lowerElement = lower.containerRef.current;
  if (!upperElement?.isConnected || !lowerElement?.isConnected || upperElement === lowerElement
    || typeof lowerElement.compareDocumentPosition !== 'function') return undefined;
  return Boolean(lowerElement.compareDocumentPosition(upperElement) & lowerElement.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * Klavyenin (Tab/Esc) sahibi, görsel olarak en üstte boyanan tuzaktır. Alt
 * katmandaki bir yüzey (ör. dar ekrana geçişte çekmece katmanında kipli sayfaya
 * dönüşen Bilgin paneli) üstteki açık kipli pencereden SONRA etkinleşse bile
 * görünmeyen denetimlerine Tab/Esc ile ulaşılamaz. Sıra bilinemediğinde en son
 * açılan kazanır.
 */
function keyboardOwner() {
  let owner = null;
  for (const token of activeTraps) if (!owner || paintsAbove(token, owner) !== false) owner = token;
  return owner;
}

/**
 * Klavye, verilen kabın DIŞINDAKİ açık bir tuzağa mı ait? Ertelenmiş odak veren
 * yüzey (ör. hazırlığı sonradan gelen Bilgin yazma alanı) odağı ancak klavye
 * sahibi kendisiyken ya da hiç tuzak yokken verir; aksi hâlde görünür pencerenin
 * arkasına odak taşırdı. Kabı bilinmeyen yüzey hiçbir tuzağın sahibi sayılmaz.
 */
export function keyboardOwnedElsewhere(container) {
  const owner = keyboardOwner();
  return Boolean(owner) && (!container || owner.containerRef.current !== container);
}

function isDocumentRoot(element, focusDocument) {
  return element === focusDocument.body || element === focusDocument.documentElement;
}

/**
 * Adaya odak vermeyi DENER ve odağın gerçekten ona geçip geçmediğini döndürür.
 * Odaklanabilirlik tahmin edilmez: devre dışı, `inert` içinde ya da gizli
 * (`display: none`, `visibility: hidden`, `hidden`) bir ögede `focus()` etkisiz
 * kalır ve sıradaki yedeğe geçilir.
 */
function focusOpener(opener, focusDocument) {
  if (!opener?.isConnected || typeof opener.focus !== 'function' || isDocumentRoot(opener, focusDocument)) return false;
  opener.focus();
  return focusDocument.activeElement === opener;
}

/** Öge tuzağın penceresinde ya da ona `data-modal-owner` ile bağlı gövde portalında mı? */
function trapOwnsElement(token, element) {
  if (!element) return false;
  if (token.containerRef.current?.contains?.(element)) return true;
  return element.closest?.('[data-modal-owner]')?.getAttribute('data-modal-owner') === token.scopeId;
}

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/**
 * Tab tuşunda odağın NEREYE gideceğine karar verir.
 *
 * Karar mantığı DOM işleyicisinden ayrılmıştır: sarma davranışı (ilk ögede
 * Shift+Tab → son öge, son ögede Tab → ilk öge, dışarıdayken → ilk öge) böylece
 * bir tarayıcı ortamı olmadan sınanabilir. İşleyici yalnızca sonucu uygular.
 *
 * @returns {{target: 'first'|'last'|'container'|null, preventDefault: boolean}}
 */
export function resolveFocusTrapTarget({ focusableCount, activeIndex, containsActive, shiftKey }) {
  // Odaklanabilir öge yoksa odak kabın kendisine alınır; aksi hâlde Tab
  // kullanıcıyı modalın dışına çıkarırdı.
  if (!focusableCount) return { target: 'container', preventDefault: true };
  // Odak modalın DIŞINDA ya da listede OLMAYAN bir ögede (kabın kendisi,
  // `tabindex="-1"` taşıyan bir başlık) olabilir. İkinci durumda `containsActive`
  // doğru ama `activeIndex` `-1`'dir; yalnızca `containsActive` denetlenirse
  // Shift+Tab tarayıcının kendi sırasına düşer ve kullanıcı modaldan ÇIKAR.
  // Her iki durum da sınır sayılır ve yön korunur.
  if (!containsActive || activeIndex < 0) {
    return { target: shiftKey ? 'last' : 'first', preventDefault: true };
  }
  if (shiftKey && activeIndex === 0) return { target: 'last', preventDefault: true };
  if (!shiftKey && activeIndex === focusableCount - 1) return { target: 'first', preventDefault: true };
  // Sınırların arasında tarayıcının kendi sırası geçerlidir.
  return { target: null, preventDefault: false };
}

/**
 * Modal odağını içeride tutar, Esc davranışını yönetir ve odağı geri verir.
 *
 * `aria-modal="true"` odağı KISITLAMAZ: klavye kullanıcısı iletişim kutusundan
 * arkadaki uygulama kabuğuna sekme ile çıkabiliyordu. Bu kanca paylaşımlıdır ki
 * her modal aynı davranışı yeniden yazmak zorunda kalmasın.
 *
 * `priority` yüzeyin kök bağlamdaki `z-index` katmanının sayısal değeridir
 * (klavye sahipliği); varsayılanı kipli pencere katmanıdır (500). Başka katmanda
 * çizilen her yüzey kendi katmanını bildirmelidir: tuzak çağıranlarının
 * katmanları `test/notification-modal-layering.test.mjs` içinde CSS ile
 * karşılaştırılır. `blocksCommandPalette` katmandan ayrı kısayol engelidir;
 * varsayılan engel kipli pencere katmanıdır (≥ 500), farklı katmanda çizilip yine
 * de engellemesi gereken yüzey bunu açıkça bildirir.
 */
export function useModalFocusTrap({ containerRef, initialFocusRef, restoreFocusRef = null, restoreFocusEnabledRef = null, onClose, blocked = false, enabled = true, priority = 500, blocksCommandPalette = priority >= 500 }) {
  const scopeId = useId();
  const focusEpochRef = useRef(0);
  const closeRef = useRef(onClose);
  const blockedRef = useRef(blocked);

  useEffect(() => {
    closeRef.current = onClose;
    blockedRef.current = blocked;
  }, [onClose, blocked]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    const epoch = ++focusEpochRef.current;
    const focusDocument = document;
    const openedFrom = focusDocument.activeElement;
    const owner = containerRef.current;
    const restoreFocus = restoreFocusRef?.current;
    const shouldRestoreFocus = () => restoreFocusEnabledRef?.current !== false;
    // Üstünde boyanan açık bir pencere varken etkinleşen alt yüzey odağı ondan
    // çalmaz; odak, üstteki pencere kapanınca aşağıdaki geri verme adımıyla gelir.
    const self = { priority, containerRef };
    if (!activeTraps.some((token) => paintsAbove(token, self) === true)) initialFocusRef.current?.focus();
    const restore = () => {
      if (!shouldRestoreFocus() || focusEpochRef.current !== epoch) return;
      const focused = focusDocument.activeElement;
      const remaining = keyboardOwner();
      // Odak bilerek başka bir ögeye taşındıysa (ör. "Görevi aç" ile açılan
      // çekmece) geri çekilmez; ancak arkada açık bir tuzak varken onun DIŞINDA
      // kalan odak kabul edilmez ve aşağıdaki adaylarla tuzağa geri alınır.
      if (focused?.isConnected && !isDocumentRoot(focused, focusDocument) && focused !== openedFrom && !owner?.contains?.(focused)
        && (!remaining || trapOwnsElement(remaining, focused))) return;
      // Açan öge pencereyle AYNI çizimde sökülebilir (ör. bildirim kartı paneliyle
      // birlikte kapanır; odak o anda gövdeye düşer) ya da odak alamaz hâle
      // gelmiş olabilir. Adaylar sırayla denenir; odak gerçekten geçene dek
      // sıradaki yedeğe geçilir.
      const candidates = [openedFrom, restoreFocus, restoreFocusRef?.current];
      // Arkada hâlâ açık bir tuzak varsa odak onun DIŞINDA bırakılmaz (ör. zil
      // düğmesi açık Bilgin sayfasının ya da "Görevi aç" ile açılan görev
      // çekmecesinin arkasında kalırdı); yalnızca o yüzeye ait adaylar, ardından
      // klavye sahibi yüzeyin ilk odağı ve kabı denenir.
      const ordered = remaining
        ? [...candidates.filter((candidate) => trapOwnsElement(remaining, candidate)),
          remaining.initialFocusRef.current, remaining.containerRef.current]
        : candidates;
      ordered.some((candidate) => focusOpener(candidate, focusDocument));
    };
    return () => { (globalThis.requestAnimationFrame || setTimeout)(restore); };
  }, [containerRef, initialFocusRef, restoreFocusRef, restoreFocusEnabledRef, enabled, priority]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    const owner = containerRef.current;
    owner?.setAttribute('data-focus-scope', scopeId);
    const token = { priority, blocksCommandPalette, blockedRef, scopeId, containerRef, initialFocusRef };
    activeTraps.push(token);
    const handleKeyDown = (event) => {
      if (keyboardOwner() !== token || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (event.isComposing || event.keyCode === 229) return;
        if (!event.defaultPrevented && !blockedRef.current) {
          event.preventDefault();
          closeRef.current?.();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const modal = containerRef.current;
      if (!modal) return;
      const portal = document.activeElement?.closest?.('[data-modal-owner]');
      const ownedPortal = portal?.getAttribute('data-modal-owner') === scopeId ? portal : null;
      // Kanıt kartı kendi içinde dolaşır; sınırda odağı ana pencerenin sırasına geri bağlar.
      if (ownedPortal?.getAttribute('data-hover-list-focus') === '') return;
      const container = ownedPortal || modal;
      const focusable = [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      const active = document.activeElement;
      const decision = resolveFocusTrapTarget({
        focusableCount: focusable.length,
        activeIndex: focusable.indexOf(active),
        containsActive: container.contains(active),
        shiftKey: event.shiftKey
      });
      if (!decision.target) return;
      if (decision.preventDefault) event.preventDefault();
      if (decision.target === 'container') container.focus();
      else if (decision.target === 'first') focusable[0].focus();
      else focusable[focusable.length - 1].focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = activeTraps.indexOf(token);
      if (index >= 0) activeTraps.splice(index, 1);
      owner?.removeAttribute('data-focus-scope');
    };
  }, [containerRef, initialFocusRef, enabled, scopeId, priority, blocksCommandPalette]);
}
