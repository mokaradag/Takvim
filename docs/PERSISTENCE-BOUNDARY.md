# Persistence-Ready State and Data Boundary

MERGEN Rota separates feature behavior from the mechanism used to store canonical project-management data. The current adapter is asynchronous and mutable in memory so the application can exercise the same loading, saving, failure and ordering semantics that a future API-backed repository will require without introducing a fake HTTP layer or a database in this increment.

## 1. Repository responsibility

`AppRepository` is the persistence boundary consumed by the state layer. Its application-facing contract is intentionally small:

```text
loadSnapshot(): Promise<AppDataSnapshot>

commitChanges({
  taskUpserts,
  taskDeletes,
  wbsUpserts,
  wbsDeletes
}): Promise<AppChangeSet>
```

`loadSnapshot()` returns canonical stored application data: Calendars, Projects, People, WBS nodes, Tasks, Baselines and TaskBaselineSnapshots.

`commitChanges()` persists only currently mutable entity changes. It is one atomic change-set operation so multi-entity Task moves and WBS subtree rebasing can later map to one server/database transaction. It is not a reducer-action protocol and it does not require rewriting an entire snapshot for every edit.

The repository does not own WBS business validation, workspace selection, CPM calculations or UI state.

## 2. State responsibility

The state layer is the feature-facing orchestration boundary. It owns:

- asynchronous load/reload orchestration;
- canonical Task normalization after load and persistence responses;
- domain validation through existing pure transitions;
- ordered mutation execution;
- high-frequency Task patch coalescing;
- loading, saving and persistence-error lifecycle state;
- reconciliation of selected Project and Task after reload;
- derived workspace and CPM projections.

Reducers remain pure. Repository calls are never made from a reducer.

## 3. Feature responsibility

Features continue to consume focused hooks and application actions such as:

```text
useTaskActions()
useWbsActions()
useWorkspace()
```

A feature does not call `repository.commitChanges()`, `fetch()`, an API route or a SQL client. Replacing the current in-memory adapter with an API adapter must not require feature rewrites.

## 4. Application startup and asynchronous loading

Application startup follows one loading path:

```text
Application startup
    │
    ▼
repository.loadSnapshot()
    │
    ▼
normalize / validate
    │
    ▼
application state
    │
    ▼
features
```

The application data lifecycle is explicit:

```text
loading → ready
    │
    └────→ error → retry → loading
```

While loading, normal features are not rendered against empty placeholder business data. A load failure shows a restrained application-level error and `Yeniden Dene` uses the same `reloadData()` path as normal reloads.

A loaded snapshot is normalized at the established data/state boundary. Legacy Task scheduling properties, dependencies, professional scheduling fields and Project/WBS relationships therefore pass through the same canonical rules whether the source is the current memory adapter or a future external source.

### 4.1 Snapshot and session ordering

`loadApplicationData()` reads the snapshot first and the session context second. **This order is deliberate and must not be parallelized.** The snapshot request triggers the corporate catalog synchronization, which can create new corporate Project rows. A session context read before that synchronization would report an access list that does not yet contain those projects.

The round-trip cost is removed without breaking the order: the Actual snapshot endpoint performs both reads inside the same request and returns the session context embedded in the snapshot body. The endpoint builds that session from the **authorization context the snapshot read already produced** (`readSnapshotWithAuthorization` → `sessionContextFrom`), so the person/role/project-grant and task-assignee scope queries do not run twice in one request. `createApiRepository.loadSnapshot()` returns the session **paired with its own snapshot result** rather than parking it in a shared slot: overlapping loads would otherwise be able to consume each other's session and combine snapshot A with the project access computed for snapshot B. Later session reads (session refresh) still go to `/api/mergen-rota/session`, which remains unchanged for other callers.

### 4.2 Corporate catalog freshness

The corporate WBS synchronization keeps its process-level freshness window, and adds stale-while-revalidate behaviour:

