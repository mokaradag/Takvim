# WBS and Workspaces

MERGEN Rota separates portfolio navigation from project execution while keeping Project, WBS and Task as distinct domain entities.

```text
Portfolio
│
├── Project A
│     │
│     ├── WBS A.1
│     │     ├── WBS A.1.1
│     │     │     ├── Activity
│     │     │     └── Activity
│     │     └── Activity
│     │
│     └── WBS A.2
│           └── Activity
│
└── Project B
      └── ...
```

## 1. Portfolio Workspace

Portfolio Workspace is the all-project context. It has no active `selectedProjectId` and preserves the broad application behavior:

- Dashboard uses all tasks;
- Tasks, Calendar and Kanban use all projects;
- the existing portfolio-oriented Gantt remains available;
- Reports use the portfolio dataset;
- Team exposes all people.

Portfolio is not a synthetic Project. It is an application navigation context over the project collection.

## 2. Project Workspace

Project Workspace activates one Project by stable `projectId`. The shared feature hooks then expose only the selected project's relevant tasks, WBS nodes and participating people. Settings remain global.

Project mode also exposes compact project-control context in the shell: Project name, Data Date, Project Calendar and the existing derived CPM finish where available.

CPM is not recalculated per WBS. The selected Project continues to consume the same project-scoped CPM projection that Portfolio mode uses.

## 3. Workspace selection semantics

The state contract is conceptually:

```text
workspaceMode: "portfolio" | "project"
selectedProjectId: null | Project.id
```

A Project is always selected by stable ID, never by display name. An invalid or deleted stored Project ID normalizes safely to Portfolio Workspace.

The last selection is stored under the local UI-preference key `mergen-rota.workspace.v1`. This localStorage value is only a workspace preference; it is not project data or application persistence. Repository loading therefore remains independent from this preference, which is restored only after Project data is ready and can be validated.

Switching projects clears a selected Task when that Task belongs to a different Project. The shell also remounts feature-local view state for the new workspace so stale cross-project filters do not survive a workspace switch.

Repository reload uses the same reconciliation rules: a missing selected Project falls back to Portfolio mode and a selected Task that no longer exists or no longer belongs to the active Project is cleared.

## 4. WBS domain model

A canonical WBS node contains:

```text
id
projectId
parentId
code
name
sortOrder?         // optional deterministic sibling-order hint
source             // "manual" | "corporate"
sourceKey?         // corporate WBS element code (CN43N "WBS element")
outlineCode?       // corporate outline code (CN43N "PYP kodu", e.g. 1.3.2.5)
level?             // corporate hierarchy level (CN43N "Level")
statusCode?        // corporate element status (CN43N "Status")
elementTypeCode?   // corporate element type (CN43N "Proj.type")
```

`id` is the stable relationship key. `projectId` owns the node. `parentId` references another WBS node in the same Project or is `null` for a root.

`sortOrder` is optional. Display ordering falls back deterministically to WBS code, name and stable ID.

WBS nodes are structural entities. They are not Tasks and do not persist schedule rollups.

`source` records who owns the structure. `manual` nodes are authored in MERGEN Rota. `corporate` nodes are mirrored from the corporate CN43N source and are read-only in the application; the remaining corporate fields carry the source attributes used for display.

## 4.1 Corporate WBS source (CN43N)

Corporate projects do not have an application-authored WBS. Their structure is fed from the corporate `CN43N` table, which lives in a **different database** than `MERGEN_Rota` and therefore has its own connection block in `.env.example` (`MERGEN_ROTA_WBS_DB_*`). Leaving `MERGEN_ROTA_WBS_DB_SERVER` / `..._DATABASE` empty disables the synchronization; corporate projects then show only their root node.

Source columns and their mapping:

| CN43N column | Meaning | MERGEN Rota target |
| --- | --- | --- |
| `Proje tanımı` | project code (same value as `projeKodu`) | join key to `MR_Projects.ProjectCode` |
| `WBS element` | corporate WBS element code | `MR_WBS.SourceKey` and `MR_WBS.Code` |
| `Name` | element name | `MR_WBS.Name` |
| `Level` | hierarchy level (1 is directly below the project) | `MR_WBS.WbsLevel` |
| `Kontrol kodu` | not used | — |
| `Planlanan bşl.tarihi` | not used | — |
| `Planlanan bitiş trm.` | not used | — |
| `Status` | element status | `MR_WBS.StatusCode` |
| `PYP kodu` | outline code, levels separated by full stops | `MR_WBS.OutlineCode` |
| `Proj.type` | element type (two capital letters) | `MR_WBS.ElementTypeCode` |

Synchronization rules:

