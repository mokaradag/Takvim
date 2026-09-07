# MERGEN Rota Authorization Model

Authorization is evaluated on the Next.js server using trusted Sicil identity. Client capability flags improve usability but are never the security boundary. Every mutation is authorized again inside the SQL transaction.

## Precedence

1. **SYSTEM_ADMIN** — full access to every Project and operation.
2. **FULL_PROJECT_ACCESS** — full access to one Project from HR09 responsibility, active `MR_ProjectAccess` FULL grant, or being the selected lead of an active manual Project.
3. **TASK_CREATOR_SCOPE** — limited ownership of one Task identified by authoritative `MR_Tasks.CreatedBySicil`; it never becomes Project access.
4. **EXECUTIVE_SCOPE** — read-only visibility of Tasks assigned to subordinate employees.
5. **ASSIGNEE_SCOPE** — task-level work editing for the current user's assigned Tasks and narrow self-assigned Task creation in Projects where such an authoritative assignment exists.
6. **DENY BY DEFAULT**.

FULL always wins when the same Project is also visible through a partial source.

## SYSTEM_ADMIN

System administrators are stored in `MR_UserRoles`, not frontend code. The creation script seeds them from the `@SystemAdminSicils` parameter, which the installing administrator fills in before running it; real Sicil values are personal data and are never committed. An empty list seeds no administrator. Inactive role rows grant nothing.

SYSTEM_ADMIN is never derived from Keycloak `resource_access` roles. A token may carry any realm or client role; MERGEN Rota still reads administration rights only from `MR_UserRoles`.

SYSTEM_ADMIN may view and mutate all Projects and may create manual Projects. It may also deactivate an empty manual Project. A Project is empty when no `MR_Tasks` row references it; root WBS, access, tags and audit rows do not make it non-empty. Corporate Projects and manual Projects containing even one Task cannot be deleted through this operation.

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

The selected manual `LeadSicil` is an explicit, derived FULL access source. If the creator and lead differ, the creator keeps the OWNER grant and the lead can see and administer the manual Project, including its WBS and Tasks. When `LeadSicil` changes, derived FULL access follows the new lead without deleting or rewriting any independent `MR_ProjectAccess` row held by the former lead. This rule is restricted to active `SourceType = 'MANUAL'` Projects; corporate lead fields remain source-controlled and do not produce this grant.

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

For an ordinary employee the server-side `assignableProjects` catalog remains empty. The client adds only visible Projects in which the snapshot contains at least one Task marked `isCurrentUserAssignee`; the server never trusts that derived list. Directors, managers, and team leaders (`isExecutive`, derived from HR02 exactly as executive visibility is — there is no hard-coded user list) receive the **entire active CN43N corporate Project catalog** in `assignableProjects`, so they can assign work to their own personnel under any corporate Project even where they hold no `corporateprojectaccess` of their own. SYSTEM_ADMIN already reaches every Project through precedence.

## Assignee Task creation scope

An ordinary employee who is the authoritative assignee of at least one Task in Project P may create a new Task in Project P. This is `ASSIGNEE_CREATE`, not FULL Project access and not executive assignment scope.

The server decides this inside the Task-create SQL transaction by reading `MR_TaskAssignees` joined to the active Project. The membership lookup uses update/serializable key-range locks, so an assignment removed before the create transaction runs cannot be replaced by stale browser state. A forged direct request receives `FORBIDDEN` when that authoritative row is absent.

`ASSIGNEE_CREATE` is deliberately constrained:

- the new Task remains in the same active Project;
- the actor is the Task's only initial assignee;
- the actor may choose an existing WBS node in the same Project, but cannot create, rename, move, or delete WBS nodes;
- planned start, planned finish, and target finish may be supplied; Simple Mode maps its required Termin date to all three fields for a new Task;
- actual dates, dependencies, recurrence, milestone, ordering, Task-specific calendar, hour and financial fields cannot be introduced through this scope;
- Project metadata, Project access, WBS, baseline, dependency and Project-delete permissions are unchanged;
- unrelated Projects and Tasks remain absent from the authorization-filtered snapshot.

The same `taskCreationScopeInProject` policy feeds Advanced Mode, Simple Mode and the quick-entry assignee picker. In Simple Mode an `ASSIGNEE_CREATE` Project offers only the current user as the initial assignee. These client rules are usability constraints; the transactional server check is the security boundary.

The widening is deliberately narrow. The server splits the decision into a Project-level check (`assertTaskProjectScope`) and an assignee-level check (`assertAssigneeScope`), and permits an assignment-scope write only when *all* of the following hold:

