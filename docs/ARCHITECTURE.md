# MERGEN Rota Architecture

MERGEN Rota is organized so feature UI does not own the global dataset and does not care whether data comes from mock JavaScript, an API, or a future SQL-backed service.

## Dependency direction

The intended direction is:

`domain <- scheduling <- data <- state <- features <- app/shell`

Shared visual components are used by features, but they do not import application state or the mock seed.

## Layers

### `src/domain`

Business concepts and data-shape rules that are independent from React and the browser. `models` documents Project, Task/Activity, Dependency, Person, WBS, Baseline and TaskBaselineSnapshot shapes with JSDoc.

Canonical Task scheduling data uses `plannedStart`, `plannedFinish`, `plannedDurationDays`, `targetFinish`, `actualStart`, `actualFinish` and `remainingDurationDays`. Project status cutoff is represented by `Project.dataDate`. CPM results are documented separately as derived `CpmTaskResult` data and are not part of canonical Task state.

Stable relationships use IDs such as `projectId`, `assigneeIds`, `predecessorId`, `wbsId`, `baselineId` and `taskId`. The current mock adapter still retains non-scheduling legacy display fields such as `proje` and `sorumlu` where the UI uses them.

WBS is a separate structural domain entity. Shared pure selectors own hierarchy construction, deterministic ordering, descendants, ancestors, paths, flattening and Task subtree rollups. Domain validation owns duplicate-ID, missing-parent, self-parent, cross-project-parent and cycle rules. A Task's `wbsId`, when present, must resolve to a WBS node owned by the same `projectId`.

### `src/scheduling`

Pure scheduling logic. `dates` owns parsing, formatting and date-range helpers; `calendars` owns holiday/working-day rules; `dependencies` owns FS/SS/FF/SF metadata and normalization; `plans` owns canonical current-plan duration normalization; `metrics` owns schedule-derived calculations used by Gantt and task status summaries; `cpm` owns the calendar-aware critical-path engine, forward/backward passes, early/late dates, float and critical paths. Scheduling remains independent from React and application state.

WBS does not create independent scheduling networks. CPM remains project-scoped. WBS summary dates and bars are derived from descendant Current Plan values and do not replace CPM output.

### `src/data`

The data-access boundary. `contracts/appRepository.js` documents the repository snapshot contract. The snapshot includes calendars, projects, people, WBS, canonical tasks, baselines and task baseline snapshots.

`mock/createMockRepository.js` is the current in-memory adapter and `mock/seed.js` contains the sample dataset. Legacy scheduling property names are accepted only by the dedicated migration adapter before a record becomes a canonical Task. No database is implemented in this work.

The mock adapter now supplies meaningful multi-level WBS hierarchies and valid Task-to-WBS relationships. The intentional cross-project dependency used to validate project-scoped CPM remains part of the data scenario.

A future API or SQL Server integration should add another adapter under `src/data` and supply it to `AppStateProvider`. Feature modules should not change when the backing source changes.

### `src/state`

`AppStateProvider` owns application-level project/task/person/WBS/baseline state, Task and safe in-memory WBS operations, workspace selection, selected-task synchronization and aggregate workspace task statistics. Pure state initialization and mutation normalization live in `src/state/appState.js`, keeping business normalization out of React feature components.

Workspace orchestration has one source of truth:

```text
workspaceMode: portfolio | project
selectedProjectId: null | Project.id
```

Pure workspace selectors expose the active Project, Projects, Tasks, WBS and participating People. Feature-facing hooks consume these scoped selectors. The same feature implementation therefore serves Portfolio and Project mode without importing raw mock data or repeating `projectId` filters in every view.

The last workspace is stored only as the UI preference `mergen-rota.workspace.v1`. Invalid persisted Project IDs normalize to Portfolio mode. Workspace switching also prevents a selected Task from remaining open when it belongs to another Project.

Normal Task CRUD changes only mutable Task data. Project changes are normalized centrally so an old Project's WBS assignment cannot survive. When one unambiguous root exists for the new Project it becomes the safe default; otherwise `wbsId` becomes `null`.