1. The project's root node stays MERGEN Rota-generated (`SourceKey` is `NULL`, `Code` is the project code) so the single-root invariant and existing Task references survive. CN43N level-1 elements attach to it.
2. Parents are resolved from `PYP kodu` by dropping the last outline segment. Elements whose parent cannot be resolved — missing, malformed or cyclic outline codes — attach to the project root instead of being dropped.
3. If the source lists the project itself as a WBS element, that row is not inserted as a node; its children fall back to the project root.
4. New elements are inserted, changed elements are updated, and elements that disappear from the source are deleted **only** when no child node and no Task reference them. A corporate node that carries Tasks is therefore never removed silently.
5. Synchronization runs on snapshot load, batched by project code. When the source database is unreachable the snapshot still loads: the failure is logged and corporate WBS is left as-is, because a second-database outage must not take the application down.

Cost characteristic: CN43N is read with one query per `MERGEN_ROTA_WBS_SYNC_PROJECT_BATCH` project codes (default 50) on the source connection, and the merge is one statement per project that actually has source rows. The merge statements are conditional, so an unchanged tree performs no writes, but a portfolio with several hundred corporate projects still costs one round trip each per snapshot load. If that becomes visible on the real dataset, the next step is a multi-project merge payload rather than per-project statements.

Corporate WBS structure is read-only end to end: `resolveWbsMutationAccess` blocks the UI actions in Gerçek Sistem mode, and `commitWbs` / `deleteWbs` reject the mutation independently on the server. Assigning Tasks to corporate WBS nodes and moving Tasks between them stays allowed — the Task-to-WBS link is MERGEN Rota data, not corporate structure. In Demo mode there is no corporate source, so sample projects keep an editable tree.

## 5. WBS hierarchy rules

The domain validation layer detects:

- `DUPLICATE_WBS_ID`;
- `MISSING_WBS_PARENT`;
- `WBS_SELF_PARENT`;
- `CROSS_PROJECT_WBS_PARENT`;
- `WBS_CYCLE`.

Hierarchy helpers are cycle-safe and support arbitrary depth. Malformed structures remain inspectable and do not recurse indefinitely.

The shared domain selector layer owns tree construction, flattening, ancestors, descendants, paths, task selection and WBS rollups. Feature components do not implement separate hierarchy algorithms.

## 6. Task-to-WBS relationship

`Task.wbsId` is either `null` or a stable WBS ID owned by the same `Task.projectId`.

Normalization applies the following rule:

1. retain the requested WBS only when it belongs to the Task's Project;
2. otherwise use the Project's root WBS when there is exactly one unambiguous root;
3. otherwise set `wbsId` to `null` for explicit assignment.

When a Task changes Project, an old-project WBS therefore cannot survive accidentally.

## 7. Project ownership rules

The canonical relationship chain is:

```text
Project
  └── WBS hierarchy
        └── Task / Activity
```

A WBS parent must belong to the same Project. A Task and its WBS must belong to the same Project. WBS names and Project names are display values, not relationship keys.

Ownership comparisons use canonical Actual System identities (`src/domain/identity/actualId.js`). SQL Server returns `uniqueidentifier` values as upper-case text while the client sends lower-case, so raw string comparison used to reject valid writes with "Üst WBS aynı projede bulunmalıdır" or "Görev WBS kaydı aynı projede olmalıdır". Every layer now canonicalizes before comparing.

The current mock data assigns every existing Task to a meaningful same-project WBS node while preserving the intentional cross-project dependency used to validate the CPM boundary.

## 8. WBS selectors and derived hierarchy

Shared pure helpers include capabilities equivalent to:

- `buildWbsTree()`;
- `flattenWbsTree()`;
- `selectProjectWbs()`;
- `selectWbsDescendantIds()`;
- `selectWbsPath()` / `formatWbsPath()`;
- `selectTasksForWbs()`;
- `selectWbsTaskRollup()`.

The WBS feature, Task Detail and Project-mode Gantt consume these shared rules rather than maintaining independent tree implementations.

## 9. WBS Gantt summaries

Project-mode Gantt defaults to a WBS hierarchy:

```text
WBS summary row
  child WBS summary row
    Activity row
    Milestone row
```

WBS rows are derived view rows, not canonical Tasks. A summary bar exists only when descendant activities have Current Plan dates and spans:

```text
earliest descendant plannedStart
        →
latest descendant plannedFinish
```

The rollup also derives activity count, progress and critical-activity count. These values are recomputed from Tasks and the existing schedule projection.

## 10. Stored versus derived WBS data

Stored WBS data:

- stable ID;
- owning Project ID;
- parent ID;
- code;
- name;
- optional sibling sort order.

