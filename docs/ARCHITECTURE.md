# MERGEN Rota Architecture

MERGEN Rota is organized so feature UI does not own the global dataset and does not care whether data comes from the current asynchronous in-memory adapter, a future API, or a SQL-backed server-side service.

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

The data-access and persistence boundary. `contracts/appRepository.js` documents the asynchronous repository contract:

```text
loadSnapshot(): Promise<AppDataSnapshot>
commitChanges(changeSet): Promise<AppChangeSet>
```

The snapshot includes calendars, projects, people, WBS, canonical tasks, baselines and task baseline snapshots. The mutation change set contains only current Task/WBS upserts and deletes and provides one atomic boundary for multi-entity operations.

`mock/createMockRepository.js` is the current asynchronous mutable in-memory adapter and `mock/seed.js` contains the sample dataset. Successful mutations remain available to later `loadSnapshot()` calls for the lifetime of that repository instance. A new repository instance starts from its supplied seed; browser/process/VM restart durability is not provided.

The adapter deep-clones external inputs and outputs and supports focused test-only latency/load/mutation failure configuration. Legacy scheduling property names are accepted only by the dedicated migration adapter before a record becomes a canonical Task. No database or fake HTTP API is implemented in this work.

The mock adapter supplies meaningful multi-level WBS hierarchies and valid Task-to-WBS relationships. The intentional cross-project dependency used to validate project-scoped CPM remains part of the data scenario.

A future browser-side API repository adapter should implement the same application-facing contract and be supplied to `AppStateProvider`. Feature modules should not change when the backing source changes.

### `src/state`

`AppStateProvider` owns React application state and composes focused feature-facing actions. Pure state initialization, canonical snapshot normalization and reducer transitions live in `src/state/appState.js`. Asynchronous persistence orchestration lives outside the reducer in `src/state/persistence.js`.

The application-data lifecycle is explicit through `dataStatus: loading | ready | error`, `loadError`, `pendingMutationCount`, `saveError` and `lastSavedAt`. Initial loading and reload use the same `repository.loadSnapshot()` path. The shell does not render normal features against incomplete loading data and exposes retry after load failure.

Current Task/WBS mutations use pessimistic canonical-state semantics: the state layer calculates and validates the intended pure transition, derives the smallest Task/WBS change set, persists it, then reconciles application state with the repository's authoritative returned entities. Persistence failures therefore do not require optimistic rollback.

All repository mutations pass through one ordered queue so delayed responses cannot overwrite newer edits and structural operations cannot complete out of order. High-frequency Task Detail patches are coalesced per Task before persistence; discrete and destructive operations flush dependent pending patches first.

Workspace orchestration has one source of truth:

```text
workspaceMode: portfolio | project
selectedProjectId: null | Project.id
```

Pure workspace selectors expose the active Project, Projects, Tasks, WBS and participating People. Feature-facing hooks consume these scoped selectors. The same feature implementation therefore serves Portfolio and Project mode without importing raw mock data or repeating `projectId` filters in every view.

The last workspace is stored only as the UI preference `mergen-rota.workspace.v1`. It is restored only after repository data becomes ready so the Project ID can be validated. Invalid persisted Project IDs normalize to Portfolio mode. Workspace switching also prevents a selected Task from remaining open when it belongs to another Project. The preference is not part of `AppRepository`.

Normal Task CRUD changes only mutable Task data. Project changes are normalized centrally so an old Project's WBS assignment cannot survive. When one unambiguous root exists for the new Project it becomes the safe default; otherwise `wbsId` becomes `null`.

Baseline records and task baseline snapshots are carried separately and are not rewritten by current-plan edits, WBS edits, Task deletion or new-task creation. Focused selectors expose primary baseline/snapshot lookup where a feature needs it.

WBS mutations remain validated at the domain/state boundary. Deletion is prevented when a node has child WBS nodes or directly assigned Tasks; the application does not silently cascade-delete or reassign data. Bulk Task WBS movement and WBS subtree reparenting are persisted as single atomic change sets after existing validation succeeds.

CPM is exposed through a derived application schedule projection in `src/state/selectors/scheduleSelectors.js`. The projection:

- calculates CPM independently for every project;
- combines successful project results into portfolio-level task lookup data;
- keeps calculated CPM fields separate from canonical task objects;
- isolates validation failures so one invalid project does not block unrelated projects;
- rejects cross-project dependencies explicitly because portfolio dependency networks are outside the current scheduling scope.

