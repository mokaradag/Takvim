'use client';
import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { appZoom } from '../lib/zoom';
import { DateInput } from './DateInput';
import { Icons } from './icons';

const PRESETS = [
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
];

export function DateFilterableTH({ label, sortKey, onSort, filter, onFilter, style }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const active = !!filter;

  return (
    <th style={{ ...style, position: 'relative' }}>
      <button
        ref={anchorRef}
        className={`col-th-btn${active ? ' has-filter' : ''}${sortKey ? ' is-sorted' : ''}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        {sortKey === 'asc' && <Icons.ChevronUp size={11} />}
        {sortKey === 'desc' && <Icons.ChevronDown size={11} />}
        {active && <span className="col-th-dot" />}
        <Icons.Filter size={10} className="col-th-filter-ico" />
      </button>
      {open && (
        <DateColumnFilter
          label={label}
          anchor={anchorRef.current}
          value={filter}
          onChange={onFilter}
          onClose={() => setOpen(false)}
          sort={sortKey}
          onSort={onSort}
        />
      )}
    </th>
  );
}

function DateColumnFilter({ label, anchor, value, onChange, onClose, sort, onSort }) {
  const initial = value && typeof value === 'object' ? value : {};
  const [mode, setMode] = useState(initial.mode || 'preset');
  const [preset, setPreset] = useState(initial.preset || '');
  const [from, setFrom] = useState(initial.from || '');
  const [to, setTo] = useState(initial.to || '');
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const ref = useRef(null);

  useEffect(() => {
    if (!anchor) return;
    const zoom = appZoom();
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth / zoom;
    setPos({
      left: Math.max(8, Math.min(viewportWidth - 308, rect.left / zoom)),
      top: rect.bottom / zoom + 4
    });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (ref.current?.contains(event.target) || anchor?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const clear = () => {
    setPreset('');
    setFrom('');
    setTo('');
    onChange(null);
    onClose();
  };

  const apply = () => {
    if (mode === 'preset' && preset) onChange({ mode: 'preset', preset });
    else if (mode === 'range' && (from || to)) onChange({ mode: 'range', from, to });
    else if (mode === 'before' && to) onChange({ mode: 'before', to });
    else if (mode === 'after' && from) onChange({ mode: 'after', from });
    else onChange(null);
    onClose();
  };

  return ReactDOM.createPortal(
    <div ref={ref} className="col-filter-pop date-column-filter-pop" style={{ position: 'fixed', left: pos.left, top: pos.top }}>
      <div className="col-filter-head">
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>{label}</span>
      </div>
      {onSort && (
        <div className="col-filter-sort">
          <button className={sort === 'asc' ? 'active' : ''} onClick={() => { onSort('asc'); onClose(); }}>
            <Icons.ChevronUp size={12} /> Eskiden yeniye
          </button>
          <button className={sort === 'desc' ? 'active' : ''} onClick={() => { onSort('desc'); onClose(); }}>
            <Icons.ChevronDown size={12} /> Yeniden eskiye
          </button>
        </div>
      )}
      <div className="col-filter-body">
        <div className="col" style={{ gap: 8, minWidth: 280 }}>
          <div className="date-filter-mode">
            <button className={mode === 'preset' ? 'active' : ''} onClick={() => setMode('preset')}>Hızlı</button>
            <button className={mode === 'before' ? 'active' : ''} onClick={() => setMode('before')}>Önce</button>
            <button className={mode === 'after' ? 'active' : ''} onClick={() => setMode('after')}>Sonra</button>
            <button className={mode === 'range' ? 'active' : ''} onClick={() => setMode('range')}>Arası</button>
          </div>

          {mode === 'preset' && (
            <div className="date-filter-preset">
              {PRESETS.map(([key, text]) => (
                <button key={key} className={preset === key ? 'active' : ''} onClick={() => setPreset(preset === key ? '' : key)}>{text}</button>
              ))}
            </div>
          )}

          {mode === 'before' && (
            <div className="col" style={{ gap: 4 }}>
              <span className="dff-label">Bu tarihten önce</span>
              <DateInput value={to} onChange={setTo} />
              <span className="dff-hint">‘{to ? displayDate(to) : 'tarih'}’ tarihinden öncesi listelenir.</span>
            </div>
          )}

          {mode === 'after' && (
            <div className="col" style={{ gap: 4 }}>
              <span className="dff-label">Bu tarihten sonra</span>
              <DateInput value={from} onChange={setFrom} />
              <span className="dff-hint">‘{from ? displayDate(from) : 'tarih'}’ tarihinden sonrası listelenir.</span>
            </div>
          )}

          {mode === 'range' && (
            <div className="col" style={{ gap: 6 }}>
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Başlangıç (dahil)</span>
                <DateInput value={from} onChange={setFrom} />
              </div>
              <div className="col" style={{ gap: 4 }}>
                <span className="dff-label">Bitiş (dahil)</span>
                <DateInput value={to} onChange={setTo} />
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="col-filter-foot">
        <button className="btn ghost sm" onClick={clear}>Temizle</button>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={apply}>Uygula</button>
      </div>
    </div>,
    document.body
  );
}

function displayDate(iso) {
  const [year, month, day] = String(iso).split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
}
