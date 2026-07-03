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
> `pickRepoSource` seam.
>
> **Residuals that are explicitly NOT gating** (a maintainer decides if/when to lift any draft
> status in light of them): decrypting a remotely-sealed PROVISIONED environment's access cipher
> (needs the mothership's key — the secrets-delegation slice); the best-effort kaizen / telemetry /
> subscription-activation no-ops a run makes over the remote (telemetry is local-first, Phase 5;
> activation is the local-sqlite bucket); and the `fragments` / `slack` connect/provision surfaces.
> The remaining `pending` org methods are the live per-repo checklist below.

### Landed so far

> Concise ledger — one line per merged slice. The full rationale for each lives in its PR
> description + git history; the live per-repo status is the [checklist table](#per-repository-bucket-checklist).
> Every slice is a server-only allow-list change (symmetric by construction — the dispatcher
> reflects over each facade's registry), with round-trip + cross-account-scope tests in
> `packages/server/test/persistenceRpc.spec.ts` and the static drift guard
> (`runtimes/node/test/mothership-allowlist.spec.ts`) moving the methods out of `pending`, unless
> noted otherwise.

**Spine & durability (PR 0–2)**

- **PR 0** — this tracker.
- **PR 1 (spine)** — the persistence-RPC core in `@cat-factory/server`: `machine` token audience,
  wire envelope + method allow-list + scope table + dispatcher (`src/persistence/rpc.ts`), the
  `Proxy`-backed `createRemoteRepositoryRegistry`, the `POST /internal/persistence` controller, and
  the full round-trip test (reads, undefined/null, rev write-back, DomainError re-throw, allow-list,
  scope). Both facades attach `ServerContainer.repositories`, so either can be a mothership (guarded
  by a conformance assertion).
- **PR 1 (consumer side)** — the local `node:sqlite` credential store (`providerApiKey` +
  `localModelEndpoint`, sealed-envelope only), the `LOCAL_MOTHERSHIP_URL` switch composing
  `composeMothership` (remote registry + local store) into `buildNodeContainer` with `db: undefined`,
  the no-Postgres `startLocalMothership` boot (no `DATABASE_URL`/`migrate`/pg-boss; same Hono app +
  WebSocket transport), and the `config.localMode.mothership` SPA flag. The `db: undefined` audit was
  pulled forward here (per-user Postgres services turn off without a `db`). Review fixes (PR #514):
  `ServerContainer.onShutdown` seam, remote runner-pool repo resolution, single
  `createRemoteRepositoryRegistry`, proxy `then`/symbol guards, shared `serveAppWithRealtime` helper.
- **PR 2 (durable SQLite work queue)** — `SqliteWorkRunner` replaces the in-memory `InProcessWorkRunner`,
  backed by a file-based `node:sqlite` queue (`~/.cat-factory/work-queue.sqlite`, override
  `LOCAL_MOTHERSHIP_WORK_DB`): pg-boss's durability without Postgres (one row per run, rerun-coalescing,
  boot-time orphan reset + lease-expiry recovery poll). A **local-sqlite bucket** differentiator (no
  symmetry obligation). Tested in `sqlite/workQueue.test.ts` + `mothership.test.ts`.
- **Repository conformance** — the shared conformance suite runs a THIRD `[mothership]` config (a
  no-Postgres node whose `CoreRepositories` are RPC-backed by a real in-process Node mothership), so
  an un-proxied / mis-scoped / non-serializing run-path method fails an EXISTING assertion. The static
  drift guard reflects EVERY Drizzle method and fails unless it is allow-listed or classified
  (`pending`/`local`/`telemetry`/`admin`/`sweeper`/`onboarding`/`helper`); the `pending` reasons ARE
  the Phase-3 backlog. `test-db` CI lane sharded so the extra config doesn't grow wall-clock.

**Phase 3 — functional surface (the merge gate, MET)**

- **Slice 1–2 (board-load reads)** — workspace-scoped + mixed board-load reads (`workspace` rule),
  plus cross-service / entity-id-keyed board-composition reads via two new scope kinds: `serviceList`
  (arg0 = `serviceIds[]`, every id must resolve in-scope) and `block` (arg0 = blockId → workspace →
  account). Reads only.
- **Slice 3 (`db: undefined` routing)** — the org/durable stores `buildNodeContainer` built directly
  from `options.db` now route through the `pickRepoSource(remoteRepos, name, build)` seam (remote
  registry when `db` is undefined, else Drizzle): projections, installation, runner-pool, bootstrap,
  reference-architecture, env-config-repair, notifications, task, subscription-activation; the separate
  `DrizzleServiceFrameRepository` is gone. Routing is orthogonal to the allow-list (an un-listed method
  returns a clean `unknown_method`, never a `TypeError`).
- **Slice 4 (functional integration test — gate exit criteria)** —
  `mothership-integration.spec.ts` boots a real loopback Node mothership + a no-Postgres local node and
  asserts a board loads and a run drives to a persisted terminal state over the RPC. Surfaced that
  `AgentContextBuilder` reads a block's docs/tasks + provisioned env on every dispatch, so those
  sub-helper repos (`document`/`task`/`environmentRegistry`/`environmentConnection`) were routed
  remotely and their workspace-scoped reads + lazy-seed / notification writes allow-listed.

**Phase 3 follow-ups (surface-completion slices — each widens `REMOTE_PERSISTENCE_METHODS`)**

- **Settings / preset / schedule writes** — the settings panels can now PERSIST, not just display:
  `workspaceSettings.upsert`, `trackerSettings.put`, `serviceFragmentDefaults.set`, both preset
  libraries' `get`/`remove`, and the recurring-schedule mgmt surface
  (`pipelineSchedule.get`/`upsert`/`remove`/`insertRun`/`updateRun`/`listRuns`). Sweeper-only
  `listDue`/`pruneRunsBefore` + `listByService` stay off.
- **Failed-run retry / stop control** — `agentRunRepository.getRef` (resolves a run's kind before
  dispatch) completes the EXECUTION-run retry/stop path. **Wiring fix (both facades):** `agentRunRepository`
  lives outside `CoreDependencies`, so `buildNodeContainer` + the Cloudflare `buildContainer` now fold
  it into the reflected registry explicitly. Sweeper-only `listStale`/`liveRunIds` stay off.
- **Post-release-health / observability settings writes** — `observabilityConnection`,
  `releaseHealthConfig`, `incidentEnrichmentConnection` repos (reads/deletes via `workspace`, the
  record-based `upsert` via a new `workspaceField` rule binding `record.workspaceId`). Connection `get`
  returns the sealed `credentials` blob (the `environmentRegistry.get` precedent). Gate-probe decryption
  stays off (secrets-delegation slice); `accountSettingsRepository` is a separate decision.
- **Advanced review / structured-dialogue sessions** — clarity-review, brainstorm and consensus
  session repos gain write/delete (mirroring the requirements-review surface):
  `clarityReview`/`brainstormSession`/`consensusSession` `get`/`upsert`/`delete*`, plus
  `requirementReview.deleteByBlock`.
- **Shared-service mount management** — `serviceRepository.get` (new `service` scope kind — single
  serviceId → owning account, routed through the request's `listByIds` memo) + `workspaceMountRepository`
  `get`/`update`/`remove` + record-based `upsert` (new `serviceMount` scope kind). Cross-org sharing is
  enforced AT THE RPC LAYER: `serviceMount` binds the mount's `workspaceId` field AND requires the
  mounted `serviceId` to be owned by the same account (defeats a multi-account token planting a
  cross-org mount). Fan-out / batch-cleanup reads stay off. **Known gap:** mount/unmount does not
  live-update OTHER boards mounting the same service (needs the fan-out reads — a later slice).
- **Bootstrap / reference-architecture / env-config-repair management** — the full run-mgmt surface
  (start / poll a single job / retry / stop): `bootstrapJob` `get`/`update`/`insert`,
  the whole `referenceArchitecture` repo, `envConfigRepairJob` `get`/`update`/`insert` (record-based
  `insert`s via `workspaceField`). Completes the `AgentRunController` retry/stop surface for those kinds.
- **Kaizen grading reads** — the Kaizen SCREEN reads: `kaizenGrading.listByWorkspace`/`listByExecution`
  - `kaizenVerifiedCombo.listByWorkspace`. The combo `upsert` + background-sweep methods stay off
    (grading itself is best-effort until Phase 5).
- **VCS / GitHub projection reads** — the SPA's VCS board panels: `repoProjection.list`,
  `branchProjection.listByRepo`, `pullRequestProjection.listByWorkspace`,
  `issueProjection.listByWorkspace`, plus `githubInstallation.getByWorkspace` (also the run-path
  `resolveRepoTarget` read). Projection WRITE surface (`upsertMany`, `linkBlock`, sync cursors,
  `repoProjection.get`) stays off — the mothership owns GitHub sync; opening repo-writes without it
  would let create-branch/open-PR half-succeed. A later GitHub sync + repo-write slice.
- **Runner-backend connection + visual-gate artifacts + service board-composition read** — three
  more repository surfaces widened in one slice (each a server-only allow-list change, symmetric by
  construction): (1) the whole `runnerPoolConnectionRepository`
  (`getByWorkspace`/`softDelete` via `workspace`, record-based `upsert` via `workspaceField`) — the
  self-hosted runner-backend connection settings panel, its credentials a SEALED `secretsCipher`
  blob (the observability/environment-connection precedent); (2) the visual-confirmation gate's
  `binaryArtifactMetadataStore` metadata surface (`insert` via `workspaceField`;
  `get`/`listByExecution`/`countByExecution`/`listByBlock`/`delete` via `workspace`) — the blob
  BYTES stay per-account local, only the metadata is proxied, and the retention sweep
  (`listOlderThan`/`deleteOlderThan`) stays mothership-internal. This one is NOT a pure allow-list
  change: `binaryArtifactMetadataStore` isn't in `CoreDependencies` (it's composed into
  `resolveBinaryArtifactStore`), so it's folded into BOTH facades' reflected `repositories` registry
  explicitly. (3) `serviceRepository.listByFrameBlocks` (the batched board-composition /
  frame-deletion read) via a new use of the `blockList` scope — its first round-trip coverage. The
  remaining service CRUD + `getByRepo` stay the later GitHub-sync / board-write slice.
- **Ephemeral-environment connection management** — the environment provider-connection + per-type
  infra-handler settings panels + the custom-manifest-type catalog: the whole
  `environmentConnectionRepository` and `customManifestTypeRepository` (reads via `workspace`,
  record-based `upsert` via `workspaceField`). Safe because the connection carries handler secrets as a
  SEALED `secretsCipher` blob (sealed/decrypted in the service under the LOCAL key — no plaintext
  crosses the machine API); custom-manifest-type rows carry no secrets. Contrast the document/task
  connection repos, which decrypt INSIDE the repo — left off. Provisioning WRITES + access-cipher
  decryption stay off (secrets-delegation slice).

**Login (PR 3)**

- **Login-based machine-token minting** — the static `LOCAL_MOTHERSHIP_TOKEN` is replaced by a token
  minted from a whitelisted login and cached in local SQLite (env var now a headless/CI override).
  The mothership serves `POST /auth/machine-token` (session-authed, account scope from
  `accountService.listForUser`, a `requestedAccountIds` hint may only NARROW). The local facade adds a
  `node:sqlite` machine-token cache + a local-only `POST /local/mothership/connect` proxy: the SPA signs
  into the mothership (OAuth), hands the session to its own node, which mints + caches the opaque machine
  token and returns a local session. `composeMothership` resolves the token per-RPC (env → cached →
  none), so a token-less node boots INERT. `AUTH_MACHINE_TOKEN_TTL_MS` (default 30d); expired = re-login.
  **Deferred:** device-code / headless CLI login, token rotation/revocation (PR 6), silent refresh.

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
2. **Local client** `createRemoteRepositoryRegistry(rpcClient): CoreRepositories` (`src/persistence/`):
   a `Proxy` lazily forwarding `(repo, method, args)` to one RPC, decoded with the existing
   shared mappers (`src/persistence/mappers.ts`, `decode.ts`).
3. **Composite repositories in the local facade**: `composeMothership` / `buildLocalContainer`
   compose the remote registry (org repos) + the local `node:sqlite` repos (credentials/settings) +
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

| Port                                                        | Bucket                                                             | Status  | PR                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ------- | -------------------------------- |
| `workspaceRepository`                                       | remote                                                             | ✅ done | PR 1                             |
| `blockRepository`                                           | remote                                                             | ✅ done | PR 1                             |
| `executionRepository` (CAS/rev)                             | remote                                                             | ✅ done | PR 1                             |
| `accountRepository`                                         | remote                                                             | ✅ done | PR 1                             |
| `membershipRepository`                                      | remote                                                             | ✅ done | PR 1                             |
| `pipelineRepository`                                        | remote                                                             | ✅ done | PR 1                             |
| `userRepository`                                            | remote                                                             | ⬜ todo | PR 3                             |
| `invitationRepository`                                      | remote                                                             | ⬜ todo | PR 3                             |
| `passwordResetTokenRepository`                              | remote                                                             | ⬜ todo | PR 3                             |
| `emailConnectionRepository`                                 | remote (delivery delegated)                                        | ⬜ todo | PR 4                             |
| `agentRunRepository`                                        | remote (`getRef`; sweeper reads internal)                          | ✅ done | PR 3 (retry/stop surface)        |
| `modelPresetRepository`                                     | remote                                                             | ✅ done | PR 3 (settings writes)           |
| `serviceFragmentDefaultsRepository`                         | remote                                                             | ✅ done | PR 3 (settings writes)           |
| `pipelineScheduleRepository`                                | remote (mgmt; `listByService` pending)                             | ◑ part  | PR 3 (settings writes)           |
| `trackerSettingsRepository`                                 | remote                                                             | ✅ done | PR 3 (settings writes)           |
| `serviceRepository`                                         | remote (mount + board-composition reads; CRUD/`getByRepo` pending) | ◑ part  | PR 3 (board-composition read)    |
| `workspaceMountRepository`                                  | remote (mount mgmt; fan-out/batch pending)                         | ◑ part  | PR 3 (mount management)          |
| `requirementReviewRepository`                               | remote                                                             | ✅ done | PR 3 (advanced-review surface)   |
| `kaizenGradingRepository`                                   | remote (run-path + screen reads; `get`/sweep off)                  | ◑ part  | PR 3 (kaizen read surface)       |
| `kaizenVerifiedComboRepository`                             | remote (`getByKey`/`listByWorkspace`; `upsert` off)                | ◑ part  | PR 3 (kaizen read surface)       |
| `consensusSessionRepository`                                | remote                                                             | ✅ done | PR 3 (advanced-review surface)   |
| `clarityReviewRepository`                                   | remote                                                             | ✅ done | PR 3 (advanced-review surface)   |
| `brainstormSessionRepository`                               | remote                                                             | ✅ done | PR 3 (advanced-review surface)   |
| `mergePresetRepository`                                     | remote                                                             | ✅ done | PR 3 (settings writes)           |
| `workspaceSettingsRepository`                               | remote                                                             | ✅ done | PR 3 (settings writes)           |
| `observabilityConnectionRepository`                         | remote                                                             | ✅ done | PR 3 (release-health settings)   |
| `incidentEnrichmentConnectionRepository`                    | remote                                                             | ✅ done | PR 3 (release-health settings)   |
| `accountSettingsRepository`                                 | remote                                                             | ⬜ todo | PR 3                             |
| `releaseHealthConfigRepository`                             | remote                                                             | ✅ done | PR 3 (release-health settings)   |
| `environmentConnectionRepository`                           | remote                                                             | ✅ done | PR 3 (env connection surface)    |
| `customManifestTypeRepository`                              | remote                                                             | ✅ done | PR 3 (env connection surface)    |
| `environmentRegistryRepository`                             | remote (reads; provision writes/decrypt pending)                   | ◑ part  | PR 3 (secrets-delegation later)  |
| `binaryArtifactMetadataStore` (metadata)                    | remote; blobs → shared backend (S3 / mothership)                   | ✅ done | PR 3 (visual-gate metadata)      |
| `githubInstallationRepository`                              | remote (`getByWorkspace` run-path read; rest pending)              | ◑ part  | PR 3 (VCS projection reads)      |
| `runnerPoolConnectionRepository`                            | remote                                                             | ✅ done | PR 3 (runner-backend connection) |
| GitHub projection repos (repo/branch/PR/issue/commit/check) | remote (board-panel reads; sync/repo-writes pending)               | ◑ part  | PR 3 (VCS projection reads)      |
| `providerApiKeyRepository`                                  | local-sqlite                                                       | ✅ done | PR 1 (store)                     |
| `localModelEndpointRepository`                              | local-sqlite                                                       | ✅ done | PR 1 (store)                     |
| `providerSubscriptionTokenRepository`                       | local-sqlite                                                       | ⬜ todo | PR 3                             |
| `personalSubscriptionRepository`                            | local-sqlite                                                       | ⬜ todo | PR 3                             |
| `subscriptionActivationRepository`                          | local-sqlite                                                       | ⬜ todo | PR 3                             |
| `localSettingsRepository`                                   | local-sqlite                                                       | ⬜ todo | PR 3                             |
| durable execution work queue                                | local-sqlite (replaces pg-boss)                                    | ✅ done | PR 1 (in-proc) → PR 2 (durable)  |
| cached mothership machine token                             | local-sqlite                                                       | ✅ done | PR 3                             |
| `llmCallMetricRepository`                                   | telemetry                                                          | ⬜ todo | PR 5                             |
| `agentContextSnapshotRepository`                            | telemetry                                                          | ⬜ todo | PR 5                             |
| `tokenUsageRepository`                                      | telemetry                                                          | ⬜ todo | PR 5                             |
| `provisioningLogRepository`                                 | telemetry                                                          | ⬜ todo | PR 5                             |

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

- **PR 0 — this tracker doc.** ✅ landed.
- **PR 1 — vertical slice (the SPINE).** ✅ landed — the persistence-RPC spine + local consumer side.
  See "Landed so far". The board-load + run end-to-end surface that makes it functional landed under
  Phase 3 (the merge gate, **MET**).
- **PR 2 — real-time both directions + durable SQLite work queue.** Durable SQLite work queue **✅
  landed**. **Remaining:** real-time both directions (`RpcEventPublisher` + `UpstreamEventSubscriber`)
  and the local-sqlite conformance binding via a fake mothership server.

### Phase 3 — Functional repository surface (THE MERGE GATE)

✅ **MET.** The phase that makes mothership mode actually work. Split across several PRs (slices 1–4 +
the follow-up surface-completion slices in "Landed so far"). **Exit criteria — MET:** a mothership-mode
`buildLocalContainer` loads a board and drives a run to a persisted terminal state against a real RPC
backend, asserted by `mothership-integration.spec.ts` (green). The three parts of the work were:

1. **Route every direct-db store through the remote surface when `db` is undefined** — via the
   `pickRepoSource(remoteRepos, name, build)` seam (slice 3, extended in slice 4 for the
   `AgentContextBuilder` sub-helper repos). STILL TODO: the sub-helper surfaces genuinely off the
   board-load + run path — `fragments` / `slack` connect/provision. (Telemetry repos stay local-first,
   Phase 5, degrading as best-effort no-ops over the remote for now.)
2. **Widen `REMOTE_PERSISTENCE_METHODS`** to the board-load + run methods, each with a correct scope
   rule (`workspace` / `workspaceField` / `block` / `serviceList` / `service` / `serviceMount`). The
   boundary is security-sensitive: a machine token scopes ACCOUNTS not roles, so admin-gated mutations
   and global sweeper reads stay excluded. Ongoing surface-completion is the follow-up slices + the
   `pending` entries in the drift guard.
3. **Expose those repos in the mothership-side registry** (the dispatcher reflects over it) with
   round-trip + cross-account-scope tests + the fake-mothership integration test (slice 4).

Residual items (provisioned-env secret decryption; best-effort kaizen/telemetry/activation no-ops;
`fragments` / `slack` connect surfaces) are NOT on the basic board-load + run path.

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
  key (the one `applyLocalDefaults` already guarantees). A security check asserts this. A connection
  repo is only remotely exposable if it returns its credential **sealed** (env/observability
  connections); repos that decrypt INSIDE the repo (document/task connections) stay off.
- **Raw-repo RPC is powerful — default-deny.** Method allow-list per repo; global/sweeper methods
  AND admin-gated mutations excluded (the RPC bypasses the service-layer `requireAdmin`, and the
  token scopes accounts not roles); every call account-scoped to the token; the scope switch
  fails closed on any unknown rule kind; the table is looked up by own-property only so an
  attacker-supplied `__proto__`/`constructor` can't reach a non-spec member. Treat the
  `/internal/persistence` surface as the highest-risk new code.
- **`db: undefined` audit.** `buildNodeContainer` constructs many repos directly from `options.db`
  rather than from `options.repos`; each on the board-load / run path must route through the composed
  remote repos in mothership mode via `pickRepoSource`. This was the single largest correctness risk
  and the core of the Phase 3 merge gate (now MET).
- **Pre-1.0 = no back-compat.** No shims for the old siloed-Postgres local mode; mothership mode is a
  parallel boot path selected by `LOCAL_MOTHERSHIP_URL`.
