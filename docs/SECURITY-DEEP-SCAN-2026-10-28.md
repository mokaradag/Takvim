# CodeRabbit security validation — 28 October 2026

## PR #107 surgical follow-up — current disposition

This follow-up supersedes the original pass's boundary behavior described below. It starts from PR HEAD `7daef0dfd514b30ca6745830e6dcda9a088d111e`, on `security/deep-scan-convergence-20261028`, with base `main` at `ed4a0aa1679ac336e7b58e8b5840f502c1ec1ab2`. Both refs were fetched and rechecked. The starting PR contains one commit and 30 changed files. All 22 unresolved threads, review submissions, discussion comments and checks were fetched. Twenty production findings appear in nineteen threads (one comment contains two findings); three threads concern tests only. No thread was resolved or dismissed.

Starting checks: test-and-build, native Windows planner, native macOS planner, Dependency Review, CodeQL (actions, Python, JavaScript/TypeScript and aggregate), and CodeRabbit succeeded. Cubic was neutral because its review allowance was exhausted. These are starting-HEAD results, not follow-up validation.

### Shared roots and preserved boundaries

| Root | Production correction | Preserved boundary |
|---|---|---|
| A — snapshot counting / malformed weekdays | Snapshot normalization opts into exact whole-week counting plus unique working-day holidays, bounded by seven weekday checks and the holiday input rather than the date span. It still validates dates, span and maximum duration; changed calendars/dates recalculate. The ordinary commit/CPM scanning algorithms and 5,000,000-day meters remain unchanged. The large-span guard uses the same array/default-weekday distinction as the existing day counter. | No larger limit, truncated duration, unbounded day scan, or blind trust in persisted duration. |
| B — historical display policy / pre-authorization cap | The report's name lookup preserves administrator access independently of project activity, uses the same latest authorized deletion snapshot for historical creator entitlement, and permits task-scoped direct-assignee names. Numeric employee fallback still requires the stricter identity policy. Missing names without stable-ID permission retain one count-free hidden marker. The evidence-person cap applies only to authorized, resolvable output identities. | The shared stable-ID/write predicate is unchanged; no personnel directory, task, project or PARTIAL scope is widened. |
| C — template versus rendered content / Unicode offsets | Sanitization returns a controlled null for oversized raw or sanitized templates. Save rejects either form above 65,536 characters; load safely uses the built-in template for an invalid legacy row; the editor keeps its last safe value and reports the error. Substitution has a separate 16-Mi-character subject/body rendering bound and controlled failure. Sanitization still runs after escaped substitution, including dynamic attributes. Script/style closing tags are searched case-insensitively in the original UTF-16 source. | No expanded stored-template contract, HTML allowlist change, unsafe dynamic attributes, uncaught size RangeError, or offset use from Unicode-transformed text. |
| D — SMTP reply grammar / aggregate time / uncertainty | Reply codes require a separator or end of line. Per-recipient messages remain serial and share one deadline derived from the existing configured SMTP timeout, using the existing abort support. Unattempted recipients produce an explicit identity-free warning; all-definite-failure logs count only attempted addresses. Any uncertain transport outcome remains terminal uncertainty even if another recipient succeeds: PENDING plus CompletedAt and MAIL_DELIVERY_UNCERTAIN. Stale claims only reclaim unfinished PENDING rows. | One mailbox per message, no fan-out, no timeout/configuration knob, unchanged TLS/certificates and network targets. Uncertain mail is neither SENT nor definite FAILED and is never automatically reclaimed. Explicit later manual sends retain the existing cooldown policy. |
| E — create intent before candidate-ID existence | Proposed no-version task/WBS IDs remain creates throughout planning and canonical persistence validation. Candidate-row reads are deferred until the complete create validation for that entry passes, immediately before INSERT, using the existing locked collision validator. Initial assignment checks reuse the exact persistence scope/field validators. All layers use the existing trimmed-version definition. | Corporate WBS restrictions, self-only creation, assignment-root rules, dependency filtering, recurrence checks and all other canonical create checks still apply. No overwrite, replacement ID, silent success, hidden-row projection or ID-semantics change. SERIALIZABLE, UPDLOCK/HOLDLOCK and deadlock retry remain. |
| F — recurrence transition | Parent visibility is required when establishing or changing the parent ID; an unchanged persisted ID does not trigger a new discovery requirement. All other parent integrity checks remain. | Invisible templates cannot be newly linked; child authorization and recurrence integrity remain enforced. |

