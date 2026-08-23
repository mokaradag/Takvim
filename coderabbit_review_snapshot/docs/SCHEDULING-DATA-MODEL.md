# Professional Scheduling Data Model

MERGEN Rota separates stored schedule facts from calculated schedule results. This distinction is the foundation for future SQL Server persistence, Primavera P6 integration, progress updating, baseline comparison and audit history.

## Conceptual model

```text
Project
├── dataDate
└── WBS hierarchy
      └── Task / Activity
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

The baseline branch in this diagram is conceptual: baseline values are not embedded in the mutable `Task` object. They are stored as separate `Baseline` and `TaskBaselineSnapshot` records. WBS is also a separate structural entity; WBS summary schedule values are derived from descendant Tasks and are not stored on WBS nodes.

## 1. Current Plan

The current plan is the editable schedule currently used by the application:

- `plannedStart`
- `plannedFinish`
- `plannedDurationDays`

`plannedStart` and `plannedFinish` are the authoritative editable current-plan dates. The primary Gantt activity bars, Calendar task ranges and current-plan date columns use these fields.

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

It is also **not** a row timestamp. Creation and modification times live in separate audit columns (`CreatedAt`, `UpdatedAt`, `MR_AuditLog`); `dataDate` answers a project-control question instead: through which day are the reported progress and actuals considered valid. It is what reporting and future progress-aware rescheduling status against.

Because that decision often comes later than the project record itself, `dataDate` is **optional**. Project creation and project updates succeed with an empty value, the UI labels the field as optional and explains the cut-off meaning, and the server only validates the format when a value is supplied. Corporate projects imported without a data date can therefore have their MERGEN-owned fields (colour, tag catalog, calendar) edited without first inventing a cut-off date.

The field is stored on the project now so future progress-aware scheduling has the correct domain foundation. The mock projects use an explicit fixed sample data date rather than deriving this field automatically from the browser clock. The current CPM engine remains a pure current-plan network calculation and does not yet use `dataDate`, actual dates or remaining duration for status updating or rescheduling.

## 6. Project, WBS and Task ownership

WBS establishes structural project ownership without changing scheduling semantics:

```text
Project.id
  └── WbsNode.projectId
        └── Task.wbsId
```

A canonical WBS node stores `id`, `projectId`, `parentId`, `code`, `name` and optionally `sortOrder`. Its parent, when present, must belong to the same Project. `Task.wbsId`, when present, must reference a WBS node whose `projectId` equals the Task's `projectId`.

When a Task changes Project, normalization cannot retain an old-project WBS. It uses the new Project's unique root when one unambiguous root exists; otherwise it leaves `wbsId` null for explicit assignment.

WBS hierarchy depth, paths, descendants, activity counts, progress and schedule ranges are derived. WBS nodes do not store Current Plan dates, CPM dates, float or progress rollups.

## 7. Baseline

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

The mock repository supplies one primary baseline for each existing project and snapshots for tasks present in the initial dataset. Normal Task CRUD and WBS edits never modify these records. A task created after that baseline exists is not automatically added to the historical snapshot.

Baseline values are not CPM results and are not recalculated when the current plan changes. Changing a Task's current WBS, renaming a WBS node or adding/removing a safe empty WBS node does not rewrite historical schedule snapshots. Historical WBS structure versioning is intentionally outside the current model.

## 8. Calculated CPM Schedule

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

The state schedule projection still calculates each Project independently. Project Workspace consumes the existing selected Project result; it does not calculate CPM per WBS. Cross-project dependency relationships remain explicitly unsupported by project-scoped CPM and produce deterministic project-level validation warnings.

## 9. WBS Gantt summaries

A Project-mode WBS summary row is derived presentation data, not a Task. When a WBS subtree contains scheduled activities, its Current Plan summary range is:

```text
earliest descendant plannedStart
        →
latest descendant plannedFinish
```

The same rollup may derive descendant activity count, completion progress and critical-activity count. These values are recomputed from canonical Tasks and the existing CPM projection and are never persisted on `WbsNode`.

A WBS summary bar must not be interpreted as CPM Early/Late schedule output. Current Plan, WBS rollup and CPM projection remain separate concepts.

## 10. Stored versus derived data

| Concept | Data | Storage semantics |
| --- | --- | --- |
| Project structure | WBS `id`, `projectId`, `parentId`, `code`, `name`, optional `sortOrder` | Stored, mutable structure |
| Task WBS assignment | `Task.wbsId` | Stored, mutable, same-project relationship |
| Current plan | `plannedStart`, `plannedFinish`, `plannedDurationDays` | Stored, mutable |
| Management target | `targetFinish` | Stored, mutable |
| Actuals | `actualStart`, `actualFinish` | Stored, mutable only through explicit user/data actions |
| Remaining duration | `remainingDurationDays` | Stored, mutable, independent of progress percentage |
| Project status cutoff | `dataDate` | Stored on Project, mutable, optional |
| Baseline | `Baseline`, `TaskBaselineSnapshot` | Stored immutable snapshot data under normal Task/WBS CRUD |
| WBS schedule summary | descendant date range, progress and counts | Derived, not written to WBS |
| CPM schedule | early/late dates, float, critical status | Derived, recomputed, not written back to Task |

## 11. Working-day duration semantics

All scheduling durations are working-day values unless explicitly documented otherwise.

- `plannedDurationDays` is normalized from the current-plan date range using the task's effective calendar.
- `remainingDurationDays` is a separate explicit planning input.
- CPM result `durationDays` is the duration used by that calculation and is derived from canonical current-plan input.
- Dependency `lagDays` and lead values continue to use working days.

Ordinary calendar-day subtraction must not be used as the canonical planned-duration calculation.

## 12. Legacy date-field migration

Legacy task input is accepted only at the dedicated data migration boundary:

```text
baslangicTarihi -> plannedStart
bitisTarihi     -> plannedFinish
hedefTarih      -> targetFinish
```

After migration, the legacy properties are deleted from the normalized task. Application state, scheduling code and feature components consume only canonical fields. The application does not maintain mirrored legacy and canonical date sources.

## 13. Validation contract

The domain validation layer reports meaningful schedule and hierarchy inconsistencies without silently rewriting user intent. Important checks include:

- planned finish before planned start;
- actual finish without actual start;
- actual finish before actual start;
- invalid or negative duration values;
- non-zero milestone planned duration;
- baseline finish before baseline start;
- duplicate WBS IDs;
- missing WBS parent;
- self-parenting WBS nodes;
- cross-project WBS parents;
- WBS cycles;
- Task-to-WBS project mismatch.

Normalization establishes structural defaults, same-project Task/WBS consistency and calendar-normalized planned duration; validation reports semantic inconsistencies that should be surfaced or handled explicitly.

## 14. Current limitations

This model intentionally does not yet implement:

- progress-aware CPM;
- data-date-driven rescheduling;
- actual-date-driven scheduling;
- formal scheduling constraints;
- baseline capture or re-baselining workflows;
- baseline version comparison;
- historical WBS versioning;
- WBS drag-and-drop/reparent history;
- cross-project CPM networks;
- resource leveling;
- earned value management;
- database or API persistence.

Those capabilities can now build on distinct Project/WBS/Activity relationships and separate current-plan, target, actual, remaining-duration, baseline, data-date, WBS-rollup and calculated-schedule semantics without redefining the core Task schedule model.
