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
| `MR_ProjectTags` | Controlled Project tag catalog (name, colour, icon) | PK `ProjectTagId`; unique `(ProjectId, TagName)` |
| `MR_ProjectAccess` | MERGEN-owned full/read grants | PK `(ProjectId, Sicil)`; Sicil/access index; rowversion |
| `MR_WBS` | Structural WBS hierarchy (manual and CN43N-sourced) | PK `WbsId`; unique `(WbsId, ProjectId)` and `(ProjectId, Code)`; filtered unique `(ProjectId, SourceKey)`; same-Project composite parent FK; project/parent/sort and project/source indexes; rowversion |
| `MR_Tasks` | Canonical mutable activity data | PK `TaskId`; unique `(TaskId, ProjectId)`; same-Project WBS FK; project/status, target, planned-range and WBS indexes; rowversion |
| `MR_TaskAssignees` | Normalized Task-to-Sicil assignments | PK `(TaskId, Sicil)`; critical `IX_MR_TaskAssignees_Sicil_Task` |
| `MR_TaskScheduleChangeRequests` | Persistent proposed-date workflow and decision history | PK `RequestId`; Task FK; filtered unique pending `(TaskId, RequesterSicil)`; owner/status and requester/status indexes; rowversion |
| `MR_TaskDependencies` | Normalized FS/SS/FF/SF relationships | PK `TaskDependencyId`; same-Project composite Task FKs; unique relationship; predecessor index |
| `MR_Baselines` | Immutable baseline headers | PK `BaselineId`; Project lookup; one primary baseline per Project |
| `MR_TaskBaselineSnapshots` | Immutable planned Task snapshots | PK `(BaselineId, TaskId)`; Task lookup; deliberately no FK to current Task (see *Baseline history*) |
| `MR_AuditLog` | Append-only committed business audit | identity PK; Project/time, actor/time, entity/time and correlation indexes |
| `MR_CorporateWbsSyncState` | CN43N synchronization fingerprints per corporate project | PK `ProjectCode` (`nvarchar(255)`, same width as `MR_Projects.ProjectCode`); `ContentHash` (SHA-256 hex), `NodeCount`, `SyncedAt` |
| `MR_ReminderSettings` | Single-row reminder template and automatic policy | PK `SettingsId` with `CHECK (SettingsId = 1)`; rowversion |
| `MR_TaskReminderLog` | Append-only reminder send history and duplicate-send claim | identity PK; `IX_MR_TaskReminderLog_Task_Created`; filtered unique `UX_MR_TaskReminderLog_AutomaticSlot` on `(TaskId, SlotKey)` where `ReminderKind = 'AUTOMATIC'` |

## Rowversion

`MR_Projects`, `MR_WBS`, `MR_Tasks`, `MR_TaskScheduleChangeRequests`, `MR_UserRoles`, `MR_Calendars`, and `MR_ProjectAccess` include `rowversion`. The application returns these bytes as opaque Base64 tokens. They are compared in update/delete predicates and are never interpreted as business numbers.

## Project schema

`SourceType` is `CORPORATE` or `MANUAL`. Corporate code, name, type fields, and `LeadSicil` are synchronized from A01/HR09 and are server-authoritative. The corporate lead comes from `MR_V_CorporateProjectAccess.RoleCode = 'PROJECT_MANAGER'`. Application metadata such as Data Date, color token, calendar, and tags remains MERGEN-owned. `DataDate` is nullable: it is the progress cut-off date, not a row timestamp, and a project can be created before that cut-off is decided. Corporate project updates preserve `LeadSicil` server-side (`CASE WHEN SourceType = 'MANUAL'`), so editing MERGEN-owned fields cannot clear the corporate lead. Manual Project leads remain selectable. A filtered unique index protects non-null Project codes without preventing multiple manual Projects whose code is null.

## WBS schema and corporate source

