import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/features/calendar/CalendarView.jsx';
let source = readFileSync(path, 'utf8');

const oldImport = "import { HOLIDAYS, holidayFor } from '../../scheduling/calendars';";
const newImport = "import { DEFAULT_CALENDAR, holidayFor } from '../../scheduling/calendars';";
if (!source.includes(oldImport)) throw new Error('CalendarView holiday import marker not found.');
source = source.replace(oldImport, newImport);

const oldCount = `{HOLIDAYS.filter(h => {
              const [m] = h.date.split('-');
              return parseInt(m) === month.getMonth() + 1;
            }).length} resmi tatil`;
const newCount = `{DEFAULT_CALENDAR.holidays.filter((holiday) => {
              const holidayDate = parseDate(holiday.date);
              return holidayDate.getFullYear() === month.getFullYear()
                && holidayDate.getMonth() === month.getMonth();
            }).length} resmi tatil`;
if (!source.includes(oldCount)) throw new Error('CalendarView holiday count marker not found.');
source = source.replace(oldCount, newCount);

writeFileSync(path, source);
