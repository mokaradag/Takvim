import { DEFAULT_CALENDAR } from '../../scheduling/calendars';

export const CALENDARS = [
  {
    ...DEFAULT_CALENDAR,
    workingDays: [...DEFAULT_CALENDAR.workingDays],
    holidays: DEFAULT_CALENDAR.holidays.map((holiday) => ({ ...holiday }))
  },
  {
    id: 'cal-tr-operations-2026',
    name: 'Türkiye Operasyon Takvimi 2026',
    timezone: 'Europe/Istanbul',
    workingDays: [1, 2, 3, 4, 5, 6],
    holidays: DEFAULT_CALENDAR.holidays.map((holiday) => ({ ...holiday }))
  }
];
