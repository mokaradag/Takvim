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

WBS is a separate structural domain entity. Shared pure selectors own hierarchy construction, deterministic ordering, descendants, ancestors, paths, flattening and Task subtree rollups. Domain validation owns duplicate-ID, missing-parent, self-parent, cross-project-parent and cycle rules. A Task's `wbsId`, when present, must resolve to a WBS node owned by the same `projectId`. A WBS node also records whether its structure is application-authored (`source: 'manual'`) or mirrored from the corporate CN43N source (`source: 'corporate'`, read-only).

`identity/actualId.js` owns Actual System identity rules for every layer: which strings are valid SQL Server `uniqueidentifier` values (any GUID, without RFC 4122 version/variant constraints) and their canonical lower-case comparison form. Client, server and validation layers must not define private UUID patterns.

`projectTypes.js` additionally owns the corporate/manual project distinction (`isCorporateProject`, `supportsManualWbsEditing`) used by write policies and the WBS UI.

`tags/index.js` owns the project tag catalog: the canonical `{ name, color, icon }` shape, the closed colour/icon key sets, deterministic default colour derivation and Turkish case-insensitive de-duplication. Client forms and server commit validation must both use these lists rather than defining private copies.

`constants/index.js` owns the Task status and priority catalogs. Priority also has canonicalization rules: `normalizePriorityId` maps unknown and legacy values (notably the persisted `normal`) onto a catalog identifier, and `resolvePriority` always returns a definition. Views must use these instead of indexing `PRIORITIES` directly — a missing entry previously produced `undefined.color` and took down the whole client render tree.

WBS rollups exist in two shapes: `selectWbsTaskRollup` for a single node, and `selectWbsRollupIndex` for every node in one pass. Anything that renders many rows uses the index; per-row calls to the single-node selector are quadratic in the node count.

`reminders/` owns task-reminder rules with no I/O of any kind. `reminderTemplate.js` holds the placeholder catalog, the allowlist HTML sanitizer, placeholder substitution with HTML escaping, plain-text derivation and the default Turkish subject/body. `reminderPolicy.js` holds the automatic policy: settings normalization, remaining-duration description, window/frequency evaluation and the deterministic *slot key* used for duplicate-send prevention. `reminderRecipients.js` and `emailAddress.js` own address validation, normalization and de-duplication; `reminderValues.js` maps a Task onto placeholder values. Because these modules are pure, the whole reminder decision surface is tested without a clock, a database or an SMTP server.

### `src/scheduling`

Pure scheduling logic. `dates` owns parsing, formatting and date-range helpers; `calendars` owns holiday/working-day rules; `dependencies` owns FS/SS/FF/SF metadata and normalization; `plans` owns canonical current-plan duration normalization; `metrics` owns schedule-derived calculations used by Gantt and task status summaries; `cpm` owns the calendar-aware critical-path engine, forward/backward passes, early/late dates, float and critical paths. Scheduling remains independent from React and application state.

`recurrence` owns recurring-task rules as an RFC 5545 (iCalendar) `RRULE` subset: normalization, `RRULE` text round-tripping, Turkish description, calendar-aware expansion into concrete dates and occurrence planning. It is pure date arithmetic and carries no application state; the rule text is the interchange format, so an exported plan stays readable by other calendar systems.

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

Feature-local pure rules live in sibling `*Policy.js` modules rather than inside `.jsx` components, so they can be imported by plain Node tests: `features/wbs/wbsTreeViewPolicy.js` (hierarchy expansion depth), `features/team/teamDirectoryPolicy.js` (directorate filtering including the unassigned bucket) and the existing `features/simple/simpleModePolicy.js`.

Portfolio Gantt preserves the existing portfolio-oriented implementation. Project Workspace defaults to a WBS hierarchy whose WBS summary rows and bars are derived view data, not fake Tasks. The existing Gantt remains available for responsible-person/CPM detail. Neither Gantt path calls `calculateCpm()` directly.

Task Detail edits current-plan, target, actual, remaining-duration, Project and WBS data. Its WBS selector only exposes nodes from the Task's current Project. The primary baseline snapshot remains read-only. Local field edits stay responsive while the state persistence layer coalesces high-frequency patches before repository writes.

