'use client';
/* ============================================================
   Extra UI primitives — Tooltip, InfoButton, AnimatedNumber,
   ColumnFilter, AnimatedBar, ChartTooltip
   ============================================================ */
import React, { useState as useSx, useEffect as useEx, useRef as useRx } from 'react';
import ReactDOM from 'react-dom';
import { DateInput } from './DateInput';
import { Icons } from './icons';
import { appZoom } from '../lib/zoom';
import { clampOverlayToViewport } from './overlayPlacement.js';
import { measureNaturalRect } from './overlayMeasurement.js';
import { addDays, diffDays, endOfWeek, parseDate, startOfWeek, today } from '../scheduling/dates';
import { OPTION_SEARCH_THRESHOLD, matchesOptionQuery } from './columnFilterSearch.js';

export { OPTION_SEARCH_THRESHOLD, matchesOptionQuery };

// ── Rich tooltip (portal, cursor-following, always on top) ─────
/**
 * `focusable` bilgi taşıyan ipuçları içindir.
 *
 * Varsayılan sarmalayıcı `<span>` odaklanabilir DEĞİLDİR: yalnızca fareyle
 * ulaşılabilen bir ipucunun içinde başka hiçbir yerde bulunmayan bilgi
 * durduğunda (örneğin gecikme yaşlandırma kartlarının payı ve görev adları) bu
 * bilgi klavye kullanıcısına hiç açılmıyordu. Her ipucunu sekme durağı yapmak
 * ise klavye gezinmesini bozardı; bu yüzden davranış açıkça seçilir.
 */
export function Tooltip({ children, content, icon, title, delay = 90, asChild = false, wrapperStyle, accent, focusable = false, ariaLabel }) {
  const [show, setShow] = useSx(false);
  const [pos, setPos] = useSx({ x: 0, y: 0, ready: false });
  const tipRef = useRx(null);
  const timer = useRx(null);
  const lastMouse = useRx({ x: 0, y: 0 });

  const place = (x, y) => {
    const el = tipRef.current;
    const OFF = 16; // distance from cursor
    // The whole app is scaled with body { zoom } for the font-size control.
    // zoom multiplies the coordinate frame of position:fixed children, so we
    // convert the (physical) cursor + rect coords into the pre-zoom layout
    // frame the fixed tooltip actually lives in. Without this the tip drifts
    // away from the cursor as zoom grows.
    const Z = appZoom();
    const vw = window.innerWidth / Z;
    const vh = window.innerHeight / Z;
    const mx = x / Z, my = y / Z;
    if (!el) { setPos({ x: mx + OFF, y: my + OFF, ready: false }); return; }
    const r = el.getBoundingClientRect();
    const w = r.width / Z, h = r.height / Z;
    let nx = mx + OFF;
    let ny = my + OFF;
    // flip horizontally if would overflow right
    if (nx + w > vw - 10) nx = mx - OFF - w;
    // flip vertically if would overflow bottom
    if (ny + h > vh - 10) ny = my - OFF - h;
    // clamp
    if (nx < 8) nx = 8;
    if (ny < 8) ny = 8;
    if (nx + w > vw - 8) nx = vw - w - 8;
    if (ny + h > vh - 8) ny = vh - h - 8;
    setPos({ x: nx, y: ny, ready: true });
  };

  const enter = (e) => {
    clearTimeout(timer.current);
    const x = e.clientX, y = e.clientY;
    lastMouse.current = { x, y };
    timer.current = setTimeout(() => {
      setShow(true);
    }, delay);
  };
  const move = (e) => {
    lastMouse.current = { x: e.clientX, y: e.clientY };
    if (show) place(e.clientX, e.clientY);
  };
  const leave = () => { clearTimeout(timer.current); setShow(false); setPos(p => ({ ...p, ready: false })); };

  useEx(() => {
    if (show && tipRef.current) place(lastMouse.current.x, lastMouse.current.y);
  }, [show]);

  // Cleanup on unmount
  useEx(() => () => { clearTimeout(timer.current); }, []);

  const handlers = {
    onMouseEnter: enter,
    onMouseLeave: leave,
    onMouseMove: move,
    onFocus: (e) => {
      const r = e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
      if (r) { lastMouse.current = { x: r.left + r.width / 2, y: r.bottom }; }
      enter({ clientX: lastMouse.current.x, clientY: lastMouse.current.y });
    },
    onBlur: leave,
    onKeyDown: (e) => { if (e.key === 'Escape') leave(); }
  };

  const tip = show && ReactDOM.createPortal(
    (
      <div
        ref={tipRef}
        className="rich-tip"
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          zIndex: 'var(--z-tooltip)',
          visibility: pos.ready ? 'visible' : 'hidden',
          pointerEvents: 'none',
          ...(accent ? { '--tip-accent': accent } : {})
        }}
      >
        {(title || icon) && (
          <div className="rich-tip-head">
            {icon && <span className="rich-tip-icon">{icon}</span>}
            {title && <span className="rich-tip-title">{title}</span>}
          </div>
        )}
        <div className="rich-tip-body">{content}</div>
      </div>
    ),
    document.body
  );

  if (asChild && React.isValidElement(children)) {
    // attach handlers to the existing child element (no extra wrapper)
    return (
      <>
        {React.cloneElement(children, {
          ...handlers,
          onMouseEnter: (e) => { handlers.onMouseEnter(e); if (children.props.onMouseEnter) children.props.onMouseEnter(e); },
          onMouseLeave: (e) => { handlers.onMouseLeave(e); if (children.props.onMouseLeave) children.props.onMouseLeave(e); },
          onMouseMove: (e) => { handlers.onMouseMove(e); if (children.props.onMouseMove) children.props.onMouseMove(e); }
        })}
        {tip}
      </>
    );
  }

  return (
    <>
      <span
        {...handlers}
        {...(focusable ? { tabIndex: 0, role: 'button', 'aria-label': ariaLabel || title } : null)}
        style={{ display: 'inline-flex', alignItems: 'center', ...wrapperStyle }}
      >
        {children}
      </span>
      {tip}
    </>
  );
}