- **First run in a process** blocks. The tree may not exist in `MR_WBS` yet and showing an empty structure would be wrong.
- **Later window expiries do not block.** The request is answered immediately from stored `MR_WBS` data (at most one TTL old) and the refresh continues in the background. Startup therefore stops depending on how fast the CN43N source responds.
- Setting `MERGEN_ROTA_WBS_SYNC_TTL_MS=0` disables the freshness window entirely; in that mode every request synchronizes synchronously, as before.

Background refresh failures are logged and never surface as a load error, and the freshness window is not advanced when a synchronization fails.

## 5. Application data versus UI/session state

Repository application data consists of:

- Calendars;
- Projects;
- People;
- WBS nodes;
- Tasks;
- Baselines;
- TaskBaselineSnapshots.

UI/session state remains separate:

- selected Task;
- workspace mode;
- selected Project preference;
- workspace preference readiness;
- feature-local filters and controls.

Reloading business data does not replace the local workspace preference service. The active workspace and selected Task are reconciled against the newly loaded entities rather than carrying stale object references forward.

## 6. Data and persistence lifecycle state

Application state exposes coherent lifecycle concepts:

```text
dataStatus: loading | ready | error
loadError
pendingMutationCount
saveError
lastSavedAt
```

`isSaving` is derived from `pendingMutationCount > 0`; it is not independently stored. This avoids contradictory loading/saving booleans.

The shell exposes restrained status feedback:

- `Kaydediliyor...`
- `Kaydedildi`
- `Kaydetme hatası`

Persistence failures remain separate from WBS/domain validation messages.

## 7. Mutation lifecycle and pessimistic semantics

MERGEN Rota uses deterministic pessimistic persistence semantics for canonical application data:

```text
Feature action
    │
    ▼
state orchestration
    │
    ▼
domain validation / intended pure transition
    │
    ▼
repository mutation
    │
    ▼
state reconciliation with authoritative result
    │
    ▼
derived selectors / CPM
```

The intended pure reducer transition is calculated first to reuse existing normalization and business rules. If validation fails, the domain error is exposed and no repository call occurs.

If validation succeeds, the state layer derives the smallest Task/WBS change set, persists it, and only then applies the repository's returned canonical entities to application state. A failed persistence operation therefore does not optimistically remove or structurally move canonical data and does not require a rollback protocol.

State actions resolve an explicit result contract:

```text
{ ok: true, value }

or

{ ok: false, error }
```

Persistence failures are caught inside the orchestration layer, so feature call sites that do not await an action do not create unhandled rejected Promises.

## 8. Mutation ordering semantics

All persistence mutations pass through one ordered application mutation queue.

The next mutation is not sent to the repository until the previous mutation has settled. This deliberately simple rule guarantees that:

- an older Task response cannot overwrite a newer edit;
- structural operations cannot complete out of order;
- update/delete races are deterministic;
- a future adapter with real network latency observes the same application mutation order.

The queue serializes persistence effects, not ordinary UI actions such as opening a Task or changing workspace.

## 9. High-frequency Task editing

Task Detail keeps its immediate local draft behavior so typing remains responsive. The persistence boundary prevents one write per keyboard character.

Rapid patches for the current high-frequency fields are coalesced per Task for a short 250 ms window:

- Task title;
- description/notes;
- progress;
- remaining duration.

The latest values are merged into one canonical Task patch and persisted through the same ordered queue.

Discrete controls such as dates, status, Project, WBS and relationship changes persist immediately. Before a discrete mutation, destructive operation, Task WBS move or application reload proceeds, any pending coalesced patch for the affected Task is flushed first. If that pending save fails, the dependent operation does not silently continue past the failed write.

This provides a future API-safe commit boundary without redesigning Task Detail around an explicit Save button.

### 9.1 Losing a coalesced edit must not be silent

Two guards protect the coalescing window:

- **Tab close / hide.** `UnsavedChangesGuard` flushes the pending queue on `visibilitychange` and `pagehide`, and raises the browser's own confirmation on `beforeunload` while a write is pending or in flight. Previously an edit made less than 250 ms before the tab closed never reached the server, and the "Kaydedildi" indicator never appeared, so the loss was invisible. That final flush is sent with `keepalive`, because a plain `fetch` started during unload may be cancelled by the browser. "In flight" is read from `pendingMutationCount`: the coalescer removes a patch from the queue *before* awaiting the request, so a queue-only check would leave an already-started write unprotected.
- **Invalid values never enter the queue.** An empty Task title is rejected in the drawer before it is scheduled. The server rejects an empty title with `TASK_TITLE_REQUIRED`, and because coalescing merges fields, that rejection took the batched progress and date edits down with it. Clearing the field also **cancels the queued title patch**: after `ABC → AB → A → empty`, the queue still held `A`, which the delay (or the drawer close) then persisted even though the UI said it would not be saved.

### 9.2 A failed write never traps the Task panel

Closing the Task panel flushes pending writes, but the close itself is **unconditional**. Earlier, both `closeTask()` and the overlay's `onClose` returned the failed flush result without clearing the selection, so a server-rejected field left the panel open with no working close button — the application appeared frozen. The failure is still reported: it stays in the persistence status strip with its message, code and field path.

Closing does not discard the edit either. A rejected patch is **retained** by the coalescer instead of being dropped: it is not put back into the pending queue (a permanently rejected patch would then loop on every flush), but it is counted as an unsaved change, it merges underneath the next edit to the same task, and the status strip offers `Yeniden dene`. Without that retention the drawer draft was the only remaining copy of the edit, and unmounting the panel destroyed it. `Verileri yeniden yükle` is the explicit discard: it asks for the authoritative server state, so the retained patch is dropped with it.

## 10. Atomic structural operations

A single `commitChanges()` call is the transaction boundary for all changes generated by one application command.

### Bulk Task WBS movement

The existing domain layer validates the complete Task selection first. A successful move persists all changed Task assignments in one change set. A failure changes neither persisted repository state nor canonical application state.

### WBS subtree reparenting

The existing domain/state logic calculates the complete valid reparent result, including deterministic descendant code rebasing. All changed WBS nodes are then sent in one change set.

Stable WBS IDs remain unchanged. Task assignments remain unchanged because Tasks continue to reference the same WBS IDs. Baselines remain unchanged.

The memory adapter applies a change set to a cloned candidate snapshot and swaps its internal snapshot only after the complete operation succeeds, modeling the all-or-nothing behavior expected from a future database transaction.

## 11. Error handling

Repository/data errors use a small normalized contract:

```text
code
message
operation
details
```

Current repository error codes are intentionally limited to:

- `LOAD_FAILED`;
- `MUTATION_FAILED`.

The shape leaves room for future API-specific errors such as conflicts without inventing unused behavior now.

Raw thrown values are normalized before entering application state. Normal UI surfaces generic application-safe messages rather than implementation details.

Domain errors and persistence errors are separate concepts:

```text
WBS_HAS_CHILDREN              → domain validation
WBS_REPARENT_TO_DESCENDANT    → domain validation
MUTATION_FAILED               → persistence failure
LOAD_FAILED                   → data loading failure
```

`wbsActionError` remains a WBS/domain error channel and is not reused for repository failures.

## 11.1 Actual System identity canonicalization

Actual mode identities are SQL Server `uniqueidentifier` values. Two rules are owned by `src/domain/identity/actualId.js` and used by every layer (client repository, commit validation, SQL repositories, authorization):

1. **Any valid GUID is accepted.** RFC 4122 version and variant bits are not enforced, because corporate source systems emit GUIDs such as `D5D70AEC-0A88-F111-9136-00505699BACD`. A version-constrained pattern rejected every corporate project, WBS node and Task with `ACTUAL_ID_INVALID`.
2. **The canonical form is lower case.** SQL Server returns identities as upper-case text while the client sends lower case, so raw `!==` comparisons on the server treated the same row as a different one. Snapshots emit canonical identities and server-side comparisons use `sameActualId()`.

