# MERGEN Rota Database Schema

All application-owned SQL Server objects use the `dbo.MR_` prefix. Corporate source tables are read-only and have no foreign keys from MERGEN tables. Employee references are logical Sicil references because HR02 owns employee lifecycle.

Identity values in `uniqueidentifier` columns are only required to be valid GUIDs. Corporate systems emit GUIDs without RFC 4122 version and variant bits (for example `D5D70AEC-0A88-F111-9136-00505699BACD`), so the application must never validate them against a version-constrained UUID pattern. All layers canonicalize identities to lower case before comparing them, because SQL Server returns them as upper-case text.

## Tables

| Table | Purpose | Important keys and indexes |
| --- | --- | --- |
| `MR_SchemaMigrations` | Applied schema records | PK `MigrationId` |
| `MR_UserRoles` | Application roles such as SYSTEM_ADMIN | PK `(Sicil, RoleCode)`; `IX_MR_UserRoles_Role_Active_Sicil`; rowversion |
| `MR_Calendars` | Scheduling calendar headers | PK `CalendarId`; filtered unique active default; rowversion |
| `MR_CalendarWorkingDays` | Weekday membership | PK `(CalendarId, Weekday)`; weekday 0–6 |
| `MR_CalendarHolidays` | Explicit holiday dates | PK `(CalendarId, HolidayDate)` |
| `MR_Projects` | Corporate registry and manual Projects | PK `ProjectId`; filtered unique `ProjectCode`; source/active and calendar indexes; rowversion |
| `MR_ProjectTags` | Controlled Project tag catalog | PK `ProjectTagId`; unique `(ProjectId, TagName)` |
| `MR_ProjectAccess` | MERGEN-owned full/read grants | PK `(ProjectId, Sicil)`; Sicil/access index; rowversion |
| `MR_WBS` | Structural WBS hierarchy (manual and CN43N-sourced) | PK `WbsId`; unique `(WbsId, ProjectId)` and `(ProjectId, Code)`; filtered unique `(ProjectId, SourceKey)`; same-Project composite parent FK; project/parent/sort and project/source indexes; rowversion |
| `MR_Tasks` | Canonical mutable activity data | PK `TaskId`; unique `(TaskId, ProjectId)`; same-Project WBS FK; project/status, target, planned-range and WBS indexes; rowversion |
| `MR_TaskAssignees` | Normalized Task-to-Sicil assignments | PK `(TaskId, Sicil)`; critical `IX_MR_TaskAssignees_Sicil_Task` |
| `MR_TaskDependencies` | Normalized FS/SS/FF/SF relationships | PK `TaskDependencyId`; same-Project composite Task FKs; unique relationship; predecessor index |
| `MR_Baselines` | Immutable baseline headers | PK `BaselineId`; Project lookup; one primary baseline per Project |
| `MR_TaskBaselineSnapshots` | Immutable planned Task snapshots | PK `(BaselineId, TaskId)`; Task lookup; deliberately no FK to current Task |
| `MR_AuditLog` | Append-only committed business audit | identity PK; Project/time, actor/time, entity/time and correlation indexes |

## Rowversion

`MR_Projects`, `MR_WBS`, `MR_Tasks`, `MR_UserRoles`, `MR_Calendars`, and `MR_ProjectAccess` include `rowversion`. The application returns these bytes as opaque Base64 tokens. They are compared in update/delete predicates and are never interpreted as business numbers.

## Project schema

`SourceType` is `CORPORATE` or `MANUAL`. Corporate code, name, type fields, and `LeadSicil` are synchronized from A01/HR09 and are server-authoritative. The corporate lead comes from `MR_V_CorporateProjectAccess.RoleCode = 'PROJECT_MANAGER'`. Application metadata such as Data Date, color token, calendar, and tags remains MERGEN-owned. `DataDate` is nullable: it is the progress cut-off date, not a row timestamp, and a project can be created before that cut-off is decided. Corporate project updates preserve `LeadSicil` server-side (`CASE WHEN SourceType = 'MANUAL'`), so editing MERGEN-owned fields cannot clear the corporate lead. Manual Project leads remain selectable. A filtered unique index protects non-null Project codes without preventing multiple manual Projects whose code is null.

## WBS schema and corporate source

`SourceType` is `CORPORATE` or `MANUAL`. Manual rows are authored in the application. Corporate rows are mirrored from the corporate `CN43N` table, which lives in a different database and is reached through the dedicated `MERGEN_ROTA_WBS_DB_*` connection. Corporate rows carry the source attributes: `SourceKey` (`WBS element`), `OutlineCode` (`PYP kodu`), `WbsLevel` (`Level`), `StatusCode` (`Status`) and `ElementTypeCode` (`Proj.type`). `CK_MR_WBS_SourceKey` keeps `SourceKey` exclusive to corporate rows and the filtered unique index makes `(ProjectId, SourceKey)` the stable identity used by synchronization.

