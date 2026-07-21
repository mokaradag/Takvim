# Professional Scheduling Data Model

MERGEN Rota separates stored schedule facts from calculated schedule results. This distinction is the foundation for future SQL Server persistence, Primavera P6 integration, progress updating, baseline comparison and audit history.

## Conceptual model

```text
Project
└── dataDate

Task
│
├── Current Plan
│     ├── plannedStart
│     ├── plannedFinish
│     └── plannedDurationDays
│
├── Target
│     └── targetFinish
│
├── Actuals
│     ├── actualStart
│     └── actualFinish
│
├── Progress Planning
│     └── remainingDurationDays
│
├── Baseline Snapshot (separate entity)
│     ├── plannedStart
│     ├── plannedFinish
│     ├── plannedDurationDays
│     └── calendarId
│
└── Calculated CPM Schedule (derived projection)
      ├── earlyStart
      ├── earlyFinish
      ├── lateStart
      ├── lateFinish
      ├── totalFloatDays
      └── freeFloatDays
```

The baseline branch in this diagram is conceptual: baseline values are not embedded in the mutable `Task` object. They are stored as separate `Baseline` and `TaskBaselineSnapshot` records.

## 1. Current Plan

The current plan is the editable schedule currently used by the application:

- `plannedStart`
- `plannedFinish`
- `plannedDurationDays`

`plannedStart` and `plannedFinish` are the authoritative editable current-plan dates. The primary Gantt bars, Calendar task ranges and current-plan date columns use these fields.

`plannedDurationDays` is the inclusive working-day duration of the current plan under the task's effective scheduling calendar. The normalization boundary recalculates it from `plannedStart` and `plannedFinish` whenever a task is loaded or updated so the stored duration does not become stale. Milestones always have a planned duration of zero.

Changing the current plan does not change actual dates and does not rewrite any baseline snapshot.

## 2. Target Finish

`targetFinish` is a management target or deadline. Existing overdue logic uses this field and excludes completed tasks according to the existing application behavior.

`targetFinish` is not a CPM scheduling constraint. The CPM engine does not interpret it as Must Finish On, Finish No Later Than or another scheduling constraint. A future constraint model must represent those concepts explicitly.

## 3. Actuals

Observed execution dates are represented independently:

- `actualStart`
- `actualFinish`

Valid states are:

- neither date recorded;
- `actualStart` recorded without `actualFinish`;
- both dates recorded.

`actualFinish` without `actualStart` is reported as a validation issue, and an `actualFinish` earlier than `actualStart` is invalid.

Actual dates are explicit data. MERGEN Rota does not fabricate them from task status, progress percentage, the browser's current date or planned dates. Changing a task to `in_progress` does not set `actualStart`, and changing it to `done` does not set `actualFinish`.

## 4. Remaining Duration

`remainingDurationDays` is an independent planning input measured in working days. It is not derived from percentage complete.

The application does not apply a formula such as:

```text
remaining duration = planned duration × (1 - progress)
```

For a newly created, not-yet-started task, the state boundary initializes remaining duration from its normalized planned duration. Existing migrated tasks may keep `remainingDurationDays` as `null` when no explicit remaining-duration information exists.

## 5. Project Data Date

`Project.dataDate` is the project status/cutoff date: the point in time through which project status is considered current.

It is distinct from:

- today's browser date;
- `targetFinish`;
- a baseline creation date;
- the current-plan finish;
- the CPM-calculated project finish.

The field is stored on the project now so future progress-aware scheduling has the correct domain foundation. The mock projects use an explicit fixed sample data date rather than deriving this field automatically from the browser clock. The current CPM engine remains a pure current-plan network calculation and does not yet use `dataDate`, actual dates or remaining duration for status updating or rescheduling.

## 6. Baseline

A baseline is immutable historical snapshot data, not another mutable pair of fields on `Task`.

`Baseline` identifies a project-level snapshot set:

