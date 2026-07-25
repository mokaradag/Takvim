'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from './icons';

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
  compact = false
}) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = useMemo(
    () => options.find((option) => String(option.value) === String(value)) || null,
    [options, value]
  );
  const filtered = useMemo(() => {
    const needle = normalized(query.trim());
    return options.filter((option) => matches(option, needle));
  }, [options, query]);
  const visible = filtered.slice(0, maxVisible);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const select = (option) => {
    onChange?.(option.value, option);
    setOpen(false);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
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
    if (event.key === 'Enter' && visible[activeIndex]) {
      event.preventDefault();
      select(visible[activeIndex]);
    }
  };

  return (
    <div ref={rootRef} className={`searchable-select ${className}`.trim()} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        className="input"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel || placeholder}
        style={{
          width: '100%',
          minHeight: compact ? 34 : 38,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer'
        }}
      >
        {selected?.icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{selected.icon}</span>}
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text)' : 'var(--text-dim)' }}>
          {selected?.label || placeholder}
        </span>
        <Icons.ChevronDown size={13} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }} />
      </button>

      {open && (
        <div
          role="listbox"
          onKeyDown={onKeyDown}
          style={{
            position: 'absolute',
            zIndex: 'var(--z-popover, 120)',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            minWidth: 280,
            maxWidth: 'min(620px, calc(100vw - 32px))',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            background: 'var(--bg-elev)',
            boxShadow: '0 18px 45px color-mix(in oklab, black 30%, transparent)',
            overflow: 'hidden'
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderBottom: '1px solid var(--border)' }}>
            <Icons.Search size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              style={{ width: '100%', border: 0, outline: 0, background: 'transparent', color: 'var(--text)', font: 'inherit' }}
            />
            {query && (
              <button type="button" className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setQuery('')} aria-label="Aramayı temizle">
                <Icons.Close size={11} />
              </button>
            )}
          </label>

          <div style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}>
            {visible.map((option, index) => {
              const selectedOption = String(option.value) === String(value);
              return (
                <button
                  key={`${option.value}:${index}`}
                  type="button"
                  role="option"
                  aria-selected={selectedOption}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '8px 9px',
                    border: 0,
                    borderRadius: 'var(--r-sm)',
                    background: activeIndex === index || selectedOption ? 'var(--bg-hover)' : 'transparent',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  {option.icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{option.icon}</span>}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: selectedOption ? 700 : 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                    {(option.description || option.group) && (
                      <span className="muted" style={{ display: 'block', marginTop: 2, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[option.group, option.description].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  {selectedOption && <Icons.Check size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                </button>
              );
            })}
            {!visible.length && <div className="muted" style={{ padding: 18, textAlign: 'center', fontSize: 12 }}>{emptyText}</div>}
          </div>

          {filtered.length > maxVisible && (
            <div className="muted" style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 10.5 }}>
              İlk {maxVisible} sonuç gösteriliyor. Arama yazarak listeyi daraltın.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