`SourceType` is `CORPORATE` or `MANUAL`. Manual rows are authored in the application. Corporate rows are mirrored from the corporate `CN43N` table, which lives in a different database and is reached through the dedicated `MERGEN_ROTA_WBS_DB_*` connection. Corporate rows carry the source attributes: `SourceKey` (`WBS element`), `OutlineCode` (`PYP kodu`), `WbsLevel` (`Level`), `StatusCode` (`Status`) and `ElementTypeCode` (`Proj.type`). `CK_MR_WBS_SourceKey` keeps `SourceKey` exclusive to corporate rows and the filtered unique index makes `(ProjectId, SourceKey)` the stable identity used by synchronization.

The project root node is always MERGEN-generated: its `SourceKey` is `NULL` and its `Code` is the project code for corporate projects. Synchronization never deletes it, never touches manual rows, and deletes a vanished corporate element only when no child row and no Task reference it. Column mapping and synchronization rules are documented in `docs/WBS-AND-WORKSPACES.md`.

## Corporate WBS synchronization state

`MR_CorporateWbsSyncState` stores one row per corporate project code: the SHA-256 fingerprint of the planned CN43N node set and the node count that fingerprint represents. The key holds the full project code — truncating it would make the lookup miss (the fingerprint could never suppress a merge) and would let two codes sharing a prefix overwrite one another's row. Snapshot loading skips the `MR_WBS` merge for a project when the recomputed fingerprint, the stored node count and the corporate node count actually present in `MR_WBS` all match. The table holds no business data — dropping it only costs one full resynchronization.

## Project tag appearance

Existing durable databases receive these columns through `database/MR_Upgrade_0004_Tag_Appearance_And_Recurrence.sql`, which is run **before** the application version is deployed. The clean-create script deliberately aborts when any `MR_*` object already exists, so it can never upgrade a live database; the upgrade script is idempotent and adds columns, constraints and indexes only when they are missing.

`MR_ProjectTags` carries `ColorToken varchar(20)` and `IconKey varchar(40)` beside `TagName`. Both are nullable: a `NULL` colour resolves to a deterministic palette entry derived from the tag name, and a `NULL` icon resolves to the default. Rows written before this column pair existed therefore stay valid without a data migration. Both values are closed sets owned by `src/domain/tags/index.js`; the commit boundary rejects anything outside them (`PROJECT_TAG_COLOR_INVALID`, `PROJECT_TAG_ICON_INVALID`). See `docs/TAGS-AND-RECURRING-TASKS.md`.

## Recurring task columns

`MR_Tasks` carries `RecurrenceRule nvarchar(400)`, `RecurrenceParentTaskId uniqueidentifier` and `RecurrenceOccurrenceDate date`. The rule is an RFC 5545 `RRULE` body and lives only on the series template; generated occurrences reference the template through `RecurrenceParentTaskId`. `CK_MR_Tasks_Recurrence` enforces that an occurrence never carries its own rule, `CK_MR_Tasks_RecurrenceSelf` blocks a self-reference, and a filtered index supports listing a template's occurrences. `RecurrenceOccurrenceDate` is the occurrence's immutable series identity (the RFC 5545 `RECURRENCE-ID` equivalent): rescheduling an occurrence does not change it, and `UX_MR_Tasks_RecurrenceOccurrence` makes `(template, occurrence day)` unique so two concurrent writers cannot both materialize the same day. The rule text is canonicalized before it is written and validated strictly at the commit boundary, so neither an unparseable value nor a rule the engine can never fulfil reaches durable storage.

## Task priority values

`MR_Tasks.Priority` accepts `low`, `medium`, `high`, `critical` and the legacy `normal`, and defaults to `medium`. The application writes only catalog identifiers: `normal` had no counterpart in the UI priority catalog, so a task stored with it made the Tasks, Kanban and Reports pages read `undefined.color` and crash the client. Legacy `normal` rows are still readable and are canonicalized to `medium` in the snapshot projection.