- the actor has task-assignment scope (`hasTaskAssignmentScope`: SYSTEM_ADMIN or executive);
- the target Project is an **active corporate** Project;
- the Task ends up with at least one assignee;
- **every** assignee — before and after the change — is inside the actor's `MR_V_ExecutiveScope`.

The Project-level check runs **before** assignee Sicils are validated against `MR_V_PeopleDirectory`. Validating people first let an unauthorized caller distinguish a real employee (`FORBIDDEN`) from an unknown one (`invalid employee`) and probe the corporate directory that way.

Both the source and the destination of a move are checked, so a Task cannot be dragged out of an executive's scope or into it past someone else's personnel. Assignment scope grants nothing else, and three limits are enforced explicitly because the Task write itself can otherwise reach beyond it:

- **WBS placement.** Executive assignment scope cannot choose a WBS node: a new Task is attached to the Project root and an existing Task keeps its current node. `ASSIGNEE_CREATE` and a limited Task creator are separate narrow scopes: they may select an existing same-Project node from a read-only catalog, but cannot administer the WBS structure.
- **Dependencies.** PARTIAL snapshots do not load `MR_TaskDependencies`, so the client holds `deps: []`. A non-FULL write therefore leaves existing dependency rows untouched instead of replacing them, and an explicit dependency edit from such a caller is rejected — otherwise editing a title would silently erase predecessors the manager was never allowed to see.
- **Cascading deletes.** Executive assignment scope alone and ordinary assignee scope cannot delete Tasks. A creator with executive assignment scope may delete their own corporate Task when all current assignees are in that scope. An ordinary creator may delete only a Task with no other assignee. The related-Task safety check still prevents either delete from mutating out-of-scope recurrence/dependency records.

Creating a recurrence occurrence under a template is checked the same way: for a non-FULL write the **template's authoritative assignees** must also be in scope, so series generation cannot silently drop a co-assignee the PARTIAL snapshot hid.

SYSTEM_ADMIN skips the per-user grant checks but still cannot write a Task into an **inactive** Project: effective FULL grants are themselves built only from active Projects, and a Task moved into an inactive Project would disappear from every snapshot.

A manager who assigns a corporate Task still sees only that Task afterwards, through ordinary executive visibility.

The client mirrors the same rule (`src/state/projectWritePolicy.js`) purely for usability. To mirror it faithfully the snapshot also returns `assignmentScopeSicils` — the employees the executive may assign — so the assignee pickers in both modes offer only people the server will accept. When a visible Task has assignees the snapshot hid, an executive assignment-scope editor remains read-only because the incomplete list cannot safely authorize reassignment. A current assignee gets the narrower work-only editor described below. A request that skips the UI is judged only by the server checks; `test/task-assignment-scope-e2e.test.mjs`, `test/assignment-scope-write-boundary.test.mjs`, and `test/task-assignee-editing-boundary.test.mjs` drive the real route bodies to prove it.

## Assignee visibility

An ordinary employee sees Tasks assigned to their Sicil plus the Project and WBS context needed to understand those Tasks. Unrelated Projects and Tasks are not returned. The server authorizes an update only after reading the authoritative `MR_TaskAssignees` rows inside the transaction and confirming that the current Sicil is still assigned.

The authorized Task projection also exposes that Task's creator Sicil and display name to a direct assignee. This is intentionally narrower than widening the people directory: the identity is attached only to the visible Task and feeds the **Görevi tanımlayan** byline and avatar key. It also makes the same authoritative creator visible that the schedule-change service selects as decision owner; a PARTIAL directory cannot turn the byline into `—` or make the request appear ownerless.

An assignee may edit the assigned Task's work fields such as title, description/tag, status, priority, progress and the permitted actual/work fields. They also own the dates that describe their own execution: **planned start, planned finish, actual start and actual finish are directly writable** by the authoritative assignee. Only **target finish** is withheld — it is a commitment rather than a personal plan, so the assignee submits a persistent schedule-change request for it (`ASSIGNEE_BLOCKED_SCHEDULE_FIELDS`). The client mirrors exactly this split: the drawer keeps the planned/actual date fields editable, disables target finish, and the *Yeni tarih öner* dialog asks only for the target finish row. The same actor may create a self-assigned Task under the narrow rules above. Neither operation grants Project metadata, WBS administration, access, dependency, recurrence, milestone, ordering, deletion or assignment-list mutation rights.

Partial snapshots may intentionally omit co-assignees. An assignee work update therefore never treats the client assignee list as authoritative: it neither deletes nor reinserts `MR_TaskAssignees`, so hidden co-assignees are preserved. To mutate the assignment list, the client must send an explicit `assigneeIds` patch and the server requires FULL or valid executive assignment scope.

## Limited Task creator scope

