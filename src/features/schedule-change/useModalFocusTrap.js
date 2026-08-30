'use client';
import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/** Modal odağını içeride tutar, Esc davranışını yönetir ve odağı geri verir. */
export function useModalFocusTrap({ containerRef, initialFocusRef, restoreFocusRef = null, onClose, blocked = false }) {
  const openerRef = useRef(null);
  const closeRef = useRef(onClose);
  const blockedRef = useRef(blocked);

  useEffect(() => {
    closeRef.current = onClose;
    blockedRef.current = blocked;
  }, [onClose, blocked]);

  useEffect(() => {
    openerRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    const restoreFocus = restoreFocusRef?.current;
    initialFocusRef.current?.focus();
    return () => {
      const opener = openerRef.current?.isConnected ? openerRef.current : restoreFocus;
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    };
  }, [initialFocusRef, restoreFocusRef]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (!event.defaultPrevented && !blockedRef.current) closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusable = [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (!focusable.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!container.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [containerRef]);
}