// ── Info button (i) — opens rich tooltip on hover/click ──
export function InfoButton({ title, children, icon, size = 13, corner = false, accent }) {
  return (
    <Tooltip title={title} content={children} icon={icon || <Icons.Info size={12} />} accent={accent}>
      <button className={`info-btn${corner ? ' corner' : ''}`} type="button" aria-label="Bilgi">
        <Icons.Info size={size - 1} />
      </button>
    </Tooltip>
  );
}

// ── CardHead — card title + corner info button (top-right) ─
export function CardHead({ icon, title, subtitle, info, infoTitle, infoAccent, infoIcon, right, children }) {
  return (
    <div className="card-head-wrap" style={{ marginBottom: 14 }}>
      <div className="row card-head-row">
        <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
          <div className="card-title" style={{ margin: 0 }}>
            {icon}
            <span>{title}</span>
            {children}
          </div>
          {subtitle && <div className="muted" style={{ fontSize: 12 }}>{subtitle}</div>}
        </div>
        {right && <div className="row" style={{ gap: 6 }}>{right}</div>}
      </div>
      {info && (
        <div className="card-info-corner">
          <InfoButton title={infoTitle || title} icon={infoIcon} accent={infoAccent} corner>{info}</InfoButton>
        </div>
      )}
    </div>
  );
}

