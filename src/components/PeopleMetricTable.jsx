'use client';
import React from 'react';
import { Avatar } from './ui';
import { Tooltip } from './ui-extras';

/**
 * Kişi bazlı ölçüm tablosu — Özet "Ekip iş yükü" ve Raporlar "Kaynak kullanımı"
 * kartlarının ortak iskeleti.
 *
 * Önceki tek çubuklu düzen adı sabit genişlikte dar bir sütuna sıkıştırıyor,
 * kartın kalan yatay alanını boş bırakıyordu: uzun kurumsal adlar üç noktaya
 * kırpılıyor, tabloda yalnızca tek bir sayı görünüyordu. Burada ad esnek
 * sütunu alır, altında birim/unvan satırı gösterilir ve kalan alan sayısal
 * sütunlara ayrılır.
 *
 * Bileşen saf sunumdur: uygulama durumuna erişmez, tüm değerler dışarıdan
 * hazır olarak verilir.
 */

/** Kişi satırının ikinci satırı: unvan ve birim; boşsa satır hiç çizilmez. */
export function personUnitLabel(person) {
  if (!person) return '';
  const unit = [person.organization?.department, person.organization?.unit, person.team]
    .map((value) => String(value || '').trim())
    .filter(Boolean)[0] || '';
  const role = String(person.role || '').trim();
  return [role, unit].filter(Boolean).join(' · ');
}

function toneColor(tone) {
  if (tone === 'done') return 'var(--status-done)';
  if (tone === 'overdue') return 'var(--status-overdue)';
  if (tone === 'warn') return 'var(--c-amber)';
  if (tone === 'muted') return 'var(--text-dim)';
  return 'var(--text)';
}

/**
 * @param {object} props
 * @param {Array<{key: string, label: string, title?: string}>} props.columns sayısal sütunlar
 * @param {Array<object>} props.rows satırlar: `{ id, name, person, subtitle, share, barColor, values, tooltip }`
 * @param {string} [props.personLabel] ilk sütun başlığı
 * @param {string} [props.barLabel] çubuk sütunu başlığı
 * @param {string} [props.emptyText] satır yoksa gösterilecek metin
 */
export function PeopleMetricTable({
  columns = [],
  rows = [],
  personLabel = 'Kişi',
  barLabel = 'Dağılım',
  emptyText = 'Gösterilecek kayıt yok.'
}) {
  const template = { '--pm-metric-cols': `repeat(${columns.length}, minmax(56px, auto))` };

  if (!rows.length) return <div className="empty">{emptyText}</div>;

  return (
    <div className="pm-table" role="table">
      <div className="pm-row pm-head" role="row" style={template}>
        <span role="columnheader">{personLabel}</span>
        <span role="columnheader">{barLabel}</span>
        {columns.map((column) => (
          <span key={column.key} className="pm-metric-head" role="columnheader" title={column.title}>{column.label}</span>
        ))}
      </div>

      {rows.map((row) => {
        const body = (
          <div className="pm-row" role="row" style={template}>
            <span className="pm-person" role="cell">
              <Avatar name={row.name} person={row.person} size="sm" />
              <span className="pm-person-text">
                <span className="pm-name" title={row.name}>{row.name}</span>
                {row.subtitle && <span className="pm-sub" title={row.subtitle}>{row.subtitle}</span>}
              </span>
            </span>
            <span className="pm-bar" role="cell">
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${Math.max(0, Math.min(100, Math.round((row.share || 0) * 100)))}%`, background: row.barColor || 'var(--accent)' }}
                />
              </span>
            </span>
            {columns.map((column) => {
              const cell = row.values?.[column.key];
              const value = cell && typeof cell === 'object' ? cell.value : cell;
              const tone = cell && typeof cell === 'object' ? cell.tone : null;
              return (
                <span
                  key={column.key}
                  className="pm-metric tabular"
                  role="cell"
                  style={{ color: toneColor(tone), fontWeight: tone && tone !== 'muted' ? 700 : 600 }}
                >
                  {value == null || value === '' ? '—' : value}
                </span>
              );
            })}
          </div>
        );
        if (!row.tooltip) return <React.Fragment key={row.id}>{body}</React.Fragment>;
        // `asChild`: varsayılan sarmalayıcı satırı `inline-flex` bir `span`
        // içine alır ve `.pm-row` artık `.pm-table`'ın doğrudan çocuğu olmaz;
        // ızgara sütunları satırdan satıra kayar. İpucu doğrudan satırın
        // kendisine bağlanır.
        return (
          <Tooltip
            key={row.id}
            asChild
            title={row.name}
            accent={row.barColor}
            icon={<Avatar name={row.name} person={row.person} size="sm" />}
            content={row.tooltip}
          >
            {body}
          </Tooltip>
        );
      })}
    </div>
  );
}
