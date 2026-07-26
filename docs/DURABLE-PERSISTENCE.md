# Durable SQL Server Persistence

## Architecture

MERGEN Rota now has two isolated data paths.

```text
Demo mode
UI → state orchestration → asynchronous in-memory Demo repository

Actual mode
UI → state orchestration → client API repository → Next.js Node routes
   → trusted current-user provider → authorization service
   → SQL Server repository → SQL Server
```

Feature modules continue to use state actions. They do not import SQL Server packages, connection configuration, queries, or server repositories. The browser never connects directly to SQL Server.

## Repository and API contract

`AppRepository` provides `loadSessionContext()`, `loadSnapshot()`, and atomic `commitChanges()`. Actual mode uses:

- `GET /api/mergen-rota/session`
- `GET /api/mergen-rota/snapshot`
- `POST /api/mergen-rota/commit`

All routes force the Next.js Node.js runtime, disable caching, derive identity on the server, and return normalized safe errors. SQL stacks, connection settings, and raw query text are not returned to the browser.

## SQL Server connection

The `mssql` package uses the `msnodesqlv8` driver only under `src/server`. The driver connects with Windows Integrated Authentication (`trustedConnection: true`); MERGEN Rota does not store or accept a SQL username or password. One reusable connection pool is initialized lazily. Queries use typed parameters. Connection and request timeouts are configurable.

SQL Server authenticates the Windows account that runs the Node.js process. During local development this is normally the signed-in Windows account that starts `npm run dev`. In production it should be a dedicated domain service account. IT must grant that account access to the target database, read access to the three corporate sources, and the required read/write permissions on `MR_*` objects.

The host must have Microsoft ODBC Driver 18 for SQL Server installed. Driver 17 may also be selected explicitly when required. The native `msnodesqlv8` dependency normally uses a prebuilt binary; when the approved npm mirror cannot provide that binary, installation falls back to compilation and requires Visual Studio 2022 Build Tools with the **Desktop development with C++** workload.

Required deployment variables are listed in `.env.example`:

- `MERGEN_ROTA_DB_SERVER`
- `MERGEN_ROTA_DB_PORT`
- `MERGEN_ROTA_DB_DATABASE`
- `MERGEN_ROTA_DB_ODBC_DRIVER`
- `MERGEN_ROTA_DB_ENCRYPT`
- `MERGEN_ROTA_DB_TRUST_SERVER_CERTIFICATE`
- `MERGEN_ROTA_DB_CONNECTION_TIMEOUT_MS`
- `MERGEN_ROTA_DB_REQUEST_TIMEOUT_MS`

Do not add `MERGEN_ROTA_DB_USER` or `MERGEN_ROTA_DB_PASSWORD`; they are not used by the Windows-authenticated adapter. All database variables are server-only and must never use the `NEXT_PUBLIC_` prefix.

### Second connection: corporate WBS source (CN43N)

The corporate WBS table `CN43N` is **not** in the `MERGEN_Rota` database, so it has its own connection block and its own lazily initialized pool (`src/server/db/corporateWbsPool.js`), also using Windows Integrated Authentication:

- `MERGEN_ROTA_WBS_DB_SERVER`
- `MERGEN_ROTA_WBS_DB_PORT`
- `MERGEN_ROTA_WBS_DB_DATABASE`
- `MERGEN_ROTA_WBS_DB_SCHEMA` (default `dbo`)
- `MERGEN_ROTA_WBS_DB_TABLE` (default `CN43N`)
- `MERGEN_ROTA_WBS_DB_ODBC_DRIVER`
- `MERGEN_ROTA_WBS_DB_ENCRYPT`
- `MERGEN_ROTA_WBS_DB_TRUST_SERVER_CERTIFICATE`
- `MERGEN_ROTA_WBS_DB_CONNECTION_TIMEOUT_MS`
- `MERGEN_ROTA_WBS_DB_REQUEST_TIMEOUT_MS`
- `MERGEN_ROTA_WBS_SYNC_PROJECT_BATCH` (project codes per source round trip)

The Windows account that runs Node.js needs **read** access to that database. Schema and table names are validated as plain SQL Server identifiers because they are embedded in the query text; project codes are always passed as parameters. Leaving `..._SERVER`/`..._DATABASE` empty disables the synchronization instead of failing: corporate projects then show only their root WBS node. When the source is configured but unreachable, snapshot loading still succeeds and the failure is logged — a second-database outage must not take the application down. Column mapping and merge rules live in `docs/WBS-AND-WORKSPACES.md`.

## Transaction semantics

One `commitChanges()` call maps to one SQL transaction. The server performs trusted identity resolution, authorization, relationship validation, optimistic-concurrency checks, normalized child reconciliation, audit insertion, and the final commit in the same transaction. Any failure rolls back the complete change set.

Atomic operations include Project creation with root WBS and owner access, Task updates with assignees and dependencies, WBS movement/reparenting, bulk Task movement, Project metadata with tags, and audit records.

