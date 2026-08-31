'use client';

import { useSyncExternalStore } from 'react';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { Icons } from '../../components/icons.jsx';
import { hasOrgSelection, UNASSIGNED_DIRECTORATE } from '../../domain/organization/organizationHierarchy.js';

const COMPACT_LAYOUT_QUERY = '(max-width: 1280px)';

function subscribeToLayoutChange(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(COMPACT_LAYOUT_QUERY);
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }
  media.addListener?.(onChange);
  return () => media.removeListener?.(onChange);
}

function compactLayoutSnapshot() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

function optionList(options, allLabel) {
  return [
    { value: '', label: allLabel, icon: <Icons.Layers size={12} /> },
    ...options.map((option) => ({
      ...option,
      icon: option.value === UNASSIGNED_DIRECTORATE
        ? <Icons.Users size={12} />
        : <Icons.Briefcase size={12} />
    }))
  ];
}

export function TaskOrganizationFilterControls({ organization }) {
  const compactLayout = useSyncExternalStore(
    subscribeToLayoutChange,
    compactLayoutSnapshot,
    () => false
  );
  const active = hasOrgSelection(organization.selection);
  const activeCount = ['directorate', 'department', 'unit']
    .filter((level) => Boolean(organization.selection[level])).length;

  const controls = (variant) => (
    <div className={`task-org-filters task-org-filters-${variant}`} aria-label="Kurumsal görev filtreleri">
      <SearchableSelect
        className="task-org-select"
        value={organization.selection.directorate}
        options={optionList(organization.directorateOptions, 'Tüm direktörlükler')}
        onChange={(value) => organization.selectLevel('directorate', value)}
        searchPlaceholder="Direktörlük ara"
        ariaLabel="Direktörlük filtresi"
        compact
      />
      <SearchableSelect
        className="task-org-select"
        value={organization.selection.department}
        options={optionList(organization.departmentOptions, 'Tüm müdürlükler')}
        onChange={(value) => organization.selectLevel('department', value)}
        searchPlaceholder="Müdürlük ara"
        ariaLabel="Müdürlük filtresi"
        disabled={organization.departmentOptions.length === 0}
        compact
      />
      <SearchableSelect
        className="task-org-select"
        value={organization.selection.unit}
        options={optionList(organization.unitOptions, 'Tüm birimler')}
        onChange={(value) => organization.selectLevel('unit', value)}
        searchPlaceholder="Birim ara"
        ariaLabel="Birim filtresi"
        disabled={organization.unitOptions.length === 0}
        compact
      />
    </div>
  );

  if (compactLayout) {
    return (
      <details className={`task-org-overflow${active ? ' is-active' : ''}`}>
        <summary className="btn ghost sm" aria-label="Kurumsal görev filtrelerini aç">
          <Icons.Filter size={12} /> Kurumsal filtre{activeCount ? ` (${activeCount})` : ''}
        </summary>
        <div className="task-org-overflow-panel">{controls('compact')}</div>
      </details>
    );
  }
  return controls('direct');
}