## WBS and Task consistency

WBS has a composite self-reference `(ParentWbsId, ProjectId) → (WbsId, ProjectId)`, preventing cross-Project parents. Task uses `(WbsId, ProjectId) → MR_WBS(WbsId, ProjectId)`, preventing cross-Project WBS assignment. Dependency rows carry `ProjectId`; both Task and predecessor composite foreign keys enforce one Project network.

Calculated CPM dates, float, critical flags, WBS schedule rollups, Dashboard aggregates, and report aggregates are not persisted.

## Assignments and external identity

Assignments store one row per `(TaskId, Sicil)`. No comma-separated identity fields and no FK to HR02 are used. The server validates Sicil through the normalized people view before committing assignment changes.

## Schedule-change requests

`MR_TaskScheduleChangeRequests` stores the requester and decision-owner Sicils, original/proposed planned start, planned finish and target finish, requester/decision messages, status, timestamps, decision actor, `CreatedAgainstTaskVersion binary(8)`, and its own rowversion. Status is constrained to `PENDING`, `ACCEPTED`, `REJECTED`, `CANCELLED`, or `STALE`. A filtered unique index permits at most one PENDING request per requester and Task while preserving the complete decision history.

The Task foreign key cascades deletion because a request cannot remain meaningful after its Task is removed. Acceptance does not trust the request row alone: the transaction compares the original date triple with the locked current Task before applying dates and marks the request `STALE` when the plan moved. `CreatedAgainstTaskVersion` is recorded as diagnostic evidence only, because an unrelated Task write also changes the rowversion. Request create, accept, reject/stale and the resulting Task update use the existing audit log and trusted Sicil identity.

## Baseline history

A baseline snapshot can outlive its current Task. Therefore `MR_TaskBaselineSnapshots.TaskId` is indexed but intentionally has no FK to `MR_Tasks`; the create script states the same decision at the table definition so it is not read as an oversight. Deleting a current Task does not rewrite or silently delete historical snapshots — adding the constraint would let a delete rewrite variance history retroactively. Normal Task/WBS mutations never update baseline rows.

## Audit model

Every committed Project, WBS, and Task create/update/delete writes an audit row in the same transaction. One atomic change set uses one `CorrelationId`. Create records have `AfterJson`; delete records have `BeforeJson`; updates have both. Actor fields come from trusted server identity. Credentials, secrets, raw SQL, and unnecessary complete HR source records are excluded.

## Read-only views

### `MR_V_CorporateProjects`

Reads only:

- `Tur`
- `Tur_Aciklama`
- `ProjeKodu`
- `ProjeAdi`

from `A01_ProjeUrunFaaliyetRaporu`, filters blank codes, and groups by the **normalized** code, `UPPER(NULLIF(LTRIM(RTRIM(ProjeKodu)), ''))`. No wide source columns or `SELECT *` are permitted.

Grouping by the raw columns produced several rows for one `ProjectCode`: source rows `' abc '` and `'ABC'` formed two groups that both normalized to `ABC`, and one code carrying two different `ProjeAdi` or `Tur_Aciklama` values had the same effect. `UX_MR_Projects_ProjectCode` is unique on the code, so a synchronization that upserts one row per view row either failed with a duplicate-key violation or wrote a nondeterministic project name depending on row order. The remaining columns are therefore aggregated with `MIN(...)`, which picks one deterministic value per code.

### `MR_V_CorporateProjectAccess`

Normalizes each HR09 responsibility column into `(ProjectCode, Sicil, RoleCode, ProgramMd)`. `pptsSicil` values use the `PPTS` role code together with `STRING_SPLIT`, trimming, and `TRY_CONVERT(int, value)`. Exact tokenization prevents partial-number authorization.

### `MR_V_ExecutiveScope`

Produces the union of Directorate, Department, and Unit subordinate scopes directly from HR02. Organizational changes become effective dynamically without copying hierarchy into MR_* tables.