## Optimistic concurrency

Mutable SQL entities use SQL Server `rowversion`. The API exposes rowversion as an opaque Base64 `version` token. Update and delete commands must provide the expected token. A zero-row update/delete is returned as `CONFLICT` / HTTP 409 rather than silently applying last-write-wins behavior.

A change-set entry **without** a version token is an explicit create intent. `assertUpsertIntentMatchesPersistence` rejects a version-less upsert whose row already exists with `UPSERT_CREATE_COLLISION` ("Kayıt kimliği zaten kullanılıyor").

This makes version freshness a client-side correctness requirement: after every commit the state layer must adopt the authoritative rows the server echoes back. `appStateReducer` therefore applies `projectUpserts`/`projectDeletes` as well as WBS and Task changes when handling `persistence/success`. Previously project rows kept their pre-commit version, so the second edit of the same project (for example changing `Proje rengi` right after saving it) was rejected as a create collision. When a repository does not echo a project row at all, `AppStateProvider` reloads the authoritative snapshot instead of storing a version-less local copy.

## Corporate sources

The three corporate sources remain read-only:

- `HR02_rehisRehberwithMasrafYeri`: live employee and organization directory, normalized by Sicil.
- `A01_ProjeUrunFaaliyetRaporu`: corporate Project catalog. Only `Tur`, `Tur_Aciklama`, `ProjeKodu`, and `ProjeAdi` are selected and the source view uses `GROUP BY` across those four fields.
- `HR09_projeSorumlu`: corporate full-Project responsibility. `pptcSicil` uses `STRING_SPLIT`, trimming, and `TRY_CONVERT(int, value)` for exact token matching; no `LIKE '%sicil%'` authorization is permitted.

Corporate synchronization updates only source-owned Project identity fields, preserves application metadata, inserts missing registry rows and root WBS records, marks disappeared source records inactive, never converts manual Projects, and never writes to A01. Corporate Project updates from the client also preserve `LeadSicil` server-side, so editing MERGEN-owned fields cannot clear the source-owned lead.

Corporate WBS synchronization is a separate step reading `CN43N` through the second connection. It writes only `SourceType = 'CORPORATE'` rows of corporate projects, never manual rows, never the MERGEN-generated project root, and never the source table. Client attempts to write corporate WBS structure are rejected with `FORBIDDEN`.

### Catalog refresh scheduling

Corporate project synchronization and corporate WBS synchronization together form the *catalog refresh*, exposed as `refreshCorporateCatalog()` on the SQL repository and kept separate from `readSnapshot()`. Three properties matter operationally:

- the refresh runs **before and outside** the serializable snapshot-read transaction, so a large CN43N merge no longer inherits serializable isolation or holds range locks on `MR_WBS` for the duration of a read;
- it is **throttled** by `MERGEN_ROTA_WBS_SYNC_TTL_MS` (default 300000; `0` refreshes on every request) and **deduplicated** — concurrent requests share one in-flight refresh;
- it is **fingerprint-gated** per project through `MR_CorporateWbsSyncState`, so an unchanged corporate tree issues no merge statements.

A failed refresh does not advance the freshness window and does not fail the request: the snapshot is served from whatever is already persisted, and the next request retries immediately. An unconfigured CN43N source is not a failure — there is nothing to synchronize, so the window advances normally and corporate project synchronization is not repeated on every request.

## Demo versus Actual mode

Demo mode remains non-durable and uses the existing rich sample dataset. It never calls SQL Server or the Actual API. Actual mode never imports or merges Demo seed records. Repository switching remounts the application state boundary; a persistent `DEMO` indicator prevents sample data from being mistaken for live data. Basit/Gelişmiş is a separate usage-mode choice.

Actual-mode failures do not silently fall back to Demo. The user sees the Actual-system error and may deliberately switch back to Demo.

## Identity

`CurrentUserProvider` is the server identity boundary, and it is now backed by **Keycloak**. `KeycloakIdentityProvider` returns the Sicil carried by the server-signed HttpOnly session cookie, which is written only after a Keycloak token is verified on the server (signature against realm JWKS, plus `iss`/`exp`/`aud`/`azp`). See `docs/KEYCLOAK-SSO.md`.

Replacing the provider required **no** change to the authorization service, the repository transaction model, or the SQL schema.

`DevelopmentIdentityProvider` survives only as an explicitly enabled local-development option and requires both `MERGEN_ROTA_AUTH_MODE=development` and `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true`. It is disabled by default.

Request bodies, query parameters, browser headers, and local storage are never trusted as current identity. There is no automatic SYSTEM_ADMIN fallback and no silent fallback to development identity or Demo mode.

## Errors

Repository errors remain compact:

- `LOAD_FAILED`
- `MUTATION_FAILED`
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `CONFLICT` (409)
- `DATABASE_UNAVAILABLE` (503)