`AppStateProvider` memoizes this projection from all canonical tasks, projects and calendars even while a feature is in Project Workspace. Project features select the appropriate existing project result; they do not trigger a second CPM calculation. A successful persisted scheduling change naturally recomputes this projection because canonical Task state changes; CPM output itself is never persisted.

### `src/features`

Feature-oriented modules: dashboard, tasks, WBS, calendar, Gantt, Kanban, reports, team, settings and task detail. Feature components consume state hooks and shared pure logic; they do not import raw mock arrays or repository implementations.

Dashboard, Tasks, Calendar, Kanban, Reports and Team consume workspace-scoped hooks. Settings remains global. The WBS feature is primarily project-oriented and consumes the shared domain hierarchy selectors.

Portfolio Gantt preserves the existing portfolio-oriented implementation. Project Workspace defaults to a WBS hierarchy whose WBS summary rows and bars are derived view data, not fake Tasks. The existing Gantt remains available for responsible-person/CPM detail. Neither Gantt path calls `calculateCpm()` directly.

Task Detail edits current-plan, target, actual, remaining-duration, Project and WBS data. Its WBS selector only exposes nodes from the Task's current Project. The primary baseline snapshot remains read-only. Local field edits stay responsive while the state persistence layer coalesces high-frequency patches before repository writes.

### `src/components`

`components/shell` contains the application frame, async loading/error boundary, persistence-status indicator, stable-ID workspace switcher, navigation, command palette, welcome screen and logo. `components/ui.jsx` and `components/ui-extras.jsx` remain reusable visual primitives.

### Presentation and styling ownership

Presentation follows the same ownership rule as domain, scheduling, data and state architecture: current behavior is defined by the component or feature that owns it, not by a chronological override chain. `src/app/globals.css` owns global tokens/base primitives; `src/app/styles/shell.css` owns application chrome; `dashboard.css` owns Dashboard structure; `components.css` owns shared visual/component, form and table contracts; `features.css` owns Gantt, WBS and Task Detail layout sections; `simple-mode.css` owns Basit Mod; and `experience.css` owns mode/settings/help presentation.

Generic visual primitives belong under `src/components`; shell presentation belongs to shell ownership; feature-specific layout belongs to the relevant feature style owner. Root global styles must not become a sequence of `fixes`/`followup`/`polish` layers. Static application structure should be exposed through semantic classes rather than inferred from inline style text or child position. Dynamic runtime values such as colors and computed widths may remain inline.

Shared layer tokens define sticky, chrome, popover, drawer, modal and tooltip ordering. Feature code should use those layers instead of escalating unexplained z-index values. See `docs/UI-STYLING-ARCHITECTURE.md` for the full contract and `docs/VISUAL-SMOKE-TESTS.md` for the manual visual validation checklist.

## Adding new work

- Project/Task/WBS/Baseline business rules: `src/domain`
- Date, dependency, calendar, current-plan duration or CPM calculations: `src/scheduling`
- Repository contracts, memory/API/database adapters and migration boundaries: `src/data`
- Global client orchestration, async persistence commands, workspace selection and derived application projections: `src/state`
- Feature UI and feature-only helpers: the relevant `src/features/<feature>` folder
- Generic visual primitives: `src/components/ui*`
- Sidebar/topbar/global overlays and application lifecycle surfaces: `src/components/shell`

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

See `docs/PERSISTENCE-BOUNDARY.md` for asynchronous loading/mutation semantics, `docs/SCHEDULING-DATA-MODEL.md` for the scheduling contract and `docs/WBS-AND-WORKSPACES.md` for workspace and hierarchy rules.

## Database/API migration path

The application starts through `appRepository`, which currently resolves to the asynchronous in-memory adapter. A durable implementation should keep the feature-facing hooks unchanged and replace the data-side adapter behind the state orchestration boundary.

The intended direction is:

```text
Browser / MERGEN Rota UI
        │
        ▼
Client-side API repository adapter
        │
        ▼
Next.js server route/service
        │
        ▼
Server-side SQL repository/service
        │
        ▼
SQL Server
```

The browser must never connect directly to SQL Server. The server/database implementation should preserve atomic `commitChanges()` semantics and return authoritative canonical entities.

A future persistence schema should preserve Project → WBS → Activity as separate stable-ID relationships and retain the semantic separation between current plan, actuals, baseline snapshots and calculated CPM output. SQL Server, Next.js route handlers, REST clients, Primavera/SAP integration, authorization and audit history remain outside the current implementation.