### `MR_V_PeopleDirectory`

Normalizes HR02 by Sicil and chooses one deterministic row for duplicate Sicil values. Team falls back from Unit to Department, Directorate, then Sector. Duplicate master data remains observable at the source boundary and never produces duplicate Person IDs.

## Reminder schema

`MR_ReminderSettings` holds exactly one row. The editable e-mail template (`SubjectTemplate`, `BodyTemplate`) and the automatic policy (`AutomaticEnabled`, `WindowValue`, `WindowUnit`, `FrequencyValue`, `FrequencyUnit`) live here — not in `.env.local` — because they are administrator-editable application data, not deployment configuration. Only SMTP connection settings and the scheduler secret are environment variables. The row is seeded with the default Turkish template and `AutomaticEnabled = 0`, so an upgrade never starts sending mail on its own.

`MR_TaskReminderLog` serves two purposes at once. It is the audit history of every attempt (`ReminderKind` = `MANUAL`/`AUTOMATIC`, `Status` = `PENDING` → `SENT`/`FAILED`, `RecipientCount`, `RecipientDigest`, `FailureCode`, `RequestedBySicil`, `CreatedAt`, `CompletedAt`), and it is the duplicate-send claim: an automatic pass inserts the row carrying the deterministic `SlotKey` as `PENDING` *before* dialling SMTP, then completes it. `UX_MR_TaskReminderLog_AutomaticSlot` makes that insert the mutual-exclusion primitive, so the same slot cannot be claimed twice across restarts or by two application instances racing on the same schedule. A slot whose send later fails stays claimed; the retry happens in the next slot rather than in a tight loop.

A `PENDING` row is not claimed forever, though. The service's `catch` block covers JavaScript exceptions only, so a process that ends mid-send (deploy, restart, host failure) used to leave the slot claimed permanently and that reminder could never be delivered. `REMINDER_CLAIM_SQL` therefore re-claims a `PENDING` row older than 30 minutes **in place** — the row is reused, marked `FailureCode = 'ABANDONED'` and re-stamped, so the filtered unique index still holds and no second row appears. The threshold is far above `SMTP_TIMEOUT_MS` so a send that is still running is never re-claimed.

**Residual risk — an ambiguous SMTP outcome can produce one duplicate.** Reusing the row preserves the unique index; it does not make *delivery* idempotent. If the process ends after SMTP has accepted the message but before the `SENT` update lands, the row stays `PENDING`, the 30-minute reclaim sends the same `(TaskId, SlotKey)` again, and recipients receive the reminder twice. The window is narrow and the direction is deliberate: a missed reminder is worse than a repeated one, and there is no way to distinguish "accepted then lost the ack" from "never accepted" without an idempotency key the SMTP relay honours. Closing it properly requires recording the outcome as *unknown* and reconciling it against the relay — a change to the delivery contract, not to this index. Operators investigating a duplicate should start from the `ABANDONED` failure code, but must read it as *"this slot was reclaimed after an attempt of unknown outcome"*, **not** as proof that a duplicate was delivered: the same code is written whether SMTP had accepted the message or the process died before it ever dialled out. Only the relay's own log can separate the two, so `ABANDONED` narrows the search rather than answering it.

The index is filtered on `ReminderKind = 'AUTOMATIC'`, so manual sends are outside it entirely: a user may deliberately send a second reminder for the same task. Manual rows still carry a slot key (`manual:<uuid>`) so every row has a stable identity.

Recipient addresses are stored masked (`a***@example.com`). The authoritative address always remains `DC01_userr.EmailAddress`; nothing copies personnel e-mail into Task records.

### Personnel e-mail resolution (`DC01_userr`)

Recipients are resolved server-side at send time by joining MERGEN data to the corporate user directory:

