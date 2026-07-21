# Scheduling Calendar Semantics

MERGEN Rota keeps calendar and dependency arithmetic in `src/scheduling` so future CPM/critical-path calculations can remain pure and independent of React, Next.js and the data adapter.

## Calendar model

A scheduling calendar has:

- a stable `id`;
- a display `name`;
- a `timezone` identifier;
- `workingDays` using JavaScript weekday numbers (`0` Sunday through `6` Saturday);
- `holidays` expressed as explicit `YYYY-MM-DD` dates.

Holiday dates are intentionally year-specific. Movable holidays must not be stored as recurring `MM-DD` values because that would silently mark the wrong dates as non-working in later years.

The current mock adapter supplies two calendars:

- `cal-tr-standard-2026`: Monday-Friday;
- `cal-tr-operations-2026`: Monday-Saturday.

Both currently use the same explicit 2026 holiday list. Half-day exceptions and working-hour shifts are outside this foundation and should be modeled explicitly later rather than approximated as full non-working days.

## Calendar selection

Calendar resolution follows this order:

1. a task-level `calendarId` override;
2. the task's project's `calendarId`;
3. the scheduling fallback calendar.

Feature components should not reimplement this lookup. Use `resolveTaskCalendar()` or `resolveProjectCalendar()` from `src/scheduling/calendars`.

## Working-day arithmetic

The calendar layer exposes pure helpers for:

- `isWorkingDay()`;
- `holidayFor()`;
- `moveToWorkingDay()`;
- `addWorkingDays()`;
- `diffWorkingDays()`.

`addWorkingDays(date, amount, calendar)` moves by working-day steps. Positive values move forward and negative values move backward. Weekends or explicit holidays are skipped according to the selected calendar.

`diffWorkingDays(a, b, calendar)` is defined so that, for a working-date start and an integer `n`:

```text
diffWorkingDays(addWorkingDays(start, n, calendar), start, calendar) === n
```

This invariant is covered by unit tests and is the arithmetic contract the CPM layer should use.

## Dependency lag and lead

The existing canonical dependency field remains `lagDays`, but scheduling interprets it as working days:

- positive `lagDays` = lag;
- negative `lagDays` = lead.

Use `applyDependencyLag()` instead of adding calendar days directly. The helper applies the selected task/project calendar and skips non-working dates.

## Data and state boundary

Scheduling calendars are part of the repository snapshot alongside projects, people, WBS and tasks. Projects carry a `calendarId`; tasks may optionally override it with their own `calendarId`.

The mock adapter is only one provider of this data. A future API/database adapter should return the same calendar objects and stable IDs so feature-facing state hooks remain unchanged.

## CPM follow-up

The CPM engine should build on these calendar contracts rather than introducing separate date arithmetic. Forward/backward passes should resolve each activity's effective calendar and use working-day helpers for durations and dependency lag/lead.

The CPM layer should add explicit handling and tests for:

- dependency graph validation and cycle detection;
- FS, SS, FF and SF constraints;
- positive lag and negative lead;
- project/task calendar overrides;
- forward and backward passes;
- early/late dates;
- total and free float;
- one or multiple critical paths;
- milestones and zero-duration activities.