// ── AnimatedNumber — counts up on mount/value change ─────
export function AnimatedNumber({ value, duration = 700, format, suffix = '' }) {
  const [v, setV] = useSx(0);
  const startRef = useRx(0);
  const fromRef = useRx(0);
  const rafRef = useRx();

  useEx(() => {
    cancelAnimationFrame(rafRef.current);
    fromRef.current = v;
    startRef.current = performance.now();
    const tick = (t) => {
      const e = Math.min(1, (t - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - e, 3);
      const cur = fromRef.current + (value - fromRef.current) * eased;
      setV(cur);
      if (e < 1) rafRef.current = requestAnimationFrame(tick);
      else setV(value);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const shown = format ? format(v) : (Number.isInteger(value) ? Math.round(v) : v.toFixed(1));
  return <span className="tabular">{shown}{suffix}</span>;
}

// ── ColumnFilter — popover on column header ─────────────
export function ColumnFilter({ label, anchor, type = 'text', options = [], value, onChange, onClose, sort, onSort, numericMin, numericMax, numericUnit }) {
  const [q, setQ] = useSx(typeof value === 'string' ? value : '');
  const [sel, setSel] = useSx(Array.isArray(value) ? new Set(value) : new Set());
  // For dates: { preset, from, to, mode } — mode = 'range' | 'preset' | 'before' | 'after'
  const initialDate = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const [dateMode, setDateMode] = useSx(initialDate.mode || 'preset');
  const [datePreset, setDatePreset] = useSx(initialDate.preset || '');
  const [dateFrom, setDateFrom] = useSx(initialDate.from || '');
  const [dateTo, setDateTo] = useSx(initialDate.to || '');
  // For numbers: { mode: 'between'|'before'|'after'|'equals', from, to, eq }
  const initialNum = (value && typeof value === 'object' && !Array.isArray(value) && (value.mode === 'between' || value.mode === 'before' || value.mode === 'after' || value.mode === 'equals')) ? value : {};
  const [numMode, setNumMode] = useSx(initialNum.mode || 'between');
  const [numFrom, setNumFrom] = useSx(initialNum.from != null ? String(initialNum.from) : '');
  const [numTo, setNumTo] = useSx(initialNum.to != null ? String(initialNum.to) : '');
  const [numEq, setNumEq] = useSx(initialNum.eq != null ? String(initialNum.eq) : '');
  // Çoklu/tekli seçim listelerinde canlı arama. Sorumlu ve proje gibi sütunlar
  // binlerce seçenek taşıyabiliyor; arama olmadan listeyi kaydırarak aramak tek
  // yoldu ve pratikte kullanılamıyordu.
  const [optionQuery, setOptionQuery] = useSx('');
  const ref = useRx(null);

  useEx(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchor?.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Çapaya göre yerleşim; kutu her zaman görünüm alanının içinde kalır.
  const [pos, setPos] = useSx({ left: 0, top: 0, maxWidth: null, maxHeight: null });
  useEx(() => {
    if (!anchor) return undefined;
    const place = () => {
      const Z = appZoom();
      const r = anchor.getBoundingClientRect();
      // Ölçüm DOĞAL boyutla yapılır; önceki kırpma yeniden ölçülmez.
      const box = measureNaturalRect(ref.current);
      setPos(clampOverlayToViewport(
        { left: r.left / Z, top: r.top / Z, bottom: r.bottom / Z, width: r.width / Z },
        { width: box ? box.width / Z : 300, height: box ? box.height / Z : 320 },
        { width: window.innerWidth / Z, height: window.innerHeight / Z }
      ));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
    // Kip değişince kutunun YÜKSEKLİĞİ değişir (hazır ayar ızgarası tek girişli
    // kiplerden çok daha yüksektir). Yerleşim yeniden ölçülmezse görünüm
    // alanının altında kalan yüksek kip kırpılıyor ve düğmelerine
    // erişilemiyordu (bkz. DateFilterableTH · DateColumnFilter, aynı kural).
  }, [anchor, type, dateMode, numMode]);

  const apply = () => {
    if (type === 'text' || type === 'single') onChange(q);
    else if (type === 'multi') onChange([...sel]);
    else if (type === 'date') {
      if (dateMode === 'preset' && datePreset) onChange({ mode: 'preset', preset: datePreset });
      else if (dateMode === 'range' && (dateFrom || dateTo)) onChange({ mode: 'range', from: dateFrom, to: dateTo });
      else if (dateMode === 'before' && dateTo) onChange({ mode: 'before', to: dateTo });
      else if (dateMode === 'after' && dateFrom) onChange({ mode: 'after', from: dateFrom });
      else onChange(null);
    }
    else if (type === 'number') {
      const f = numFrom !== '' ? parseFloat(numFrom) : null;
      const t = numTo !== '' ? parseFloat(numTo) : null;
      const e = numEq !== '' ? parseFloat(numEq) : null;
      if (numMode === 'between' && (f != null || t != null)) onChange({ mode: 'between', from: f, to: t });
      else if (numMode === 'before' && t != null) onChange({ mode: 'before', to: t });
      else if (numMode === 'after' && f != null) onChange({ mode: 'after', from: f });
      else if (numMode === 'equals' && e != null) onChange({ mode: 'equals', eq: e });
      else onChange(null);
    }
    onClose();
  };
  const clear = () => {
    if (type === 'text' || type === 'single') { setQ(''); onChange(''); }
    else if (type === 'multi') { setSel(new Set()); onChange([]); }
    else if (type === 'date') {
      setDatePreset(''); setDateFrom(''); setDateTo('');
      onChange(null);
    }
    else if (type === 'number') {
      setNumFrom(''); setNumTo(''); setNumEq('');
      onChange(null);
    }
    onClose();
  };

  // Sorted options for multi
  const sortedOptions = type === 'multi'
    ? [...options].sort((a, b) => (a.label || '').localeCompare(b.label || '', 'tr'))
    : options;

  // Seçili değerler aramada elense bile GÖRÜNÜR kalır: aksi hâlde kullanıcı
  // arama yazdığında neyi seçtiğini göremez ve farkında olmadan kaldırır.
  const searchableOptions = (type === 'multi' || type === 'single') && optionQuery.trim()
    ? sortedOptions.filter((option) => matchesOptionQuery(option, optionQuery)
      || (type === 'multi' ? sel.has(option.value) : String(option.value) === String(q ?? '')))
    : sortedOptions;
  const searchable = (type === 'multi' || type === 'single') && options.length > OPTION_SEARCH_THRESHOLD;

  return (
    // `?? undefined` bilinçlidir: sıfır GEÇERLİ bir sınırdır. `|| undefined`
    // yazıldığında "hiç yer yok" sonucu "sınır yok"a dönüşüyor ve kutu tam da
    // bu kırpmanın engellemesi gereken biçimde görünüm alanının dışına taşıyordu.
    <div
      ref={ref}
      className="col-filter-pop"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        maxWidth: pos.maxWidth ?? undefined,
        maxHeight: pos.maxHeight ?? undefined
      }}
    >
      <div className="col-filter-head">
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.01em', color: 'var(--text-dim)' }}>{label}</span>
      </div>
      {onSort && (
        <div className="col-filter-sort">
          <button className={sort === 'asc' ? 'active' : ''} onClick={() => { onSort('asc'); onClose(); }}>
            <Icons.ChevronUp size={12} /> {type === 'date' ? 'Eskiden yeniye' : type === 'number' ? 'Küçükten büyüğe' : 'Artan'}
          </button>
          <button className={sort === 'desc' ? 'active' : ''} onClick={() => { onSort('desc'); onClose(); }}>
            <Icons.ChevronDown size={12} /> {type === 'date' ? 'Yeniden eskiye' : type === 'number' ? 'Büyükten küçüğe' : 'Azalan'}
          </button>
        </div>
      )}
      <div className="col-filter-body">
        {type === 'text' && (
          <div className="row" style={{ gap: 6 }}>
            <Icons.Search size={13} className="muted" />
            <input
              autoFocus
              className="input"
              placeholder={`${label} ara...`}
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') apply(); }}
              style={{ padding: '5px 8px', fontSize: 12.5 }}
            />
          </div>
        )}
        {searchable && (
          <label className="col-filter-search">
            <Icons.Search size={12} />
            <input
              autoFocus
              value={optionQuery}
              aria-label={`${label} seçeneklerinde ara`}
              placeholder={`${label} ara...`}
              onChange={(e) => setOptionQuery(e.target.value)}
              // Enter aramadaki seçeneği uygular. Tek seçimli süzgeçte genel
              // `apply()` çağrılırsa ARANAN değil, ÖNCEDEN seçili radyo değeri
              // uygulanır: kullanıcı arayıp Enter'a bastığında süzgeç eskisi gibi
              // kalır. Tek eşleşme varsa o seçilir, yoksa hiçbir şey uygulanmaz.
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (type !== 'single') { apply(); return; }
                if (searchableOptions.length !== 1) return;
                const [only] = searchableOptions;
                setQ(only.value);
                onChange(only.value);
                onClose();
              }}
            />
            {optionQuery && (
              <button type="button" onClick={() => setOptionQuery('')} aria-label="Aramayı temizle">
                <Icons.Close size={11} />
              </button>
            )}
          </label>
        )}
        {type === 'multi' && (
          <div className="col" style={{ gap: 2, maxHeight: 220, overflowY: 'auto' }}>
            {!searchableOptions.length && (
              <span className="col-filter-empty">Eşleşen seçenek yok.</span>
            )}
            {searchableOptions.map(o => {
              const checked = sel.has(o.value);
              return (
                <label key={o.value} className="col-filter-opt">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = new Set(sel);
                      if (checked) next.delete(o.value); else next.add(o.value);
                      setSel(next);
                    }}
                  />
                  {o.icon && <span style={{ display: 'inline-flex' }}>{o.icon}</span>}
                  <span>{o.label}</span>
                </label>
              );
            })}
          </div>
        )}
        {type === 'single' && (
          /* Tek seçimli (radyo) süzgeç: kurumsal kırılım düzeyleri aynı anda
             yalnızca BİR değer taşıyabilir. Seçim anında uygulanır; böylece
             tablo başlığı ile üstteki dizin açılır listeleri eşzamanlı kalır. */
          <div className="col" role="radiogroup" aria-label={label} style={{ gap: 2, maxHeight: 240, overflowY: 'auto', minWidth: 220 }}>
            {!searchableOptions.length && (
              <span className="col-filter-empty">Eşleşen seçenek yok.</span>
            )}
            {searchableOptions.map((o) => {
              const checked = String(o.value) === String(q ?? '');
              return (
                <label key={o.value || '__all__'} className="col-filter-opt">
                  <input
                    type="radio"
                    name={`col-filter-single-${label}`}
                    checked={checked}
                    onChange={() => { setQ(o.value); onChange(o.value); onClose(); }}
                  />
                  {o.icon && <span style={{ display: 'inline-flex' }}>{o.icon}</span>}
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block' }}>{o.label}</span>
                    {o.description && <small className="muted" style={{ display: 'block' }}>{o.description}</small>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {type === 'date' && (
          <div className="col" style={{ gap: 8, minWidth: 280 }}>
            <div className="date-filter-mode">
              <button className={dateMode === 'preset' ? 'active' : ''} onClick={() => setDateMode('preset')}>Hızlı</button>
              <button className={dateMode === 'before' ? 'active' : ''} onClick={() => setDateMode('before')}>Önce</button>
              <button className={dateMode === 'after' ? 'active' : ''} onClick={() => setDateMode('after')}>Sonra</button>
              <button className={dateMode === 'range' ? 'active' : ''} onClick={() => setDateMode('range')}>Arası</button>
            </div>
            {dateMode === 'preset' && (
              <div className="date-filter-preset">
                {[
                  ['overdue', 'Geciken'],
                  ['today', 'Bugün'],
                  ['tomorrow', 'Yarın'],
                  ['thisWeek', 'Bu hafta'],
                  ['nextWeek', 'Gelecek hafta'],
                  ['thisMonth', 'Bu ay'],
                  ['nextMonth', 'Gelecek ay'],
                  ['last7', 'Son 7 gün'],
                  ['last30', 'Son 30 gün'],
                  ['next30', 'Sonraki 30 gün']
                ].map(([k, l]) => (
                  <button key={k} className={datePreset === k ? 'active' : ''} onClick={() => setDatePreset(datePreset === k ? '' : k)}>{l}</button>
                ))}
              </div>
            )}
            {dateMode === 'before' && (
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Bu tarihten önce</span>
                <DateInput value={dateTo} onChange={setDateTo} allowEmpty />
                <span className="dff-hint">‘{dateTo || 'tarih'}’ tarihinden öncesi listelenir.</span>
              </div>
            )}
            {dateMode === 'after' && (
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Bu tarihten sonra</span>
                <DateInput value={dateFrom} onChange={setDateFrom} allowEmpty />
                <span className="dff-hint">‘{dateFrom || 'tarih'}’ tarihinden sonrası listelenir.</span>
              </div>
            )}
            {dateMode === 'range' && (
              <div className="col" style={{ gap: 6 }}>
                <div className="col" style={{ gap: 4 }}>
                  <span className="dff-label">Başlangıç (dahil)</span>
                  <DateInput value={dateFrom} onChange={setDateFrom} allowEmpty maxDate={dateTo} />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <span className="dff-label">Bitiş (dahil)</span>
                  <DateInput value={dateTo} onChange={setDateTo} allowEmpty minDate={dateFrom} />
                </div>
              </div>
            )}
          </div>
        )}
        {type === 'number' && (
          <div className="col" style={{ gap: 8, minWidth: 240 }}>
            <div className="date-filter-mode">
              <button className={numMode === 'between' ? 'active' : ''} onClick={() => setNumMode('between')}>Arası</button>
              <button className={numMode === 'before' ? 'active' : ''} onClick={() => setNumMode('before')}>Az</button>
              <button className={numMode === 'after' ? 'active' : ''} onClick={() => setNumMode('after')}>Çok</button>
              <button className={numMode === 'equals' ? 'active' : ''} onClick={() => setNumMode('equals')}>Eşit</button>
            </div>
            {(numericMin != null && numericMax != null) && (
              <div className="dff-hint" style={{ textAlign: 'center' }}>Aralık: {numericMin} – {numericMax}{numericUnit || ''}</div>
            )}
            {numMode === 'between' && (
              <div className="row" style={{ gap: 6 }}>
                <div className="col" style={{ gap: 3, flex: 1 }}>
                  <span className="dff-label">En az</span>
                  <input type="number" className="input" value={numFrom} onChange={(e) => setNumFrom(e.target.value)} placeholder={numericMin != null ? String(numericMin) : 'min'} style={{ padding: '5px 8px', fontSize: 12.5 }} />
                </div>
                <div className="col" style={{ gap: 3, flex: 1 }}>
                  <span className="dff-label">En çok</span>
                  <input type="number" className="input" value={numTo} onChange={(e) => setNumTo(e.target.value)} placeholder={numericMax != null ? String(numericMax) : 'max'} style={{ padding: '5px 8px', fontSize: 12.5 }} />
                </div>
              </div>
            )}
            {numMode === 'before' && (
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Şu değerden az</span>
                <input type="number" className="input" value={numTo} onChange={(e) => setNumTo(e.target.value)} placeholder="ör. 50" style={{ padding: '5px 8px', fontSize: 12.5 }} />
              </div>
            )}
            {numMode === 'after' && (
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Şu değerden çok</span>
                <input type="number" className="input" value={numFrom} onChange={(e) => setNumFrom(e.target.value)} placeholder="ör. 50" style={{ padding: '5px 8px', fontSize: 12.5 }} />
              </div>
            )}
            {numMode === 'equals' && (
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Tam olarak eşit</span>
                <input type="number" className="input" value={numEq} onChange={(e) => setNumEq(e.target.value)} placeholder="ör. 100" style={{ padding: '5px 8px', fontSize: 12.5 }} />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="col-filter-foot">
        <button className="btn ghost sm" onClick={clear}>Temizle</button>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={apply}>Uygula</button>
      </div>
    </div>
  );
}

// Helper for VeriView: check if a date matches a date-filter spec.
// Uygulama `./dateMatchesFilter.js` içindedir (düz Node'dan sınanabilmesi için);
// burada yalnızca yeniden dışa aktarılır, çağıranların içe aktarımı değişmez.
export { dateMatchesFilter } from './dateMatchesFilter.js';

// Helper: numeric filter match
// Uygulama `./numericMatchesFilter.js` içindedir (düz Node'dan sınanabilmesi
// için); burada yalnızca yeniden dışa aktarılır, çağıranların içe aktarımı
// değişmez.
export { numericMatchesFilter } from './numericMatchesFilter.js';

// ── Sortable + filterable column header ──────────────────
export function FilterableTH({ label, sortKey, sortDir, onSort, filter, onFilter, filterType = 'text', filterOptions, style, numericMin, numericMax, numericUnit }) {
  const [open, setOpen] = useSx(false);
  const anchorRef = useRx(null);
  const active = (filterType === 'text' || filterType === 'single')
    ? !!filter
    : Array.isArray(filter) ? filter.length > 0 : !!filter;
  return (
    <th className={`filterable-th${open ? ' is-filter-open' : ''}`} style={style}>
      <button
        type="button"
        ref={anchorRef}
        aria-expanded={open}
        className={`col-th-btn${active ? ' has-filter' : ''}${sortKey ? ' is-sorted' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>{label}</span>
        {sortKey === 'asc' && <Icons.ChevronUp size={11} />}
        {sortKey === 'desc' && <Icons.ChevronDown size={11} />}
        {active && <span className="col-th-dot" />}
        <Icons.Filter size={10} className="col-th-filter-ico" />
      </button>
      {open && (
        <ColumnFilter
          label={label}
          anchor={anchorRef.current}
          type={filterType}
          options={filterOptions || []}
          value={filter}
          onChange={onFilter}
          onClose={() => setOpen(false)}
          sort={sortKey}
          onSort={onSort}
          numericMin={numericMin}
          numericMax={numericMax}
          numericUnit={numericUnit}
        />
      )}
    </th>
  );
}

// ── Animated bar (for BarRows / progress) ────────────────
export function useReveal() {
  const ref = useRx(null);
  const [visible, setVisible] = useSx(false);
  useEx(() => {
    if (!ref.current || visible) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { threshold: 0.15 });
    obs.observe(ref.current);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [ref, visible];
}

// ── HoverListCard — interactive, anchored hover card with a
//    scrollable list. Unlike Tooltip it does NOT follow the cursor
//    and accepts pointer events, so a long list can be scrolled. ──
export function HoverListCard({
  children, title, icon, accent, summary, items = [], renderItem,
  listLabel = 'Görevler', listHint, onViewAll, emptyText = 'Kayıt yok.',
  wrapperStyle, wrapperClass = 'hovercard-trigger'
}) {
  const [show, setShow] = useSx(false);
  const [pos, setPos] = useSx({ x: 0, y: 0, ready: false });
  const wrapRef = useRx(null);
  const cardRef = useRx(null);
  const openT = useRx(null);
  const closeT = useRx(null);

  const place = () => {
    const trg = wrapRef.current, el = cardRef.current;
    if (!trg) return;
    const Z = appZoom();
    const vw = window.innerWidth / Z;
    const vh = window.innerHeight / Z;
    const r = trg.getBoundingClientRect();
    const rx = r.left / Z, ry = r.top / Z, rw = r.width / Z, rh = r.height / Z;
    const cr = el ? el.getBoundingClientRect() : null;
    const w = cr ? cr.width / Z : 300;
    const h = cr ? cr.height / Z : 220;
    const GAP = 8;
    let x = rx;
    let y = ry + rh + GAP;
    if (y + h > vh - 8) y = ry - h - GAP;       // flip above
    if (y < 8) y = 8;
    if (x + w > vw - 8) x = vw - w - 8;
    if (x < 8) x = 8;
    setPos({ x, y, ready: !!el });
  };

  // Sabitleme (pin): tıklama/klavye ile açılan kart, işaretçi ayrıldığında
  // KAPANMAZ. Dokunmatik ve klavye kullanıcısının listedeki görev düğmelerine
  // ulaşabilmesinin tek yolu budur.
  const [pinned, setPinned] = useSx(false);

  const open = () => {
    clearTimeout(closeT.current);
    if (show) return;
    openT.current = setTimeout(() => setShow(true), 90);
  };
  const openNow = () => {
    clearTimeout(closeT.current);
    clearTimeout(openT.current);
    setShow(true);
  };
  const closeNow = () => {
    clearTimeout(openT.current);
    clearTimeout(closeT.current);
    setPinned(false);
    setShow(false);
  };
  const scheduleClose = () => {
    clearTimeout(openT.current);
    if (pinned) return;
    closeT.current = setTimeout(() => setShow(false), 160);
  };
  const toggle = () => {
    if (pinned) { closeNow(); return; }
    setPinned(true);
    openNow();
  };

  useEx(() => { if (show) place(); }, [show]);
  useEx(() => () => { clearTimeout(openT.current); clearTimeout(closeT.current); }, []);

  // Sabitlenmiş kart dışarı tıklamayla ve Esc ile kapanır.
  useEx(() => {
    if (!pinned) return undefined;
    const onPointerDown = (event) => {
      if (wrapRef.current?.contains(event.target) || cardRef.current?.contains(event.target)) return;
      closeNow();
    };
    const onKey = (event) => { if (event.key === 'Escape') closeNow(); };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);

  const card = show && ReactDOM.createPortal(
    <div
      ref={cardRef}
      className="rich-tip interactive"
      style={{
        position: 'fixed', left: pos.x, top: pos.y,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...(accent ? { '--tip-accent': accent } : {})
      }}
      onMouseEnter={() => clearTimeout(closeT.current)}
      onMouseLeave={scheduleClose}
      onFocus={() => clearTimeout(closeT.current)}
    >
      {(title || icon) && (
        <div className="rich-tip-head">
          {icon && <span className="rich-tip-icon">{icon}</span>}
          {title && <span className="rich-tip-title">{title}</span>}
        </div>
      )}
      <div className="rich-tip-body">
        {summary}
        <div className="rt-list-head">
          <span>{listLabel} · {items.length}</span>
          {listHint && <span className="rt-list-hint">{listHint}</span>}
        </div>
        {onViewAll && <button type="button" className="btn ghost sm hover-list-detail" onClick={() => { closeNow(); onViewAll(wrapRef); }}>Tüm görevleri gör <Icons.ChevronRight size={12} /></button>}
        <div className="rt-list">
          {items.length === 0
            ? <div className="rt-list-empty">{emptyText}</div>
            : items.map((it, i) => renderItem(it, i))}
        </div>
      </div>
    </div>,
    document.body
  );

  return (
    <>
      {/* Tetikleyici odaklanabilir ve tıklanabilirdir: eski `<span>` yalnızca
          `onMouseEnter` ile açılıyordu, dolayısıyla klavye kullanıcısı listeyi
          hiç açamıyor, dokunmatik kullanıcı ise ipucunun "Açmak için tıklayın"
          yönergesini izleyemiyordu. */}
      <span
        ref={wrapRef}
        className={wrapperClass}
        role="button"
        tabIndex={0}
        aria-expanded={show}
        style={{ display: 'block', ...wrapperStyle }}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onBlur={scheduleClose}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          } else if (event.key === 'Escape') {
            closeNow();
          }
        }}
      >
        {children}
      </span>
      {card}
    </>
  );
}
