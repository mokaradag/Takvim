'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getAppDateDisplayFormat } from '../scheduling/dates';
import { appZoom } from '../lib/zoom';
import { dateInputHint, formatEditableDate, maskDateDraft, parseDisplayDate } from './dateInputFormat.js';
import {
  TURKISH_CALENDAR_WEEKDAYS,
  buildCalendarMonth,
  calendarMonthHasSelectableDate,
  calendarMonthLabel,
  dateLimitMessage,
  isDateWithinLimits,
  resolveCalendarMonth,
  shiftCalendarMonth,
  todayIso
} from './datePickerCalendar.js';
import { Icons } from './icons';
import { computePopoverPlacement } from './searchableSelectPlacement.js';

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
  title,
  minDate = '',
  maxDate = ''
}) {
  const dateFormat = getAppDateDisplayFormat();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const [draft, setDraft] = useState(() => formatEditableDate(value));
  const [validationMessage, setValidationMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(null);
  const [month, setMonth] = useState(() => resolveCalendarMonth(value, { minDate, maxDate }));
  const hint = dateInputHint(dateFormat);
  const calendarDays = useMemo(() => buildCalendarMonth(month), [month]);
  const previousMonth = shiftCalendarMonth(month, -1);
  const nextMonth = shiftCalendarMonth(month, 1);
  const currentDay = todayIso();

  // Biçim tercihi de bağımlılıktır: değer aynı kalırken tercih değiştiğinde
  // taslak eski biçimde donup kalıyordu.
  useEffect(() => {
    setDraft(formatEditableDate(value));
    setValidationMessage('');
  }, [value, dateFormat]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Odak panel açıldığında YAZILIMLA içeri taşınır.
  //
  // `tabIndex={-1}` paneli sekme sırasına ALMAZ; yalnızca yazılımla
  // odaklanabilir kılar. Odak girdide kaldığı sürece panelin `onKeyDown`
  // işleyicisi hiç çalışmıyor, panel içindeki Escape ulaşılamıyor ve gün
  // düğmeleri — panel `document.body`'ye taşındığı için — belge sekme sırasının
  // en sonunda kalıyordu.
  //
  // Odak AÇILIŞ BAŞINA BİR KEZ alınır. Etki `placement` bağımlılığını taşır
  // (panel ölçülmeden odaklanamaz), ama `placement` her yakalanan kaydırma ve
  // yeniden boyutlandırmada YENİDEN hesaplanır: koşulsuz odaklama, açık
  // seçicide sayfa kaydırıldığında odağı seçili gün düğmesinden çalıp panel
  // kabına geri sıçratıyor ve klavye gezinmesini kesiyordu.
  const panelFocusedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      panelFocusedRef.current = false;
      return;
    }
    if (!placement || panelFocusedRef.current) return;
    panelFocusedRef.current = true;
    panelRef.current?.focus();
  }, [open, placement]);

  const measure = useCallback(() => {
    if (!rootRef.current || typeof window === 'undefined') return;
    const scale = appZoom();
    const rect = rootRef.current.getBoundingClientRect();
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
      if (rootRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  const commit = () => {
    if (!draft.trim()) {
      setValidationMessage('');
      if (!allowEmpty) setDraft(formatEditableDate(value));
      else onChange?.('');
      return;
    }

    const iso = parseDisplayDate(draft);
    if (!iso) {
      setValidationMessage(`Tarihi ${hint} biçiminde girin.`);
      return;
    }
    const limitMessage = dateLimitMessage(iso, { minDate, maxDate, formatDate: formatEditableDate });
    if (limitMessage) {
      setValidationMessage(limitMessage);
      return;
    }

    setValidationMessage('');
    setDraft(formatEditableDate(iso));
    onChange?.(iso);
  };

  const togglePicker = () => {
    if (disabled) return;
    setMonth(resolveCalendarMonth(value, { minDate, maxDate }));
    setOpen((current) => !current);
  };

  const selectDate = (next) => {
    if (!isDateWithinLimits(next, { minDate, maxDate })) return;
    setValidationMessage('');
    setDraft(formatEditableDate(next));
    setOpen(false);
    onChange?.(next);
    inputRef.current?.focus();
  };

  const clearDate = () => {
    if (!allowEmpty) return;
    setValidationMessage('');
    setDraft('');
    setOpen(false);
    onChange?.('');
    inputRef.current?.focus();
  };

  const picker = open && placement && typeof document !== 'undefined' ? createPortal(
    <div
      ref={panelRef}
      className="date-picker-panel"
      role="dialog"
      aria-label="Tarih seçici"
      // Panel ODAK ALABİLİR: portala taşındığı için DOM sekme sırasında girdiden
      // sonra değil, sayfanın en sonunda yer alır; odak hiç içeri girmediğinde
      // aşağıdaki `onKeyDown` işleyicisi çalışmıyor ve gün düğmelerine klavyeyle
      // erişilemiyordu.
      tabIndex={-1}
      // `preventDefault` yalnızca panelin BOŞ alanı için gerekir (girdinin odağı
      // korunsun). Düğmelerde engellenmesi, tıklanan günün odağı almasını da
      // engelliyordu.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          inputRef.current?.focus();
        }
      }}
      style={{
        position: 'fixed',
        left: placement.left,
        width: placement.width,
        maxHeight: placement.panelMaxHeight,
        overflowY: placement.scrollPanel ? 'auto' : undefined,
        ...(placement.openUp ? { bottom: placement.bottom } : { top: placement.top })
      }}
    >
      <div className="date-picker-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Önceki ay"
          disabled={!calendarMonthHasSelectableDate(previousMonth, { minDate, maxDate })}
          onClick={() => setMonth(previousMonth)}
        >
          <Icons.ChevronLeft size={15} />
        </button>
        <strong>{calendarMonthLabel(month)}</strong>
        <button
          type="button"
          className="icon-btn"
          aria-label="Sonraki ay"
          disabled={!calendarMonthHasSelectableDate(nextMonth, { minDate, maxDate })}
          onClick={() => setMonth(nextMonth)}
        >
          <Icons.ChevronRight size={15} />
        </button>
      </div>
      <div className="date-picker-weekdays" aria-hidden="true">
        {TURKISH_CALENDAR_WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="date-picker-grid">
        {calendarDays.map((day) => {
          const unavailable = !isDateWithinLimits(day.iso, { minDate, maxDate });
          return (
            <button
              key={day.iso}
              type="button"
              className={`${day.inCurrentMonth ? '' : 'other-month'}${day.iso === value ? ' selected' : ''}${day.iso === currentDay ? ' today' : ''}`.trim()}
              disabled={unavailable}
              aria-label={day.label}
              aria-pressed={day.iso === value}
              onClick={() => selectDate(day.iso)}
            >
              {day.day}
            </button>
          );
        })}
      </div>
      <div className="date-picker-foot">
        <button type="button" className="btn ghost sm" disabled={!isDateWithinLimits(currentDay, { minDate, maxDate })} onClick={() => selectDate(currentDay)}>
          Bugün
        </button>
        {allowEmpty && <button type="button" className="btn ghost sm" onClick={clearDate}>Temizle</button>}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div ref={rootRef} className={`date-input-shell${validationMessage ? ' invalid' : ''}`} style={style}>
      <input
        ref={inputRef}
        type="text"
        inputMode={dateFormat === 'dd/mm/yyyy' ? 'numeric' : 'text'}
        className={className}
        value={draft}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder || hint}
        aria-label={ariaLabel}
        aria-invalid={validationMessage ? true : undefined}
        title={validationMessage || title}
        onChange={(event) => {
          setValidationMessage('');
          setDraft(maskDateDraft(event.target.value));
        }}
        // Odak SEÇİCİNİN İÇİNE geçtiğinde taslak işlenmez. Panel açılışta odağı
        // alır ve gün düğmesine basmak da odağı girdiden alır; koşulsuz `commit`
        // bu yüzden önce taslaktaki tarihi, hemen ardından `selectDate` seçilen
        // günü yazıyordu. İki `onChange` arka arkaya gittiği için ARADAKİ tarih
        // kalıcılaşabiliyordu.
        onBlur={(event) => {
          if (panelRef.current?.contains(event.relatedTarget)) return;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'ArrowDown' && event.altKey) {
            event.preventDefault();
            togglePicker();
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="date-input-button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={togglePicker}
        disabled={disabled}
        aria-label="Takvimden tarih seç"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icons.Calendar size={13} />
      </button>
      {validationMessage && <span className="date-input-error" role="alert">{validationMessage}</span>}
      {picker}
    </div>
  );
}

export { formatEditableDate, parseDisplayDate };