Client-generated identities keep their `task-`/`wbs-`/`project-` prefix locally; the API repository extracts and canonicalizes the GUID for the wire and restores the prefixed form from the alias map on the way back.

## 12. Reload and reconciliation

`reloadData()` is the single application reload mechanism and is also used for initial-load retry.

Before reload, pending Task patches are flushed and the ordered mutation queue is allowed to settle. The repository snapshot is then loaded and normalized.

A reload does **not** tear down the application shell. `dataStatus` returns to `loading`, but `hasLoadedOnce` stays true after the first successful load, and `AppDataBoundary` therefore keeps the shell mounted and shows the blocking screen only for the initial load. Before this rule, every post-save refresh remounted `AppShell`, discarding view state and re-showing the welcome screen as if the application had just started. A failed refresh with data already present is reported in the persistence status area instead of replacing the application.

After reload:

- an invalid selected Project falls back safely to Portfolio Workspace;
- a selected Task that no longer exists is cleared;
- a selected Task that no longer belongs to the active Project workspace is cleared;
- Task/WBS relationships are normalized through the canonical boundary;
- the project-scoped CPM projection derives again from the newly loaded canonical Tasks, Projects and Calendars.

No stale entity object references are retained across reload.

## 13. Async in-memory adapter semantics

`createMockRepository()` is now an asynchronous mutable in-memory adapter. It:

- starts from the existing mock seed or a supplied test seed;
- deep-clones seed input;
- deep-clones loaded snapshots and mutation results;
- persists successful Task/WBS mutations for the lifetime of that repository instance;
- returns current persisted data from later `loadSnapshot()` calls;
- applies multi-entity change sets atomically;
- supports test-only latency, load failure and next-mutation failure behavior.

No artificial latency is enabled in normal application use.

A successful mutation **does survive an application-level repository reload within the same active repository instance**.

It does **not** survive creation of a new repository instance, browser refresh, process restart or VM restart. The adapter is a persistence-contract simulator, not durable production storage.

No `localStorage` or IndexedDB business-data database is introduced.

## 14. Workspace preference separation

`workspaceMode` and the last `selectedProjectId` remain under the existing local UI preference key:

```text
mergen-rota.workspace.v1
```

This preference is not read or written by `AppRepository`. It is restored only after business data has loaded so the stored Project ID can be validated against the current Project collection.

A future user-preference service can replace this local mechanism independently from project-management data persistence.

## 15. Derived data that is never persisted

The repository stores canonical project-management facts, not deterministic projections.

The persistence boundary does not save:

- CPM Early Start / Early Finish;
- CPM Late Start / Late Finish;
- Total Float / Free Float;
- critical status or critical paths;
- calculated Project finish;
- WBS summary date ranges;
- WBS progress rollups;
- WBS critical Task counts;
- workspace Task subsets;
- Dashboard aggregates.

These values continue to derive from canonical state through selectors and the pure scheduling layer.

Baseline and TaskBaselineSnapshot records continue to load through the repository but remain read-only under current UI operations. Normal Task/WBS mutations never rewrite them.

## 16. Future API and SQL Server path

The intended durable persistence direction is:

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

The browser must never connect directly to SQL Server.

A future client API adapter should implement the same application-facing `loadSnapshot()` and `commitChanges()` semantics. The server-side service can translate atomic change sets into database transactions and return authoritative canonical entities without changing feature components.

## 17. Current non-goals

This persistence-boundary increment does not implement:

- SQL Server or any other database;
- database migrations or connection strings;
- Prisma, Sequelize, TypeORM or another ORM;
- fake REST endpoints or local HTTP round trips;
- authentication or authorization;
- audit logging;
- baseline capture/re-baselining CRUD;
- durable browser-refresh persistence;
- conflict-resolution UI;
- progress-aware CPM or Data Date rescheduling.

The next persistence step is a real API/server-side persistence implementation. Progress-aware scheduling remains a separate scheduling track.