`MR_Tasks.CreatedBySicil` is the authoritative source of limited ownership. A normal creator can directly edit the three controlled plan dates and select an existing same-Project WBS node for that one Task. They do not receive FULL Project access, Project metadata rights, assignee management, dependency management, or WBS administration.

An ordinary creator may delete the Task only when the authoritative `MR_TaskAssignees` set contains no Sicil other than the creator. An empty set and a creator-only set are eligible; any other assignee blocks deletion. List and drawer controls reuse the shared client policy for a precise explanation, while the SQL transaction reloads creator and assignee rows and is the final boundary.

Creator status does not suppress a director's, manager's or team leader's existing assignment rights. On their own active corporate Task, an executive may add/remove in-scope assignees and delete the Task even when other team members are assigned. An explicit assignee mutation validates both the current and proposed lists against `MR_V_ExecutiveScope`; the resulting list must remain nonempty. Hidden/out-of-scope assignees cannot be removed to bypass this check. Content, tag and date edits retain creator permissions and preserve the authoritative assignee list unless reassignment is explicitly requested. Project metadata, dependencies, recurrence structure and WBS administration remain protected.

Task updates and deletes still require the current `RowVersion`. `CONFLICT` (HTTP 409) means the submitted version is stale; it is distinct from `FORBIDDEN`. Consecutive successful UI saves apply the returned version before the next save. A stale request never silently overwrites the latest row; reload the data before retrying, using the existing explicit discard/reload flow when unsaved changes remain.

## Schedule-change requests

An assignee of somebody else's Task submits a row in `MR_TaskScheduleChangeRequests` for the date they cannot write themselves — in practice the target finish; the Task itself is unchanged. **A request carries only the dates it actually proposes.** Omitted fields are filled from the Task row read under lock, never from the client's copy: the requester's window may have been open while somebody else moved the plan, and echoing the stale values back would let an accepted target-only request silently roll the current plan back (the STALE guard compares originals captured at submit time, so it would not catch it). The server prefers `MR_Tasks.CreatedBySicil` as the deterministic decision owner; this is the same identity projected to the direct assignee's Task byline. When creator provenance is absent on a legacy Task, it falls back in order to the manual Project lead, an active FULL Project-access user, or an authorized corporate FULL user. Only the requester and decision owner can read the request, and only that exact owner can accept or reject it. One PENDING row per `(TaskId, RequesterSicil)` is active; submitting a replacement cancels the earlier row.

Accept runs under SERIALIZABLE isolation, compares the three captured original dates with the current Task, recalculates planned working-day duration with the effective calendar, updates the Task and request atomically, and writes correlated audit rows. A date mismatch marks the request STALE and never overwrites the newer plan. Reject stores the decision without changing Task dates. The projected snapshot is the persistent notification source for both parties, so status survives refresh, logout, and offline periods; the UI uses a non-blocking request center rather than a mandatory real-time modal.

## Write permissions

FULL Project users may create/edit/delete Tasks, assign employees, manage dependencies, manage WBS, move Tasks, reparent WBS, edit permitted Project metadata, and use complete Project scheduling/reporting.

PARTIAL users cannot mutate Project, WBS structure, assignment, dependency, baseline, tag, or access records. Narrow Task exceptions are the executive Task assignment scope, authoritative current assignees editing work fields, `ASSIGNEE_CREATE` creating a self-assigned Task with Termin and an existing WBS selection, and the limited creator scope described above. The client may disable controls, but the server independently returns FORBIDDEN for unauthorized writes.

Corporate identity fields are source-controlled. Even FULL users cannot change corporate SourceType, ProjectCode, ProjectName, ProjectTypeCode, ProjectTypeName, or LeadSicil; the update statement preserves the corporate lead explicitly, so editing MERGEN-owned fields can never clear it. They may change supported application metadata such as Data Date, color, calendar, and tags. Manual Project owners may change the manual Project lead.

The corporate WBS structure is source-controlled in the same sense: FULL access on a corporate Project permits Task work and Task-to-WBS assignment, but never WBS create/rename/move/delete. That structure comes from the CN43N synchronization only, and the server rejects client attempts with FORBIDDEN.

Access maps are keyed by canonical Actual System identities (lower-case GUIDs). SQL Server returns `uniqueidentifier` values as upper-case text, so an un-canonicalized key made the effective-access lookup miss and denied writes to users who were in fact FULL on the project.

## Authorization-filtered snapshots

Visible Projects are the union of:

- every active Project for SYSTEM_ADMIN;
- HR09-authorized corporate Projects, including Projects with zero Tasks;
- active MR_ProjectAccess grants;
- active manual Projects whose `LeadSicil` is the current Sicil;
- Projects containing own-created, own-assigned, or subordinate-assigned visible Tasks.