```
MR_TaskAssignees.Sicil
  → MR_V_PeopleDirectory.Username          (HR02 rehber, kullanici_adi)
  → DC01_userr.Name                        (case-insensitive match)
  → DC01_userr.EmailAddress
```

`DC01_userr` is read-only, lives in `MERGEN_ROTA_DB_DATABASE`, and is never written to. Its schema and table name are configurable (`MERGEN_ROTA_USER_DIRECTORY_SCHEMA`, `MERGEN_ROTA_USER_DIRECTORY_TABLE`) so an installation with a different directory object needs no code change. The query tolerates every observed data defect: a missing directory row, a NULL/blank/malformed address, several users sharing one address and one user appearing more than once. Addresses are validated and de-duplicated before use; when nothing valid survives, no message is sent and the caller is told why.

## Index rationale

- Project/status and Project/date indexes support Task lists, filters, Gantt, and target-date sorting.
- WBS Project/parent/sort supports tree traversal.
- Assignee Sicil/Task supports own-task and executive visibility.
- ProjectAccess Sicil/active/access supports authorization loading.
- Dependency predecessor index supports relationship validation and explicit delete cleanup.
- Baseline Project and snapshot Task indexes support Project history and deleted-Task lookup.
- Audit indexes support Project, actor, entity, and transaction-correlation investigations.
- The reminder log's Task/time index supports send history; its filtered unique slot index is the duplicate-send guard rather than a read optimization.

Indexes are limited to demonstrated repository and UI query patterns rather than being created for every column.

## Creation and rollback

Remove existing MERGEN-owned objects with:

`database/MR_Rollback_Durable_Persistence.sql`

Then create the complete current schema with:

`database/MR_Create_Durable_Persistence.sql`

The creation script performs source-table preflight, fails fast if MR_* objects already exist, uses a transaction and TRY/CATCH, creates `MR_V_CorporateProjectAccess` directly with the `PPTS` role code, seeds the default calendar, seeds SYSTEM_ADMIN roles from the `@SystemAdminSicils` parameter (empty by default; real Sicil values are personal data and are not committed), and records `0001_durable_persistence`.

Task reminders are added by `database/MR_Upgrade_0005_Task_Reminders.sql`, which is idempotent and safe to rerun: it creates `MR_ReminderSettings` and `MR_TaskReminderLog` only when absent, seeds the single settings row with automatic sending disabled, creates the filtered unique slot index and records `0005_task_reminders`. Existing data is untouched. `MR_Create_Durable_Persistence.sql` creates the same objects for a fresh installation and `MR_Rollback_Durable_Persistence.sql` drops them in reverse order.

Schedule-change requests are added by `database/MR_Upgrade_0007_Task_Schedule_Change_Requests.sql`. The migration is idempotent, creates only the missing table/indexes, records `0007_task_schedule_change_requests`, and never rewrites existing Tasks. Fresh installations create the same object in `MR_Create_Durable_Persistence.sql`; rollback drops it before Task rows.

During the first corporate project synchronization, the repository fills `MR_Projects.LeadSicil` from the `PROJECT_MANAGER` role. No separate `0002` migration script is required while the application is being tested through clean database recreation.

The rollback is intentionally destructive to MERGEN-owned data, drops views before tables in dependency-safe reverse order, is rerunnable, and never drops or alters HR02, A01, or HR09.

## Authentication and the schema

Keycloak authentication required **no schema change**. It replaces the identity
provider only: the verified `sicil` claim (or the optional
`preferred_username → MR_V_PeopleDirectory.Username → Sicil` lookup) feeds the
same `loadAuthorizationContext()` query that already existed.

`MR_V_PeopleDirectory` is read for the username fallback with a parameterized
query that must return exactly one Sicil; ambiguous results grant nothing. The
`0003_keycloak_identity` migration row records this phase and the parameterized
SYSTEM_ADMIN seed.

Generated user photograph URLs are presentation data and are **not persisted**
in any table. They are derived at render time from the configured base URL and
the employee number.
