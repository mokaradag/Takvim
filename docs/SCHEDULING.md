# Scheduling Calendar Semantics

MERGEN Rota keeps calendar, current-plan normalization, dependency and CPM arithmetic in `src/scheduling` so scheduling calculations remain pure and independent of React, Next.js and the data adapter.

The professional stored/derived scheduling model is documented in `docs/SCHEDULING-DATA-MODEL.md`.

## Calendar model

A scheduling calendar has:

- a stable `id`;
- a display `name`;
- a `timezone` identifier;
- `workingDays` using JavaScript weekday numbers (`0` Sunday through `6` Saturday);
- `holidays` expressed as explicit `YYYY-MM-DD` dates.

Holiday dates are intentionally year-specific. Movable holidays must not be stored as recurring `MM-DD` values because that would silently mark the wrong dates as non-working in later years.

`workingDays` must contain at least one weekday. An empty list is not a valid
configuration: the SQL projection emits `workingDays: []` for a calendar that has
no rows in `MR_CalendarWorkingDays`, and with such a list every working-day
search is unsatisfiable. `isWorkingDay()` and `normalizeCalendar()` therefore
treat an empty list as the default Monday-Friday week.

The fallback calendar ships the fixed-date Turkish national holidays through
2028. Movable religious holidays (Ramazan, Kurban) are announced officially and
are **not** guessed for future years; a deployment supplies them through its own
`MR_CalendarHolidays` rows.

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

`countWorkingDays(start, end, calendar)` counts working dates inclusively. Current-plan normalization uses it to calculate `plannedDurationDays` from `plannedStart` and `plannedFinish` under the task's effective calendar. CPM can use the same current-plan dates as a duration fallback when an explicit canonical planned duration is not supplied.

`calculatePlannedDurationDays()` clamps a valid non-milestone range to at least
one day. A single-day task that falls on a weekend or holiday counts zero working
days; reporting `0` made the task render as a milestone in Gantt group summaries
and dropped its progress weight.

### Termination guarantees

Every working-day search is **bounded**. The helpers used to loop unconditionally,
so two ordinary inputs froze the browser tab outright — the reported "the app
freezes when I press Tamam" defect:

- a calendar whose `workingDays` list is empty (see above) made `isWorkingDay()`
  return `false` for every date, and `moveToWorkingDay()` / `addWorkingDays()`
  never terminated. `createNewTask()` calls `moveToWorkingDay()`, so creating a
  task in such a project hung the whole tab;
- a value `parseDate()` cannot resolve produces an Invalid Date, whose
  `getTime()` is `NaN`. `diffWorkingDays()` compares timestamps for equality, so
  its loop never ended either.

The contract now is:

- an unresolvable date returns the input unchanged (`moveToWorkingDay`,
  `addWorkingDays`) or `0` (`diffWorkingDays`, `countWorkingDays`);
- every scan stops after `MAX_CALENDAR_SCAN_DAYS` (about ten years) and falls
  back to the input rather than looping;
- `parseDate()` accepts an ISO string that carries a time part
  (`2026-08-18T00:00:00.000Z`) and returns an Invalid Date — never a silent
  "today" — for anything it cannot resolve. `isValidDate()` is exported for
  callers that need to tell the two apart.

These contracts are covered by unit tests (`test/task-dialog-freeze-regressions.test.mjs`)
and are the arithmetic foundation used by the current-plan and CPM layers.

## Duration semantics

All scheduling durations are working-day values unless explicitly documented otherwise.

- `Task.plannedDurationDays` is the normalized duration of the mutable current plan.
- `Task.remainingDurationDays` is an independent explicit planning input and is not calculated from `progress`.
- `CpmTaskResult.durationDays` is the working-day duration used by that particular CPM calculation.
- `Dependency.lagDays` is a working-day lag/lead value.

Canonical planned duration must not be calculated with ordinary calendar-day subtraction. Milestones have zero planned duration.

## Dependency lag and lead

The canonical dependency field remains `lagDays`, but scheduling interprets it as working days:

- positive `lagDays` = lag;
- negative `lagDays` = lead.

Use `applyDependencyLag()` instead of adding calendar days directly. The helper applies the selected scheduling calendar and skips non-working dates.

`lagValue`/`lagUnit` is the source of truth and `lagDays` is the derived cache.
`normalizeDependency()` therefore takes the **calendar** as a parameter and
converts week and month units with it; converting with the default calendar
wrote a `lagDays` value that disagreed with the date scheduling actually applied
on a six-day calendar, and consumers that read `lagDays` directly (the
cross-project dependency report, for example) reported a lag that did not match
the plan. `normalizeTaskRecord()` resolves the task's own calendar and passes it
through.