### Every posted production-finding disposition

Comment numbers link to the original review data, independently verified against the starting HEAD. DUPLICATE denotes another manifestation of a repaired shared root, not an ignored finding.

| Review comment | Posted finding | Disposition / evidence |
|---|---|---|
| [4400490860](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400490860) | P1 aggregate snapshot scan exhaustion | FIXED BY A; fresh 40-task sparse maximum-duration snapshot loads and changed holidays recalculate. |
| [4400886582](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400886582) | P2 fresh persisted-duration snapshot exhaustion | DUPLICATE of 4400490860; same fresh-load regression includes persisted durations. |
| [4400490811](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400490811) | P3 non-array workingDays | FIXED BY A; malformed weekdays match existing default-week behavior over a large supported span. |
| [4400490822](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400490822) | P3 inactive-project administrator names | FIXED BY B; administrator history regression retains names. |
| [4400756113](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400756113) | P3 deleted-task creator names | FIXED BY B; creator history regression uses deletion evidence after the task disappears. |
| [4400893873](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400893873) | P3 direct-assignee co-assignee names | FIXED BY B; names remain, unresolved employee IDs do not, and the strict assignee-ID query remains self-only. |
| [4402682967](https://github.com/mokaradag/Takvim/pull/107#discussion_r4402682967) | P3 hidden people consume evidence cap | FIXED BY B; 2,001 hidden identities do not exhaust a one-authorized-person cap; authorized population still enforces it. |
| [4400490799](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400490799) | P2 sanitizer RangeError across callers | FIXED BY C; controlled raw/output/render overflow, load fallback and safe editor handling. |
| [4400676498](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400676498) | P2 expanded message hits template limit | DUPLICATE of C size-contract root; long escapable descriptions render and deliver. |
| [4401113686](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401113686) | P3 save creates unloadable expanded template | DUPLICATE of C size-contract root; under-raw-limit expanding output is rejected before persistence. |
| [4401113645](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401113645) | P3 Turkish İ shifts script/style offsets | FIXED BY C; mixed-case blocks preserve following text in sanitizer and rendering. |
| [4401113662](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401113662) | P3 malformed successful SMTP replies | FIXED BY D; 2501 foo and 250OK reject, multiline and bare final 250 remain valid. |
| [4401573275](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401573275) | P2 multiplicative SMTP timeout latency | FIXED BY D; real stalled loopback SMTP with 200 recipients opens one connection within one shared deadline and records one attempt. |
| [4402126800](https://github.com/mokaradag/Takvim/pull/107#discussion_r4402126800) | P3 uncertainty lost in mixed outcomes | FIXED BY D; mixed uncertain/success stays terminally uncertain and cannot be stale-reclaimed. |
| [4401113695](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401113695) | P2 corporate WBS collision oracle | FIXED BY E; hidden/unused candidate IDs produce identical FORBIDDEN results. |
| [4401244101](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401244101) | P2 ASSIGNEE_CREATE non-self assignment oracle | FIXED BY E; the same self-assignment validator runs before sensitive planning/collision. |
| [4401997616](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401997616) | P2 ASSIGNEE_CREATE forbidden-field oracle | FIXED BY E; isMilestone payloads reject identically for hidden/unused IDs. |
| [4401997616](https://github.com/mokaradag/Takvim/pull/107#discussion_r4401997616) | P2 assignment-scope non-root WBS oracle | FIXED BY E; canonical root-selection rejection precedes collision. |
| [4402723167](https://github.com/mokaradag/Takvim/pull/107#discussion_r4402723167) | P2 invalid dependency-target oracle | FIXED BY E; missing and hidden predecessors reject before candidate lookup. Blank versions also preserve create intent. An otherwise valid hidden-ID creation still collides while an unused ID succeeds (F-024). |
| [4400490847](https://github.com/mokaradag/Takvim/pull/107#discussion_r4400490847) | P2 ordinary recurrence-child update rejected | FIXED BY F; an authorized child edit succeeds with its unchanged hidden parent; new hidden-parent creation remains rejected. |

No posted production finding was dismissed as invalid or assumed fixed without verification. Test-only threads: 4401113706 (barrier completeness) and 4403006511 (attribute-bound proof) are outside this production convergence pass; the current sticky attribute scanner is forward-only. 4403006476 (nonempty PARTIAL report) was strengthened as part of B's actual redaction regression, including its exact hidden marker. None of these threads was resolved.

### Follow-up production-file inventory

| File (under src/) | Why this file is necessary |
|---|---|
| scheduling/calendars/index.js | Exact bounded week-count option for snapshot reconstruction; original metered scanner remains the default. |
| scheduling/plans/index.js | Select snapshot counting and preserve malformed-weekday fallback. |
| state/appState.js | Opt snapshot normalization into bounded counting. |
| server/reports/taskActivityReport.js | Report-specific display permission, deletion evidence and authorized identity cap. |
| domain/reminders/reminderTemplate.js | Consistent raw/stored/render size contracts, bounded substitution and original-source closing offsets. |
| server/reminders/reminderStore.js | Reject expanding stored templates and load invalid legacy rows safely. |
| features/reminders/RichTextEditor.jsx | Keep oversized input from escaping editor handling or replacing the last safe value. |
| features/reminders/ReminderSettingsView.jsx | Present controlled preview overflow and terminal uncertain history accurately. |
| server/mail/smtpClient.js | Exact reply-code separator/end boundary. |
| server/reminders/reminderService.js | Shared delivery deadline, attempted-recipient accounting and uncertainty propagation. |
| server/reminders/reminderQueries.js | Prevent completed uncertain deliveries from stale-claim recovery. |
| domain/reminders/reminderRunOutcome.js | Preserve controlled size/uncertainty codes in aggregate outcomes. |
| server/repository/upsertIntentPolicy.js | Reuse the existing trimmed-version predicate in new create-intent boundaries. |
| server/repository/upsertIntentValidation.js | Reuse canonical assignment checks and defer create collisions. |
| server/repository/orderedSqlAppRepository.js | Select deferred collision handling after destination/dependency authorization. |
| server/repository/hardenedSqlAppRepository.js | Keep proposed creates independent of hidden candidate rows during integrity planning. |
| server/repository/sqlAppRepository.js | Final locked collision check after canonical create validation; unchanged recurrence transition. |

Regression helpers model actual SQL policy; no test bypasses authorization. Existing source-shape checks were updated for the deliberate version-gated reads while retaining source/destination authorization ordering and UPDLOCK/HOLDLOCK ancestry assertions. The original scanner-budget tests are unchanged.

### Follow-up validation and residual

Final local validation: targeted **213/213**, full serial suite **4,660/4,660**, zero failures/cancellations/skips; lint and production build passed; `git diff --check` passed. The Quality lockfile-consistency gate was reproduced in an isolated copy using `npm install --package-lock-only --ignore-scripts --offline`; its result is byte-identical to the committed lockfile. The full suite's fourteen warnings exactly match an independently executed unchanged-base 80-test run (one TLS-IP deprecation, one React key warning and twelve React SSR layout-effect warnings). The npm `http-proxy` environment warning also reproduces on the unchanged base. No warning was suppressed. Initial validation found source-shape assumptions about unconditional candidate reads; the assertions were corrected without removing their authorization/locking guarantees, then the complete suite was rerun successfully on the final production code.

```sh
node --test --test-concurrency=1 --test-reporter=tap test/security-calendar-bounds.test.mjs test/task-activity-report.test.mjs test/task-reminder-emails.test.mjs test/task-reminder-integration.test.mjs test/delete-intent-and-project-wbs-validation.test.mjs test/recurring-series-integrity.test.mjs test/smtp-delivery-lifecycle.test.mjs test/actual-mode-commit-and-authorization-regressions.test.mjs test/commit-integrity-hardening.test.mjs
npm test -- --test-concurrency=1 --test-reporter=tap
npm run lint
npm run build
git diff --check
```

Ending commit, publication and exact-HEAD remote check results are reported in the delivery. Native-platform and CodeQL/Dependency Review results for the final commit require the repository's remote checks; local success is not substituted for them.

Only the explicitly accepted F-024 residual may remain: a fully authorized valid creation with a hidden existing client-selected ID collides, while an unused ID creates. No other validated posted production defect is intentionally left open. No schema, migration, dependency, origin, endpoint, configuration knob or external service was added. AI/Outlook disclosure code, filesystem/network trust, scheduler authentication and transaction isolation are unchanged.

---

## Original pass: result and remaining constraint

All 26 findings were independently evaluated against fetched production HEAD. Eleven require fixes, fourteen are already fixed in production, and **F-024 remains partially remediated/open**. Complete security convergence is not claimed.

F-024: unauthorized destination writers now receive indistinguishable hidden-existing/missing task/WBS responses before collision lookup. An authorized creator can still distinguish an unused client-selected globally unique ID (creation succeeds) from an ID belonging to a hidden resource (collision must fail). A controlled same-ID reproduction returned `409 / UPSERT_CREATE_COLLISION` versus `200`. Error redaction cannot make successful creation indistinguishable from rejected creation. Eliminating that remainder requires a change to ID allocation/creation semantics, such as server-issued creation IDs with reference remapping, which the governing instructions did not authorize. No such redesign, permissive overwrite, silent success or expanded disclosure right was introduced.

## Live state and source

- Repository: https://github.com/mokaradag/Takvim
- Starting branch/base: `main`; starting/base SHA: `ed4a0aa1679ac336e7b58e8b5840f502c1ec1ab2`.
- Working branch: `security/deep-scan-convergence-20261028`.
- Clean independent checkout. Unrelated prior checkouts were left untouched.
- GitHub was queried first, and queried again after runtime recovery: no open PR exists. Historical PR #106 was already merged; its old remote branch was deleted. No PR was created, replaced, reopened or merged.
- Remote was fetched before work. No pull/rebase was needed; the working branch starts at fetched `main`.
- The runtime reset removed the first uncommitted checkout/test processes. The patches were reconstructed against the same freshly fetched base and immediately checkpointed in Git. Earlier test runs are historical observations, not substitutes for recovered-commit validation.
- Final commit SHA, push status and exact-HEAD check results are supplied in the delivery message.

Root `package.json`, Next configuration, CI and deployment documentation build/use root `src/`. They do not import or launch `coderabbit_review_runtime`. That directory is a stale review copy and is not regenerated by the normal build. No mirror was modified. Recent relevant history was inspected, including `aeddf50`, `971ce43`, `a55cd8e`, `6c88c77`, `77b2007`, `3a9ae05` and the later calendar-preservation commits incorporated in the merge base.

## Individual dispositions

Paths in this table are source-of-truth production paths unless explicitly under `test/`. An additional OPEN disposition is necessary for F-024; assigning a closed disposition would be inaccurate.

| ID | Disposition | Evidence / root cause and changed source |
|---|---|---|
| F-001 | ALREADY FIXED / NOT PRESENT | `src/scheduling/cpm/engine.js::findCriticalPaths` already uses iterative path/next stacks, copies only complete paths, and counts visits plus copied entries against 250,000 steps and 500 results. Critical tasks/dependencies remain complete when path enumeration truncates. Existing CPM/Gantt tests cover this. |
| F-002 | FIXED | `src/scheduling/plans/index.js` rejects provably excessive duration ranges using a conservative weekly lower bound before scanning. `src/scheduling/calendars/index.js` can stop at the first excessive working-day count. `src/state/appState.js` shares one snapshot normalization meter and supplies prior task/calendar context; unchanged durations are reused only with the same effective calendar. Supported maximum sparse-calendar durations remain valid. |
| F-003 | ALREADY FIXED / NOT PRESENT | `sqlAppRepository.js` already caches dates-only membership by persisted parent ID/RowVersion/effective calendar, checks membership before span calculations, caches immutable template spans and computes only the requested occurrence's finishes. Children share one existing fixed transaction meter. Maximum-duration and adversarial 399-child rollback tests cover it. |
| F-004 | FIXED | Task visibility previously authorized all historical assignee formatting. `src/server/reports/taskActivityReport.js` resolves historical identities per task/project through `src/server/authorization/taskIdentityVisibility.js`, extracted from the existing assignment policy in `sqlAppRepository.js`. `taskActivityChanges.js` applies the allowlist before names/raw personnel-number fallbacks, emitting at most one identity-free hidden-change marker without a count. FULL/READ and authorized unresolved identities retain their behavior. |
| F-005 | FIXED | Two ordinary narrow/self-assigned duration paths in `src/server/repository/sqlAppRepository.js` bypassed the shared transaction meter. Both now use that same meter. Regression: one maximum sparse ordinary task succeeds; a 50-task batch stops at exactly 5,000,000 checks and rolls back all transactional tables. |
| F-006 | ALREADY FIXED / NOT PRESENT | Root `src/server/identity/keycloakPkce.js::safeReturnTo` rejects literal/decoded controls, protocol-relative prefixes and backslashes. The root callback revalidates immediately before redirect. Existing tests include literal tab, `%09`, encoded slash and valid local paths. The PDF cites the stale review callback. |
| F-007 | FIXED | Unanchored attribute matching retried malformed-name suffixes. `src/domain/reminders/reminderTemplate.js` uses sticky forward tokenization, skips each malformed token as a unit, bounds source at 65,536 characters and reuses lowercased input for script/style scans. `src/server/reminders/reminderStore.js` returns controlled oversized-save validation before parsing/SQL. Allowlist/XSS and 40,000-character malformed-attribute tests remain. |
| F-008 | ALREADY FIXED / NOT PRESENT | Root `orderedSqlAppRepository.js` authenticates before persistence-dependent checks. FULL source authority precedes deletion reconciliation; `dependencyReconciliationValidation.js` loads/discloses successor IDs only with FULL relationship visibility. Existing hidden/missing and pre-authentication tests cover it. |
| F-009 | FIXED | `src/server/reminders/reminderService.js` sends individually addressed messages, removing shared To-address disclosure and username fallback. Current canonical task projections intentionally allow direct assignees to see co-assignee display names; reminders preserve that authorized behavior. Partial delivery is recorded honestly; total SMTP failure retains immediate retry behavior. |
| F-010 | ALREADY FIXED / NOT PRESENT | `reminderQueries.js::REMINDER_MANUAL_LOG_SQL` already combines cooldown check/reservation in a conditional INSERT with `UPDLOCK, HOLDLOCK`; preliminary reads only calculate display time. Added regressions overlap sends and synchronize two empty preliminary reads, proving one winner. Failed-send retry tests remain. |
| F-011 | ALREADY FIXED / NOT PRESENT | Root snapshot SQL separates `#DirectorySicils.IsPublished` from task-only name resolution. Partial shared-task outsiders are not published; self/scope/READ and explicit existing exceptions remain. Existing snapshot performance/runtime tests verify directory privacy. |
| F-012 | FIXED | `src/server/repository/sqlAppRepository.js` checks normalized submitted assignee scope before unrestricted `ensurePeople`. Same out-of-scope number yields the same response with/without a directory row; an authorized subordinate succeeds. The precheck is reused rather than repeating its SQL. |
| F-013 | ALREADY FIXED / NOT PRESENT | Root movement already unconditionally requires FULL source-project authority before dependency DELETE, regardless of relationship existence. Existing client and server move/dependency tests retain this rule. |
| F-014 | ALREADY FIXED / NOT PRESENT | Root administrator reminder-run cookie branch checks `assertBrowserMutationIntent` before pool/auth/delivery work. Correct scheduler-secret requests retain their independently authenticated path. Existing sibling-origin and scheduler-secret route tests cover it. |
| F-015 | FIXED | `src/scheduling/cpm/engine.js` wraps the entire CPM operation in one existing calendar meter: metadata, forward/backward passes, slack and critical-edge work. Exhaustion yields typed `CALENDAR_WORK_BUDGET_EXCEEDED`, never a partial schedule. A 200-edge maximum-lag graph has deterministically bounded reads; a normal maximum-lag calculation still succeeds. |
| F-016 | FIXED | Cached text could outlive deleted evidence. `src/server/ai/assistant/conversationQueries.js` reads owned message presence and optional evidence in one joined statement with message/conversation locks retained through that statement. `conversationStore.js` separates surviving evidence-free messages from missing messages. `assistantService.js` withholds disappeared answers during replay/reopen and subsequent model-history construction. Evidence writes are atomic with answers; application deletion uses conversation/message cascades, with no independent application evidence-deletion path. Real deletion races, general answers and evidence failures are covered. No schema change. |
| F-017 | ALREADY FIXED / NOT PRESENT | Root `openAiCompatibleStream.js` already discards leading whitespace incrementally and retains only unresolved tag prefixes. Existing tests count work over 20,000 fragments and cover split tags, UTF-8 and stop behavior. |
| F-018 | ALREADY FIXED / NOT PRESENT | Assignment creation/decision and overlapping reminder/Outlook cookie mutations already use the shared intent helper before side effects; JSON routes require `application/json`. Existing route matrix covers sibling origins, `same-site`, wrong media types and zero pre-rejection SQL writes. |
| F-019 | FIXED | `src/server/mail/smtpClient.js` searches only new chunks and joins a completed bounded line once. It rejects/closes before retaining more than 4,096 bytes per line or 65,536 per response. Tests cover unterminated/oversized multiline input, every split of valid CRLF/multiline replies, ordinary delivery and STARTTLS lifecycle. TLS/certificate settings are unchanged. |
| F-020 | ALREADY FIXED / NOT PRESENT | Single/bulk Outlook activation routes already check intent before subscription writes; bulk also requires JSON media type. Existing sibling-origin route matrix proves zero writes. |
| F-021 | FIXED | `src/server/outlook/outlookQueries.js` now reuses the existing task visibility predicate in the subscription-state SELECT and joins current active tasks/projects. Owning an active subscription no longer discloses later completion metadata after revocation. Regression keeps the subscription active, revokes access, checks empty state, then restores READ and verifies legitimate metadata. |
| F-022 | ALREADY FIXED / NOT PRESENT | Commit and schedule-change routes already validate same-origin intent and JSON media type before mutation. Existing sibling-origin/simple-request tests cover the actual boundaries. |
| F-023 | FIXED | `src/server/repository/sqlAppRepository.js` checks current canonical parent task visibility using the existing `loadOutlookTask` visibility query before reading parent-specific rule/project/span metadata. Identical submitted IDs produce identical full responses for hidden/absent parents; authorized parents retain normal recurrence validation. |
| F-024 | PARTIALLY REMEDIATED / OPEN | `orderedSqlAppRepository.js` and `upsertIntentValidation.js` authorize task/WBS creation destinations and dependency authority before collision reads, reusing the existing exported task-create scope. Unauthorized hidden/absent probes are indistinguishable. The authorized-creator success/collision oracle remains, as explained above. |
| F-025 | ALREADY FIXED / NOT PRESENT | Supported standalone local test helper `test/helpers/fakeOpenAiCompatibleServer.mjs` already validates semantic strings/arrays before conversion and catches processing exceptions at the HTTP boundary. Existing malformed-object/listener-survival tests cover it. Production AI behavior was not modified for this helper. |
| F-026 | ALREADY FIXED / NOT PRESENT | The fake helper already enforces query/count/document/embedding bounds and uses `hashedScorer` to hash the common query once. Existing tests count hashes, test boundaries and verify unchanged deterministic scores. |

## Consolidation and security invariants

F-002/F-005/F-015 extend existing calendar work accounting rather than introducing separate task/edge allowances. Already-correct F-001/F-003 algorithms remain. F-004 reuses canonical identity policy; F-012/F-023 move scope/disclosure checks ahead of existence/metadata; F-021 filters at the current SQL disclosure boundary. F-016 uses the existing atomic persistence/cascade lifecycle. Template and SMTP complexity fixes remain separate because their contracts differ. F-009 isolates transport headers while preserving authorized names. F-024 moves creation authorization earlier without pretending that it solves the remaining identity-contract conflict.

No authorization, FULL/READ/PARTIAL project visibility, task/WBS visibility, personnel identity visibility, dependency modification authority, assignment/corporate-project authority, AI disclosure authority, Outlook visibility, mutation rights, or filesystem/network trust was broadened. Authority remains server-derived. FULL deletion/movement restrictions, SERIALIZABLE/locking/retry behavior, identity normalization, scheduler-secret authentication, recurrence integrity, calendar/date semantics and maximum supported durations remain enforced.

No dependency, schema, external service, telemetry, CDN, Unix-only filesystem/process assumption or weakened TLS/certificate validation was introduced. SMTP now sends one message per unique mailbox; if some messages deliver, the result is a partial send so an immediate retry does not duplicate successful deliveries. If none deliver, FAILED logging/retry semantics remain.

## Production diff inventory

| Source | Reason |
|---|---|
| `src/domain/reminders/reminderTemplate.js` | Bounded forward attribute parsing and template limit. |
| `src/scheduling/calendars/index.js` | Optional early excessive-count stop; default counting semantics retained. |
| `src/scheduling/plans/index.js` | Cheap conservative rejection and calendar-aware duration reuse. |
| `src/scheduling/cpm/engine.js` | Whole-calculation aggregate calendar meter. |
| `src/state/appState.js` | Snapshot meter and prior task/calendar context. |
| `src/server/authorization/taskIdentityVisibility.js` | Reuse exact existing identity predicate. |
| `src/server/reports/taskActivityReport.js` | Deduplicated task/project-specific authorized historical names. |
| `src/server/reports/taskActivityChanges.js` | Identity allowlist before formatting, one count-free generic marker. |
| `src/server/repository/sqlAppRepository.js` | Scope-before-directory lookup, parent disclosure gate, ordinary calendar meter and shared policy/create scope. |
| `src/server/repository/orderedSqlAppRepository.js` | Creation authorization before collision checks. |
| `src/server/repository/upsertIntentValidation.js` | Existing creation authority before task/WBS existence lookup. |
| `src/server/reminders/reminderService.js` | Individual addressing, no username fallback, accurate delivery outcomes. |
| `src/server/reminders/reminderStore.js` | Controlled oversized-template rejection before SQL. |
| `src/server/mail/smtpClient.js` | Incremental bounded SMTP replies. |
| `src/server/outlook/outlookQueries.js` | Current task visibility in subscription state. |
| `src/server/ai/assistant/conversationQueries.js` | Consistent owned message/evidence read. |
| `src/server/ai/assistant/conversationStore.js` | Explicit message presence separate from evidence presence. |
| `src/server/ai/assistant/assistantService.js` | Missing-message gate for saved disclosure and model history. |

Split: **18 production files, 11 test/helper files, 1 report**. Test helpers model the changed real SQL; no authorization branch is bypassed. The shared-To assertion was replaced with stronger individual-header assertions. The SMTP-failure source-shape test now checks aggregate delivery outcome; runtime failure/retry assertions remain. No hostile input or security assertion was weakened.

## Validation and limitations

Exact recovered-commit commands/results are supplied in the delivery message:

```sh
node --test --test-reporter=tap --test-concurrency=1 test/security-calendar-bounds.test.mjs test/smtp-delivery-lifecycle.test.mjs test/task-activity-report.test.mjs test/task-reminder-integration.test.mjs test/task-reminder-emails.test.mjs test/delete-intent-and-project-wbs-validation.test.mjs test/recurring-series-integrity.test.mjs test/ai-disclosure-invariants.test.mjs test/actual-api-boundary.test.mjs test/ai-semantic-gateway.test.mjs test/working-calendars.test.mjs test/cpm-validation-edge-cases.test.mjs test/outlook-calendar-integration.test.mjs test/ai-domain-tools.test.mjs test/ai-evidence-boundaries.test.mjs
npm test -- --test-concurrency=1 --test-reporter=tap
npm run lint
npm run build
git diff --check
```

No separate typecheck script exists; Next production build includes its normal lint/type-validation stage. Runtime is Node 24.22.1; CI specifies 24.14.0. The dependency tree was copied from an existing installed checkout with a byte-identical package lock; no dependency/lockfile change. The earlier offline installation attempt failed because a tarball was absent from cache.

Historical pre-reset results: targeted 376/376, an additional Outlook test 1/1, related activity/AI 127/127, adversarial 178/178, extended disclosure 66/66. The superseded full run found two count-free hidden-assignment marker expectations, corrected without changing their tests. Baseline focused regressions failed on the original disclosure behavior; read-only probes confirmed the old duration path scans before rejecting and old SMTP does not close oversized unterminated input. These historical observations are not final recovered-HEAD validation.

Native Windows/macOS CI, live SQL Server/organizational SMTP/Keycloak/model systems and CodeRabbit deep-scan tooling are unavailable locally. The complete available suite uses supported SQL/provider/mail doubles and loopback servers; no external production service was called. No fresh scanner-success claim is made. Final HEAD/push status and final warning disposition are recorded in the delivery, not guessed here.
