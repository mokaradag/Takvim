'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './icons';
import { appZoom } from '../lib/zoom';
import { computePopoverPlacement } from './searchableSelectPlacement.js';

function normalized(value) {
  return String(value || '').toLocaleLowerCase('tr-TR');
}

function matches(option, query) {
  if (!query) return true;
  return normalized([
    option.label,
    option.description,
    option.group,
    ...(option.keywords || [])
  ].filter(Boolean).join(' ')).includes(query);
}

export function SearchableSelect({
  value = '',
  options = [],
  onChange,
  placeholder = 'Seçim yapın',
  searchPlaceholder = 'Ara...',
  emptyText = 'Eşleşen kayıt bulunamadı.',
  disabled = false,
  maxVisible = 80,
  className = '',
  style,
  ariaLabel,
  compact = false,
  allowClear = false,
  clearLabel = 'Seçimi temizle',
  clearValue = ''
}) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState(null);

  const selected = useMemo(
    () => options.find((option) => String(option.value) === String(value)) || null,
    [options, value]
  );
  const filtered = useMemo(() => {
    const needle = normalized(query.trim());
    return options.filter((option) => matches(option, needle));
  }, [options, query]);
  const visible = useMemo(() => filtered.slice(0, maxVisible), [filtered, maxVisible]);
  const hasSelection = Boolean(selected) && String(value) !== String(clearValue);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    // Yazı boyutu ölçeği gövdeye `zoom` uygular; `position: fixed` çocukların
    // koordinat çerçevesi de bu oranda büyür. Ölçülen (fiziksel) dikdörtgen ve
    // görünüm alanı ölçeğe bölünmezse panel, yazı büyütüldükçe tetikleyiciden
    // kayar ve ekranın dışına taşardı.
    const scale = appZoom();
    const rect = trigger.getBoundingClientRect();
    setPlacement(computePopoverPlacement(
      {
        top: rect.top / scale,
        bottom: rect.bottom / scale,
        left: rect.left / scale,
        width: rect.width / scale
      },
      { width: window.innerWidth / scale, height: window.innerHeight / scale }
    ));
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    const onViewportChange = () => measure();
    // Kaydırma yakalama aşamasında dinlenir; panel her zaman tetikleyiciye yapışık kalır.
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      if (panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const focus = () => inputRef.current?.focus();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
    else focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    // Klavye ile gezinirken etkin satır her zaman görünür alanda tutulur.
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const select = (option) => {
    onChange?.(option.value, option);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const clearSelection = () => {
    onChange?.(clearValue, null);
    setOpen(false);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(visible.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(visible.length - 1, 0));
      return;
    }
    if (event.key === 'Enter' && visible[activeIndex]) {
      event.preventDefault();
      select(visible[activeIndex]);
    }
  };

  const onTriggerKeyDown = (event) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const panel = open && placement && typeof document !== 'undefined' ? createPortal(
    <div
      ref={panelRef}
      data-modal-owner={rootRef.current?.closest('[data-focus-scope]')?.getAttribute('data-focus-scope')}
      className="searchable-select-panel"
      role="listbox"
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: placement.left,
        width: placement.width,
        // Panelin tamamı görünüm alanına sığar; taşan içerik liste içinde kayar.
        maxHeight: placement.panelMaxHeight,
        // Panel çerçevesi (arama satırı, dipnot) bile sığmıyorsa panelin KENDİSİ
        // kaydırılır; aksi hâlde sabit satırlar payı tüketip seçenekleri
        // `overflow: hidden` altında erişilemez bırakırdı.
        ...(placement.scrollPanel ? { overflowY: 'auto' } : null),
        ...(placement.openUp ? { bottom: placement.bottom } : { top: placement.top })
      }}
    >
      <label className="searchable-select-search">
        <Icons.Search size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
        {/* `onKeyDown` YALNIZCA panel kapsayıcısında durur. Arama kutusu React
            ağacında panelin torunudur ve React olayları portal sınırını aşarak
            ağaç boyunca kabarır; işleyici iki yerde birden bağlıyken her tuş
            vuruşu onu iki kez çalıştırıyordu: ArrowDown/ArrowUp `activeIndex`
            değerini ikişer ikişer oynatıyor (seçeneklerin yarısına klavyeyle
            hiç ulaşılamıyor), Enter ise `onChange` olayını aynı seçenek için
            iki kez tetikliyordu. Panel açılınca odak zaten bu kutuya geçtiği
            için bu, kenar durum değil OLAĞAN klavye yoluydu. */}
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        {query && (
          <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setQuery('')} aria-label="Aramayı temizle">
            <Icons.Close size={11} />
          </button>
        )}
      </label>

      {allowClear && hasSelection && (
        <button type="button" className="searchable-select-clear" onClick={clearSelection}>
          <Icons.Close size={12} /> {clearLabel}
        </button>
      )}

      <div
        ref={listRef}
        className="searchable-select-list"
        // `listMaxHeight` sayı değilse (panel kaydırma yolu) sınır uygulanmaz.
        style={Number.isFinite(placement.listMaxHeight) ? { maxHeight: placement.listMaxHeight } : undefined}
      >
        {visible.map((option, index) => {
          const selectedOption = String(option.value) === String(value);
          return (
            <button
              key={`${option.value}:${index}`}
              type="button"
              role="option"
              data-active={activeIndex === index ? 'true' : 'false'}
              aria-selected={selectedOption}
              className={`searchable-select-option${activeIndex === index ? ' is-active' : ''}${selectedOption ? ' is-selected' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(option)}
            >
              {option.icon && <span className="searchable-select-option-icon">{option.icon}</span>}
              <span className="searchable-select-option-copy">
                <span className="searchable-select-option-label">{option.label}</span>
                {(option.description || option.group) && (
                  <span className="muted searchable-select-option-meta">
                    {[option.group, option.description].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              {selectedOption && <Icons.Check size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
            </button>
          );
        })}
        {!visible.length && <div className="muted searchable-select-empty">{emptyText}</div>}
      </div>

      {filtered.length > maxVisible && (
        <div className="muted searchable-select-foot">
          {filtered.length} sonuçtan ilk {maxVisible} tanesi gösteriliyor. Arama yazarak listeyi daraltın.
        </div>
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div ref={rootRef} className={`searchable-select ${className}`.trim()} style={{ position: 'relative', ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="input searchable-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel || placeholder}
        style={{ minHeight: compact ? 34 : 38, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        {selected?.icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{selected.icon}</span>}
        <span className="searchable-select-value" style={{ color: selected ? 'var(--text)' : 'var(--text-dim)' }}>
          {selected?.label || placeholder}
        </span>
        <Icons.ChevronDown size={13} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
      </button>
      {panel}
    </div>
  );
}
