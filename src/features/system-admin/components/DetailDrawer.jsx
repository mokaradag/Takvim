'use client';
import { useRef } from 'react';
import { Icons } from '../../../components/icons';
import { useModalFocusTrap } from '../../../hooks/useModalFocusTrap.js';

/**
 * Ayrıntı çekmecesi.
 *
 * Ayrıntı bilgisi kip penceresi (modal) yerine çekmecede gösterilir: yönetici
 * listeyi kaybetmeden kaydı inceleyebilir. Odak tuzağı ve `Esc` davranışı
 * uygulamanın ortak kancasından gelir.
 */
export function DetailDrawer({ title, subtitle = null, onClose, children, footer = null }) {
  const containerRef = useRef(null);
  const closeRef = useRef(null);
  useModalFocusTrap({ containerRef, initialFocusRef: closeRef, onClose });

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer sysadmin-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={containerRef}
      >
        <header className="drawer-head">
          <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <h2 className="sysadmin-drawer-title">{title}</h2>
            {subtitle && <p className="sysadmin-drawer-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="btn ghost sm" onClick={onClose} ref={closeRef} aria-label="Ayrıntı panelini kapat">
            <Icons.Close size={14} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

/** Çekmecedeki güvenli teknik künye satırı. */
export function DrawerField({ label, value, mono = false }) {
  if (value == null || value === '') return null;
  return (
    <div className="sysadmin-drawer-field">
      <span>{label}</span>
      <strong className={mono ? 'tabular' : ''}>{value}</strong>
    </div>
  );
}
