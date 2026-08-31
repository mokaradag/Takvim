'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { createEmptyOrgFilter } from '../../domain/organization/organizationHierarchy.js';

const TaskOrganizationFilterContext = createContext(null);

/** Modlar ve görünüm yeniden montajları arasında yaşayan oturumluk görev kapsamı. */
export function TaskOrganizationFilterProvider({ children, initialSelection = null }) {
  const [selection, setSelection] = useState(
    () => initialSelection ? { ...initialSelection } : createEmptyOrgFilter()
  );
  const value = useMemo(() => ({ selection, setSelection }), [selection]);
  return (
    <TaskOrganizationFilterContext.Provider value={value}>
      {children}
    </TaskOrganizationFilterContext.Provider>
  );
}

export function useSharedTaskOrganizationFilter() {
  const value = useContext(TaskOrganizationFilterContext);
  if (!value) throw new Error('Görev kurumsal süzgeç sağlayıcısı bulunamadı.');
  return value;
}
