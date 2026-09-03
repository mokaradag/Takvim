'use client';
import { DateInput } from './DateInput';
import { Icons } from './icons';
import { DATE_RANGE_PRESETS } from '../features/shared/dateRangeFilter.js';

/**
 * Özet ve Raporlar sayfalarının ortak tarih aralığı denetimi.
 *
 * Ön ayar çipleri + yalnızca "Özel" seçildiğinde açılan iki tarih kutusu.
 * Çipler tek bir `radiogroup` oluşturur: grup TEK sekme durağıdır ve seçim ok
 * tuşlarıyla değişir; odak seçimle birlikte taşınır (bkz. ProjectColorPicker).
 */
export function DateRangeFilter({ value, onChange, label = 'Tarih aralığı', summary = null }) {
  const preset = value?.preset || 'all';
  const keys = DATE_RANGE_PRESETS.map((item) => item.id);

  const moveSelection = (offset, group) => {
    const current = keys.indexOf(preset);
    const nextIndex = ((current < 0 ? 0 : current) + offset + keys.length) % keys.length;
    onChange({ ...value, preset: keys[nextIndex] });
    group?.querySelectorAll('[role="radio"]')[nextIndex]?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1, event.currentTarget.parentElement);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1, event.currentTarget.parentElement);
    }
  };

  return (
    <div className="date-range-filter">
      <span className="date-range-filter-label">
        <Icons.Calendar size={12} /> {label}
      </span>
      <div className="date-range-presets" role="radiogroup" aria-label={label}>
        {DATE_RANGE_PRESETS.map((item, index) => {
          const selected = preset === item.id;
          const tabStop = selected || (!keys.includes(preset) && index === 0);
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={tabStop ? 0 : -1}
              className={`date-range-chip${selected ? ' active' : ''}`}
              onKeyDown={onKeyDown}
              onClick={() => onChange({ ...value, preset: item.id })}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {preset === 'custom' && (
        <div className="date-range-custom">
          {/* Kutular birbirini SINIRLAR: ters sıralı bir aralık hiç girilemez.
              Sınır olmasaydı `resolveDateRangeSelection` böyle bir seçim için
              `null` döner, sayfa da bunu "süzgeç yok" sayıp sessizce TÜM ZAMANLAR
              ölçümlerine dönerdi — kullanıcı yanlış aralık girdiğini fark etmeden
              yanlış sayılara bakardı. */}
          <DateInput
            value={value?.start || ''}
            onChange={(start) => onChange({ ...value, preset: 'custom', start })}
            ariaLabel="Aralık başlangıcı"
            allowEmpty
            maxDate={value?.end || ''}
          />
          <span className="date-range-dash">—</span>
          <DateInput
            value={value?.end || ''}
            onChange={(end) => onChange({ ...value, preset: 'custom', end })}
            ariaLabel="Aralık bitişi"
            allowEmpty
            minDate={value?.start || ''}
          />
        </div>
      )}
      {/* Uygulanmayan özel aralık AÇIKÇA bildirilir: yarım bırakılmış bir seçim
          süzgeci uygulamaz ve bu, sessiz kaldığında "süzgeç çalışmıyor" gibi
          görünür. */}
      {preset === 'custom' && !(value?.start && value?.end) && (
        <span className="date-range-hint" role="status">
          Aralığı uygulamak için iki tarihi de seçin; şu an tüm zamanlar gösteriliyor.
        </span>
      )}
      {summary && <span className="date-range-summary">{summary}</span>}
    </div>
  );
}