### `src/components`

`components/shell` contains the application frame, async loading/error boundary, persistence-status indicator, stable-ID workspace switcher, navigation, command palette, welcome screen, logo and the authenticated sidebar user panel. `components/ui.jsx` and `components/ui-extras.jsx` remain reusable visual primitives.

`Avatar`/`AvatarStack` show corporate photographs with a reliable initials fallback. They must not import application state, so the shell supplies the person directory through `components/PeopleDirectoryContext.jsx`; the pure resolution rules live in `components/avatarIdentity.js` and the single URL builder in `lib/userPhoto.js`. Identity resolution prefers a supplied person, then a canonical id/Sicil, and only then a display name — an ambiguous name never guesses between two employees.

### Server layer (`src/server`)

Server-only identity, authentication, authorization, SQL configuration and durable repositories.

`identity/` owns the authentication boundary. `currentUserProvider.js` selects the provider from server configuration alone (`MERGEN_ROTA_AUTH_MODE`): `KeycloakIdentityProvider` by default, `DevelopmentIdentityProvider` only when local development explicitly asks for it. The Keycloak modules are deliberately small and single-purpose: `keycloakConfig.js` (env → config), `keycloakJwks.js` (JWKS fetch/cache/rotation), `keycloakToken.js` (pure JWT decode + RSA signature + standard claim validation via `node:crypto`), `keycloakClaims.js` (pure claim → identity mapping and log masking), `keycloakSessionCookie.js` (HMAC-signed HttpOnly session payload), `keycloakPkce.js` (PKCE + signed state transaction), `keycloakAuthentication.js` (orchestration), `resolveSicilFromUsername.js` (optional HR02 lookup) and `authRouteSupport.js` (shared route helpers). No third-party authentication framework is used, so the runtime stays offline-capable.

`sicil.js` is the single rule for parsing a Sicil; both the Keycloak claim and the development identity use it. `src/domain/identity/sessionUser.js` is pure and shared by server and client: it merges the corporate directory record with verified claims and resolves the sidebar display labels.

Two connection pools exist: `db/pool.js` for the MERGEN Rota database and `db/corporateWbsPool.js` for the separate corporate WBS (CN43N) database. Both resolve the native driver through `db/driver.js`, which also exposes the test-only injection seam used by end-to-end persistence tests.

Corporate WBS synchronization is split into a pure projection module (`repository/corporateWbsProjection.js`, CN43N rows → hierarchy plan), a pure skip-decision module (`repository/corporateWbsSyncState.js`, content fingerprints), the process-level schedule (`repository/corporateWbsSyncSchedule.js`, freshness window plus single-flight), the SQL text (`repository/corporateWbsQueries.js`) and the orchestration (`repository/corporateWbsSync.js`). Hierarchy resolution and skip decisions are therefore testable without a database.

Snapshot loading is deliberately two steps: `refreshCorporateCatalog()` brings the corporate catalog up to date and `readSnapshot()` reads the authorized snapshot. `projectedSqlAppRepository` calls the refresh *before* opening its serializable read transaction, so a large CN43N merge never inherits serializable isolation or holds range locks across the read. `loadSnapshot()` remains the composition of the two for callers that want both.

`mail/` is the SMTP transport. `smtpConfig.js` reads server-only environment variables (never `NEXT_PUBLIC_*`), `mimeMessage.js` builds an RFC 5322 multipart/alternative message with encoded headers and dot-stuffed bodies, `smtpClient.js` speaks the SMTP dialogue over `node:net`/`node:tls` (EHLO → STARTTLS → EHLO → AUTH → MAIL FROM → RCPT TO → DATA → QUIT) and `mailService.js` composes the two. No third-party mail dependency is added: the native server stack already performs this flow, and credentials never leave the server process or appear in logs.

