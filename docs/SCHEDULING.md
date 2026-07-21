# Scheduling Calendar Semantics

MERGEN Rota keeps calendar, dependency and CPM arithmetic in `src/scheduling` so scheduling calculations remain pure and independent of React, Next.js and the data adapter.

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
- `diffWorkingDays()`;
- `countWorkingDays()`.

`addWorkingDays(date, amount, calendar)` moves by working-day steps. Positive values move forward and negative values move backward. Weekends or explicit holidays are skipped according to the selected calendar.

`diffWorkingDays(a, b, calendar)` is defined so that, for a working-date start and an integer `n`:

```text
diffWorkingDays(addWorkingDays(start, n, calendar), start, calendar) === n
```

`countWorkingDays(start, end, calendar)` counts working dates inclusively and is used when CPM derives an activity duration from existing baseline dates.

These contracts are covered by unit tests and are the arithmetic foundation used by the CPM layer.

## Dependency lag and lead

The existing canonical dependency field remains `lagDays`, but scheduling interprets it as working days:

- positive `lagDays` = lag;
- negative `lagDays` = lead.

Use `applyDependencyLag()` instead of adding calendar days directly. The helper applies the selected scheduling calendar and skips non-working dates.

## Data and state boundary

Scheduling calendars are part of the repository snapshot alongside projects, people, WBS and tasks. Projects carry a `calendarId`; tasks may optionally override it with their own `calendarId`.

The mock adapter is only one provider of this data. A future API/database adapter should return the same calendar objects and stable IDs so feature-facing state hooks remain unchanged.

## CPM engine

The pure CPM implementation lives under `src/scheduling/cpm` and consumes the calendar contracts above. It provides:

- dependency graph validation and cycle detection;
- FS, SS, FF and SF constraints;
- positive lag and negative lead in working days;
- project/task calendar resolution;
- forward and backward passes;
- early and late dates;
- total and free float;
- one or multiple critical paths;
- milestone and zero-duration activity handling.

Detailed input, relationship and output semantics are documented in `docs/CPM.md`.

## Application schedule projection

The application consumes CPM through `src/state/selectors/scheduleSelectors.js` rather than calling `calculateCpm()` from feature components.

The projection calculates each project independently and then combines successful results for portfolio-level lookup. This prevents one project's finish date from affecting another project's float. CPM validation failures are captured per project, while unrelated projects remain usable.

Cross-project dependencies are currently reported as `CROSS_PROJECT_DEPENDENCY` and the affected project is excluded from CPM until a future portfolio-network model defines those semantics.

CPM output remains derived data. Early/late dates, float and critical status are not written into canonical task objects. The Gantt continues to position its primary bars from stored task dates and overlays CPM information separately.