- `id`
- `projectId`
- `name`
- `createdAt`
- `isPrimary`

`TaskBaselineSnapshot` stores the schedule state captured for one task in one baseline:

- `baselineId`
- `taskId`
- `plannedStart`
- `plannedFinish`
- `plannedDurationDays`
- `calendarId`

The mock repository supplies one primary baseline for each existing project and snapshots for tasks present in the initial dataset. Normal task CRUD never modifies these records. A task created after that baseline exists is not automatically added to the historical snapshot.

Baseline values are not CPM results and are not recalculated when the current plan changes. Baseline capture, re-baselining, deletion and multi-baseline comparison are intentionally outside this PR.

## 7. Calculated CPM Schedule

CPM output remains derived application schedule state. `CpmTaskResult` can contain:

- `earlyStart`
- `earlyFinish`
- `lateStart`
- `lateFinish`
- `totalFloatDays`
- `freeFloatDays`
- `isCritical`
- `durationDays`, meaning the working-day duration used by that CPM calculation.

These values are not copied into canonical `Task` objects and are not persisted as normal task fields. The application flow remains:

```text
Canonical Task Current Plan
          │
          ▼
     Pure CPM Engine
          │
          ▼
Derived Schedule Projection
```

The state schedule projection still calculates each project independently. Cross-project dependency relationships remain explicitly unsupported by project-scoped CPM and produce deterministic project-level validation warnings.

## 8. Stored versus derived data

| Concept | Data | Storage semantics |
| --- | --- | --- |
| Current plan | `plannedStart`, `plannedFinish`, `plannedDurationDays` | Stored, mutable |
| Management target | `targetFinish` | Stored, mutable |
| Actuals | `actualStart`, `actualFinish` | Stored, mutable only through explicit user/data actions |
| Remaining duration | `remainingDurationDays` | Stored, mutable, independent of progress percentage |
| Project status cutoff | `dataDate` | Stored on Project, mutable |
| Baseline | `Baseline`, `TaskBaselineSnapshot` | Stored immutable snapshot data under normal task CRUD |
| CPM schedule | early/late dates, float, critical status | Derived, recomputed, not written back to Task |

## 9. Working-day duration semantics

All scheduling durations are working-day values unless explicitly documented otherwise.

- `plannedDurationDays` is normalized from the current-plan date range using the task's effective calendar.
- `remainingDurationDays` is a separate explicit planning input.
- CPM result `durationDays` is the duration used by that calculation and is derived from canonical current-plan input.
- Dependency `lagDays` and lead values continue to use working days.

Ordinary calendar-day subtraction must not be used as the canonical planned-duration calculation.

## 10. Legacy date-field migration

Legacy task input is accepted only at the dedicated data migration boundary:

```text
baslangicTarihi -> plannedStart
bitisTarihi     -> plannedFinish
hedefTarih      -> targetFinish
```

After migration, the legacy properties are deleted from the normalized task. Application state, scheduling code and feature components consume only canonical fields. The application does not maintain mirrored legacy and canonical date sources.

## 11. Validation contract

The domain validation layer reports meaningful schedule inconsistencies without silently rewriting user intent. Important checks include:

- planned finish before planned start;
- actual finish without actual start;
- actual finish before actual start;
- invalid or negative duration values;
- non-zero milestone planned duration;
- baseline finish before baseline start.

Normalization establishes structural defaults and calendar-normalized planned duration; validation reports semantic inconsistencies that should be surfaced or handled explicitly.

## 12. Current limitations

This model intentionally does not yet implement:

- progress-aware CPM;
- data-date-driven rescheduling;
- actual-date-driven scheduling;
- formal scheduling constraints;
- baseline capture or re-baselining workflows;
- baseline version comparison;
- cross-project CPM networks;
- resource leveling;
- earned value management;
- database or API persistence.

Those capabilities can now build on distinct current-plan, target, actual, remaining-duration, baseline, data-date and calculated-schedule semantics without redefining the core Task schedule model.
