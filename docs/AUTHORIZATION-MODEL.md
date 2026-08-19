# MERGEN Rota Authorization Model

Authorization is evaluated on the Next.js server using trusted Sicil identity. Client capability flags improve usability but are never the security boundary. Every mutation is authorized again inside the SQL transaction.

## Precedence

1. **SYSTEM_ADMIN** — full access to every Project and operation.
2. **FULL_PROJECT_ACCESS** — full access to one Project from HR09 responsibility or active `MR_ProjectAccess` FULL grant.
3. **EXECUTIVE_SCOPE** — read-only visibility of Tasks assigned to subordinate employees.
4. **ASSIGNEE_SCOPE** — read-only visibility of the current user's assigned Tasks.
5. **DENY BY DEFAULT**.

FULL always wins when the same Project is also visible through a partial source.

## SYSTEM_ADMIN

System administrators are stored in `MR_UserRoles`, not frontend code. The creation script seeds them from the `@SystemAdminSicils` parameter, which the installing administrator fills in before running it; real Sicil values are personal data and are never committed. An empty list seeds no administrator. Inactive role rows grant nothing.

SYSTEM_ADMIN is never derived from Keycloak `resource_access` roles. A token may carry any realm or client role; MERGEN Rota still reads administration rights only from `MR_UserRoles`.

SYSTEM_ADMIN may view and mutate all Projects and may create manual Projects.

## Corporate full access

`MR_V_CorporateProjectAccess` normalizes HR09 roles:

- PROJECT_MANAGER
- TECHNICAL_MANAGER
- QUALITY_MANAGER
- PROCUREMENT_RESPONSIBLE
- PPTS
- PRODUCTION_PLANNING_RESPONSIBLE
- DELIVERY_MANAGER
- RISK_MANAGER
- CONFIGURATION_MANAGER
- LOGISTICS_MANAGER

Every valid Sicil in these role columns receives FULL access to the matching corporate Project. `programMd` is descriptive and never treated as employee identity.

PPTS authorization uses exact comma tokenization of `pptsSicil` with `STRING_SPLIT`, whitespace trimming, and `TRY_CONVERT(int, value)`. Malformed tokens grant nothing. Substring or `LIKE '%10000%'` matching is prohibited.

The corporate Project owner is authoritative: `MR_Projects.LeadSicil` is synchronized from the `PROJECT_MANAGER` role. It is displayed read-only for corporate Projects and remains selectable only for manual Projects.

## Manual access

`MR_ProjectAccess` stores only MERGEN-owned grants. It does not duplicate HR09-derived access.

When an eligible user creates a manual Project, one transaction creates:

- the Project;
- its root WBS;
- creator FULL access with `GrantSource = OWNER`;
- audit rows.

Manual Project creation is allowed only for SYSTEM_ADMIN or users dynamically identified as directors, managers, or team leaders through HR02.

## Executive visibility

Executive scope is the union of:

- Directorate employees where `direktorluk_yonetici_sicil` equals current Sicil;
- Department employees where `mudurluk_yonetici_sicil` equals current Sicil;
- Unit employees where `birim_yonetici_sicil` equals current Sicil.

This scope is dynamic and read-only. Executives may see subordinate-assigned Tasks and necessary Project/WBS context. They do **not** automatically gain full administration of every Project containing subordinate work.

## Task assignment scope

Selecting a Project **for a new or reassigned Task** is a different question from seeing a Project or its Tasks. The two are answered by two different lists:

- `projects` — what the user may *see*: workspace switcher, filters, reports, Gantt, portfolio statistics. Unchanged by this rule.
- `assignableProjects` — what the user may *choose from* when defining or assigning a Task. Additive, selection-only, and never merged into `projects`.

For an ordinary employee `assignableProjects` is empty: the selector offers exactly their `corporateprojectaccess` Projects, as before. Directors, managers, and team leaders (`isExecutive`, derived from HR02 exactly as executive visibility is — there is no hard-coded user list) receive the **entire active CN43N corporate Project catalog** in `assignableProjects`, so they can assign work to their own personnel under any corporate Project even where they hold no `corporateprojectaccess` of their own. SYSTEM_ADMIN already reaches every Project through precedence.

The widening is deliberately narrow. `assertTaskProjectAccess` (server-side, `sqlAppRepository.js`) permits an assignment-scope write only when *all* of the following hold:

- the actor has task-assignment scope (`hasTaskAssignmentScope`: SYSTEM_ADMIN or executive);
- the target Project is an **active corporate** Project;
- the Task ends up with at least one assignee;
- **every** assignee — before and after the change — is inside the actor's `MR_V_ExecutiveScope`.

Both the source and the destination of a move are checked, so a Task cannot be dragged out of an executive's scope or into it past someone else's personnel. Assignment scope grants nothing else: no Project metadata writes, no WBS create/rename/move/delete, no access-record changes, no visibility of Tasks belonging to people outside the executive's scope. A manager who assigns a corporate Task still sees only that Task afterwards, through ordinary executive visibility.

