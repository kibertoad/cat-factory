# Initiative: refactoring & simplification round, August 2026

**Status:** proposed (analysis complete, no slices landed) · **Owner:** core ·
**Started:** 2026-08-08

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A whole-tree analysis pass (2026-08-08, at `e6f58f4`) over the orchestration engine, the
three runtime facades, `@cat-factory/server` and the VCS clients, the executor harness, the
integrations package, and the frontend SPA, looking for the highest-impact refactorings and
simplifications that lose no functionality. Every entry below was verified against the tree
by reading the code, not inferred from file sizes.

The selection principle: **duplication that has already produced drift, or structurally can,
outranks raw line count.** Several entries fix a live inconsistency the duplication caused
(a routing client that silently drops 18 optional port methods, sibling gate reads that
disagree on null vs 404, a batched fix that landed in one of two twin modals, a heartbeat
wrapper whose omission already killed healthy runs once). Those come first; pure size
reductions come after.

This round is complementary to
[`docs/internal/refactoring-candidates.md`](../internal/refactoring-candidates.md), which
keeps the three big structural candidates (#6 DI-graph promotion, #7 shared D1 ⇄ Drizzle
base repositories, #8 shared Node ⇄ Cloudflare container builder). Nothing here depends on
those, and nothing here is blocked by them; entries that touch their territory say so.

## How to land a slice

Each entry is independently landable as one PR unless its text names a prerequisite.
Standard rules apply: pure code movement verified by the existing suites, conformance for
anything cross-runtime, a lowered `check-file-size.mjs` allowance in the same PR when a
split shrinks a ratcheted file, and a changeset per versioned package touched. Tick the box
and add the PR link when a slice lands.

## Summary

| #   | Item                                                           | Area         | Impact                          | Effort  |
| --- | -------------------------------------------------------------- | ------------ | ------------------------------- | ------- |
| 1   | `settleStepAndAdvance` + dispatch epilogue + `persistAndEmit`  | Engine       | High (terminal-path invariants) | Low     |
| 2   | Provider-routing VCS client as a Proxy + drift test            | Server       | High (fixes a live gap)         | Low-Med |
| 3   | Shared HKDF cipher-info constants                              | Runtimes     | High (seal/unseal drift)        | Trivial |
| 4   | Harness ⇄ backend contract conformity test                     | Harness      | High (no image bump)            | Trivial |
| 5   | Wire the five telemetry conformance suites to local-sqlite     | Runtimes     | High (enables #6)               | Low     |
| 6   | One SQLite telemetry store behind a `SqliteRunner` port        | Runtimes     | High (~600-800 lines)           | Medium  |
| 7   | Gate-action sub-facades; settle the null/404 divergence        | Engine       | High (~350 lines + API fix)     | Medium  |
| 8   | Shared `notifyError` composable                                | Frontend     | High (27 sites + better copy)   | Low     |
| 9   | `refuse` adoption + envelope helpers in `PublicApiController`  | Server       | Medium (~130 lines)             | Trivial |
| 10  | Safe-fetch consolidation + Jira redirect guard                 | Integrations | Medium (closes a gap)           | Low-Med |
| 11  | Repo-issue provider core (GitHub/GitLab/Jira/Linear)           | Integrations | Medium (~230 lines)             | Medium  |
| 12  | `selectInChunks` helper in the D1 facade                       | Runtimes     | Medium (~170 lines, 29 sites)   | Low     |
| 13  | Shared periodic-backstop catalog (sweepers ⇄ crons)            | Runtimes     | Medium (~400 lines + parity)    | Medium  |
| 14  | Harness dedup batch (one image bump)                           | Harness      | Medium (~350 lines + fixes)     | Medium  |
| 15  | Kernel home for the cross-VCS pure helpers                     | Server       | Low-Med (4 copies → 1)          | Trivial |
| 16  | `ContainerAgentExecutor` accounting extraction                 | Server       | Medium (~180 lines)             | Low     |
| 17  | Human-gate parked-plumbing unification                         | Engine       | Medium (~180 lines)             | Medium  |
| 18  | Workspace preset-library twins (backend + frontend)            | Engine + SPA | Medium (fixes twin drift)       | Medium  |
| 19  | `EnvironmentConnectionService` context + event-log helpers     | Integrations | Medium (−8 reads, ~150 lines)   | Low     |
| 20  | Contracts mechanical pass (`nullish`, `nonEmpty`, shared refs) | Contracts    | Medium (~100 lines, 300 sites)  | Low     |
| 21  | Decompose `PipelineBuilder` and `ObservabilityPanel`           | Frontend     | Medium (structure)              | Medium  |
| 22  | Frontend ratchet allowances + knip entry fix + dead files      | Guards       | Medium (guards gain teeth)      | Low     |
| 23  | Review-window draft machinery + repo-source link UI            | Frontend     | Medium (~350 lines)             | Medium  |
| 24  | Delete the 8 dead Cloudflare re-export shims                   | Runtimes     | Low (hygiene)                   | Trivial |
| 25  | Narrow `GitHubClient` consumers with `Pick`                    | Server       | Medium (kills ~20 `as` casts)   | Low     |
| 26  | Small engine cleanups bundle                                   | Engine       | Low (~150 lines)                | Low     |

## Candidates

### 1. Run-settlement helpers on `RunStateMachine`

- [ ] `settleStepAndAdvance` extracted and adopted at all seven sites
- [ ] `dispatchHelperJob` (or a generalised `GateHelperDispatcher`) adopted at all seven dispatch sites
- [ ] `persistAndEmit` adopted for the remaining adjacent `casPersist` + `emitInstance` pairs

The "finish this step, then finish the run or advance the cursor" epilogue is a 23-line
block copy-pasted seven times: byte-identical private `completeStep` methods in
`ReviewGateController.ts:398`, `VisualConfirmationController.ts:391`,
`InterviewGateController.ts:311` and `HumanTestController.ts:530`, plus inlined variants in
`CompanionController.ts:436`, `RunDispatcher.skipGatedStep` and
`RunDispatcher.recordStepResult`. This is the run's terminal transition: the
`stopRunContainer`-only-on-final-step invariant is re-asserted by hand in seven places.
Target: `RunStateMachine.settleStepAndAdvance(ws, instance, step, isFinalStep, opts)`
beside its existing counterparts `parkStepOnDecision` and `advanceRunPastGate`; the options
carry the three real variations (`confidence` pass-through, `resolverOwnsTerminalStatus`,
`pendingInterview` clearing).

Same treatment for the helper-dispatch epilogue (`startJob` → `step.jobId` →
`recordDispatchAttribution` → `step.container = { status: 'up' }` → persist → emit →
`awaiting_job`), repeated in `GateHelperDispatcher.ts:88`, `AgentDispatchController.ts:193`,
`TesterController.ts:361` and `:561`, `RalphController.ts:176`,
`VisualConfirmationController.ts:293`, `HumanTestController.ts:413`. `GateHelperDispatcher`
was extracted for exactly this but only `GateStepController` uses it. Two of the sites carry
duplicated comments warning that forgetting `recordDispatchAttribution` is a silent
attribution regression; the helper makes that structural.

Finally `casPersist` immediately followed by `emitInstance` occurs 43 times across 18
engine files (ten of them preceded by `updateBlockProgress` as a stable trio). A
`persistAndEmit(ws, instance, { blockStatus?, rollUpMetrics? })` makes "persisted but not
emitted" unrepresentable. Land the three in this order; the first two subsume about twenty
of the 43 pairs. Roughly 250 lines total, all on the engine's hottest transitions.

### 2. `ProviderRoutingGitHubClient` becomes a Proxy, with a method-surface drift test

- [ ] Proxy-based routing client, keeping the memoised `providerOf` resolution
- [ ] Prototype-reflection drift test (the `fanOutEventPublisher.spec.ts:198` pattern)

`GitHubClient` declares 53 methods, 20 of them optional. The hand-written delegate
(`backend/packages/server/src/github/ProviderRoutingGitHubClient.ts`, 339 lines) implements
the 33 required ones plus two pass-throughs and none of the other 18 optional ones, which
TypeScript accepts because they are optional. In the one deployment shape where the router
is wired (GitHub App + GitLab PAT together), every optional-method caller feature-tests and
silently degrades: PR reviews read as empty (`GitHubPullRequestReviewProvider.ts:162`), the
rebase path is skipped (`GitHubBranchUpdater.ts:45`), and the PR-review agent's inline
comment capability disappears (`repoFiles.ts:95-121` conditionally spreads `createReview`
and friends). The repo already wrote the fix and named this class as the known-bad case:
`runtimes/local/src/vcsClientRouter.ts` is a `Proxy` router whose header comment explains
why a hand-written delegate fails silently, and whose `has` trap keeps `?.` feature-tests
working per provider. Port that shape (including its `then`/symbol protocol-key guard),
keep the memo and its documented immutability rationale, and pin the surface with a
reflection test. 339 → ~110 lines, and 18 methods return to dual-provider deployments.
This is the one entry that changes runtime behaviour on purpose, so the restored
capabilities want integration coverage in the same PR.

### 3. Shared HKDF cipher-info constants

- [ ] Five constants exported next to the four that already are; both facades import them

Both `wireCredentialServices.ts` files hard-code the same five HKDF `info` literals
(`cat-factory:provider-subscriptions`, `provider-api-keys`, `personal-subscriptions`,
`local-model-endpoints`, `user-secret`). These strings derive the keys that seal
credentials at rest, so a divergence produces credentials one facade seals and the other
cannot unseal, silently. The fix pattern is already in the same files:
`TEST_SECRETS_CIPHER_INFO`, `CAPABILITY_CREDENTIALS_CIPHER_INFO`, `MCP_OAUTH_CIPHER_INFO`
and `PACKAGE_REGISTRY_CIPHER_INFO` are imported constants; these five were missed. Ten
lines. A later `buildCredentialServices` extraction of the mechanically-parallel builder
pairs is possible but optional; the constants are the part that must not wait.

### 4. Harness ⇄ backend contract conformity test

- [ ] `test/harness-contract.conformity.test.ts` pinning `safeDirSegment` and the sentinel paths
- [ ] `.cat-follow-ups.jsonl` lifted onto a named constant on the prompt side

Distinct from the three intentionally pinned kernel copies, two cross-package contracts
claim byte-identity in comments with nothing enforcing it. `safeDirSegment` plus the
`owner__name` join exist in `executor-harness/src/coding-agent.ts:1022` and
`server/src/agents/jobBody.ts:583`; the harness creates the directory and the backend names
it in the agent's prompt, so drift points the agent at a directory that does not exist. The
four sentinel paths (`.cat-effort.json`, `.cat-pr-description.md`, `.cat-context`,
`.cat-follow-ups.jsonl`) each exist once in the harness and once in
`@cat-factory/agents`' prompt text, the last as a bare inline literal. One conformity test
in the exact style of `host-markdown.conformity.test.ts` closes all of it, and because
`docker-publish.yml` gates the image rebuild on `src/**`, a `test/**`-only change ships
with **no image bump**: the highest value per unit of shipping cost in the package.

### 5. Run the existing telemetry conformance suites against the local-sqlite store

- [ ] Five ~12-line conformance test files (the `toolCalls.conformance.test.ts` pattern)
- [ ] Bespoke describes in `telemetryStore.test.ts` that the suites subsume deleted

`defineLlmMetricsSuite`, `defineAgentContextSuite`, `defineAgentSearchQuerySuite`,
`defineProvisioningLogSuite` and `defineSubscriptionQuotaSuite` each run against Node and
the Worker but never against `runtimes/local/src/sqlite/telemetryStore.ts`, which
implements all five ports; the local store's coverage is a hand-rolled 813-line sibling.
`toolCalls.conformance.test.ts` already states the rationale ("the store a developer's own
runs are recorded in is the one nothing pins") and is the 12-line pattern to copy. This is
the prerequisite that turns #6 from a medium-risk refactor into a mechanical one.

### 6. One SQLite telemetry implementation behind a `SqliteRunner` port

- [ ] Driver port + two adapters (D1, `node:sqlite`)
- [ ] Six repository pairs folded onto shared implementations; local extras stay as wrappers

The local telemetry store and the six D1 telemetry repositories are the same SQL over two
drivers: D1 is SQLite, so unlike the tracked D1 ⇄ Drizzle candidate the SQL text itself is
shared, not just the semantics. Measured with normalisation: 574 unique lines byte-identical
across the pair, including a contiguous 103-line block
(`D1LlmCallMetricRepository.ts:174-303` ⇄ `telemetryStore.ts:116-245`) and both files'
comments declaring they "mirror each other by contract, line for line". Today a fix to the
carry-cost ordering or the `ON CONFLICT(id) DO NOTHING` idempotency rule must land twice.
Target: a 3-method `SqliteRunner` port (`all`/`first`/`run`), two ~30-line adapters, one
implementation of each repository; `LocalTelemetryCoverage`, the pruning overrides and the
`telemetry_ingest_state` table stay local-only. Gotcha: `node:sqlite` is synchronous and
the batch inserts deliberately avoid `await` inside `BEGIN` (documented at
`telemetryStore.ts:470-489`), so the adapter's batch path must stay a sync loop behind an
async facade. Land after #5. ~600-800 lines out of ~3,100.

### 7. Gate-action sub-facades; one not-found contract for the sibling reads

- [ ] `prReview` / `followUps` / `forkDecision` / `judge` getters on `ExecutionService`
- [ ] The ~40 + ~25 single-line pass-throughs deleted; server controllers re-pointed
- [ ] One not-found contract across the four `getActive` reads
- [ ] Shared `activeStepBy` / `parkedStepOfKind` lookup helpers

`ExecutionService` and `RunDispatcher` carry a two-layer verbatim delegation chain:
nineteen methods exist at all three layers with identical signatures, ~350 lines whose
entire bodies are `return this.x.y(...)`. The codebase already documents the fix on itself:
`ExecutionService.ts:666-720` exposes seven gate-window sub-facades as getters "consumed by
the matching server controllers"; the four remaining clusters never got the treatment.
Doing so also forces the real inconsistency into the open: `FollowUpGateController`
throws `NotFoundError` for a missing execution where its three siblings return null, and
the four are served side by side. The hand-rolled backward scans behind them
(`activeForkStep`, `activePrReviewStep`, `activeFollowUpStep`, plus the parked-step scans
in the human-gate controllers) collapse onto two helpers in a `run-step-lookup.ts`.
Call-site churn is contained to six server modules, all mechanical.

### 8. Shared `notifyError` composable

- [ ] `useErrorToast` composable, envelope-aware; the 27 local copies deleted

Twenty-seven components define a local `notifyError(title, e)`; 24 are byte-identical and
show `e.message` raw, which for API groups still on the `$fetch` path is HTTP boilerplate
(`[POST] .../x: 500`), while the two envelope-aware copies show the server's actual
message. One auto-imported composable built on
`apiErrorEnvelope(e)?.message ?? (e instanceof Error ? e.message : String(e))` deletes
~216 lines and upgrades 24 surfaces to the server's explanation. The ~86 further inline
`toast.add` error blocks with the same shape can migrate opportunistically.

### 9. `PublicApiController` adopts its own module's `refuse`

- [ ] The 21 hand-built gate envelopes replaced with `refuse(c, gate.fail)`
- [ ] `notFound` / `invalidCursor` helpers for the 19 repeated literal envelopes

`publicApiAuth.ts` exports `refuse` precisely so no controller can drift from the shared
refusal shape, and five sibling public controllers use it; `PublicApiController` imports
`authorize` but not `refuse` and spells the identical 6-line block out 21 times. The other
repeated literals (`'Task not found'` ×8 and friends) get three module-local helpers. The
hand-built envelope convention on `/api/v1` is deliberate (failures are data there); only
the repetition is the smell. ~130 lines, mechanical.

### 10. Safe-fetch consolidation, and Jira joins its Confluence sibling

- [ ] Notion and Linear onto `createHostPinnedFetch` + `readCappedText`; local copies deleted
- [ ] `documents/http.ts` re-based on `shared/safe-fetch.ts`
- [ ] All five Jira call sites through `getJson`, routed via `safeFetch` with the Atlassian guard

Four implementations of "manual-redirect host-guarded fetch with a capped body read" exist:
`shared/safe-fetch.ts` (the real one, 8 consumers), `documents/http.ts`,
`NotionProvider.ts:48-124`, and `linear.client.ts:143-205`, the last copied from the Notion
copy by its own comment. Separately `JiraProvider` writes the same authenticated GET out
five times while its own private `getJson` helper has one caller, `fetchTask` skips the
base-URL re-validation its siblings perform, and all five sites use default
`redirect: 'follow'` with a Basic authorization header, so a 302 can chase the credential
off-host; `ConfluenceProvider`, same auth and same per-connection base URL, already routes
through `safeFetch` with a per-hop guard. Preserve two semantic deltas when consolidating:
cross-origin credential stripping is new behaviour for fixed-host providers (harmless but
state it), and pass `throwOnOverflow: true` where today's copies throw rather than
truncate. ~215 lines, and one definition of the SSRF/OOM guard instead of four.

### 11. Repo-issue provider core

- [ ] `toRepoSearchResult`, `walkIntakeHits`, `searchExactFirst`, `classifyHttpDiagnostic` in the shared logic module
- [ ] GitHub + GitLab providers re-based; Jira + Linear adopt the classifier

`GitHubIssuesProvider` and `GitLabIssuesProvider` are method-for-method structural clones
(~320 duplicated lines): the exact-first search with dedupe, the bounded intake page walk
(`INTAKE_MAX_PAGES = 5` declared twice, the GitLab copy's comment admitting "same bound as
the GitHub provider's"), the same 6-field search-hit projection written out six times, and
the same 401/403/null/else diagnostic ladder that also appears in `JiraProvider.ts:253` and
`LinearTaskProvider.ts:339`. `repo-issues.logic.ts` already exists for "the projections
every repo-backed issue source shares"; extend it. The per-provider differences
(GitLab's case-sensitive compare, its `hasMore` stop rule, the `UnavailableError`
precondition) are deliberate and travel as options, never folded away. Both providers have
substantial tests pinning behaviour.

### 12. `selectInChunks` for the D1 facade

- [ ] Helper beside `chunkForIn`; the 29 open-coded fan-out sites collapsed

The chunked-`IN` idiom (guard clause, accumulator, placeholder join, `results ?? []`, the
re-typed bound-parameter comment) is open-coded 29 times across 19 D1 repository files. One
`selectInChunks(db, ids, sqlOf, leadingBinds?)` collapses each site to two lines. Lives
entirely inside the Cloudflare facade and survives a later shared-base-repository
extraction unchanged, so it is not blocked by candidate #7 next door. ~170 lines. Watch the
handful of sites with leading binds and the bounded status lists that are deliberately not
chunked.

### 13. Shared periodic-backstop catalog

- [ ] `PeriodicBackstop` descriptor table in `@cat-factory/server`
- [ ] Node maps it through `startSweeper`, the Worker through `SweepTick.run`

Each facade has a good local scheduler abstraction; what is transcribed twice is the
catalog: name, tuning constants, failure message and success log for each of ~12 sweeps
(verified pairs include the Kaizen constants and messages, recurring pipelines, the
initiative loop, notifications, foundational sources, spend alerts, platform metrics). Ten
Node wrapper modules of ~40 lines each collapse to descriptors; `index.ts:770-950` becomes
a loop. Facade-specific sweeps (pg-boss stale-run/dead-letter, the container reaper) stay
put. Gotchas: cadence semantics differ (per-sweep intervals vs a shared 2-minute cron with
window gates), so the descriptor carries a cadence field, and the Worker's `kaizenSweeping`
isolate latch must survive as a flag. ~400 lines, and "the Worker got the new sweep, Node
didn't" becomes unrepresentable, which is the facade-parity rule made structural.

### 14. Harness dedup batch (one image bump)

- [ ] `heartbeatMs` option on `runCapturedCommand`; the four copy-pasted wrappers and per-phase env readers deleted
- [ ] `harnessAuth` projector next to `agentCapabilities`; the two inline capability rebuilds use the helper
- [ ] Single-repo coding result built from one base object; the `ralphVerdict` branch inconsistency resolved deliberately
- [ ] `prepareWorkCheckout` shared by the single-repo and multi-repo paths
- [ ] Env-int idiom onto one exported helper (reconcile the floor/no-floor variant deliberately)
- [ ] `describeFailure` watchdog branches as a lookup; `pi.ts` progress rollup onto `toProgress`
- [ ] Dead `hasDiffAgainstBase` removed; `InlineJob.maxOutputTokens` forwarded or deleted with its false comment

The harness is better factored than its file sizes suggest (watchdog, progress, spawn and
stream plumbing are already shared); the duplication is around those seams. The
inactivity-heartbeat wrapper is copy-pasted four times with a fifth hardcoded variant, and
its omission has already caused one documented regression (`coding-agent.ts:923-931`:
healthy `pnpm test` runs killed as inactivity wedges). The 7-field harness-auth spread is
retyped at six call sites although both source types already extend `HarnessAuthFields`.
`runSingleRepoCoding` builds the same result literal six times and `ralphVerdict` is spread
on some clean-non-event branches and not others, a live inconsistency to resolve rather
than normalise away. The clone/resume/base-refresh sequence exists three times with
comments saying "as in the single-repo path". Batch all of it into one PR so the image
bumps once; ~350 lines plus two small behaviour fixes, each named in the changeset. The
subscription-CLI isolated-home envelope and a shared `spawnJsonlCli` are follow-on
candidates deliberately left out of the batch: the first touches credential lifecycles and
the second the Pi hot path, so each earns its own PR if taken at all.

### 15. Kernel home for the cross-VCS pure helpers

- [ ] `parseNextLink`, `decodeBase64Utf8`, one epoch-parse helper moved beside `describeVcsApiError`

`parseNextLink` exists byte-identical in four files (both VCS clients and both identity
resolvers); `decodeBase64Utf8` twice; the GitHub and GitLab time parsers are the same
function under two names. RFC-5988 link parsing is not provider-specific. Kernel's
`vcs-errors.ts` is already the shared VCS-HTTP home both clients import from; move them
beside it and re-export from `githubHttpHelpers.ts` so no importer changes. A broader
shared HTTP core for the two Fetch clients was investigated and rejected (see below).

### 16. `ContainerAgentExecutor` accounting extraction

- [ ] `BoundedJobGuard` + `RunAccountingRecorder` extracted; `pollJob` delegates

The executor carries four dedupe collections and five methods that exist only to service
them, with the identical 10,000-entry bound-and-clear idiom four times and doc comments
cross-referencing each other ("same replay-safety rationale as..."). The whole cluster is
reached from exactly one place (`pollJob`), which makes it the cleanest remaining cohesive
extraction in an already-mined file. ~180 lines out, and the replay-safety invariants
become unit-testable without a full poll cycle. Ratchet the file's allowance down in the
same PR.

### 17. Human-gate parked-plumbing unification

- [ ] Shared parked-gate plumbing (`findParked` / `requireParked` / `signalAction` / `completeStep` / notification clearing) parameterised by a gate descriptor

`HumanTestController` (715 lines) and `VisualConfirmationController` (537) are structural
clones: method lists align one-for-one and `signalAction` differs only in the agent kind,
the state-slice key and the message strings. The precedent is next door:
`ReviewGateController` is already kind-parameterised over three subjects via
`ReviewKind<T>`. Scope this to the parked-gate plumbing (~180 lines) and leave the
genuinely divergent phase bodies alone (human-test owns environment provisioning and a
`pullMain`/`recreate` action set; visual-confirm owns the artifact store): a full merge of
the two controllers was considered and rejected as over-abstraction. A third human gate
then starts from a descriptor, not a 600-line copy.

### 18. Workspace preset-library twins, backend and frontend

- [ ] `WorkspacePresetLibrary` shared by `ModelPresetService` and `RiskPolicyService`
- [ ] `useCatalogPresetHealth` replacing the two line-for-line identical health composables
- [ ] Shared advisory-modal shell; the sequential-reseed twin adopts the batched `reseedMany`

The same feature is written twice at two layers. Backend: `ModelPresetService` and
`RiskPolicyService` have identical method sets in identical order over identically-shaped
repositories; `remove` is verbatim in both and `reseed` is the same 35-line algorithm. The
`isDefault` reclaim predicate differs subtly between them, so it becomes a supplied hook.
Frontend: `useModelPresetHealth` and `useRiskPolicyHealth` differ only in type, store and
id-prefix regex, and their modals diverge in exactly one real way: the batched `reseedMany`
fix landed in the model-preset copy while the risk-policy copy still loops sequentially.
Share the shell, keep three thin callers (`PipelineHealthModal` has real extra categories).
~340 lines across the two layers, and the drift that already happened is healed by
construction.

### 19. `EnvironmentConnectionService` context and event-log helpers

- [ ] `primaryContext(workspaceId)` reads the connection row once per request path
- [ ] `withBoundRepo` for the six near-copies of the "no VCS connection" early return
- [ ] `rotateSecrets` shared by the two byte-identical secret-update bodies
- [ ] `recordEnvEvent` helper for the nine 10-field provisioning-log literals
- [ ] Dead `composeConfigToManifest`, `classifyPodStartupFailure`, `describePodStatus` deleted with their stale doc comments

Four endpoint paths each read the same connection row three times (no cache on the port,
three `listByWorkspace` reads plus three manifest builds per request) because
`providerForWorkspace`, `optionalManifest` and `resolveSecrets` resolve independently. The
"no VCS connection" refusal block appears six times with wording that has already drifted
slightly; keep the messages per-caller, share the plumbing. The provisioning-log event
literal is spelled out nine times across three services with the best-effort posture
applied inconsistently; one helper states it once. The three dead exports have zero
production callers and doc comments that misdescribe the system. Roughly 150 lines plus
eight redundant reads per affected request.

### 20. Contracts mechanical pass

- [ ] `v.optional(v.nullable(X))` → `v.nullish(X)` (300 occurrences, zero current uses of `nullish`)
- [ ] Inline `v.pipe(v.string(), v.minLength(1))` → the existing `nonEmpty` (58 sites)
- [ ] Inline `v.picklist(['github', 'gitlab'])` → the existing `vcsProviderSchema`; a spreadable `repoCoordsFields` for the repeated repo-coords quartet

Type-identical rewrites, confirmed by typecheck; `environments.ts` already imports
`nonEmpty` and uses both spellings. No schema-scaffolding abstraction beyond this: the
seemingly-paired deploy/dispose state schemas differ for real, and the 648-line
`pipelineStepSchema` extraction is readability-only and deliberately not scheduled.

### 21. Decompose `PipelineBuilder` and `ObservabilityPanel`

- [ ] `PipelineDraftStep` / `PipelineConsensusConfig` / `SavedPipelineList` / `AddAgentModal` slices
- [ ] Observability run-summary + four tab components

The two components with the cleanest seams among the six frontend monoliths.
`PipelineBuilder.vue` (1423 lines) is three self-contained grid columns plus an inline
modal, all state already on `usePipelinesStore` (the store was split into five modules
while the component never followed), and the directory already holds five extracted slices
of this surface. `ObservabilityPanel.vue` (1214) is four independent tabs sharing one
`view` ref plus a standalone run-summary block, everything keyed by `executionId`, with the
slice pattern already established in `components/observability/`. `AddTaskModal`,
`RequirementsReviewWindow`, `ServiceTestConfig` and `FragmentLibraryManager` stay tracked
by the July review's item and by #22's ratchet entries; #23 shrinks two of them from the
composable side first.

### 22. Give the frontend guards teeth

- [ ] The six >1,000-line components added to `LEGACY_ALLOWANCES` at current size
- [ ] knip's frontend `entry` narrowed so `rules.files` can fire; ignore baseline for auto-imports
- [ ] Dead `AgentChip.vue` deleted (with its `localization.md` mention)

The size ratchet scans `.vue` but has zero frontend allowances, so its only frontend budget
is the raw 1,500 default: `PipelineBuilder.vue` may grow 77 more lines before CI notices,
which is not the ratchet's stated purpose. Adding shrink-only entries costs nothing and
locks in every future win. Separately `knip.jsonc` declares every frontend file an entry,
so the dead-file rule structurally cannot fire for the SPA; `AgentChip.vue` (59 lines, zero
references, verified against the auto-import naming forms) is the existing proof. The knip
re-scope is its own change with a first-run baseline; the deletion and the allowances are
trivial.

### 23. Shared review-draft machinery and repo-source link UI

- [ ] `useReviewFindingDrafts` + a shared finding row, adopted by requirements + clarity (brainstorm follows)
- [ ] `useRepoSourceDraft` + `RepoSourceLinkForm` / `RepoSourceRow`, adopted by the fragment + skill library managers

Two frontend duplication pairs with drift already visible. 84% of `ClarityReviewWindow`'s
non-blank lines also appear in `RequirementsReviewWindow` (per-item draft replies keyed by
id, the seed-without-clobbering watch, status transitions, the busy set, the
incorporate/iteration-cap flow); the draft-seeding watch has a documented subtlety that
must survive generalisation, so extend the existing `.logic.spec.ts` before moving it. The
repo-source linking UI (state block, link form, source row) is duplicated between the
fragment and skill library managers with the skills copy already ahead (tooltips, synced
date) of the fragments copy; extracting heals the gap by construction. Do not merge any of
the host components themselves. ~350 lines across the four files, and two of the six
oversized components shrink meaningfully.

### 24. Delete the eight dead Cloudflare re-export shims

- [ ] Two test imports re-pointed; eight files and the knip `ignore` baseline deleted

All eight (`knip.jsonc:83-92`) are pure `export ... from '@cat-factory/server'` extraction
leftovers; knip proves seven have zero importers and the eighth serves two test files. The
baseline's own comment says "triage separately"; this is the triage.

### 25. Narrow `GitHubClient` consumers with `Pick`

- [ ] The 1-3 method consumers declared as `Pick<GitHubClient, ...>`; the `as GitHubClient` test casts retired

The god-port is real (958 lines, 53 methods, grown ~24% since the July review measured it),
but the cost is not stubbing labour: no fake stubs the surface, 26 test sites cast past the
type system instead, two of them literally `{} as GitHubClient`. Most consumers use one to
three methods and can declare exactly that, which deletes most of the casts with no port
change and makes the fakes type-checked again. The follow-on sub-port split along the
observed optionality clusters (the review group is 7/8 optional, git-data 0/11, so the 20
optional flags are really one capability question) is worthwhile but wide; #2 fixes the
concrete harm the god-port causes today, so it goes first and this entry stays cheap.

### 26. Small engine cleanups bundle

- [ ] `AgentContextBuilder` incorporated-review lookups as a 3-entry table
- [ ] `NotificationService.clearCards`; the three hand-rolled full-inbox filter loops deleted
- [ ] `container.ts` module-shape re-exports collapsed to `export type *`

Three verified small wins, bundled to be worth a PR. Explicitly considered and skipped in
the same neighbourhood: turning `validateRegistrations`' linear check list into an array
(costs the numbered section comments that make the file navigable, no duplication to
remove) and a `singleServiceModule` helper in `container/modules.ts` (the explicit
prerequisite `if` chains are what make each module's opt-in conditions greppable).

## Investigated and rejected

Recorded so the next analysis pass does not re-propose them.

- **Generating or deriving `rpc-allowlist.ts`.** 63% of the file is per-entry threat
  rationale that exists nowhere else, entries are already one line, and deriving it from
  the repositories would invert default-deny into default-allow, the exact failure the
  table exists to prevent. It is drift-guarded by `mothership-allowlist.spec.ts` and is the
  right size for its job.
- **A shared HTTP core for `FetchGitHubClient` ⇄ `FetchGitLabClient`.** They implement
  different ports and diverge on every axis that matters (auth lifecycle, headers,
  rate-limit recording, pagination semantics). The genuinely common part is the ~15 lines
  entry #15 moves for free.
- **A shared builder over the Node ⇄ local containers.** Refuted by measurement: ~4%
  normalised overlap, and `buildLocalContainer` already composes through one
  `buildNodeContainer` call and overrides the delta. The seam exists and is used.
- **Server-side re-validation dedup.** Does not exist: zero zod/valibot schemas under
  `server/src`; validation is contracts-only through `buildHonoRoute`.
- **Table-driving the harness CLI event handlers.** The claude and codex `onEvent` bodies
  differ because the streams differ; the shared parts are already extracted. Only the
  isolated-home envelope is duplicated (noted under #14 as a cautious follow-on).
- **Merging the three preset-health modals into one component.** The pipeline modal has
  genuinely more categories; share the shell only (#18).
- **`validateRegistrations` as a registry, `singleServiceModule` in `modules.ts`,
  `pipelineStepSchema` extraction.** Each trades greppability or review-noise for little
  (#26, #20).
