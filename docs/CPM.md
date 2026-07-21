# CPM and Critical-Path Engine

The CPM implementation lives under `src/scheduling/cpm` and is intentionally pure. It does not import React, Next.js, application state, the mock repository, or feature UI.

## Public API

```js
import { calculateCpm, buildDependencyGraph, CpmValidationError } from './src/scheduling/cpm/index.js';
```

`calculateCpm(tasks, options)` accepts:

- `tasks`: activities with stable IDs and canonical dependencies;
- `projects`: project records used to resolve project calendars;
- `calendars`: scheduling calendars;
- `projectStart`: optional schedule anchor date;
- `fallbackCalendar`: optional fallback calendar.

If `projectStart` is omitted, the engine uses the earliest available task baseline start date.

## Activity duration

The engine determines working-day duration in this order:

1. explicit numeric `task.durationDays`;
2. zero for `task.milestone === true`;
3. inclusive working-day count between `baslangicTarihi` and `bitisTarihi` using the activity's effective calendar.

An explicit `durationDays` value is useful for CPM scenarios that are independent from the current baseline dates. Existing application tasks can continue to derive their duration from baseline dates.

## Calendar resolution

Every activity resolves its effective calendar through the scheduling-calendar contract:

1. task-level `calendarId` override;
2. project `calendarId`;
3. fallback calendar.

Durations, schedule movement and dependency lag/lead use working-day helpers from `src/scheduling/calendars`.

## Relationship semantics

The engine supports all four dependency types:

- `FS`: Finish-to-Start;
- `SS`: Start-to-Start;
- `FF`: Finish-to-Finish;
- `SF`: Start-to-Finish.

The schedule uses date-only, inclusive activity dates. Therefore a zero-lag `FS` relationship places the successor on the next working day after the predecessor's finish. `lagDays` is measured in working days:

- positive values add lag;
- negative values create lead/overlap.

Relationship constraints use the successor activity's effective calendar when translating lag/lead into dates. This keeps successor placement consistent with the calendar on which the successor can actually work.

## Forward pass

The forward pass follows topological dependency order and calculates:

- Early Start (`earlyStart`);
- Early Finish (`earlyFinish`).

Each activity starts no earlier than the project start and no earlier than any incoming dependency constraint.

## Backward pass

The backward pass starts from the calculated project finish and processes activities in reverse topological order. It calculates:

- Late Start (`lateStart`);
- Late Finish (`lateFinish`).

The engine then calculates:

- Total Float (`totalFloatDays`);
- Free Float (`freeFloatDays`);
- critical status (`isCritical`).

An activity is currently classified as critical when `totalFloatDays <= 0`.

## Critical paths

The result includes:

- `criticalTaskIds`: all zero-or-negative-float activities;
- `criticalPaths`: dependency paths connecting critical activities through zero-slack relationships.

Multiple critical paths can therefore be returned when parallel paths have equal controlling duration.

## Result shape

`calculateCpm()` returns:

```text
projectStart
projectFinish
orderedTaskIds
criticalTaskIds
criticalPaths
tasks
  <taskId>
    id
    calendarId
    durationDays
    earlyStart
    earlyFinish
    lateStart
    lateFinish
    totalFloatDays
    freeFloatDays
    isCritical
```

Dates are returned as local `YYYY-MM-DD` strings.

## Graph validation

The dependency graph is validated before scheduling. `CpmValidationError` includes a stable `code` and optional `details`.

Current validation codes include:

- `MISSING_TASK_ID`;
- `DUPLICATE_TASK_ID`;
- `MISSING_PREDECESSOR`;
- `SELF_DEPENDENCY`;
- `DEPENDENCY_CYCLE`;
- `MISSING_TASK_DATE`;
- `INVALID_TASK_DATE`;
- `INVALID_TASK_DATES`;
- `MISSING_PROJECT_START`;
- `INVALID_PROJECT_START`.

Invalid networks fail before partial CPM results are returned.

## Application integration

The CPM engine remains a scheduling service. Application integration is owned by `src/state/selectors/scheduleSelectors.js` and memoized by `AppStateProvider`.

The state projection:

- partitions tasks by `projectId`;
- calls `calculateCpm()` independently for each project;
- combines successful task results into a portfolio-level derived lookup;
- preserves project-level `criticalTaskIds`, `criticalPaths` and calculated finish dates;
- isolates validation failures so one malformed project does not prevent other projects from rendering;
- reports cross-project dependencies explicitly as `CROSS_PROJECT_DEPENDENCY` instead of silently producing an invalid project-scoped calculation.

Feature components consume the derived projection through state hooks. They do not call `calculateCpm()` directly and do not copy CPM mathematics into React.

The Gantt integration keeps existing stored task bars as the primary visual schedule. CPM results are presented as derived overlays: critical task/relationship styling, optional early/late/float columns, critical-only filtering, project calculated finish information, CPM tooltips and validation warnings.

Calculated CPM fields are not persisted or merged into canonical task objects. A future scheduling-data-model PR is expected to formalize baseline, current-plan, actual and calculated schedule semantics before calculated dates can become an editable canonical source.

## Remaining engine scope

The engine and current application projection still intentionally do not:

- modify task baseline/stored dates automatically;
- persist CPM results;
- model cross-project dependency networks;
- model working hours or partial-day calendars;
- resource-level activities.
