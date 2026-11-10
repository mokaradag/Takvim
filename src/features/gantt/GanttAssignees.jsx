'use client';
import { Avatar } from '../../components/ui';
import { usePersonLookup } from '../../components/PeopleDirectoryContext.jsx';
import { ganttAssigneeEntries } from './ganttAssignees.js';

export function GanttAssignees({ task }) {
  const lookup = usePersonLookup();
  const entries = ganttAssigneeEntries(task, lookup);
  return (
    <div className="rt-row gantt-assignee-row">
      <span className="rt-label">Sorumlu</span>
      <span className="rt-val gantt-assignee-list">
        {entries.length ? entries.map((entry) => (
          <span className="gantt-assignee" key={entry.key}>
            <Avatar name={entry.name} person={entry.person} lookupPerson={false} size="sm" />
            <span>{entry.name}</span>
          </span>
        )) : '—'}
      </span>
    </div>
  );
}
