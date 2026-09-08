'use client';
import { useEffect, useId, useRef } from 'react';

const activeTraps = [];

const FOCUSABLE_SELECTOR = [
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
 */
export function useModalFocusTrap({ containerRef, initialFocusRef, restoreFocusRef = null, onClose, blocked = false, enabled = true }) {
  const scopeId = useId();
  const openerRef = useRef(null);
  const closeRef = useRef(onClose);
  const blockedRef = useRef(blocked);

  useEffect(() => {
    closeRef.current = onClose;
    blockedRef.current = blocked;
  }, [onClose, blocked]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    openerRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    const restoreFocus = restoreFocusRef?.current;
    initialFocusRef.current?.focus();
    return () => {
      const opener = openerRef.current?.isConnected ? openerRef.current : restoreFocus;
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    };
  }, [initialFocusRef, restoreFocusRef, enabled]);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    const owner = containerRef.current;
    owner?.setAttribute('data-focus-scope', scopeId);
    const token = {};
    activeTraps.push(token);
    const handleKeyDown = (event) => {
      if (activeTraps[activeTraps.length - 1] !== token || event.defaultPrevented) return;
      if (event.key === 'Escape') {
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
      const container = portal?.getAttribute('data-modal-owner') === scopeId ? portal : modal;
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
  }, [containerRef, enabled, scopeId]);
}
