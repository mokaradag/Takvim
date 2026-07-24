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

All routes force the Next.js Node.js runtime, disable caching, derive identity on the server, and return normalized safe errors. SQL stacks, connection strings, credentials, and raw query text are not returned to the browser.

## SQL Server connection

The `mssql` driver is used only under `src/server`. One reusable connection pool is initialized lazily. Queries use typed parameters. Connection and request timeouts are configurable. Credentials must be supplied through server-only environment variables and must never use the `NEXT_PUBLIC_` prefix.

Required deployment variables are listed in `.env.example`:

- `MERGEN_ROTA_DB_SERVER`
- `MERGEN_ROTA_DB_PORT`
- `MERGEN_ROTA_DB_DATABASE`
- `MERGEN_ROTA_DB_USER`
- `MERGEN_ROTA_DB_PASSWORD`
- `MERGEN_ROTA_DB_ENCRYPT`
- `MERGEN_ROTA_DB_TRUST_SERVER_CERTIFICATE`
- `MERGEN_ROTA_DB_CONNECTION_TIMEOUT_MS`
- `MERGEN_ROTA_DB_REQUEST_TIMEOUT_MS`

## Transaction semantics

One `commitChanges()` call maps to one SQL transaction. The server performs trusted identity resolution, authorization, relationship validation, optimistic-concurrency checks, normalized child reconciliation, audit insertion, and the final commit in the same transaction. Any failure rolls back the complete change set.

Atomic operations include Project creation with root WBS and owner access, Task updates with assignees and dependencies, WBS movement/reparenting, bulk Task movement, Project metadata with tags, and audit records.

## Optimistic concurrency

Mutable SQL entities use SQL Server `rowversion`. The API exposes rowversion as an opaque Base64 `version` token. Update and delete commands must provide the expected token. A zero-row update/delete is returned as `CONFLICT` / HTTP 409 rather than silently applying last-write-wins behavior.

## Corporate sources

The three corporate sources remain read-only:

- `HR02_rehisRehberwithMasrafYeri`: live employee and organization directory, normalized by Sicil.
- `A01_ProjeUrunFaaliyetRaporu`: corporate Project catalog. Only `Tur`, `Tur_Aciklama`, `ProjeKodu`, and `ProjeAdi` are selected and the source view uses `GROUP BY` across those four fields.
- `HR09_projeSorumlu`: corporate full-Project responsibility. `pptcSicil` uses `STRING_SPLIT`, trimming, and `TRY_CONVERT(int, value)` for exact token matching; no `LIKE '%sicil%'` authorization is permitted.

Corporate synchronization updates only source-owned Project identity fields, preserves application metadata, inserts missing registry rows and root WBS records, marks disappeared source records inactive, never converts manual Projects, and never writes to A01.

## Demo versus Actual mode

Demo mode remains non-durable and uses the existing rich sample dataset. It never calls SQL Server or the Actual API. Actual mode never imports or merges Demo seed records. Repository switching remounts the application state boundary; a persistent `DEMO` indicator prevents sample data from being mistaken for live data. Basit/Gelişmiş is a separate usage-mode choice.

Actual-mode failures do not silently fall back to Demo. The user sees the Actual-system error and may deliberately switch back to Demo.

## Identity before Keycloak

`CurrentUserProvider` is the replaceable server identity boundary. This phase supplies only `DevelopmentIdentityProvider`, controlled by:

- `MERGEN_ROTA_DEV_IDENTITY_ENABLED`
- `MERGEN_ROTA_DEV_SICIL`

It is disabled by default. Sicil is read only from server environment configuration; request bodies, query parameters, browser headers, and local storage are never trusted as current identity. There is no automatic SYSTEM_ADMIN fallback.

The next phase can replace this provider with Keycloak identity resolution using a Sicil claim or username-to-HR02 lookup without redesigning authorization, repository, or SQL schema.

## Errors

Repository errors remain compact:

- `LOAD_FAILED`
- `MUTATION_FAILED`
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `CONFLICT` (409)
- `DATABASE_UNAVAILABLE` (503)

Domain validation errors remain separate from persistence and authorization failures.

## Deployment

1. Back up the target database.
2. Run `database/MR_Create_Durable_Persistence.sql`.
3. Configure the server-only database variables.
4. Enable and configure the temporary development identity only in the pre-Keycloak integration environment.
5. Run `npm ci`.
6. Run `npm run build`.
7. Start with `npm run start -- -H 0.0.0.0 -p 3000`.
8. Select **Gerçek Sistem** and verify authorization and persistence.

To remove the build-phase schema, run `database/MR_Rollback_Durable_Persistence.sql`. **Rollback permanently deletes all MR_* application data.** It never modifies the three corporate source tables.

## Offline/on-premise operation

Runtime remains fully on-premise. No CDN, remote font, public API, remote JavaScript, or remote CSS dependency is introduced. The SQL driver is a local npm dependency installed through the approved registry or internal proxy.

## Validation boundary

The normal test suite uses pure/static and injected boundaries and does not require the private corporate SQL Server. Optional live validation may be enabled separately with `MERGEN_ROTA_DB_INTEGRATION=1` and valid server configuration. A successful build or simulated transaction test must not be represented as live database validation.
