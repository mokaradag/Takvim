'use client';
import { Icons } from '../../components/icons';

/**
 * Gantt anahat denetimleri: tümünü genişlet/daralt ve seviye seçimi.
 *
 * Yakınlaştırma düğmelerinin yanında durur; etiketler Türkçedir.
 */
export function GanttOutlineControls({
  onExpandAll,
  onCollapseAll,
  levels = 0,
  activeLevel = null,
  onSelectLevel = null
}) {
  return (
    <div className="gantt-outline-controls" role="group" aria-label="Anahat denetimleri">
      <div className="seg gantt-outline-seg">
        <button type="button" onClick={onExpandAll} title="Tüm dalları genişlet" aria-label="Tümünü genişlet">
          <Icons.ChevronDown size={12} /> <span>Genişlet</span>
        </button>
        <button type="button" onClick={onCollapseAll} title="Tüm dalları daralt" aria-label="Tümünü daralt">
          <Icons.ChevronUp size={12} /> <span>Daralt</span>
        </button>
      </div>
      {levels > 1 && onSelectLevel && (
        <>
          <span className="muted gantt-control-label">Seviye</span>
          <div className="seg gantt-level-seg" role="group" aria-label="Görünecek hiyerarşi seviyesi">
            {Array.from({ length: levels }, (unused, index) => index + 1).map((level) => (
              <button
                key={level}
                type="button"
                className={activeLevel === level ? 'active' : ''}
                aria-pressed={activeLevel === level}
                title={`${level}. seviyeye kadar göster`}
                onClick={() => onSelectLevel(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
