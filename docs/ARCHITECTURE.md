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

### `src/scheduling`

Pure scheduling logic. `dates` owns parsing, formatting and date-range helpers; `calendars` owns holiday/working-day rules; `dependencies` owns FS/SS/FF/SF metadata and normalization; `plans` owns canonical current-plan duration normalization; `metrics` owns schedule-derived calculations used by Gantt and task status summaries; `cpm` owns the calendar-aware critical-path engine, forward/backward passes, early/late dates, float and critical paths. Scheduling remains independent from React and application state.

### `src/data`

The data-access boundary. `contracts/appRepository.js` documents the repository snapshot contract. The snapshot now includes calendars, projects, people, WBS, canonical tasks, baselines and task baseline snapshots.

`mock/createMockRepository.js` is the current in-memory adapter and `mock/seed.js` contains the sample dataset. Legacy scheduling property names are accepted only by the dedicated migration adapter before a record becomes a canonical Task. No database is implemented in this work.

A future API or SQL Server integration should add another adapter under `src/data` and supply it to `AppStateProvider`. Feature modules should not change when the backing source changes.

### `src/state`

`AppStateProvider` owns application-level project/task/person/WBS/baseline state, task CRUD operations, selected-task synchronization and aggregate task statistics. Pure state initialization and task CRUD normalization live in `src/state/appState.js`, keeping business normalization out of React feature components.

Normal task CRUD changes only mutable Task data. Baseline records and task baseline snapshots are carried separately and are not rewritten by current-plan edits, task deletion or new-task creation. Focused selectors expose primary baseline/snapshot lookup where a feature needs it.

CPM is exposed through a derived application schedule projection in `src/state/selectors/scheduleSelectors.js`. The projection:

- calculates CPM independently for every project;
- combines successful project results into portfolio-level task lookup data;
- keeps calculated CPM fields separate from canonical task objects;
- isolates validation failures so one invalid project does not block unrelated projects;
- rejects cross-project dependencies explicitly because portfolio dependency networks are outside the current scheduling scope.

`AppStateProvider` memoizes this projection from canonical tasks, projects and calendars. Feature components consume schedule hooks/results and do not call `calculateCpm()` directly.

### `src/features`

Feature-oriented modules: dashboard, tasks, calendar, Gantt, Kanban, reports, team, settings and task detail. Feature components consume state hooks and shared pure logic; they do not import raw mock arrays.

The Gantt positions its primary bars from `plannedStart`/`plannedFinish` and overlays derived CPM information separately. Task Detail edits current-plan, target, actual and remaining-duration data and can display the primary baseline snapshot read-only.

### `src/components`

`components/shell` contains the application frame, navigation, command palette, welcome screen and logo. `components/ui.jsx` and `components/ui-extras.jsx` remain reusable visual primitives.

## Adding new work

- Project/Task/WBS/Baseline business rules: `src/domain`
- Date, dependency, calendar, current-plan duration or CPM calculations: `src/scheduling`
- Mock/API/database adapters and migration boundaries: `src/data`
- Global client orchestration and derived application projections: `src/state`
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
- baseline: separate immutable snapshot entities under normal task CRUD;
- CPM schedule: derived state only.

See `docs/SCHEDULING-DATA-MODEL.md` for the complete data contract.

## Database/API migration path

The application starts from `appRepository`, which is currently the mock adapter. A database-backed implementation should not be imported by feature components. Introduce an adapter in `src/data`, perform asynchronous loading/persistence in the state layer, and keep the hooks exposed to features stable.

A future persistence schema should preserve the same semantic separation rather than flattening current plan, actuals, baseline snapshots and calculated CPM output into one ambiguous task-date model. SQL Server, Next.js route handlers, REST clients, Primavera/SAP integration, authorization and audit history remain outside the current implementation.
