import { Icons } from '../../components/icons.jsx';
import { fmt } from '../../scheduling/dates/index.js';
import { effectiveTaskDate } from './taskDisplayValues.js';

export function TaskDate({ task, field }) {
  const actual = field === 'plannedStart' ? task.actualStart : field === 'plannedFinish' ? task.actualFinish : null;
  const label = field === 'plannedStart' ? 'Gerçekleşen başlangıç' : 'Gerçekleşen bitiş';
  return <span className="task-effective-date">
    {fmt(effectiveTaskDate(task, field))}
    {actual && <span className="task-actual-marker" title={label} role="img" aria-label={label}><Icons.Check size={11} /></span>}
  </span>;
}
