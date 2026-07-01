# Initiative: mothership mode for local mode

**Status:** in progress (board-load + run functional over the RPC; later slices widen the surface) · **Owner:** core · **Started:** 2026-06-30

> This is the durable source of truth for a multi-PR initiative. Read it FIRST before picking
> up the next slice; update the checklist at the end of each PR.

> ## ✅ MERGE GATE — MET (the functional repository surface has landed)
>
> The [Phase 3 — Functional repository surface](#phase-3--functional-repository-surface-the-merge-gate)
> merge gate is **satisfied**. A no-Postgres mothership-mode `buildLocalContainer` **loads a board**
> and **drives a run to a persisted terminal state** over the real `/internal/persistence` RPC —
> asserted end-to-end by `backend/runtimes/local/test/mothership-integration.spec.ts` (a real
> loopback Node mothership over Postgres + a no-Postgres local node) and by the cross-runtime
> `[mothership]` conformance config. The board-load + run paths are allow-listed
> (`REMOTE_PERSISTENCE_METHODS`) and every direct-db store on those paths is routed through the
> `pickRepoSource` seam, so the earlier "first board load 500s" failure no longer applies.
>
> **Residuals that are explicitly NOT gating** (a maintainer decides if/when to lift any draft
> status in light of them): decrypting a remotely-sealed PROVISIONED environment's access cipher
> (needs the mothership's key — the secrets-delegation slice); the best-effort kaizen / telemetry /
> subscription-activation no-ops a run makes over the remote (telemetry is local-first, Phase 5;
> activation is the local-sqlite bucket); the `fragments` / `slack` connect/provision surfaces;
> the durable SQLite work queue (PR 2 — the in-process runner is single-process / best-effort); and
> login-based machine-token minting (PR 3 — a static `LOCAL_MOTHERSHIP_TOKEN` is used until then).
> The remaining `pending` org methods are the live per-repo checklist below.

### Landed so far

- **PR 2 (durable SQLite work queue)** — the best-effort in-memory `InProcessWorkRunner` (PR 1) is
  replaced by the durable `SqliteWorkRunner`, backed by a file-based `node:sqlite` work queue
  (`runtimes/local/src/sqlite/workQueue.ts`, default `~/.cat-factory/work-queue.sqlite`, override
  `LOCAL_MOTHERSHIP_WORK_DB`). The queue persists the intent "this run needs driving", so a crash or
  restart re-drives what was in flight — the durability pg-boss gives the Node facade, now without
  Postgres. It mirrors pg-boss's `exclusive` advance queue: one row per run (PRIMARY KEY = the
  `singletonKey` dedup); a `startRun`/`signalDecision` (re)queues + kicks a drain loop that claims
  drivable runs up to `concurrency` and drives each via the SAME `driveExecution` advance/poll loop;
  a signal mid-drive coalesces via the row's `rerun` flag; a re-armed unbounded gate is deferred for
  the gate poll interval then re-polled; and crash recovery comes from a boot-time orphan reset
  (`active`→`queued`) plus a periodic recovery poll that reclaims lease-expired rows. Lease/sweeper/
  retry/concurrency knobs reuse the same `executionRuntime()` derivation the pg-boss queue+sweeper
  use. This is a **local-sqlite bucket** differentiator (no cross-runtime symmetry obligation). It is
  exercised by the merge-gate integration test (`mothership-integration.spec.ts` drives a run to a
  persisted terminal state through it) and unit-tested in `sqlite/workQueue.test.ts` (dedup, claim
  ordering, lease/orphan reclaim, rerun coalescing, defer, poison eviction) + `mothership.test.ts`
  (the runner's completion, coalescing, error-defer, and crash-recovery-on-bind paths).
- **Repository conformance (cross-runtime `[mothership]` config + static drift guard)** — the
  shared conformance suite now runs against a THIRD configuration: a no-Postgres mothership-mode
  node whose `CoreRepositories` are RPC-backed by a real in-process Node mothership
  (`backend/runtimes/local/test/mothership/harness.ts`). The **execution group** is green over the
  real `/internal/persistence` path, so an un-proxied / mis-scoped / non-serializing run-path
  repository method fails an EXISTING assertion (no test written twice). The run-path allow-list
  was widened to match (merge-preset `getDefault`, service `getByFrameBlock`, notification /
  requirement-review `get`, requirement-review `upsert`, kaizen `getByStep`/`upsert`, the kaizen
  LLM-metric summary, env-config-repair + kaizen-combo reads). A static guard
  (`backend/runtimes/node/test/mothership-allowlist.spec.ts`) reflects EVERY Drizzle repository
  method and fails unless each is allow-listed or explicitly classified
  (`pending`/`local`/`telemetry`/`admin`/`sweeper`/`onboarding`/`helper`) — so adding a repo/method
  without proxying it (or recording why not) goes red regardless of behavioural coverage. The
  `pending` reasons in that guard ARE the remaining Phase-3 surface-completion backlog. The
  `test-db` CI lane is sharded (vitest `--shard`) so the extra config doesn't grow wall-clock.
  Remaining: extend the `[mothership]` behavioural config to the core/agents/integration/misc
  groups (they need mode-skips for HTTP workspace/account creation + user-dependent onboarding
  flows), and proxy the `pending` methods slice by slice.
- **PR 0** — this tracker.
- **PR 1 (spine)** — the persistence-RPC core in `@cat-factory/server`: the `machine` token
  audience, the wire envelope + method allow-list + scope table + dispatcher
  (`src/persistence/rpc.ts`), the `Proxy`-backed `createRemoteRepositoryRegistry`
  (`src/persistence/remoteRepositories.ts`), the `POST /internal/persistence` controller, and
  a unit test covering the full round-trip (reads, undefined/null, rev write-back, DomainError
  re-throw, allow-list, cross-account scope). BOTH facades attach their repository registry
  (`ServerContainer.repositories`) so either can be a mothership, guarded by a cross-runtime
  conformance assertion.
- **PR 1 (remaining)** — the local-facade _consumer_ side: the `node:sqlite` credential store +
  local cipher, the `LOCAL_MOTHERSHIP_URL` switch composing remote + local repos in
  `buildLocalContainer`, the no-Postgres `startLocal` boot path with an in-process work runner,
  and the `config.mothership` SPA flag. The six pilot repos below are remotely _callable_ now;
  this slice makes a local node _consume_ them.
  - **Landed (1a):** the local `node:sqlite` credential store
    (`runtimes/local/src/sqlite/credentialStore.ts`) — `createLocalCredentialStore(path)` plus
    `SqliteProviderApiKeyRepository` + `SqliteLocalModelEndpointRepository`, the two
    `local-sqlite` bucket ports, mirroring the Drizzle/D1 repos column-for-column (usage-window
    rotation, atomic lease-least-used, createdAt-preserving endpoint upsert) and unit-tested
    against an in-memory db. It stores only the already-sealed cipher envelopes, so the local
    key wiring (the existing `ENCRYPTION_KEY`-keyed `WebCryptoSecretCipher`, which never carries
    the mothership's key) belongs to the composition step.
  - **Landed (1b):** the `LOCAL_MOTHERSHIP_URL` switch is live. `createRemoteRepositoryRegistry`
    (`@cat-factory/server`) is a drift-proof full-surface remote `CoreRepositories` (a `Proxy`
    lazily forwarding any repo to one RPC); `composeMothership` (`runtimes/local/src/mothership.ts`)
    pairs it with the local credential store, and `buildLocalContainer` threads both into
    `buildNodeContainer` with `db: undefined`, injecting the two credential repos. The
    **`db: undefined` audit was pulled forward** (it was nominally PR 3): `buildNodeContainer` now
    takes an optional `db`, the per-user Postgres services (subscriptions / user-secrets /
    OpenRouter catalog) turn off without one, the API-key pool + local-model endpoints accept an
    injected repository. NOTE: the Drizzle constructors only stash the handle (no build-time work),
    so BUILDING the container over `db: undefined` is safe — but CALLING the direct-db repos
    (notifications / bootstrap / projections / subscription-activation / …) on a board load or run
    still throws, because they are not yet routed to the remote surface. That, plus the narrow
    allow-list, is why mothership mode was NOT yet functional at 1b (see the merge gate + Phase 3).
    _(Superseded: Phase-3 slices 3–4 routed those direct-db stores via `pickRepoSource` and widened
    the allow-list, so the board-load + run paths now work — the gate is MET; see the banner.)_ The
    **no-Postgres `startLocal` boot** is a dedicated path (`startLocalMothership`) — no
    `DATABASE_URL`/`migrate`/pg-boss; it serves the same Hono app + WebSocket transport and drives
    runs with the new in-process `WorkRunner` (serialized per execution, the pg-boss analogue). The
    `config.localMode.mothership` flag is surfaced to the SPA. A static `LOCAL_MOTHERSHIP_TOKEN` is
    used for now (login minting is PR 3). Tests: the remote-registry round-trip + allow-list
    (`packages/server/test/persistenceRpc.spec.ts`), and `composeMothership` / `InProcessWorkRunner`
    / the no-Postgres `buildLocalContainer` build (`runtimes/local/src/mothership.test.ts`).
  - **Review fixes folded into 1b (PR #514):** the credential SQLite handle is now released on
    shutdown via a new `ServerContainer.onShutdown` seam (the boot path calls it); the runner-pool
    connection repo resolves remotely in mothership mode (a clean gated `unknown_method`, not an
    undefined-db `TypeError`); the superseded `createRemoteRepositories` (pilot-6 typed set) was
    removed in favour of the single `createRemoteRepositoryRegistry` (the round-trip test now runs
    against the registry production uses); `makeRepoProxy` guards `then`/symbol probes so an
    accidental `await` of a repo proxy can't forward a bogus RPC; the in-process runner no longer
    double-arms a re-drive when a gate re-arm and a signal coincide; the boot serve/realtime tail is
    a shared `serveAppWithRealtime` helper (no drift with `start()`); and the overstated
    "loads a board / persists executions" claims were corrected to match the gated reality.
  - **Deferred from 1b (carried forward):** the full cross-runtime `defineConformanceSuite`
    binding for the local-sqlite store still wants a **fake mothership server** so the suite can
    build a real mothership-mode `buildLocalContainer` over a working RPC backend — folded into
    Phase 2 alongside the durable SQLite work queue (the in-process runner is single-process /
    best-effort, with no durable queue or stale-run sweeper yet). The credential store keeps its
    isolated unit test (`sqlite/credentialStore.test.ts`) and is now proven _wired into the
    container_ by the no-Postgres build test. At 1b the allow-list exposed only the six core
    domain repos remotely — the spine, NOT a working board/run; making it actually functional was
    [Phase 3](#phase-3--functional-repository-surface-the-merge-gate), the merge gate, now **MET**.

## Goal & rationale

Local mode (`backend/runtimes/local`, `@cat-factory/local-server`) today runs the **whole**
product on a developer's machine: the Node facade's Drizzle/**Postgres** persistence + pg-boss,
with only the runner transport (per-run local containers) and GitHub-via-PAT swapped in. A
developer's work is therefore **siloed in their local Postgres** — no collaboration on shared org
projects, and durability hangs on a database on the laptop.

**Mothership mode** keeps local mode's fast differentiators (local container agent provisioning,
local service execution, the SPA served from localhost) but **delegates all org/durable state to a
hosted "mothership" cat-factory** (Node _or_ Cloudflare) over an authenticated machine-to-machine
API. The local node stops running a main database; org data lives on the mothership, so a developer
running locally participates in the same shared org projects as hosted teammates, with the
mothership providing durability, email sending, and notification delivery.

### Confirmed product decisions

1. **Mothership target: both Node + Cloudflare.** The new `/internal/*` machine API is served from
   the shared `@cat-factory/server`, so both facades work as a mothership (symmetry + conformance).
2. **No PostgreSQL at all in mothership mode.** `DATABASE_URL`, `migrate()`, and pg-boss are not
   used or expected. The only local database is a file-based **`node:sqlite`** store.
3. **Secrets split.** Agent/model credentials are stored **locally** in the `node:sqlite` store,
   encrypted with a **local** key — the mothership's `ENCRYPTION_KEY` never reaches the laptop.
   Everything else goes through the mothership. The UI labels what is stored locally.
4. **Seamless login-based onboarding.** The machine token is minted by the mothership after a
   GitHub/GitLab OAuth login, gated by whitelisting (allowed account, org membership, or email
   domain) + automated onboarding; the token is cached in the local SQLite. No manual paste.
5. **Telemetry/logs are local-first.** High-volume observability is written local, batch-ingested
   to the mothership only for finished runs, then pruned locally on a short TTL; rendering reads
   local-first and falls back to the mothership only when pruned.

## Target pattern (the reference implementation)

The **generic persistence-RPC** spine is the template every later slice follows:

1. **Shared controller** `registerPersistenceController(app)` in `@cat-factory/server`
   (`src/modules/persistence/`), mounted by **both** facades, machine-authed:
   `POST /internal/persistence` body `{ repo, method, args }` → `{ result }`. Reflects over the
   real repository registry on the mothership. Per call it enforces: (a) `machine` token-audience
   pin (`auth/signing.ts`), (b) **scope binding** — extract the workspace/account arg, resolve its
   owning account via `workspaceService.accountOf` exactly like `http/authGate.ts`, reject **404**
   if outside the token scope, (c) a **per-repo method allow-list** (global/sweeper methods
   `deleteOlderThan` / `listStale` / bare `delete` are excluded — they stay mothership-internal).
   The allow-list also excludes **admin-gated mutations** (`accountRepository.rename`/
   `updateSettings`, `membershipRepository.upsert`/`remove`): the machine token scopes whole
   accounts, not a role within them, and the RPC bypasses the service-layer `requireAdmin` check,
   so exposing those raw repo writes would let any in-scope member self-promote to admin. They
   come back only once a later slice adds a role dimension to the scope (or routes them through
   the service). The pilot exposes the account/membership **reads** a board load needs.
2. **Local client** `createRemoteRepositories(rpcClient): CoreRepositories` (`src/persistence/`):
   each entry is a `Proxy` forwarding `(repo, method, args)` to one RPC, decoded with the existing
   shared mappers (`src/persistence/mappers.ts`, `decode.ts`).
3. **Composite repositories in the local facade**: `buildLocalContainer` composes
   `createRemoteRepositories` (org repos) + the local `node:sqlite` repos (credentials/settings) +
   the telemetry composite into ONE `CoreRepositories`, passed to `buildNodeContainer` with
   `db: undefined`.
4. **Conformance**: a round-trip suite asserts the remote-backed `CoreRepositories` behaves
   identically to the direct Drizzle/D1 repo on BOTH runtimes — including the `undefined`/`null`/
   `rev` edges and scope/allow-list rejection.

### Serialization gotchas the pilot must nail (carried to every slice)

- **`undefined` vs `null` must round-trip.** Several signatures branch on all three (e.g.
  `WorkspaceRepository.accountOf` → `string | null | undefined`, used by `authGate.ts`). JSON drops
  `undefined`; use a **tagged RPC envelope**, not bare JSON.
- **`rev` write-back.** `compareAndSwap`/`upsert` mutate `execution.rev` **in place** on the
  caller's object. The RPC must **return the new rev** and the Proxy must write it back onto the
  passed-in instance before resolving — the optimistic-concurrency contract the engine relies on.
- **`DomainError` re-throw.** `ConflictError`/`assertFound` etc. must be re-thrown client-side from
  an error code in the envelope, so CAS-retry / 404 control flow is preserved.
- **`Clock` / `IdGenerator` stay local** — never serialized.

## Per-repository bucket checklist

Every persistence port, and where it lives in mothership mode. `remote` = mothership RPC;
`local-sqlite` = local `node:sqlite` store; `telemetry` = local-first + batched up; `excluded` =
never remotely invocable (mothership-internal cron).

| Port                                                        | Bucket                                           | Status  | PR                              |
| ----------------------------------------------------------- | ------------------------------------------------ | ------- | ------------------------------- |
| `workspaceRepository`                                       | remote                                           | ✅ done | PR 1                            |
| `blockRepository`                                           | remote                                           | ✅ done | PR 1                            |
| `executionRepository` (CAS/rev)                             | remote                                           | ✅ done | PR 1                            |
| `accountRepository`                                         | remote                                           | ✅ done | PR 1                            |
| `membershipRepository`                                      | remote                                           | ✅ done | PR 1                            |
| `pipelineRepository`                                        | remote                                           | ✅ done | PR 1                            |
| `userRepository`                                            | remote                                           | ⬜ todo | PR 3                            |
| `invitationRepository`                                      | remote                                           | ⬜ todo | PR 3                            |
| `passwordResetTokenRepository`                              | remote                                           | ⬜ todo | PR 3                            |
| `emailConnectionRepository`                                 | remote (delivery delegated)                      | ⬜ todo | PR 4                            |
| `agentRunRepository`                                        | remote                                           | ⬜ todo | PR 3                            |
| `modelPresetRepository`                                     | remote                                           | ⬜ todo | PR 3                            |
| `serviceFragmentDefaultsRepository`                         | remote                                           | ⬜ todo | PR 3                            |
| `pipelineScheduleRepository`                                | remote                                           | ⬜ todo | PR 3                            |
| `trackerSettingsRepository`                                 | remote                                           | ⬜ todo | PR 3                            |
| `serviceRepository`                                         | remote                                           | ⬜ todo | PR 3                            |
| `workspaceMountRepository`                                  | remote                                           | ⬜ todo | PR 3                            |
| `requirementReviewRepository`                               | remote                                           | ⬜ todo | PR 3                            |
| `kaizenGradingRepository`                                   | remote                                           | ⬜ todo | PR 3                            |
| `kaizenVerifiedComboRepository`                             | remote                                           | ⬜ todo | PR 3                            |
| `consensusSessionRepository`                                | remote                                           | ⬜ todo | PR 3                            |
| `clarityReviewRepository`                                   | remote                                           | ⬜ todo | PR 3                            |
| `brainstormSessionRepository`                               | remote                                           | ⬜ todo | PR 3                            |
| `mergePresetRepository`                                     | remote                                           | ⬜ todo | PR 3                            |
| `workspaceSettingsRepository`                               | remote                                           | ⬜ todo | PR 3                            |
| `observabilityConnectionRepository`                         | remote                                           | ⬜ todo | PR 3                            |
| `incidentEnrichmentConnectionRepository`                    | remote                                           | ⬜ todo | PR 3                            |
| `accountSettingsRepository`                                 | remote                                           | ⬜ todo | PR 3                            |
| `releaseHealthConfigRepository`                             | remote                                           | ⬜ todo | PR 3                            |
| `binaryArtifactMetadataStore` (metadata)                    | remote; blobs → shared backend (S3 / mothership) | ⬜ todo | PR 3                            |
| `githubInstallationRepository`                              | remote                                           | ⬜ todo | PR 3                            |
| `runnerPoolConnectionRepository`                            | remote                                           | ⬜ todo | PR 3                            |
| GitHub projection repos (repo/branch/PR/issue/commit/check) | remote                                           | ⬜ todo | PR 3                            |
| `providerApiKeyRepository`                                  | local-sqlite                                     | ✅ done | PR 1 (store)                    |
| `localModelEndpointRepository`                              | local-sqlite                                     | ✅ done | PR 1 (store)                    |
| `providerSubscriptionTokenRepository`                       | local-sqlite                                     | ⬜ todo | PR 3                            |
| `personalSubscriptionRepository`                            | local-sqlite                                     | ⬜ todo | PR 3                            |
| `subscriptionActivationRepository`                          | local-sqlite                                     | ⬜ todo | PR 3                            |
| `localSettingsRepository`                                   | local-sqlite                                     | ⬜ todo | PR 3                            |
| durable execution work queue                                | local-sqlite (replaces pg-boss)                  | ✅ done | PR 1 (in-proc) → PR 2 (durable) |
| cached mothership machine token                             | local-sqlite                                     | ⬜ todo | PR 3                            |
| `llmCallMetricRepository`                                   | telemetry                                        | ⬜ todo | PR 5                            |
| `agentContextSnapshotRepository`                            | telemetry                                        | ⬜ todo | PR 5                            |
| `tokenUsageRepository`                                      | telemetry                                        | ⬜ todo | PR 5                            |
| `provisioningLogRepository`                                 | telemetry                                        | ⬜ todo | PR 5                            |

## Cross-cutting delegation (not per-call repo proxies)

- **Real-time both directions.** `RpcEventPublisher` (`@cat-factory/server`) POSTs each engine event
  to `POST /internal/events/publish` so hosted teammates see the local node's activity; an
  `UpstreamEventSubscriber` opens `GET /internal/events/subscribe?scope=…` and re-publishes into the
  local `NodeRealtimeHub` so the local SPA sees org activity. SPA wire protocol unchanged.
- **Notifications.** Row persists via the remote `notificationRepository`; in-app delivery rides the
  event fan-out; **Slack** stays mothership-side via a `RemoteNotificationChannel` →
  `POST /internal/notifications/deliver`.
- **Email.** `RemoteEmailSender` → `POST /internal/email/send`; the mothership decrypts the account
  key and sends. Email/Slack keys never reach the laptop.
- **Telemetry ingest.** Bulk `POST /internal/telemetry/ingest` (append-only, excluded from the
  generic allow-list); finished-runs batch sweeper + short local-TTL pruner + read-through.

## Phased delivery

- **PR 0 — this tracker doc.** No code.
- **PR 1 — vertical slice (the SPINE).** `machine` audience; `registerPersistenceController`
  (scope + allow-list); `PersistenceRpcClient` + `createRemoteRepositoryRegistry` (the full-surface
  remote registry); local `node:sqlite` store + local cipher with `providerApiKey` +
  `localModelEndpoint`; `LOCAL_MOTHERSHIP_URL` switch + no-Postgres `startLocal` boot with an
  **in-process** work runner; static `LOCAL_MOTHERSHIP_TOKEN` for now; `config.mothership` flag to
  the SPA. Conformance: rev/undefined/scope round-trip (server spine) + the no-Postgres composition
  build. The board-load + run end-to-end surface that makes it functional landed under Phase 3 (the
  merge gate, now **MET** — see the banner at the top).
- **PR 2 — real-time both directions + durable SQLite work queue** (+ the deferred local-sqlite
  conformance binding via a fake mothership server). **Durable SQLite work queue: ✅ landed** (see
  "Landed so far"). Remaining in PR 2: real-time both directions (`RpcEventPublisher` +
  `UpstreamEventSubscriber`) and the local-sqlite conformance binding.

### Phase 3 — Functional repository surface (THE MERGE GATE)

This is the phase that makes mothership mode actually work, and the one PR #514 must wait for.
It also carries login-based machine-token minting and the formal `db: undefined` audit. It is
larger than one hop — split it across several PRs, but **none of the mothership boot ships until
the board-load + run paths below are green**. The work is in three parts:

> **Landed (Phase 3 slice 1):** part 2's workspace-scoped + mixed (workspaceId + entity-id) board-load
> reads are now allow-listed in `REMOTE_PERSISTENCE_METHODS`, each reusing the existing `workspace`
> scope rule (resolve the owning account, reject out-of-scope as 404). Reads only — no new mutation
> is exposed. Part 3 needed no registry change: the dispatcher already reflects over the full
> `CoreDependencies` object, so allow-listing a method is enough to expose it. Round-trip +
> cross-account-scope tests for every newly-listed method are in `packages/server/test/persistenceRpc.spec.ts`.
>
> **Landed (Phase 3 slice 2):** part 2's **cross-service** + **entity-id-keyed** board-composition
> reads are now allow-listed, via two NEW scope kinds that resolve the entity's owning account
> server-side before the check: `serviceList` (arg0 = `serviceIds[]`; resolve each service's
> account, EVERY id must be in scope, a missing/out-of-scope id fails closed, empty list is a no-op)
> and `block` (arg0 = blockId; resolve block → home workspace → account). Newly callable:
> `serviceRepository.listByIds`/`listByAccount` (the latter on the existing `account` rule, so the
> `null` unscoped listing is refused), `blockRepository.findById`/`listByServices`,
> `executionRepository.listByServices`, `bootstrapJobRepository.listByServices`,
> `pipelineScheduleRepository.listByServices`, `workspaceMountRepository.countByServiceIds`. The two
> resolvers are wired in `PersistenceController` (block → `blockRepository.findById` + `accountOf`;
> service → `serviceRepository.listByIds`) and the dispatcher fails closed if a kind's resolver is
> absent. Round-trip + cross-account-scope + unknown-id + empty-list tests are in `persistenceRpc.spec.ts`.
> Note: `subscriptionActivationRepository.deleteByExecution` is NOT exposed remotely — per the
> per-repo bucket checklist it is the **local-sqlite** bucket (the token is re-sealed with the system
> key for the run; how that key is available in mothership mode is an open design question for the
> credential/activation slice), so it stays off the remote allow-list.
>
> **Landed (Phase 3 slice 3):** part 1's `db: undefined` audit for the board-load + run path. The
> org/durable stores `buildNodeContainer` constructed directly from `options.db` now route through a
> single `pickRepoSource(remoteRepos, name, build)` seam (exported from `runtimes/node/src/container.ts`):
> when `db` is undefined, `options.repos` is the full-surface remote `Proxy` (`composeMothership`) and
> the repo comes from THERE; else the Drizzle repo is built over `db` as before. Routed:
> `githubInstallationRepository`, `repoProjectionRepository` + the five GitHub projections
> (branch/PR/issue/commit/check), `runnerPoolConnectionRepository`, `bootstrapJobRepository`,
> `referenceArchitectureRepository`, `envConfigRepairJobRepository`, `notificationRepository`,
> `taskRepository` (issue writeback), and `subscriptionActivationRepository`; the separate
> `DrizzleServiceFrameRepository` construction is gone — `buildResolveRepoTarget` now reuses
> `repos.serviceRepository` (remote in mothership mode, Drizzle otherwise). Routing is orthogonal to
> the allow-list: an un-allow-listed remote method returns a clean `unknown_method`, never a
> `db`-undefined `TypeError`. Tests: `pickRepoSource` routing in `runtimes/node/test/mothership-repo-source.spec.ts`
>
> - the existing no-Postgres build test (which now exercises the remote-sourced repos and still makes
>   no build-time network call).
>
> **Landed (Phase 3 slice 4):** the **fake-mothership functional integration test** — the gate's exit
> criteria — and the agent-context run-path repo surface it surfaced.
> `runtimes/local/test/mothership-integration.spec.ts` boots a stock Node mothership
> (`buildNodeContainer` over real Postgres) on a 127.0.0.1 loopback and a no-Postgres mothership-mode
> `buildLocalContainer` whose `CoreRepositories` are the RPC-backed remote registry pointing at it,
> then asserts a board **loads** over the remote RPC and a run **drives to a persisted terminal state**
> (`done`) over it — the execution read back straight from the mothership's Postgres. It corrected a
> wrong assumption from slice 3: `AgentContextBuilder` resolves a block's linked docs/tasks AND its
> provisioned environment on EVERY agent dispatch, so those feature-flagged sub-helper repos ARE on the
> board-load + run path, not off it. Fixes: `buildNodeContainer` now routes `documentRepository` /
> `taskRepository` / `environmentRegistryRepository` / `environmentConnectionRepository` from the remote
> registry when `db` is undefined (the sub-helpers built them directly over the absent `db`; their
> connect/provision surfaces stay db-direct, off the path); and `REMOTE_PERSISTENCE_METHODS` gained the
> workspace-scoped methods the path exercises — `documentRepository.{listByBlock,get,getByUrl}`,
> `taskRepository.{listByBlock,get,getByUrl}`, `environmentRegistryRepository.{getByBlock,get}`,
> `modelPresetRepository.getDefault`, the board-load lazy default-preset seeds
> `mergePresetRepository.upsert` / `modelPresetRepository.upsert`, and the completion notification raise
>
> - inbox transitions `notificationRepository.{findOpenByBlock,upsertOpenForBlock,upsert}` (round-trip +
>   cross-account-scope unit tests for each in `persistenceRpc.spec.ts`). The `*.getByUrl` reads back a
>   URL named in a block's description and `notificationRepository.upsert` backs block-less raises + the
>   inbox act/dismiss/escalate transitions — both on the same run/post-run path as the methods beside
>   them, so the integration test now patches the run's task with a URL + Jira/GitHub refs and enables
>   the environment integration on the local node, so `*.get`/`getByUrl` and
>   `environmentRegistryRepository.getByBlock` are exercised over the RPC end-to-end (not unit-only).
>
> **Residual after slice 4** (none on the basic board-load + run path): decrypting a remotely-sealed
> PROVISIONED environment's access cipher needs the mothership's key (only the non-secret block→env
> mapping read is on the path here; full decryption is the later secrets-delegation slice); the
> kaizen-grading, LLM-metric and subscription-activation calls a run also makes currently degrade as
> best-effort no-ops over the remote (telemetry is Phase 5 local-first; activation is the local-sqlite
> bucket); and the `fragments` / `slack` connect/provision surfaces are follow-ups.

1. ✅ **Route every direct-db store through the remote surface when `db` is undefined — DONE
   (slice 3) for the board-load + run path.** The stores `buildNodeContainer` constructed directly
   from `options.db` now route through the `pickRepoSource(remoteRepos, name, build)` seam (sourced
   from the remote registry when `db` is undefined, else the Drizzle repo): `notificationRepository`,
   `bootstrapJobRepository`, `envConfigRepairJobRepository`, `subscriptionActivationRepository`,
   `runnerPoolConnectionRepository`, `githubInstallationRepository`, the GitHub projection repos
   (repo/branch/PR/issue/commit/check), `taskRepository`, `referenceArchitectureRepository`; the
   separate `DrizzleServiceFrameRepository` is gone (`buildResolveRepoTarget` reuses
   `repos.serviceRepository`). **Slice 4 then routed the feature-flagged sub-helper repos that turned
   out to be ON the run path** — `documentRepository` / `taskRepository` / `environmentRegistryRepository`
   / `environmentConnectionRepository` (the `AgentContextBuilder` per-step reads). STILL TODO: the
   remaining sub-helper surfaces that are genuinely off the basic board-load + run path —
   `fragments` / `slack` connect/provision — a follow-up sub-slice. (Telemetry repos —
   `tokenUsage`/`llmCallMetric`/`agentContextSnapshot`/`provisioningLog` — are the local-first
   telemetry bucket, Phase 5, NOT remote; they degrade as best-effort no-ops over the remote for now.)

2. **Widen the server allow-list (`REMOTE_PERSISTENCE_METHODS`) to the methods a board load + a run
   exercise, each with a correct scope rule.** The boundary is security-sensitive: a machine token
   is scoped to ACCOUNTS, not roles, so admin-gated mutations and global sweeper reads stay excluded.
   The concrete map (from a call-graph trace of `GET /workspaces/:id` and the execution lifecycle):
   - ✅ **Workspace-scoped (arg0 = workspaceId; reuse the existing `workspace` rule) — DONE (slice 1):**
     `workspaceMountRepository.listByWorkspace`, `workspaceSettingsRepository.get`,
     `mergePresetRepository.list`, `modelPresetRepository.list`, `serviceFragmentDefaultsRepository.get`,
     `pipelineScheduleRepository.list`, `trackerSettingsRepository.get`, `notificationRepository.listOpen`,
     `bootstrapJobRepository.listByWorkspace`, `tokenUsageRepository.totalsSinceForWorkspace`,
     plus the run-path writes `blockRepository.update`, `executionRepository.upsert/getByBlock/deleteByBlock`
     (the latter were already in the pilot set).
   - ✅ **Mixed (workspaceId + entity id) — keep the workspace arg as the scope key — DONE (slice 1):**
     `requirementReviewRepository.getByBlock`, `clarityReviewRepository.getByBlock`,
     `brainstormSessionRepository.getByBlockStage` (+ `pipelineScheduleRepository.getByBlock`).
   - ✅ **Entity-id-keyed (NO workspaceId arg) — NEW `block` scope kind resolves the entity's
     workspace/account server-side before the check — DONE (slice 2) for `blockRepository.findById`.**
     `subscriptionActivationRepository.deleteByExecution(executionId)` is NOT done: it is the
     **local-sqlite** bucket (see the per-repo checklist), so it is off the remote surface, not a
     remote allow-list entry.
   - ✅ **Cross-service reads (arg0 = serviceIds[] / accountId) — NEW `serviceList` scope kind
     resolves each service's owning account; `listByAccount` reuses the `account` rule — DONE
     (slice 2):** `serviceRepository.listByIds`, `serviceRepository.listByAccount`,
     `blockRepository.listByServices`, `executionRepository.listByServices`,
     `bootstrapJobRepository.listByServices`, `pipelineScheduleRepository.listByServices`,
     `workspaceMountRepository.countByServiceIds`.

3. ✅ **Expose those repos in the mothership-side `PersistenceRegistry`** (the dispatcher reflects
   over it) and add round-trip + cross-account-scope tests for every newly-allow-listed method, plus
   an integration test that actually serves `GET /workspaces/:id` and drives a run in mothership mode
   over a fake mothership — **DONE (slice 4).** `runtimes/local/test/mothership-integration.spec.ts`
   serves both sides for real (a loopback Node mothership over Postgres + a no-Postgres local node)
   and asserts the board-load + run-to-terminal. Standing it up also forced the agent-context run-path
   repos (`documentRepository` / `taskRepository` / `environmentRegistryRepository`) to route remotely
   - their workspace-scoped reads + the lazy-seed / notification writes onto the allow-list (see the
     slice-4 note above; unit round-trip + scope tests in `persistenceRpc.spec.ts`).

Exit criteria for the gate: a mothership-mode `buildLocalContainer` loads a board and drives a run
to a persisted terminal state against a real RPC backend, asserted by that integration test. ✅ **MET
(slice 4)** — `mothership-integration.spec.ts` is green. The residual items listed in the slice-4 note
(provisioned-env secret decryption; the best-effort kaizen/telemetry/activation no-ops; `fragments` /
`slack` connect surfaces) are NOT on the basic board-load + run path; a maintainer decides whether to
lift the ⛔ gate / mark PR #514 ready in light of them.

- **PR 4 — notifications + email + Slack delegation.**
- **PR 5 — telemetry/logs local-first sync.**
- **PR 6 — UI labeling + hardening** (whitelisting admin, token rotation, rate-limiting, security
  review).

Each PR adds a changeset and updates this checklist.

## Conventions / gotchas carried between iterations

- **Keep the runtimes symmetric.** The `/internal/*` endpoints and their conformance assertions land
  on **both** Node + Cloudflare in the SAME change. The local `node:sqlite` store is a
  local-facade-only differentiator (like the container transport) and carries **no** symmetry
  obligation — only the mothership-served endpoints do.
- **The mothership `ENCRYPTION_KEY` must never reach the laptop.** Local secrets use a separate local
  key (the one `applyLocalDefaults` already guarantees). A security check asserts this.
- **Raw-repo RPC is powerful — default-deny.** Method allow-list per repo; global/sweeper methods
  AND admin-gated mutations excluded (the RPC bypasses the service-layer `requireAdmin`, and the
  token scopes accounts not roles); every call account-scoped to the token; the scope switch
  fails closed on any unknown rule kind; the table is looked up by own-property only so an
  attacker-supplied `__proto__`/`constructor` can't reach a non-spec member. Treat the
  `/internal/persistence` surface as the highest-risk new code.
- **`db: undefined` audit.** `buildNodeContainer` constructs many repos directly from `options.db`
  (projections, blob backends, notifications, bootstrap, subscription-activation, …) rather than from
  `options.repos`. PR 1 made `db` optional and turned the per-user Postgres services off without one,
  but the direct-db repos still throw when CALLED on a board load / run — each must route through the
  composed remote repos in mothership mode. This is the single largest correctness risk and is the
  core of the [Phase 3 merge gate](#phase-3--functional-repository-surface-the-merge-gate): the
  mothership boot does not ship until it is done.
- **Pre-1.0 = no back-compat.** No shims for the old siloed-Postgres local mode; mothership mode is a
  parallel boot path selected by `LOCAL_MOTHERSHIP_URL`.
