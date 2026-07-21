# MERGEN Rota Architecture

MERGEN Rota is organized so feature UI does not own the global dataset and does not care whether data comes from mock JavaScript, an API, or a future SQL-backed service.

## Dependency direction

The intended direction is:

`domain <- scheduling <- data <- state <- features <- app/shell`

Shared visual components are used by features, but they do not import application state or the mock seed.

## Layers

### `src/domain`

Business concepts and data-shape rules that are independent from React and the browser. `models` documents Project, Task/Activity, Dependency, Person and WBS shapes with JSDoc. Stable relationships use IDs (for example `projectId`, `assigneeIds`, `predecessorId` and `wbsId`) while the mock adapter also retains the legacy display fields used by the current UI.

### `src/scheduling`

Pure scheduling logic. `dates` owns parsing, formatting and date-range helpers; `calendars` owns holiday/working-day rules; `dependencies` owns FS/SS/FF/SF metadata and normalization; `metrics` owns schedule-derived calculations used by Gantt and task status summaries. Future CPM work (forward/backward pass, float, critical path, lag/lead and project calendars) belongs here rather than in React components.

### `src/data`

The data-access boundary. `contracts/appRepository.js` documents the repository snapshot contract. `mock/createMockRepository.js` is the current in-memory adapter and `mock/seed.js` contains the normalized sample dataset. No database is implemented in this refactor.

A future API or SQL Server integration should add another adapter under `src/data` and supply it to `AppStateProvider`. Feature modules should not change when the backing source changes.

### `src/state`

`AppStateProvider` owns application-level project/task/person/WBS state, task CRUD operations, selected-task synchronization and aggregate task statistics. Focused hooks in `src/state/hooks` are the feature-facing API.

### `src/features`

Feature-oriented modules: dashboard, tasks, calendar, Gantt, Kanban, reports, team, settings and task detail. Feature components consume state hooks and shared pure logic; they do not import raw mock arrays.

### `src/components`

`components/shell` contains the application frame, navigation, command palette, welcome screen and logo. `components/ui.jsx` and `components/ui-extras.jsx` remain reusable visual primitives.

## Adding new work

- Project/Task/WBS business rules: `src/domain`
- Date, dependency, calendar or CPM calculations: `src/scheduling`
- Mock/API/database adapters: `src/data`
- Global client orchestration: `src/state`
- Feature UI and feature-only helpers: the relevant `src/features/<feature>` folder
- Generic visual primitives: `src/components/ui*`
- Sidebar/topbar/global overlays: `src/components/shell`

## Database/API migration path

The current application starts from `appRepository`, which is the mock adapter. A database-backed implementation should not be imported by feature components. Introduce an adapter in `src/data`, perform async loading/persistence in the state layer, and keep the hooks exposed to features stable. This isolates SQL Server, Next.js route handlers, REST clients, Primavera/SAP integration and authorization concerns from the feature UI.
