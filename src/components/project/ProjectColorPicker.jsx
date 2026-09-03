'use client';
import { COLOR_MAP } from '../../lib/colors';

export const PROJECT_COLOR_LABELS = {
  blue: 'Mavi',
  emerald: 'Yeşil',
  purple: 'Mor',
  amber: 'Kehribar',
  rose: 'Gül',
  cyan: 'Camgöbeği'
};

export function ProjectColorPicker({ value, onChange, disabled = false }) {
  const keys = Object.keys(COLOR_MAP);
  // `role="radiogroup"` + `role="radio"` yardımcı teknolojiye "grup TEK sekme
  // durağıdır, seçim ok tuşlarıyla değişir" sözü verir. Her düğme sekmeye açık
  // ve ok tuşları işlenmiyorken duyurulan etkileşim modeli gerçek davranışla
  // uyuşmuyordu.
  // Gezinen sekme durağı odağın SEÇİMLE BİRLİKTE taşınmasını gerektirir.
  // Yalnızca `onChange` çağrılsaydı, yeniden çizimden sonra tek sekme durağı
  // yeni seçili düğme olur, DOM odağı ise eskisinde `tabIndex={-1}` ile kalırdı:
  // ekran okuyucu SEÇİLİ OLMAYAN bir seçeneği odaklanmış diye duyurur, görünür
  // odak halkası eski renkte kalır ve sonraki `Tab` grubu tutarsız bir noktadan
  // terk ederdi.
  const moveSelection = (offset, group) => {
    if (disabled || !keys.length) return;
    const current = keys.indexOf(value);
    const nextIndex = ((current < 0 ? 0 : current) + offset + keys.length) % keys.length;
    onChange(keys[nextIndex]);
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
    <div className="col" style={{ gap: 7 }}>
      <span style={{ fontSize: 12, fontWeight: 650 }}>Proje rengi</span>
      <div
        role="radiogroup"
        aria-label="Proje rengi"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
          gap: 8
        }}
      >
        {Object.entries(COLOR_MAP).map(([key, color], index) => {
          const selected = value === key;
          // Gezinen sekme durağı: seçili seçenek (hiçbiri seçili değilse ilki)
          // sekmeye açıktır, ötekiler değildir.
          const tabStop = selected || (!keys.includes(value) && index === 0);
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={tabStop ? 0 : -1}
              disabled={disabled}
              onKeyDown={onKeyDown}
              onClick={() => onChange(key)}
              style={{
                minHeight: 38,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '8px 10px',
                borderRadius: 'var(--r-md)',
                border: selected ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: selected ? 'var(--accent-soft)' : 'var(--bg-elev-2)',
                color: selected ? 'var(--text)' : 'var(--text-muted)',
                fontSize: 12.5,
                fontWeight: selected ? 650 : 500,
                textAlign: 'left',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.65 : 1
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 99,
                  background: color,
                  border: '2px solid var(--bg-elev)',
                  outline: selected ? '2px solid var(--accent)' : '1px solid var(--border-strong)',
                  flexShrink: 0
                }}
              />
              <span>{PROJECT_COLOR_LABELS[key] || key}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
