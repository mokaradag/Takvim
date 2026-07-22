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
        {Object.entries(COLOR_MAP).map(([key, color]) => {
          const selected = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
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
