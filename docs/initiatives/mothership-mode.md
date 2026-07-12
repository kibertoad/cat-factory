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
> (needs the mothership's key — the secrets-delegation slice); the best-effort kaizen / telemetry
> no-ops a run makes over the remote (telemetry is local-first, Phase 5); and the `fragments` /
> `slack` connect/provision surfaces. (Subscription activation is no longer among these — PR 3 gave
> it, and the rest of the subscription-credential trio + local settings, their real `local-sqlite`
> home; see the [local-sqlite bucket pattern](#the-local-sqlite-bucket-pattern-credentials--settings).)
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
- **GitHub token delegation + environment self-test run surface** — the first GitHub-in-mothership
  slice, in two halves. (1) **GitHub installation-token delegation**: the mothership serves a new
  machine-authed `POST /internal/github/installation-token` (shared `githubDelegationController`,
  mounted on BOTH facades like the persistence RPC; the facade seam is
  `ServerContainer.githubTokenDelegation`, wired from each facade's GitHub App registry). Auth
  first (the `machine` audience pin — asserted by a shared conformance test), then a per-node
  fixed-window rate limit (keyed by the token's signed `nodeId`; per process/isolate — an abuse
  brake on GitHub's mint API, not a distributed quota), then the call is account-scoped
  server-side off the installation's own account binding (`getByInstallationId` → live row +
  `accountId` in the token scope; an installation is bound to exactly ONE account, so this is a
  single point read), else 404 (no existence leak). The minted token is **repo-scoped, not
  installation-wide**: the mint passes GitHub `repository_ids` narrowed to the live App-linked
  rows of the `github_repos` projection for that installation (the batched
  `repoProjectionRepository.listByInstallation` read, mirrored D1 ⇄ Drizzle; `user_pat`-linked
  rows excluded — not App-reachable; no linked repos ⇒ the same uniform 404). A scoped mint
  bypasses the mothership's unscoped in-memory engine token cache in BOTH directions (no
  over-grant from a cached unscoped token, no poisoning of the engine path), and every mint /
  denial / failure is audit-logged with the node + user ids (the client-facing 500 stays opaque).
  The laptop consumes it through `DelegatedAppTokenSource` (an `AppTokenSource`; short
  in-process memo, `forceRefresh` pass-through): `composeMothership` builds it on the SAME machine
  token as the persistence RPC, and `buildLocalContainer` — when NO `GITHUB_PAT` is set — wires it
  as BOTH the executor's push/clone-token mint and a full `FetchGitHubClient` (gates, merge,
  repo-link, `resolveRunRepoContext`/RepoFiles). So a mothership-mode node runs on the org's
  GitHub App installation with no PAT and no App key on the machine — only short-lived (~1h),
  repo-scoped installation tokens. An explicit PAT still wins.
  (2) **`environmentTestRunRepository` goes remote** (`get`/`update`/`listRunningByWorkspace` via
  `workspace`, record-based `insert` via `workspaceField`): the ephemeral-environment self-test's
  run store — previously all-`pending` precisely because the self-test needs
  `resolveRunRepoContext` (GitHub), which (1) now serves. A FULL mothership-mode self-test still
  rides the later secrets-delegation slice (the provisioning writes
  `environmentRegistryRepository.insert`/`update` stay off), failing cleanly at the provisioning
  stage with cleanup until it lands.
- **Prompt-fragment library + account onboarding reads** — four more repository surfaces widened in
  one slice (each a server-only allow-list change, symmetric by construction). (1) The tenant-scoped
  **prompt-fragment library** (`promptFragmentRepository` list/get/upsert/softDelete +
  `fragmentSourceRepository` list/link) the SPA's `FragmentLibraryController` curates — introduces
  two new scope rules, `owner` (an `(ownerKind, ownerId)` positional PAIR) + `ownerField` (the same
  as record fields on `upsert`), resolving a `workspace` owner to its account and taking an `account`
  owner as the accountId directly, so a token scoped to one account can never read/write another
  tenant's fragments. Both tiers are member-level (account-tier routes guard on `requireMember`, NOT
  `requireAdmin`), rows carry no secrets, and the library module assembles from
  `promptFragmentRepository` alone (unlike the document/task integration modules, which require a
  decrypt-inside connection repo and so stay off). Node routes the two fragment repos through the
  `if (remoteRepos)` seam ONLY when the library is configured (else setting `promptFragmentRepository`
  would spuriously turn the module on and force fragment resolution on every run). The `sourceId`-keyed
  `promptFragmentRepository.listBySource` + `fragmentSourceRepository.get`/`updateSyncState`/`softDelete`
  stay off — they back the repo-SYNC the mothership owns (its source service needs a GitHub client a
  mothership node lacks). (2) The two member-level **account onboarding reads** the SPA's
  members/email-settings panels drive: `invitationRepository.listByAccount` (pending invites) and
  `emailConnectionRepository.getByAccount` (the email connection, its provider key a SEALED
  `apiKeyCipher` blob — the repo never decrypts), both via the `account` rule. The account-lifecycle
  WRITES stay off: invite `create`/`setStatus` (admin-gated), the pre-auth `findByTokenHash`/`get`
  accept-invite lookups, and email `upsert`/`softDelete` (connect/disconnect, admin-gated).

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

**Local credential + settings buckets (PR 3)**

- **Subscription credentials + local settings move onto the laptop** — the four remaining
  `local-sqlite` bucket rows now have a `node:sqlite` home, so the subscription features + the
  local-settings panel work in mothership mode (previously the services were OFF for lack of a db).
  `credentialStore.ts` gains three sealed-credential repos —
  `SqliteProviderSubscriptionTokenRepository` (per-workspace pooled Claude Code / Codex / GLM
  tokens), `SqlitePersonalSubscriptionRepository` (per-user individual-usage creds, the outer
  double-encryption blob), and `SqliteSubscriptionActivationRepository` (their short-lived per-run,
  system-key-only copies) — and a new `localSettingsStore.ts` holds the local-mode operational
  settings singleton (`SqliteLocalSettingsRepository`; kept out of the credential store so that
  store's "only credentials" invariant holds). All mirror their `D1*` SQL (D1 is SQLite) and stay
  LOCAL for the same reason the API-key pool does: the tokens are leased + decrypted by the LOCAL
  container executor, so they must never traverse the machine API. Wired via new `NodeContainerOptions`
  credential-override seams (`providerSubscriptionTokenRepository` /
  `personalSubscriptionRepository` / `subscriptionActivationRepository`, mirroring the existing
  `providerApiKeyRepository` seam) that let `buildNode{Subscription,PersonalSubscription}Service`
  build even without a `db`; `subscriptionActivationRepository` is threaded ONCE and reused by BOTH
  its consumers (the personal-subscription service's mint + the engine core's clear-on-completion).
  `localSettingsService` is built in `buildLocalContainer` from the local-sqlite repo when there's no
  `db`. Removes the last mothership-mode "service OFF (no db)" gaps for these features. See the
  [local-sqlite bucket pattern](#the-local-sqlite-bucket-pattern-credentials--settings) below.

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

### The local-sqlite bucket pattern (credentials + settings)

The mirror of the remote spine for the OTHER bucket: state that must NOT go to the mothership
because it is a per-user/per-deployment credential or a local-runner knob. This is the reference
for adding a new `local-sqlite` repo (and the template a future agent should copy rather than
re-derive). It is a **local-facade-only differentiator** — no symmetry obligation (see Conventions).

- **Where it lives.** `backend/runtimes/local/src/sqlite/`. The credential store
  (`credentialStore.ts`, file `credentials.sqlite`) holds every SEALED credential repo:
  `providerApiKey`, `localModelEndpoint`, and (PR 3) the subscription trio
  `providerSubscriptionToken` / `personalSubscription` / `subscriptionActivation`. The local-mode
  operational settings singleton has its OWN store (`localSettingsStore.ts`, file
  `local-settings.sqlite`) so the credential store's "ONLY credentials" invariant holds — it is
  non-secret config, not a credential. Both open through the shared `db.ts` `openSqliteDb` (WAL +
  busy-timeout). The machine-token cache (`machineTokenStore.ts`) and the durable work queue
  (`workQueue.ts`) are the other two local stores.
- **Implementing a repo.** `node:sqlite`'s `DatabaseSync` is SYNCHRONOUS + single-process, so a
  select-then-write is inherently atomic (no `FOR UPDATE` analogue needed) and the port's async
  methods just execute synchronously. **Mirror the `D1*` repository's SQL** — D1 IS SQLite, so the
  `D1ProviderSubscriptionTokenRepository` / `D1PersonalSubscriptionRepository` (in
  `backend/runtimes/cloudflare/.../repositories/`) are the closest reference, adapted to the
  `.prepare().run(...)/.get(...)/.all(...)` API (`Number(res.changes)` for a delete count). Add the
  table to the store's `SCHEMA` const. The repo is **crypto-agnostic**: it stores only the opaque
  `*Cipher` blob the SERVICE hands it.
- **The sealing model.** The cipher is applied ABOVE the store, in the service (e.g.
  `ProviderSubscriptionService` seals with a `WebCryptoSecretCipher` keyed by the LOCAL
  `ENCRYPTION_KEY` that `applyLocalDefaults` guarantees). Personal subscriptions are
  DOUBLE-encrypted (`system.encrypt(personal.seal(token, password))`) — the inner password layer
  (`WebCryptoPersonalSecretCipher`) is also above the store, so the password never touches disk.
  The mothership's `ENCRYPTION_KEY` NEVER reaches the laptop (product decision 3): these creds are
  leased + decrypted by the LOCAL container executor, which is exactly why they can't be remoted.
- **The wiring seam.** `NodeContainerOptions` carries a per-repo credential OVERRIDE
  (`providerApiKeyRepository`, and PR 3's `providerSubscriptionTokenRepository` /
  `personalSubscriptionRepository` / `subscriptionActivationRepository`). Each `buildNode*Service`
  takes a `repositoryOverride?` and builds even without a `db` (`override ?? (db ? new Drizzle… :
undefined)`; off only when neither is present) — so the feature turns ON in mothership mode. When
  ONE repo has TWO consumers (e.g. `subscriptionActivationRepository` feeds both the
  personal-subscription service's mint AND the engine core's clear-on-completion), thread the ONE
  injected instance into both so they agree. `buildLocalContainer` reads the repos off
  `mothership.credentialStore.*` and passes them in the `...(mothership ? {…} : {})` block.
  `localSettingsService` (local-facade-built, not a `NodeContainerOptions` seam) is constructed from
  the Drizzle repo when `options.db` is present, else `mothership.localSettingsStore.localSettingsRepository`.
- **composeMothership** opens each store, exposes it on `MothershipComposition`, and closes it in
  `close()` (called from `onShutdown`). Each store's file path is `localDbPath(env.LOCAL_MOTHERSHIP_*_DB,
'<name>.sqlite')` — an env override (incl. `:memory:` for tests) else `~/.cat-factory/<name>.sqlite`.
  **Tests that build a mothership container MUST set every `LOCAL_MOTHERSHIP_*_DB` to `:memory:`**
  (incl. `LOCAL_MOTHERSHIP_SETTINGS_DB`) or they write real files under `~/.cat-factory`.
- **Drift guard.** `runtimes/node/test/mothership-allowlist.spec.ts` reflects the DRIZZLE repos only,
  so a local-sqlite repo needs NO allow-list entry; a repo that also has a Drizzle impl is classified
  `local` in that guard's `NON_REMOTE` map (the subscription trio already is), and a local-ONLY repo
  (e.g. `localSettings`) isn't reflected at all. The `node:sqlite` classes are covered by unit tests
  (`credentialStore.test.ts` / `localSettingsStore.test.ts`) asserting parity with the D1/Drizzle SQL.
- **NOT this pattern:** the telemetry repos (Phase 5) are `telemetry`-bucket, not `local-sqlite` —
  they are local-FIRST + batch-synced-up + short-TTL-pruned, a different model, not a plain
  laptop-only store.

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
| `invitationRepository`                                      | remote (`listByAccount` read; writes admin/pre-auth pending)       | ◑ part  | PR 3 (account onboarding reads)  |
| `passwordResetTokenRepository`                              | remote                                                             | ⬜ todo | PR 3                             |
| `emailConnectionRepository`                                 | remote (`getByAccount` read, sealed; connect/disconnect admin)     | ◑ part  | PR 3 (account onboarding reads)  |
| `promptFragmentRepository`                                  | remote (owner-scoped library mgmt; `listBySource` sync pending)    | ◑ part  | PR 3 (fragment library surface)  |
| `fragmentSourceRepository`                                  | remote (owner-scoped list + link; id-keyed sync mgmt pending)      | ◑ part  | PR 3 (fragment library surface)  |
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
| `environmentTestRunRepository`                              | remote (whole repo; full self-test rides provision writes)         | ✅ done | PR 3 (GitHub delegation slice)   |
| `binaryArtifactMetadataStore` (metadata)                    | remote; blobs → shared backend (S3 / mothership)                   | ✅ done | PR 3 (visual-gate metadata)      |
| `githubInstallationRepository`                              | remote (`getByWorkspace` run-path read; rest pending)              | ◑ part  | PR 3 (VCS projection reads)      |
| `runnerPoolConnectionRepository`                            | remote                                                             | ✅ done | PR 3 (runner-backend connection) |
| GitHub projection repos (repo/branch/PR/issue/commit/check) | remote (board-panel reads; sync/repo-writes pending)               | ◑ part  | PR 3 (VCS projection reads)      |
| `providerApiKeyRepository`                                  | local-sqlite                                                       | ✅ done | PR 1 (store)                     |
| `localModelEndpointRepository`                              | local-sqlite                                                       | ✅ done | PR 1 (store)                     |
| `providerSubscriptionTokenRepository`                       | local-sqlite                                                       | ✅ done | PR 3 (local subscription bucket) |
| `personalSubscriptionRepository`                            | local-sqlite                                                       | ✅ done | PR 3 (local subscription bucket) |
| `subscriptionActivationRepository`                          | local-sqlite                                                       | ✅ done | PR 3 (local subscription bucket) |
| `localSettingsRepository`                                   | local-sqlite                                                       | ✅ done | PR 3 (local subscription bucket) |
| durable execution work queue                                | local-sqlite (replaces pg-boss)                                    | ✅ done | PR 1 (in-proc) → PR 2 (durable)  |
| cached mothership machine token                             | local-sqlite                                                       | ✅ done | PR 3                             |
| `llmCallMetricRepository`                                   | telemetry                                                          | ⬜ todo | PR 5                             |
| `agentContextSnapshotRepository`                            | telemetry                                                          | ⬜ todo | PR 5                             |
| `tokenUsageRepository`                                      | telemetry                                                          | ⬜ todo | PR 5                             |
| `provisioningLogRepository`                                 | telemetry                                                          | ⬜ todo | PR 5                             |

## Cross-cutting delegation (not per-call repo proxies)

- **GitHub installation tokens** ✅ landed. `POST /internal/github/installation-token` (machine-authed,
  rate-limited per node, scoped by the installation's account binding) mints the mothership App's
  short-lived installation tokens for the laptop, **repo-scoped** via `repository_ids` to the live
  App-linked `github_repos` projection for the installation; `DelegatedAppTokenSource` consumes them
  as the push-token mint + the `FetchGitHubClient` token source when no `GITHUB_PAT` is set. The App
  private key never leaves the mothership, and a delegated token never grants more than the
  mothership projects. (Projection WRITES — sync ingest, `setMonorepo`, cursors — remain
  mothership-owned; the repo-write projection-refresh slice is still open.)
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

Residual items (provisioned-env secret decryption; best-effort kaizen/telemetry no-ops;
`fragments` / `slack` connect surfaces) are NOT on the basic board-load + run path. (Subscription
activation is no longer a residual — PR 3 landed its `local-sqlite` bucket; see "Landed so far".)

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
