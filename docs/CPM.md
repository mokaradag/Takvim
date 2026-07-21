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

## Scope of this engine PR

This layer provides the scheduling engine and regression tests only. It intentionally does not yet:

- modify task baseline dates automatically;
- persist CPM results;
- display critical paths in the Gantt view;
- add schedule-warning UI;
- model working hours or partial-day calendars;
- resource-level activities.

The next integration step should consume `calculateCpm()` from the state/feature boundary and add Gantt visualization without moving CPM calculations into React components.