`assignableProjects` is returned beside — never inside — this union, so widening Task selection for executives cannot widen what anyone sees. The people directory is widened by exactly one rule: when task-assignment scope is on, the executive's own `MR_V_ExecutiveScope` employees are included. Without it an executive holding no visible FULL Project could not find the very subordinate the rule exists to let them assign. Task, WBS, and Project visibility remain untouched by that flag.

Co-assignee avatars do not widen the people directory. The projected snapshot carries a Task-scoped `(DisplayName, AvatarEmployeeNo)` identity only for already-authorized visible Task IDs. Task surfaces and Dashboard workload aggregation retain that Sicil through grouping and derive the photograph from it; display name alone is never used to choose a photograph, so same-name employees cannot receive each other's image.

Task creator bylines do not create a second directory bypass. The creator's name and Sicil/photo key are projected only when that person is already in the caller's authorization-filtered people scope. A Task that is visible solely because the caller is its assignee can therefore show a generic creator label without exposing an unrelated employee identity; the server-derived `isCurrentUserCreator` boolean continues to support write policy without revealing the hidden Sicil.

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

### Görev görünümlerindeki kurumsal süzgeç yetki değildir

Her iki kipte Görevler ve Takvim, ayrıca Kapsamlı Kipte Kanban araç çubuğundaki **Direktörlük → Müdürlük → Birim** seçimi yalnızca istemci tarafı kullanım kolaylığıdır. Sunucu önce mevcut oturum, proje erişimi ve görev görünürlüğü kurallarıyla yetkili snapshot'ı üretir; istemci çalışma alanı/proje seçimini uygular; kurumsal süzgeç ancak bundan sonra bu kümeyi daraltır. Seçili bir kurumsal yol yeni görev, proje veya kişi kaydı görünür kılamaz ve yazma/silme/atama kararlarına katılmaz. Takvimde gün kutuları, ek görev sayıları ve genişletilmiş gün penceresi aynı süzülmüş kümeyi kullanır.

Eşleşme görev oluşturucusu, proje sorumlusu veya oturum kullanıcısı üzerinden değil görevin mevcut projeksiyondaki sorumluları üzerinden yapılır. Kararlı `assigneeIds` varsa ad eşlemesi kullanılmaz. Eski bir kayıtta kimlik hiç yoksa yalnızca mevcut kişi projeksiyonundaki tekil ad güvenli yedektir; aynı adlı iki kişi varsa tahmin yapılmaz. Çok sorumlulu görevde en az bir görünür sorumlunun seçili kurumsal yolda bulunması yeterlidir. Projeksiyon dışındaki veya gizli sorumlular için kurumsal bilgi türetilmez; kişi dizini genişletilmez.

### Atama kimliği ve manuel projelerde personel kapsamı

Sorumlu yazmalarında `assigneeIds` (Sicil/SicilNo) kesin kaynaktır. Aynı istekteki `sorumlu` adları kimlikleri yeniden türetmez. Eski, yalnızca ad taşıyan girdilerde tekil eşleşme bulunmazsa işlem reddedilir; iki aynı adlı çalışan birleştirilmez. Görev kapsamlı fotoğraf kimlikleri mutasyon yanıtında da güncel Sicil ile verilir; eski bir fotoğraf aynı ad üzerinden başka çalışana taşınmaz. Proje sorumlusu için eski ad yedeği ve Özet plan bütünlüğü denetimleri de yalnızca tekil adları kabul eder; geçersiz Sicil eş adlı bir kişiyle tamamlanmaz. Genel kişi rehberi ve görev görünürlüğü genişlemez.

Sistem yöneticisi olmayan direktör, müdür veya birim yöneticisinin yeni/değiştirilen atama listesi `MR_V_ExecutiveScope` ile doğrulanır. Manuel projenin sahibi/sorumlusu olmak veya kurumsal projede FULL erişim taşımak bu personel sınırını kaldırmaz. İstemcide üç görev giriş/düzenleme seçicisi aynı kümeyi kullanır; sunucu doğrudan API yazmalarında da denetler. FULL projede değişmeyen eski atamalar içerik düzenlemesini engellemez; sorumlu listesi veya proje değişirse sonuçtaki tüm çalışanlar kapsamda olmalıdır. Kısmi projede mevcut ve yeni atama listeleri ayrı ayrı doğrulanmaya devam eder.

Kaydet işleminde görev/ardıl yamaları tek transaction ile uygulanır. Yerel taslak başlamasından sonra bilinen sürüm değişmişse istemci kaydı reddeder; sunucu mevcut rowversion denetimini ayrıca uygular. SQL şema değişikliği gerekmez.
