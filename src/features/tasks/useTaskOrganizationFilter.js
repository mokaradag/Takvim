'use client';

import { useCallback, useEffect, useMemo } from 'react';
import {
  applyOrgSelection,
  orgLevelOptions,
  pruneOrgSelectionForPeople,
  sameOrgSelection
} from '../../domain/organization/organizationHierarchy.js';
import {
  createTaskAssigneeOrganizationIndex,
  filterTasksByOrganization,
  organizationPeopleForTasks
} from '../../domain/organization/taskOrganizationFilter.js';

/** Görev görünümlerinin ortak kurumsal süzgeci. */
export function useTaskOrganizationFilter(tasks, people, selection, onSelectionChange) {
  const peopleIndex = useMemo(() => createTaskAssigneeOrganizationIndex(people), [people]);
  // Görev kapsamındaki çakışmaları bir kez saptar; süzgeç yine güvenli biçimde eşleşmez.
  const hasIdentityConflicts = useMemo(
    () => (tasks || []).some((task) => (Array.isArray(task.assigneeIds) ? task.assigneeIds : [])
      .some((id) => peopleIndex.ambiguousIds.has(String(id ?? '').trim()))),
    [tasks, peopleIndex]
  );
  const organizationPeople = useMemo(
    () => organizationPeopleForTasks(tasks, peopleIndex),
    [tasks, peopleIndex]
  );
  const safeSelection = useMemo(
    () => pruneOrgSelectionForPeople(selection, organizationPeople),
    [selection, organizationPeople]
  );

  useEffect(() => {
    if (!sameOrgSelection(selection, safeSelection)) onSelectionChange(safeSelection);
  }, [selection, safeSelection, onSelectionChange]);

  const selectLevel = useCallback((level, value) => {
    onSelectionChange(applyOrgSelection(safeSelection, level, value));
  }, [safeSelection, onSelectionChange]);

  const filteredTasks = useMemo(
    () => filterTasksByOrganization(tasks, safeSelection, peopleIndex),
    [tasks, safeSelection, peopleIndex]
  );
  const directorateOptions = useMemo(
    () => orgLevelOptions(organizationPeople, 'directorate', safeSelection),
    [organizationPeople, safeSelection]
  );
  const departmentOptions = useMemo(
    () => orgLevelOptions(organizationPeople, 'department', safeSelection),
    [organizationPeople, safeSelection]
  );
  const unitOptions = useMemo(
    () => orgLevelOptions(organizationPeople, 'unit', safeSelection),
    [organizationPeople, safeSelection]
  );

  return {
    selection: safeSelection,
    hasIdentityConflicts,
    selectLevel,
    filteredTasks,
    directorateOptions,
    departmentOptions,
    unitOptions
  };
}