Baseline records and task baseline snapshots are carried separately and are not rewritten by current-plan edits, WBS edits, Task deletion or new-task creation. Focused selectors expose primary baseline/snapshot lookup where a feature needs it.

Safe WBS mutations remain in-memory and are dispatched through the state boundary. Deletion is prevented when a node has child WBS nodes or directly assigned Tasks; the application does not silently cascade-delete or reassign data.

CPM is exposed through a derived application schedule projection in `src/state/selectors/scheduleSelectors.js`. The projection:

- calculates CPM independently for every project;
- combines successful project results into portfolio-level task lookup data;
- keeps calculated CPM fields separate from canonical task objects;
- isolates validation failures so one invalid project does not block unrelated projects;
- rejects cross-project dependencies explicitly because portfolio dependency networks are outside the current scheduling scope.

`AppStateProvider` memoizes this projection from all canonical tasks, projects and calendars even while a feature is in Project Workspace. Project features select the appropriate existing project result; they do not trigger a second CPM calculation.

### `src/features`

Feature-oriented modules: dashboard, tasks, WBS, calendar, Gantt, Kanban, reports, team, settings and task detail. Feature components consume state hooks and shared pure logic; they do not import raw mock arrays.

Dashboard, Tasks, Calendar, Kanban, Reports and Team consume workspace-scoped hooks. Settings remains global. The WBS feature is primarily project-oriented and consumes the shared domain hierarchy selectors.

Portfolio Gantt preserves the existing portfolio-oriented implementation. Project Workspace defaults to a WBS hierarchy whose WBS summary rows and bars are derived view data, not fake Tasks. The existing Gantt remains available for responsible-person/CPM detail. Neither Gantt path calls `calculateCpm()` directly.

Task Detail edits current-plan, target, actual, remaining-duration, Project and WBS data. Its WBS selector only exposes nodes from the Task's current Project. The primary baseline snapshot remains read-only.

### `src/components`

`components/shell` contains the application frame, stable-ID workspace switcher, navigation, command palette, welcome screen and logo. `components/ui.jsx` and `components/ui-extras.jsx` remain reusable visual primitives.

## Adding new work

- Project/Task/WBS/Baseline business rules: `src/domain`
- Date, dependency, calendar, current-plan duration or CPM calculations: `src/scheduling`
- Mock/API/database adapters and migration boundaries: `src/data`
- Global client orchestration, workspace selection and derived application projections: `src/state`
- Feature UI and feature-only helpers: the relevant `src/features/<feature>` folder
- Generic visual primitives: `src/components/ui*`
- Sidebar/topbar/global overlays: `src/components/shell`

## Scheduling data ownership

Stored schedule data and calculated schedule data have deliberately different semantics:

- current plan: mutable canonical Task fields;
- management target: mutable `targetFinish`, not a CPM constraint;
- actuals: explicit observed dates, never inferred from status;
- remaining duration: explicit working-day planning input, independent of progress percentage;
- project data date: stored project status cutoff;
- baseline: separate immutable snapshot entities under normal Task/WBS CRUD;
- CPM schedule: derived state only;
- WBS schedule summaries: derived from descendant current-plan Tasks, never persisted on WBS nodes.

See `docs/SCHEDULING-DATA-MODEL.md` for the scheduling contract and `docs/WBS-AND-WORKSPACES.md` for workspace and hierarchy rules.

## Database/API migration path

The application starts from `appRepository`, which is currently the mock adapter. A database-backed implementation should not be imported by feature components. Introduce an adapter in `src/data`, perform asynchronous loading/persistence in the state layer, and keep the hooks exposed to features stable.

A future persistence schema should preserve Project → WBS → Activity as separate stable-ID relationships and retain the semantic separation between current plan, actuals, baseline snapshots and calculated CPM output. SQL Server, Next.js route handlers, REST clients, Primavera/SAP integration, authorization and audit history remain outside the current implementation.
