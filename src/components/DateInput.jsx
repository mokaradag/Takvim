'use client';
import { useEffect, useRef, useState } from 'react';
import { getAppDateDisplayFormat } from '../scheduling/dates';
import { dateInputHint, formatEditableDate, maskDateDraft, parseDisplayDate } from './dateInputFormat.js';
import { Icons } from './icons';

/**
 * Tarih kutusu — uygulama genelindeki BİÇİM TERCİHİNE uyar.
 *
 * Biçimlendirme, okuma ve maskeleme kuralları `dateInputFormat.js` içindedir;
 * bu bileşen yalnızca taslak durumunu, doğrulamayı ve takvim düğmesini taşır.
 * Ayar "her ekrandaki tarih" derken düzenlenebilir alanlar `gg/aa/yyyy`
 * biçiminde donup kalıyordu.
 */
export function DateInput({
  value,
  onChange,
  allowEmpty = true,
  className = 'input',
  style,
  disabled = false,
  autoFocus = false,
  placeholder,
  ariaLabel,
  title
}) {
  const dateFormat = getAppDateDisplayFormat();
  const pickerRef = useRef(null);
  const [draft, setDraft] = useState(() => formatEditableDate(value));
  const [invalid, setInvalid] = useState(false);
  const hint = dateInputHint(dateFormat);

  // Biçim tercihi de bağımlılıktır: değer aynı kalırken tercih değiştiğinde
  // taslak eski biçimde donup kalıyordu.
  useEffect(() => {
    setDraft(formatEditableDate(value));
    setInvalid(false);
  }, [value, dateFormat]);

  const commit = () => {
    if (!draft.trim()) {
      setInvalid(false);
      if (!allowEmpty) setDraft(formatEditableDate(value));
      else onChange?.('');
      return;
    }

    const iso = parseDisplayDate(draft);
    if (!iso) {
      setInvalid(true);
      return;
    }

    setInvalid(false);
    setDraft(formatEditableDate(iso));
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
        inputMode={dateFormat === 'dd/mm/yyyy' ? 'numeric' : 'text'}
        className={className}
        value={draft}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder || hint}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        title={invalid ? `Tarihi ${hint} biçiminde girin.` : title}
        onChange={(event) => {
          setInvalid(false);
          setDraft(maskDateDraft(event.target.value));
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
          setDraft(formatEditableDate(next));
          onChange?.(next);
        }}
      />
    </div>
  );
}

export { formatEditableDate, parseDisplayDate };