The client mirrors the same rule (`src/state/projectWritePolicy.js`) purely for usability. A request that skips the UI is judged only by `assertTaskProjectAccess`; `test/task-assignment-scope-e2e.test.mjs` drives the real route bodies to prove it.

## Assignee visibility

An ordinary employee sees Tasks assigned to their Sicil plus the Project and WBS context needed to understand those Tasks. Unrelated Projects and Tasks are not returned.

Assignee visibility is read-only in this phase. Self-service progress editing is a possible future policy and is not implied by assignment.

## Write permissions

FULL Project users may create/edit/delete Tasks, assign employees, manage dependencies, manage WBS, move Tasks, reparent WBS, edit permitted Project metadata, and use complete Project scheduling/reporting.

PARTIAL users cannot mutate Project, WBS, Task, assignment, dependency, baseline, tag, or access records. The single exception is the Task assignment scope described above, which lets an executive write a Task — and only a Task — in a corporate Project for their own personnel. The client may disable controls, but the server independently returns FORBIDDEN for unauthorized writes.

Corporate identity fields are source-controlled. Even FULL users cannot change corporate SourceType, ProjectCode, ProjectName, ProjectTypeCode, ProjectTypeName, or LeadSicil; the update statement preserves the corporate lead explicitly, so editing MERGEN-owned fields can never clear it. They may change supported application metadata such as Data Date, color, calendar, and tags. Manual Project owners may change the manual Project lead.

The corporate WBS structure is source-controlled in the same sense: FULL access on a corporate Project permits Task work and Task-to-WBS assignment, but never WBS create/rename/move/delete. That structure comes from the CN43N synchronization only, and the server rejects client attempts with FORBIDDEN.

Access maps are keyed by canonical Actual System identities (lower-case GUIDs). SQL Server returns `uniqueidentifier` values as upper-case text, so an un-canonicalized key made the effective-access lookup miss and denied writes to users who were in fact FULL on the project.

## Authorization-filtered snapshots

Visible Projects are the union of:

- every active Project for SYSTEM_ADMIN;
- HR09-authorized corporate Projects, including Projects with zero Tasks;
- active MR_ProjectAccess grants;
- Projects containing own or subordinate-assigned visible Tasks.

`assignableProjects` is returned beside — never inside — this union, so widening Task selection for executives cannot widen what anyone sees.

FULL Project snapshots include the complete Task network, WBS, dependencies, baselines, and scheduling context. PARTIAL snapshots include only authorized Tasks and necessary Project/WBS context. Deny-by-default prevents unrelated A01 catalog Projects from appearing for ordinary employees.

## Partial visibility and CPM

A filtered Task subset is not a complete network. The scheduling selector therefore marks partial Projects `suppressed-partial`, returns no complete Project CPM, and makes no critical-path claim. Portfolio statistics for partial users describe visible scope only.

## Session model

Session/capability data is separate from canonical business data. The repository session contains:

- data mode;
- normalized current user;
- isSystemAdmin;
- isExecutive;
- canCreateProjects;
- canAssignAllCorporateProjects;
- Project access entries with FULL/PARTIAL and server-derived reasons.

The browser cannot invent these values.

## Current identity provider

Authentication is provided by **Keycloak** (`MERGEN_ROTA_AUTH_MODE=keycloak`, the default). `KeycloakIdentityProvider` reads the trusted Sicil only from the server-signed, HttpOnly application session cookie that the server writes after verifying a Keycloak token. Full flow, environment variables, and operational steps: `docs/KEYCLOAK-SSO.md`.

`DevelopmentIdentityProvider` remains only as an explicitly enabled local-development option. It requires **both** `MERGEN_ROTA_AUTH_MODE=development` and `MERGEN_ROTA_DEV_IDENTITY_ENABLED=true`, and is disabled by default.

No request body, query parameter, browser-controlled header, local storage value, display name, or client capability is trusted as current identity. Missing or unresolved identity returns UNAUTHORIZED and never falls back to admin, development identity, or Demo data.

## Identity mapping

`CurrentUserProvider` is the only layer authentication replaced:

```text
Keycloak authenticated user
→ verified `sicil` claim
```

or, when the claim is absent and the fallback is enabled:

```text
Keycloak `preferred_username`
→ HR02.kullanici_adi   (parameterized server-side query, must match exactly one row)
→ HR02.sicil
```

Ambiguous or unresolved lookups return UNAUTHORIZED. All business authorization continues to operate on Sicil. Authorization precedence, SQL schema, repository transactions, and corporate read models are unchanged.

## Session display fields

The session response carries safe display fields alongside the authorization data: `sicil`, `employeeNo`, `name`, `username`, `givenName`, `familyName`, `email`, `department` (Keycloak claim), `sector`, `managementUnit`, `subject`, plus the corporate directory `role`, `team`, and `organization`. Raw access tokens are never exposed.

`currentUser.department` is the Keycloak `department` claim and is what the sidebar displays. `currentUser.organization.department` is the corporate directory value derived from HR02 `mudurluk`. These are different sources and must not be conflated. None of these fields participates in an authorization decision.