Derived WBS data:

- tree depth and display path;
- descendants;
- direct and subtree task counts;
- Current Plan date range;
- progress rollup;
- critical-task count;
- Gantt summary rows and bars.

Derived values are never written back into WBS records or persisted through the repository.

## 11. Interaction with CPM

CPM remains one independent network calculation per Project. WBS is a structural decomposition and does not define CPM network boundaries.

The application continues to calculate the portfolio schedule projection once at the state boundary. Project Workspace reads the selected Project's existing result. WBS and Gantt components do not call `calculateCpm()`.

Existing behavior is preserved for:

- critical Tasks and paths;
- float values;
- calculated Project finish;
- validation warnings;
- deterministic `CROSS_PROJECT_DEPENDENCY` rejection.

Task moves between WBS nodes and WBS hierarchy reparenting change structural classification only. They do not modify Task dates, durations, dependencies or calendars and therefore do not change CPM output by themselves. CPM output remains derived and is never included in WBS persistence change sets.

## 12. Interaction with Baselines

Baseline schedule snapshots remain separate immutable historical entities under normal Task and WBS operations.

Changing a Task's WBS, moving multiple Tasks between WBS nodes, reparenting a WBS subtree, renaming a WBS node, adding a WBS node or deleting an empty WBS node does not alter `Baseline` or `TaskBaselineSnapshot` records.

Historical WBS structure versioning is not implemented. A baseline schedule snapshot therefore describes schedule facts captured at baseline time while the current WBS describes the current project structure.

## 13. Controlled move workflows

### Task movement

The WBS feature provides a project-scoped movement workspace. A source WBS is selected first, then one or more Tasks directly assigned to that source can be selected and moved to another WBS in the same Project.

The state/domain boundary validates the entire selection before persistence:

- the target WBS must exist;
- every selected Task must exist;
- every selected Task must belong to the target WBS Project;
- if any selected Task fails validation, no repository mutation is attempted.

Only `Task.wbsId` changes during a successful move. Schedule fields, dependencies, assignments, Project ownership and baseline snapshots remain unchanged.

A single Task move persists one canonical Task update. A bulk move persists every changed Task assignment in one `commitChanges()` call, which is the explicit atomic transaction boundary for a future API/SQL implementation. The current async memory adapter applies that change set all-or-nothing as well.

### WBS reparenting

A non-root WBS node can be moved under another valid WBS node in the same Project. The operation is rejected when:

- the source or target does not exist;
- the source is a Project root;
- the source is moved under itself;
- the target belongs to another Project;
- the target is already a descendant of the source and would create a cycle.

A successful reparent keeps every WBS stable ID unchanged. The moved node receives the next deterministic child code under its new parent, and descendant display codes are rebased to the new prefix. Existing Task assignments continue to reference the same stable WBS IDs and therefore move with the subtree structurally without rewriting Task records.

All WBS nodes changed by the reparent/code-rebase operation are persisted in one atomic repository change set. A persistence failure therefore leaves both canonical application state and the repository hierarchy unchanged rather than exposing a partially rebased subtree.

Business validity remains implemented at the domain/state boundary. The repository owns persistence and atomic commit semantics, not WBS business rules.

## 14. Persistence semantics and current limitations

Task/WBS mutations now pass through the asynchronous state/data persistence boundary. Successful changes survive `loadSnapshot()` calls made against the same active async in-memory repository instance.

The current adapter is not durable storage. A browser refresh that creates a new repository instance, process restart or VM restart starts again from the supplied seed. Real API/database persistence remains future work.

This increment intentionally does not implement:

- durable database or API persistence;
- drag-and-drop WBS editing;
- cross-project Task or WBS movement;
- cascade deletion;
- historical WBS versioning;
- cross-project CPM networks;
- progress-aware CPM or Data Date rescheduling;
- a full project-administration screen.

Deletion remains blocked when a node has children or directly assigned Tasks; no Task or descendant is silently deleted or moved. Persistence failures are reported separately from WBS validation failures.

## 15. Future Primavera P6 mapping considerations

The model is deliberately compatible with a future import boundary based on:

```text
Project → WBS hierarchy → Activities
```

Future adapters can map external Project, WBS and Activity identifiers to MERGEN Rota stable IDs without changing feature hierarchy semantics. The current design already preserves explicit Project ownership, parent relationships, arbitrary WBS depth and a separate Activity entity.

Primavera-specific database identifiers, persistence rules, import conflict handling and synchronization metadata are intentionally deferred until a focused integration contract is designed. The async repository boundary can later sit in front of such server-side integration without exposing persistence implementation details to WBS feature components.