Domain validation errors remain separate from persistence and authorization failures.

Persistence errors are surfaced to the user verbatim. `PersistenceStatus` renders the server message, the error/detail code and, where present, the offending field or change-set path. `CONFLICT`, `UPSERT_CREATE_COLLISION` and `UPSERT_TARGET_MISSING` additionally offer a **Verileri yeniden yükle** action, because those are stale-state failures the user can resolve. A generic "Kaydetme hatası" label without the underlying reason is not acceptable: it leaves the user with no path to recovery.

## Deployment

1. Back up the target database.
2. Run `database/MR_Create_Durable_Persistence.sql`.
3. Install Microsoft ODBC Driver 18 for SQL Server on the MERGEN Rota host.
4. Make sure the Windows account that will run Node.js has the required SQL Server permissions.
5. Create `.env.local` from `.env.example` and configure the server-only database variables.
6. Configure the Keycloak variables in `.env.local` and register the redirect URIs listed in `docs/KEYCLOAK-SSO.md`. Enable the development identity only in a local development environment.
7. Run `npm ci`.
8. Run `npm run build`.
9. Start with `npm run start -- -H 0.0.0.0 -p 8008` (or `npm run start:prod`) under the approved Windows/domain account. MERGEN Rota uses port 8008; 8009 belongs to MERGEN Bilge.
10. Select **Gerçek Sistem** and verify authorization and persistence.

To remove the build-phase schema, run `database/MR_Rollback_Durable_Persistence.sql`. **Rollback permanently deletes all MR_* application data.** It never modifies the three corporate source tables.

## Native-driver loading

`src/server/db/driver.js` imports the pure-JavaScript `mssql` core statically (type constants, `ISOLATION_LEVEL`) and loads the native `mssql/msnodesqlv8.js` driver **lazily**, on first connection. Both pools (`pool.js` and `corporateWbsPool.js`) share that single driver resolution. Both packages re-export the same `lib/base` definitions, so the type constants are identical.

The lazy load is required, not cosmetic. A module-level `import` of `mssql/msnodesqlv8.js` makes `next build` fail while collecting API-route page data on any host where the native binding has not been compiled (Linux CI, a workstation installing with `--ignore-scripts`). With the lazy load, the build succeeds everywhere and a missing driver degrades to a runtime `DATABASE_UNAVAILABLE` (503) with an explicit Turkish message instead of a build crash.

`package-lock.json` must resolve `msnodesqlv8`. When it is absent from the lock file, `npm ci` fails outright and the host has no SQL driver at all. `test/mergen-rota-critical-fixes.test.mjs` guards both invariants.

## Native-driver installation troubleshooting

If `npm install` or `npm ci` reports `Could not find any Visual Studio installation to use`, the prebuilt `msnodesqlv8` binary was not available through the configured npm registry or proxy and npm attempted a local native build. Use one of these approved remedies:

1. Ask IT to mirror/provide the matching prebuilt `msnodesqlv8` binary for the approved Node.js x64 version; or
2. Ask IT to install Visual Studio 2022 Build Tools with **Desktop development with C++**, the MSVC toolset and a Windows SDK on the build host.

Installing the full Visual Studio IDE is not necessary. Do not work around the error by adding a Windows password or SQL login to `.env.local`.

## Offline/on-premise operation

Runtime remains fully on-premise. No CDN, remote font, public API, remote JavaScript, or remote CSS dependency is introduced. `mssql` and `msnodesqlv8` are local npm dependencies installed through the approved registry or internal proxy. Native binaries and the Microsoft ODBC driver must be available inside the on-premise software-distribution boundary.

## Validation boundary

The normal test suite uses pure/static and injected boundaries and does not require the private corporate SQL Server. Optional live validation may be enabled separately with `MERGEN_ROTA_DB_INTEGRATION=1` and valid server configuration. A successful build or simulated transaction test must not be represented as live database validation.

### End-to-end persistence tests

`test/wbs-and-task-creation-e2e.test.mjs` drives the complete Actual-mode chain — application state → mutation orchestrator → client API repository → the real route handlers → ordered/hardened/base SQL repositories — against an in-memory SQL Server double (`test/helpers/fakeSqlServer.mjs`). Only the driver is substituted, through the `setSqlDriverForTests` seam in `src/server/db/driver.js`; every validation, authorization and SQL-building module under test is the real one.

The double behaves like SQL Server where it matters for correctness: `uniqueidentifier` values come back as upper-case text, comparisons are case-insensitive, corporate GUIDs without RFC 4122 version bits are stored verbatim, and `rowversion` tokens must match for an update or delete to affect a row. `test/helpers/actualStack.mjs` wires the stack and routes `fetch` to the route handlers; `server-only` is redirected to an empty module through a resolve hook, since that package throws in plain Node.

This is still not a substitute for live database validation: T-SQL text itself (merge statements, snapshot query) is exercised only by its contract, not by SQL Server's parser.
