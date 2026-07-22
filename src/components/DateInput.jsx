'use client';
import { useEffect, useRef, useState } from 'react';
import { fmtDisplayDate } from '../scheduling/dates';
import { Icons } from './icons';

export function parseDisplayDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDraft(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export function DateInput({
  value,
  onChange,
  allowEmpty = true,
  className = 'input',
  style,
  disabled = false,
  autoFocus = false,
  placeholder = 'gg/aa/yyyy',
  ariaLabel,
  title
}) {
  const pickerRef = useRef(null);
  const [draft, setDraft] = useState(() => fmtDisplayDate(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(fmtDisplayDate(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    if (!draft.trim()) {
      if (allowEmpty) {
        setInvalid(false);
        onChange?.('');
      } else {
        setDraft(fmtDisplayDate(value));
      }
      return;
    }

    const iso = parseDisplayDate(draft);
    if (!iso) {
      setInvalid(true);
      return;
    }

    setInvalid(false);
    setDraft(fmtDisplayDate(iso));
    onChange?.(iso);
  };

  const openPicker = () => {
    if (disabled || !pickerRef.current) return;
    try {
      if (typeof pickerRef.current.showPicker === 'function') pickerRef.current.showPicker();
      else pickerRef.current.click();
    } catch {
      pickerRef.current.click();
    }
  };

  return (
    <div className={`date-input-shell${invalid ? ' invalid' : ''}`} style={style}>
      <input
        type="text"
        inputMode="numeric"
        className={className}
        value={draft}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        title={invalid ? 'Tarihi gg/aa/yyyy biçiminde girin.' : title}
        onChange={(event) => {
          setInvalid(false);
          setDraft(formatDraft(event.target.value));
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
      />
      <button type="button" className="date-input-button" onMouseDown={(event) => event.preventDefault()} onClick={openPicker} disabled={disabled} aria-label="Takvimden tarih seç">
        <Icons.Calendar size={13} />
      </button>
      <input
        ref={pickerRef}
        type="date"
        className="date-input-native"
        value={value || ''}
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setInvalid(false);
          setDraft(fmtDisplayDate(next));
          onChange?.(next);
        }}
      />
    </div>
  );
}
