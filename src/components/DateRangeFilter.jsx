'use client';
import { useEffect, useMemo } from 'react';
import { DateInput } from './DateInput';
import { Icons } from './icons';
import { DATE_RANGE_PRESETS } from '../features/shared/dateRangeFilter.js';
import { useAllPeople, useTasks } from '../state/hooks';
import { hasOrgSelection } from '../domain/organization/organizationHierarchy.js';
import { TaskOrganizationFilterControls } from '../features/tasks/TaskOrganizationFilterControls.jsx';
import { useSharedTaskOrganizationFilter } from '../features/tasks/TaskOrganizationFilterContext.jsx';
import { useTaskOrganizationFilter } from '../features/tasks/useTaskOrganizationFilter.js';

function sameIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * Özet ve Raporlar sayfalarının ortak tarih + kurumsal kapsam denetimi.
 * Kurumsal seçim Görevler ile aynı oturumluk seçimi kullanır ve yalnızca
 * kullanıcının zaten görebildiği görev kümesini daraltır.
 */
export function DateRangeFilter({ value, onChange, label = 'Tarih aralığı', summary = null }) {
  const preset = value?.preset || 'all';
  const keys = DATE_RANGE_PRESETS.map((item) => item.id);
  const allTasks = useTasks();
  const people = useAllPeople();
  const { selection, setSelection } = useSharedTaskOrganizationFilter();
  const organization = useTaskOrganizationFilter(allTasks, people, selection, setSelection);
  const organizationActive = hasOrgSelection(organization.selection);
  const organizationTaskIds = useMemo(
    () => organization.filteredTasks.map((task) => String(task.id)),
    [organization.filteredTasks]
  );

  useEffect(() => {
    const currentIds = Array.isArray(value?.organizationTaskIds) ? value.organizationTaskIds : null;
    const nextIds = organizationActive ? organizationTaskIds : null;
    if (sameIds(currentIds, nextIds)) return;
    const nextValue = { ...value };
    if (nextIds) nextValue.organizationTaskIds = nextIds;
    else delete nextValue.organizationTaskIds;
    onChange(nextValue);
  }, [onChange, organizationActive, organizationTaskIds, value]);

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
      <TaskOrganizationFilterControls organization={organization} />
      {preset === 'custom' && !(value?.start && value?.end) && (
        <span className="date-range-hint" role="status">
          Aralığı uygulamak için iki tarihi de seçin; şu an tüm zamanlar gösteriliyor.
        </span>
      )}
      {summary && <span className="date-range-summary">{summary}</span>}
    </div>
  );
}
