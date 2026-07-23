# MERGEN Rota Database Schema

All application-owned SQL Server objects use the `dbo.MR_` prefix. Corporate source tables are read-only and have no foreign keys from MERGEN tables. Employee references are logical Sicil references because HR02 owns employee lifecycle.

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
| `MR_WBS` | Structural WBS hierarchy | PK `WbsId`; unique `(WbsId, ProjectId)` and `(ProjectId, Code)`; same-Project composite parent FK; project/parent/sort index; rowversion |
| `MR_Tasks` | Canonical mutable activity data | PK `TaskId`; unique `(TaskId, ProjectId)`; same-Project WBS FK; project/status, target, planned-range and WBS indexes; rowversion |
| `MR_TaskAssignees` | Normalized Task-to-Sicil assignments | PK `(TaskId, Sicil)`; critical `IX_MR_TaskAssignees_Sicil_Task` |
| `MR_TaskDependencies` | Normalized FS/SS/FF/SF relationships | PK `TaskDependencyId`; same-Project composite Task FKs; unique relationship; predecessor index |
| `MR_Baselines` | Immutable baseline headers | PK `BaselineId`; Project lookup; one primary baseline per Project |
| `MR_TaskBaselineSnapshots` | Immutable planned Task snapshots | PK `(BaselineId, TaskId)`; Task lookup; deliberately no FK to current Task |
| `MR_AuditLog` | Append-only committed business audit | identity PK; Project/time, actor/time, entity/time and correlation indexes |

## Rowversion

`MR_Projects`, `MR_WBS`, `MR_Tasks`, `MR_UserRoles`, `MR_Calendars`, and `MR_ProjectAccess` include `rowversion`. The application returns these bytes as opaque Base64 tokens. They are compared in update/delete predicates and are never interpreted as business numbers.

## Project schema

`SourceType` is `CORPORATE` or `MANUAL`. Corporate code, name, and type fields are synchronized from A01 and are server-authoritative. Application metadata such as Data Date, color token, calendar, tags, and lead remains MERGEN-owned. A filtered unique index protects non-null Project codes without preventing multiple manual Projects whose code is null.

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

Normalizes each HR09 responsibility column into `(ProjectCode, Sicil, RoleCode, ProgramMd)`. PPTC values use `STRING_SPLIT`, trimming, and `TRY_CONVERT(int, value)`. Exact tokenization prevents partial-number authorization.

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

Create with:

`database/MR_Create_Durable_Persistence.sql`

The script performs source-table preflight, fails fast if MR_* objects already exist, uses a transaction and TRY/CATCH, seeds the default calendar, seeds SYSTEM_ADMIN roles for 10276, 18068, and 23977, and records migration `0001_durable_persistence`.

Remove with:

`database/MR_Rollback_Durable_Persistence.sql`

The rollback is intentionally destructive to MERGEN-owned data, drops views before tables in dependency-safe reverse order, is rerunnable, and never drops or alters HR02, A01, or HR09.