`dependencyLagDays()` is a **pure read**: it never writes to the dependency it
inspects. Dependencies come from task records held in application state, so an
in-place write changed state outside the reducer and left equality checks on
`task.deps` reporting "unchanged" while the content differed. The legacy
completion — filling `lagValue` from a stored `lagDays` when the record carries a
unit but no explicit value — moved to `materializeDependencyLag()`, which returns
a **copy** and is called only from the editor write paths (`TaskDrawer.updateDep`,
`planSuccessorUpdate`).

## Predecessors and successors

A dependency edge is stored **once**, on the successor: `B.deps` containing `A`
means "A is a predecessor of B". There is no `successors` field, and there must
not be one — the same edge held in two places will eventually disagree.

"Successor" is therefore a **reading direction**, not a second data shape. The
Task Detail relations editor exposes both directions:

- the *Öncüller* tab edits `task.deps` directly;
- the *Ardıllar* tab edits the **other** task's `deps` and is patched through
  `updateTask(successorId, …)`.

`src/features/task-detail/taskSuccessorPolicy.js` owns that translation as a pure
module: it derives successors by scanning for the reverse reference, produces the
patch for link/unlink/type-and-lag changes, and rejects an edge that would create
a cycle. The cycle check walks the transitive predecessor closure of the current
task; candidates already in that closure are filtered out of the picker, so the
user cannot make a selection that would be refused. The traversal marks visited
nodes, so it terminates even against already-cyclic stored data.

## Task priority

`Task.priority` is canonicalized at the data boundary (`normalizePriorityId`) to
one of `critical` / `high` / `medium` / `low`; unknown and legacy values map to
`medium`. Priority is **not** a scheduling constraint — it does not influence CPM
or dates — but it drives the Görevler, Gantt, Kanban and Raporlar risk views.

The field was previously read-only everywhere: every list rendered and filtered
it, but no screen could set it, so every task kept the default. It is now edited
in the Task Detail **Öncelik** section.

## Professional schedule concepts

The current scheduling model distinguishes:

- current plan: `plannedStart`, `plannedFinish`, `plannedDurationDays`;
- management target: `targetFinish`;
- actuals: `actualStart`, `actualFinish`;
- remaining planning input: `remainingDurationDays`;
- project status cutoff: `Project.dataDate`;
- immutable historical baseline snapshots;
- derived CPM results.

`targetFinish` is not a scheduling constraint. Actual dates are not inferred from status. Remaining duration is not inferred from percentage complete.

## Data and state boundary

Scheduling calendars, projects, canonical tasks, baselines and task baseline snapshots are part of the repository snapshot. Projects carry `calendarId` and `dataDate`; tasks may optionally override the project calendar with their own `calendarId`.

The mock adapter is only one provider of this data. A future API/database adapter should return the same stable semantic shapes so feature-facing state hooks remain unchanged.

Legacy schedule property names are normalized once at the data boundary and do not propagate into state, scheduling calculations or features.

## CPM engine

The pure CPM implementation lives under `src/scheduling/cpm` and consumes canonical current-plan data plus the calendar contracts above. It provides:

- dependency graph validation and cycle detection;
- FS, SS, FF and SF constraints;
- positive lag and negative lead in working days;
- project/task calendar resolution;
- forward and backward passes;
- early and late dates;
- total and free float;
- one or multiple critical paths;
- milestone and zero-duration activity handling.

The engine does not currently apply `actualStart`, `actualFinish`, `remainingDurationDays` or `Project.dataDate` to progress-aware rescheduling. Detailed input, relationship and output semantics are documented in `docs/CPM.md`.

## Application schedule projection

The application consumes CPM through `src/state/selectors/scheduleSelectors.js` rather than calling `calculateCpm()` from feature components.

The projection calculates each project independently and then combines successful results for portfolio-level lookup. This prevents one project's finish date from affecting another project's float. CPM validation failures are captured per project, while unrelated projects remain usable.

Cross-project dependencies are currently reported as `CROSS_PROJECT_DEPENDENCY` and the affected project is excluded from CPM until a future portfolio-network model defines those semantics.

CPM output remains derived data. Early/late dates, float and critical status are not written into canonical task objects. The Gantt continues to position its primary bars from the mutable current plan and overlays CPM information separately.