`reminders/` is the reminder application service. `reminderQueries.js` owns the SQL text, including the recipient chain `MR_TaskAssignees.Sicil → MR_V_PeopleDirectory.Username → DC01_userr.Name → DC01_userr.EmailAddress`; `reminderStore.js` reads/writes the settings row and the send log and masks addresses before they reach any log line; `reminderAccess.js` owns the authorization checks (task access, admin-only settings, the scheduler key compared with `timingSafeEqual`); `reminderService.js` orchestrates the single shared path `deliverTaskReminder()` used by both the manual button and the scheduler, so the two flows can never diverge in recipient resolution, rendering or transport. The send function is injectable, which is how integration tests exercise everything up to the socket.

The scheduler is server-side: `POST /api/mergen-rota/reminders/run` runs one automatic pass and is driven by Windows Task Scheduler or cron. No browser needs to be open. Duplicate sends are prevented by claiming the deterministic slot key in `MR_TaskReminderLog` *before* sending, under a unique index filtered to automatic sends, so restarts and multiple application instances converge on one message per slot.

### Presentation and styling ownership

Presentation follows the same ownership rule as domain, scheduling, data and state architecture: current behavior is defined by the component or feature that owns it, not by a chronological override chain. `src/app/globals.css` owns global tokens/base primitives; `src/app/styles/shell.css` owns application chrome; `dashboard.css` owns Dashboard structure; `components.css` owns shared visual/component, form and table contracts; `features.css` owns Gantt, WBS and Task Detail layout sections; `simple-mode.css` owns Basit Mod; and `experience.css` owns mode/settings/help presentation.

Generic visual primitives belong under `src/components`; shell presentation belongs to shell ownership; feature-specific layout belongs to the relevant feature style owner. Root global styles must not become a sequence of `fixes`/`followup`/`polish` layers. Static application structure should be exposed through semantic classes rather than inferred from inline style text or child position. Dynamic runtime values such as colors and computed widths may remain inline.

Shared layer tokens define sticky, chrome, popover, drawer, modal and tooltip ordering. Feature code should use those layers instead of escalating unexplained z-index values. See `docs/UI-STYLING-ARCHITECTURE.md` for the full contract and `docs/VISUAL-SMOKE-TESTS.md` for the manual visual validation checklist.

## Adding new work

- Authentication, token verification, session cookies and identity resolution: `src/server/identity`
- Project/Task/WBS/Baseline business rules and Actual System identity rules: `src/domain`
- Date, dependency, calendar, current-plan duration or CPM calculations: `src/scheduling`
- Repository contracts, memory/API/database adapters and migration boundaries: `src/data`
- Global client orchestration, async persistence commands, workspace selection and derived application projections: `src/state`
- Reminder rules, templates and policy: `src/domain/reminders`
- SMTP transport, reminder persistence and the reminder service: `src/server/mail` and `src/server/reminders`
- Feature UI and feature-only helpers: the relevant `src/features/<feature>` folder
- Generic visual primitives: `src/components/ui*`
- Sidebar/topbar/global overlays and application lifecycle surfaces: `src/components/shell`

## Scheduling data ownership

Stored schedule data and calculated schedule data have deliberately different semantics:

- current plan: mutable canonical Task fields;
- management target: mutable `targetFinish`, not a CPM constraint;
- actuals: explicit observed dates, never inferred from status;
- remaining duration: nullable compatibility field, not manufactured or consumed by current scheduling;
- project data date: stored, optional project status cutoff — not a row timestamp;
- baseline: separate immutable snapshot entities under normal Task/WBS CRUD;
- CPM schedule: derived state only;
- WBS schedule summaries: derived from descendant current-plan Tasks, never persisted on WBS nodes.

See `docs/PERSISTENCE-BOUNDARY.md` for asynchronous loading/mutation semantics, `docs/SCHEDULING-DATA-MODEL.md` for the scheduling contract and `docs/WBS-AND-WORKSPACES.md` for workspace and hierarchy rules.

## Database/API migration path

The application starts through `getAppRepository()`, which lazily resolves to the asynchronous in-memory adapter used by Demo Mode. It is an accessor rather than a module-level constant so the demo seed is not built at import time when the session runs on Actual System data. A durable implementation should keep the feature-facing hooks unchanged and replace the data-side adapter behind the state orchestration boundary.

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