The project root node is always MERGEN-generated: its `SourceKey` is `NULL` and its `Code` is the project code for corporate projects. Synchronization never deletes it, never touches manual rows, and deletes a vanished corporate element only when no child row and no Task reference it. Column mapping and synchronization rules are documented in `docs/WBS-AND-WORKSPACES.md`.

## WBS and Task consistency

WBS has a composite self-reference `(ParentWbsId, ProjectId) → (WbsId, ProjectId)`, preventing cross-Project parents. Task uses `(WbsId, ProjectId) → MR_WBS(WbsId, ProjectId)`, preventing cross-Project WBS assignment. Dependency rows carry `ProjectId`; both Task and predecessor composite foreign keys enforce one Project network.

Calculated CPM dates, float, critical flags, WBS schedule rollups, Dashboard aggregates, and report aggregates are not persisted.

## Assignments and external identity

Assignments store one row per `(TaskId, Sicil)`. No comma-separated identity fields and no FK to HR02 are used. The server validates Sicil through the normalized people view before committing assignment changes.

## Baseline history

A baseline snapshot can outlive its current Task. Therefore `MR_TaskBaselineSnapshots.TaskId` is indexed but intentionally has no FK to `MR_Tasks`. Deleting a current Task does not rewrite or silently delete historical snapshots. Normal Task/WBS mutations never update baseline rows.

## Audit model

Every committed Project, WBS, and Task create/update/delete writes an audit row in the same transaction. One atomic change set uses one `CorrelationId`. Create records have `AfterJson`; delete records have `BeforeJson`; updates have both. Actor fields come from trusted server identity. Credentials, secrets, raw SQL, and unnecessary complete HR source records are excluded.

## Read-only views

### `MR_V_CorporateProjects`

Reads only:

- `Tur`
- `Tur_Aciklama`
- `ProjeKodu`
- `ProjeAdi`

from `A01_ProjeUrunFaaliyetRaporu`, filters blank codes, and uses `GROUP BY Tur, Tur_Aciklama, ProjeKodu, ProjeAdi`. No wide source columns or `SELECT *` are permitted.

### `MR_V_CorporateProjectAccess`

Normalizes each HR09 responsibility column into `(ProjectCode, Sicil, RoleCode, ProgramMd)`. `pptsSicil` values use the `PPTS` role code together with `STRING_SPLIT`, trimming, and `TRY_CONVERT(int, value)`. Exact tokenization prevents partial-number authorization.

### `MR_V_ExecutiveScope`

Produces the union of Directorate, Department, and Unit subordinate scopes directly from HR02. Organizational changes become effective dynamically without copying hierarchy into MR_* tables.

### `MR_V_PeopleDirectory`

Normalizes HR02 by Sicil and chooses one deterministic row for duplicate Sicil values. Team falls back from Unit to Department, Directorate, then Sector. Duplicate master data remains observable at the source boundary and never produces duplicate Person IDs.

## Index rationale

- Project/status and Project/date indexes support Task lists, filters, Gantt, and target-date sorting.
- WBS Project/parent/sort supports tree traversal.
- Assignee Sicil/Task supports own-task and executive visibility.
- ProjectAccess Sicil/active/access supports authorization loading.
- Dependency predecessor index supports relationship validation and explicit delete cleanup.
- Baseline Project and snapshot Task indexes support Project history and deleted-Task lookup.
- Audit indexes support Project, actor, entity, and transaction-correlation investigations.

Indexes are limited to demonstrated repository and UI query patterns rather than being created for every column.

## Creation and rollback

Remove existing MERGEN-owned objects with:

`database/MR_Rollback_Durable_Persistence.sql`

Then create the complete current schema with:

`database/MR_Create_Durable_Persistence.sql`

The creation script performs source-table preflight, fails fast if MR_* objects already exist, uses a transaction and TRY/CATCH, creates `MR_V_CorporateProjectAccess` directly with the `PPTS` role code, seeds the default calendar, seeds SYSTEM_ADMIN roles for 10276, 18068, and 23977, and records `0001_durable_persistence`.

During the first corporate project synchronization, the repository fills `MR_Projects.LeadSicil` from the `PROJECT_MANAGER` role. No separate `0002` migration script is required while the application is being tested through clean database recreation.

The rollback is intentionally destructive to MERGEN-owned data, drops views before tables in dependency-safe reverse order, is rerunnable, and never drops or alters HR02, A01, or HR09.
