# Initiative: mothership mode for local mode

**Status:** in progress (board-load + run functional over the RPC; real-time complete BOTH directions; telemetry local-first AND synced up, read-through pending; later slices widen the surface) · **Owner:** core · **Started:** 2026-06-30

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
> (needs the mothership's key — the secrets-delegation slice); the best-effort kaizen no-ops a run
> makes over the remote (telemetry itself is now local-first — see PR 5 below); and the document/task
> connection integration (blocked on its decrypt-inside connection repos). (Subscription activation,
> the prompt-fragment library, the Claude Skills library — catalog AND repo sync — and the Slack
> settings surface are no longer among these — PR 3 gave
> them, and the subscription-credential trio + local settings their real `local-sqlite` home; see the
> [local-sqlite bucket pattern](#the-local-sqlite-bucket-pattern-credentials--settings).)
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
- **PR 2 (real-time UPSTREAM publish)** — the OUTBOUND half of "real-time both directions". A new
  machine-authed `POST /internal/events/publish` (`eventsRelayController`, `@cat-factory/server`) +
  the `MachineEventRelay` seam on `ServerContainer`, mounted + attached symmetrically on BOTH facades
  (`LocalMachineEventRelay` over the Node hub/propagator; `DurableObjectMachineEventRelay` over the
  per-workspace `WorkspaceEventsHub` DO). The laptop publishes each engine event upstream through a
  `MothershipWebSocketPropagator` — a `WebSocketPropagator` adapter reusing the existing cross-node
  seam, layered over the local hub — so hosted teammates on the shared board see the local node's
  activity live. Account-scoped + default-deny like the persistence RPC (out-of-scope workspace →
  404). Tested in `packages/server/test/eventsRelay.spec.ts`, `runtimes/node/test/machineEventRelay.spec.ts`,
  the Cloudflare `events-stream.spec.ts` (relay delivery + `buildContainer` wiring-parity assertion),
  and `runtimes/local/src/mothership.test.ts`. The relay-wiring parity is asserted per-facade (Node
  `mothership.test.ts`, Cloudflare `events-stream.spec.ts`); folding an end-to-end relay assertion into
  the shared cross-runtime suite still rides with the mothership conformance-server binding (that
  harness has no realtime sink today). The INBOUND (subscribe) leg has since landed — see below.
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
- **The account-wide run-credential floor** — `accountSettingsRepository.getConfigByAccount` goes
  **remote** (`account` scope), and the shape of that decision is the reusable part. The floor
  (`allowInitiatorPat`, see `backend/docs/security-model.md`) is read on the RUN path, so leaving it
  un-routed would not have blanked a panel — a mothership node would have silently stopped enforcing
  an account admin's refusal, which is the worst kind of parity gap. But the obvious carrier,
  `getByAccount`, is deliberately mothership-INTERNAL: it returns the sealed secret blob, and the
  machine token scopes ACCOUNTS rather than ROLES while the RPC bypasses the service layer's
  `requireAdmin`, so proxying it would let any account member pull the account's secrets.
  The resolution was to NARROW THE READ rather than widen the surface — a new port method selecting
  the non-secret `config` column alone, which is exactly the "or routes them through the service"
  escape the original classification anticipated. **Prefer that move to either horn** when a run-path
  read is trapped behind a secret-bearing sibling: a method that carries no secret needs no role
  dimension to be safe. `upsert` (an admin write) and `listAll` (the unscoped sweeper) stay off, and
  a test pins that `getByAccount` is still refused.
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
- **Slack integration management surface** — the Slack settings panels (`SlackController` →
  `SlackConnectionService` / `SlackSettingsService` / `SlackMemberMappingService`: connect / disconnect
  the per-account Slack workspace, edit the per-workspace notification routing, maintain the per-account
  GitHub-user → Slack-member mapping) now PERSIST over the mothership. Introduces a new scope rule
  **`accountField`** — the account-owned mirror of `workspaceField`, binding on an `upsert(record)`'s
  `accountId` FIELD — used by `slackConnectionRepository.upsert`. Allow-listed:
  `slackConnectionRepository` `getByAccount`/`upsert`/`softDelete` (the bot token rides a SEALED
  `tokenCipher`, so only ciphertext crosses the machine API — the observability/runner-connection
  precedent), `slackSettingsRepository` `getByWorkspace`/`upsert` and `slackMemberMappingRepository`
  `getByAccount`/`upsert` (no secrets). The Node facade routes the three Slack repos through the
  `sourced`/`pickRepoSource` seam inside `selectNodeSlackDeps` (so both the management services AND the
  `SlackNotificationChannel` read the remote-backed repos, not the db-less Drizzle instances).
  **Still off:** `slackConnectionRepository.getByTeam` — the GLOBAL teamId → connection lookup the
  inbound OAuth callback / event webhook use on the mothership (never the laptop), unscopable by
  account, so mothership-internal. **Residual (later secrets-delegation slice):** mothership-SIDE Slack
  DELIVERY of a notification raised by a HOSTED teammate — the mothership decrypting a laptop-sealed
  token — mirrors the observability gate-probe residual; local-node delivery (the run's own node holds
  the key) is unaffected.
- **Member-display reads** — the account members panel now renders real names/emails/avatars in
  mothership mode: `userRepository.get` + `userRepository.listByIds` (the roster enrichment behind
  `AccountService.members`) are allow-listed. Introduces a new scope rule pair **`user`/`userList`**
  bound by CO-MEMBERSHIP — a userId is not an account/workspace, so it is admitted iff the user is a
  member of one of the token's in-scope accounts, resolved server-side from the account rosters via a
  new `resolveAccountMemberIds` dispatch resolver (bounded by the token's account scope, not the
  requested user list — no N+1). Safe because the reads carry only the presentational `UserRecord`
  (id/name/email/avatarUrl/createdAt); the password `secret` lives on `UserIdentityRecord`, reachable
  only via `getIdentity`/`listIdentities`, which — with `update` (profile write) and
  `findByIdentity`/`findByEmail` — stay OFF (the account-lifecycle / login surface). Round-trip +
  co-membership-scope + secret-read-refusal tests in `persistenceRpc.spec.ts`; the drift guard moves
  `get`/`listByIds` out of `pending`.
- **Repo-sourced Claude Skills library (ADR 0024) — catalog AND sync** — the first content library
  whose repo-SYNC goes remote too, not just its management reads. Two things forced the widening
  beyond the fragment-library shape:
  - **A skill catalog read is a RUN-path read.** `skillResolver` is a HARD dependency for a `skill`
    step (and for ADR 0029's declared `{ catalogSkillId }` capabilities), so an un-routed
    `accountSkillRepository` did not blank a panel — it failed the dispatch. Worse, it failed
    PARTIALLY: a skill with no sibling resources resolved from the catalog alone, while one with
    resources threw out of `SkillRunResolver.resolveResources`, so the feature looked wired.
  - **"A mothership node has no GitHub client" is no longer true.** That premise is what parked the
    fragment / foundational-service sync surfaces at `pending`; token delegation
    (`DelegatedAppTokenSource`) since gave the node one, so its `SkillSourceService` assembles and
    its link / sync / unlink routes are LIVE — reachable and broken, which is worse than either
    serving them or hiding them.

  Introduces the **`skillSource`** scope rule: the sync methods carry a source id and nothing else,
  so nothing positional binds them. It resolves the source's owning account server-side through a
  new `resolveSkillSourceAccountId` dispatch resolver (memoised beside the block/service resolvers,
  and the dispatched `skillSourceRepository.get` is routed through the SAME memo so the scope check
  is not a second read). The sibling libraries can adopt it when their own sync surface lands.
  Allow-listed: `accountSkillRepository` `listByAccount`/`get` (the `account` rule),
  `upsert` (`accountField`), `softDelete` (`account`), `listBySource`/`softDeleteBySource`
  (`skillSource`); `skillSourceRepository` `listByAccount` (`account`),
  `upsert` (**`accountFieldUpsert`**), `get`/`updateSyncState`/`softDelete` (`skillSource`). Rows
  carry no secrets — a `SKILL.md` body plus a `{ path, sha, size }` manifest; the resource BODIES
  are fetched from the repo at dispatch and never stored.

  Also introduces **`accountFieldUpsert`**, the upsert form of `accountField` for a record-keyed
  write whose CONFLICT KEY is the record's `id` rather than its `accountId`. `accountField` is safe
  only under the precondition its own doc entry states — the row is stored under, and later read
  by, the bound `accountId`. An `ON CONFLICT (id) DO UPDATE` that does not re-`SET account_id`
  breaks it: the write lands on whichever row already holds that id, under ITS account. Binding
  only the declared field would let a token scoped to account A name account B's source id, declare
  its own account to pass the check, and repoint B's link at a repo A controls — whose `SKILL.md`
  bodies are agent INSTRUCTIONS that B's next sync folds into their catalog. The rule therefore
  binds the STORED row's account as well; an absent row is a CREATE and passes on the declared half
  alone. Its sibling `accountSkillRepository.upsert` keeps plain `accountField` because that write
  conflicts on `(account_id, skill_id)`, so the bound account is part of the key.

  > **Open gap this rule does NOT close.** `fragmentSourceRepository.upsert` (`ownerField`) has the
  > same id-keyed conflict shape and the same exposure. Closing it needs the `ownerField` analogue —
  > a source → owner-PAIR resolver (`(ownerKind, ownerId)`, not a bare accountId) — plus its own
  > round-trip tests, so it is tracked here rather than folded into the skills slice. Until then, do
  > not copy `ownerField`/`accountField` onto a new id-keyed upsert.

  **Also new: `githubInstallationRepository.listActiveForAccount`** (`account` rule), a real port
  addition rather than an allow-list line. The account-tier installation lookup every repo-sourced
  library resolves its GitHub credential through went via the cron `listActive()` plus a JS filter —
  a read of every tenant's installations to answer a single-account question, which no
  account-scoped token can ever be allowed to serve and which no rule can bind (the method takes no
  arguments). The scoped form pushes "bound to the account directly OR to one of its own boards"
  into SQL on both runtimes, ordered `(createdAt, installationId)` so the two pick the same row;
  `createTierInstallationResolvers.forAccount` now makes one query where it made two.

  **Still off:** `skillSourceRepository.listByRepo` — the GLOBAL `(repoOwner, repoName)` → sources
  reverse lookup behind the push-webhook fan-out, spanning every account by construction and running
  on the mothership that receives the webhook. Classified `sweeper`, like
  `slackConnectionRepository.getByTeam`. **Config expectation:** both ends must have
  `fragmentLibrary.enabled` — the mothership folds the skill repos into its reflected registry only
  when its own library is configured, exactly as it does for fragments, so a node with the library on
  against a mothership with it off gets a clean `... is not wired`.

**Code-registered ORG state: the foundational-services `builtin` tier**

- **`GET /internal/foundational-services`** (+ `/:serviceId/contracts`) — the catalog tier a
  deployment registers in CODE (ADR 0031). It is the one class of state this initiative's four
  buckets did not cover, because it is not a repository method at all, and the gap it left was the
  quiet kind. A mothership deployment is TWO processes, so the estate had to be registered on both
  entry points and the copies matched only while both ran the same build — with a node one build
  behind being the normal state of running one. Nothing detected the skew, and a run whose catalog
  is missing a service simply does not consider it, which reads exactly like an Architect judging
  it irrelevant.

  So the estate is treated as the org state it is: the node reads the tier from the mothership
  through the kernel `FoundationalBuiltinSource` port and does NOT consult its own registry (a boot
  warning names any ids it is therefore ignoring). Same machine-token audience pin as the
  persistence RPC, same base URL and same per-request token — but its OWN `/internal/*` endpoint
  rather than a hole in the persistence proxy, per ADR 0009: there are no rows, and every method in
  `REMOTE_PERSISTENCE_METHODS` binds to an account through a scope rule this read has no argument
  to offer one from. There is nothing account-shaped to scope: the tier is one deployment-wide set
  every workspace of every account already resolves in full.

  **A failed read throws rather than answering with an empty tier** — including the 404 from a
  mothership OLDER than the node — because an empty catalog reaching an Architect is precisely the
  failure the feature exists to prevent.

  **The general rule this sets:** state a deployment registers in CODE and a RUN resolves is org
  state in mothership mode too. It rides its own `/internal/*` read, never a second registration on
  the node, whose build is by construction the one that can be stale.

**Notification delivery delegation (PR 4, first half)**

- **`POST /internal/notifications/deliver`** — the mothership now DELIVERS a notification a
  mothership-mode node raised, through the ORG's external transports (Slack today). Previously such
  a notification persisted remotely (the allow-listed `notificationRepository`) and rendered in the
  inbox, but never reached Slack: the bot token is sealed with the MOTHERSHIP's key, which by
  product decision 3 never reaches a laptop, so a `merge_review` / `ci_failed` /
  `release_regression` raised by a local run silently stopped at the board. The shared
  `notificationRelayController` (`@cat-factory/server`) is mounted on BOTH facades like the
  persistence RPC, behind the same machine-token audience pin (checked FIRST, so availability isn't
  probeable) and the same account-scope binding (workspace → account → uniform 404, no existence
  leak). The facade seam is `ServerContainer.machineNotificationDelivery`, wired from each
  facade's **EXTERNAL** channels only (Node: `buildNodeRealtimeDeps`' new
  `externalNotificationChannel`; Cloudflare: the new exported `buildExternalNotificationChannel`) —
  the IN-APP frame for a laptop-raised notification already reaches the mothership's browsers over
  the real-time upstream relay, so routing it here too would double-push it. No external channel
  (Slack off) ⇒ 503.
  **The wire carries IDENTIFIERS ONLY** (`{ workspaceId, notificationId }`): the mothership
  re-reads the row from its OWN workspace-scoped store and delivers THAT, so a compromised node
  token can at most ask for a re-delivery of a row that already exists in an account it can already
  reach — it can never inject forged text into the org's Slack, and a notification of another
  workspace can't be addressed through an in-scope one.
  The laptop consumes it through `RemoteNotificationChannel` over `HttpMachineNotificationClient`
  (same base URL + per-request machine token as the persistence RPC, so it follows the same
  connect/expiry lifecycle; a token-less node skips the round-trip entirely). `composeMothership`
  builds it and `buildLocalContainer` threads it into `buildNodeContainer`'s new
  `notificationChannels` seam, so it composes alongside the local in-app push with no engine
  change. Self-swallowing per the port's best-effort contract (with an `onError` log), so an
  unreachable mothership never breaks the state transition that raised the notification.
  Tested in `packages/server/test/notificationsRelay.spec.ts` (auth pin, scope, the
  stored-content-not-body-content property, cross-workspace refusal, 503/422/500 edges, and the
  client+channel round-trip), `runtimes/node/test/machineNotificationDelivery.spec.ts` (the
  in-app-stays-out-of-the-seam split at its source), `runtimes/local/src/mothership.test.ts`
  (client wire shape + the `buildLocalContainer` threading), and the shared cross-runtime suite
  (`core-workspaces.ts` asserts the endpoint is mounted + machine-gated on BOTH facades).
  **Still open in PR 4:** email delegation (`RemoteEmailSender` → `POST /internal/email/send`) is
  deliberately NOT built — see the "Cross-cutting delegation" note on why it has no reachable
  consumer today — and mothership-SIDE delivery of a notification a HOSTED teammate raised whose
  Slack connection was sealed by a LAPTOP (the secrets-delegation residual, unchanged).

**Real-time INBOUND subscribe — PR 2 COMPLETE**

- **`GET /internal/events/subscribe/:workspaceId`** closes the loop the upstream publish opened, so
  real-time is finally bidirectional: org activity raised on the mothership (a hosted teammate) or
  relayed up by a peer laptop now reaches THIS laptop's SPA. Before it, a mothership-mode board was
  write-only in real time — it animated for work the laptop drove and stayed frozen for everyone
  else's, with only a manual refresh to reconcile.
  - **The mothership SERVE side is NOT a new fan-out.** The tracker previously deferred this leg on
    the grounds that a long-lived subscriber registry is genuinely runtime-shaped (in-process on
    Node vs DO-held on Cloudflare). That premise turned out to be avoidable: the handshake is handed
    to the SAME per-workspace realtime transport the browser stream already uses
    (`gateways.realtime.upgrade` — the `WorkspaceEventsHub` DO / the `NodeRealtimeHub`), so a
    subscribed node is just another socket in the workspace's room. No registry to invent, no
    per-runtime divergence, and events reach laptops and browsers through ONE path. The Durable
    Object needed no change at all.
  - **Auth is the shared `authorizeMachineSubscribe`** (`@cat-factory/server`), in the same order as
    every other `/internal/*` surface: machine-audience pin FIRST (so availability isn't probeable),
    then the capability probe (503), then the workspace → account scope binding (uniform 404, no
    existence leak). It lives beside `wsTicket.ts` and for the same reason — Cloudflare authorises
    in the shared controller, Node in its HTTP-server `upgrade` listener (`@hono/node-server` can't
    upgrade from a Hono `Response`), and one implementation keeps the two identical. Deliberately
    role-blind, which is sound because the subscription is READ-ONLY and workspace-scoped: it
    carries exactly the frames any member of the account already receives.
  - **The laptop side is DEMAND-DRIVEN**: `MothershipEventSubscriber` holds one upstream socket per
    workspace with at least one local subscriber, opened off a new `RealtimeRoomWatcher` seam on
    `NodeRealtimeHub` (first-socket / last-socket transitions). An idle laptop holds none, and the
    node never needs to enumerate the org's workspaces. It is NOT expressed as a
    `WebSocketPropagator` adapter: that port's `start(deliver)` receives no workspace list, so
    forcing it through would mean subscribing to nothing or inventing that enumeration.
  - **Two invariants keep it from looping or double-delivering.** Inbound events are broadcast to
    the BARE hub, never back through the layered propagator (which would re-publish them upstream) —
    the same rule `LayeredEventPropagator.start` follows for Redis. And the node's stable `?cid=` is
    now stamped as the outbound publish's `originConnectionId`, REPLACING the originating tab's id:
    the tab id means nothing on the mothership (which holds no laptop-local socket) and was already
    honoured locally, while the node id is precisely the one socket that must not receive its own
    event back.
  - A dropped subscription reconnects with jittered capped backoff, and a token-less node simply
    doesn't connect until the SPA login completes (then the pending retry picks the token up — no
    restart). A refused handshake is REPORTED (rate-limited), because the retry loop is unbounded
    by design and an invisible one is indistinguishable from a healthy node.
  - **Liveness is CLIENT-driven, and has to be, because the two mothership runtimes disagree.** A
    Node mothership pings at the protocol level and reaps a socket that stops answering, so a drop
    surfaces as a `close` the subscriber retries. A Cloudflare mothership does not: the
    `WorkspaceEventsHub` uses the hibernation API, which sends no pings, so a half-open socket
    never fires `close` and the workspace would go dark FOREVER while the node still believed it
    was subscribed. So the subscriber runs its own heartbeat and treats any inbound frame as proof
    of life — its app-level `"ping"` is auto-answered at the Cloudflare edge (the DO's existing
    `setWebSocketAutoResponse` pair, no DO wake), while Node's own protocol ping arrives as a
    `ping` event. Neither hub reads subscriber frames, so the text ping is inert where unneeded.
    Silence past the idle deadline drops the socket and reconnects.
  - Tested in `packages/server/test/eventsRelay.spec.ts` (the gate + the gateway hand-off),
    `runtimes/node/test/machineEventSubscribe.spec.ts` (the Node upgrade listener authorising
    identically, an accepted node landing in the same hub room with its `?cid=` honoured over a
    real handshake, and the hub's room seam), `runtimes/local/src/mothershipSubscriber.test.ts`
    (the demand-driven lifecycle, verbatim delivery, backoff, the idle deadline, failure
    reporting), `runtimes/local/src/mothership.test.ts` (the wiring + the echo-suppression
    contract), and the shared cross-runtime suite (`core-workspaces.ts` asserts the endpoint is
    mounted + machine-gated on BOTH facades).

**Real-time fan-out read (a defect the inbound leg surfaced)**

- **`workspaceMountRepository.listWorkspaceIdsMountingBlock` is now allow-listed** — and it was
  never optional. `FanOutEventPublisher` calls it on EVERY engine event publish to expand the
  changed block to the set of boards mounting its service, and a mothership-mode node wires the same
  decorator; with the method off the allow-list the call came back `unknown_method`, the remote proxy
  threw, and the rejection propagated out of `RunStateMachine`'s unguarded emit. The earlier
  mount-management slice classified this method as a "later slice" fan-out read, which was true of
  its mount/unmount role and wrong about its hot-path one. It takes the plain `workspace` rule
  (arg0 is the origin workspaceId) and returns workspace IDS only.
- **`blockRepository.countActiveInternal`** joins it, completing the headless public-API surface
  whose paginated reads (`listServiceTasks`, `executionRepository.listInternal`) were already remote:
  without the cap read a mothership-mode node refused every public-API run start.

**Telemetry local-first (PR 5, first half)**

- **The telemetry bucket now has a laptop home**, so a mothership-mode run finally produces the
  observability it is supposed to. Before this, the five telemetry repositories resolved to the
  remote registry, where none of their methods is (or should be) allow-listed: every write came back
  `unknown_method` — swallowed by the best-effort recorders — and every read came back empty. The
  developer's observability panel, per-step token rollups, web-search log and provisioning "View
  logs" surfaces were all blank, and nothing anywhere failed. The new
  `sqlite/telemetryStore.ts` (`telemetry.sqlite`, override `LOCAL_MOTHERSHIP_TELEMETRY_DB`) mirrors
  the D1 telemetry/provisioning SQL for `llmCallMetric` / `agentContextSnapshot` /
  `agentSearchQuery` / `provisioningLog` / `subscriptionQuotaCycle`, including the properties the
  engine leans on: `record` is first-write-wins on a duplicate id (so the harness-call recorder's
  deterministic id stays idempotent across the live drain, the terminal list and a driver replay,
  without corrupting a stored prompt delta), `latestChainTip` skips `message_count = 0` subagent
  calls, and the quota upsert accumulates-or-re-anchors in one statement. It also serves the remote
  debugging surface's BOUNDED reads (`listPage` / `get` / `listIndex` / `countByExecution`, with the
  body slicing, `?contains=` search and match offsets done in SQL exactly as on D1), so
  `/api/v1/debug/*` works on a mothership-mode node without any of those pages crossing the machine
  RPC — routing a page over a long run is precisely the bulk read this bucket exists to forbid.
- **The composition seam is the registry, not the consumers.** `createRemoteRepositoryRegistry`
  gained a `localFirst` map: any repository named there is served locally for the WHOLE registry, so
  the recorders, the observability endpoints, the board's per-step rollups and the retention sweep
  all resolve the local store with no per-consumer wiring. Membership is declared ONCE, server-side,
  as `LOCAL_FIRST_PERSISTENCE_REPOSITORIES` (beside the allow-list — they are complements), and the
  local composition is TYPED by it, so a telemetry repository added later cannot be half-wired: it
  fails to compile rather than silently resolving a remote proxy. The drift guard additionally
  asserts the two tables stay disjoint and that every method of a local-first repository is
  classified `telemetry`/`sweeper`.
- **`llmCallMetricRepository.summarizeByExecution` is REMOVED from the allow-list** rather than left
  beside the local store. It was a run-path stopgap resolving against the MOTHERSHIP's telemetry
  store — which holds none of a laptop's calls — so it could only ever report zeros for the run that
  produced them.
- **`tokenUsageRepository.record` goes the OTHER way: it is now allow-listed.** The spend ledger has
  this bucket's write profile but is the org's budget SAFEGUARD, and its three rollups
  (`totalsSinceForWorkspace`/`ForAccount`/`ForUser`) have long been read REMOTELY by the spend gate —
  so a laptop-local ledger would leave every local run invisible to the budget it must answer to,
  and the gate would under-enforce until a batch sync caught up. It rides a NEW scope rule,
  **`usageRecord`**: bind on the row's `workspaceId` field like `workspaceField`, AND pin the two
  DENORMALIZED rollup keys — `accountId` must be null or exactly the workspace's own owning account,
  `userId` null or the token's user. Without that second half, a node legitimately scoped to one
  account could write rows into its OWN workspace stamped with another account's id and exhaust that
  account's budget (pausing its runs) without ever addressing a workspace it isn't entitled to.
- **The prune is local too, and had to be.** Nothing else bounds the store: the mothership's cron
  owns ITS tables, and the Node facade's retention sweeper runs from `start()`, which a
  mothership-mode boot never calls — so `llm_call_metrics` (full per-call prompt + response bodies)
  would grow forever on the developer's disk. `telemetryRetention.ts` prunes on the SAME
  `RetentionConfig` windows the other two runtimes use, started by `buildLocalContainer` so it shares
  the store's open → prune → close lifecycle. Its stop is AWAITED before the store closes, because
  the immediate first pass is asynchronous and would otherwise die on "database is not open".
- Tested in `sqlite/telemetryStore.test.ts` (D1-parity per repository), `telemetryRetention.test.ts`
  (windows per table, disabled-window handling), `mothership.test.ts` (the bucket round-trips through
  the composed registry with ZERO RPC calls, while the org half still goes to the mothership),
  `packages/server/test/persistenceRpc.spec.ts` (the `usageRecord` rule: in-scope write, null
  account/user, cross-account workspace, the two cross-stamping refusals, and `summarizeByExecution`
  no longer callable), and the `[mothership]` conformance config, whose SUT now composes the same
  in-memory telemetry store production composes.
  **Telemetry sync UP (PR 5, second half)**

- **`POST /internal/telemetry/ingest`** carries a finished run's locally captured telemetry to the
  mothership, closing the gap the capture half left: a run a laptop drove was observable ONLY on
  that laptop, and only until its short retention window came round. A hosted teammate opening the
  same run saw an empty observability panel, zero token rollups and no web-search log — with
  nothing anywhere reporting a problem, because the rows genuinely existed, just not there. The
  shared `telemetryIngestController` (`@cat-factory/server`) is mounted on BOTH facades like the
  persistence RPC, behind the same machine-token audience pin (checked FIRST, so availability
  isn't probeable) and the same workspace → account scope binding (uniform 404, no existence
  leak). It needs no new facade seam: the append lands on the mothership's OWN
  `container.repositories`, which every mothership already attaches.
  - **It is a DEDICATED endpoint, not allow-listed persistence-RPC methods.** The whole reason
    telemetry is local-first is that its writes must not be per-row RPCs, so re-admitting them one
    at a time would undo the bucket (ADR 0009). The drift guard classifies the new `recordMany`
    methods `telemetry` for that reason.
  - **The batch's SCOPE is STAMPED onto every row.** Whatever `workspaceId`/`executionId` the rows
    themselves carry is discarded and replaced with the scope-bound pair from the envelope, so a
    node can neither file telemetry into a workspace it cannot already reach nor smuggle a foreign
    run's rows through an in-scope one. The row ids are the only thing about a row the node
    chooses.
  - **The append is idempotent by row id**, which is what makes the upload retryable: a chunk
    whose ack was lost is simply re-offered. A repeat is IGNORED, never overwritten — overwriting
    would invalidate a metric's stored prompt DELTA, meaningful only against the chain tip that
    preceded its FIRST write. That is a new kernel port method on each of the three run-scoped
    sinks (`recordMany`, mirrored D1 ⇄ Drizzle ⇄ the local `node:sqlite` store, with conformance
    parity assertions), because looping the single-row `record` over a batch is the banned N+1
    write. Note the deliberate asymmetry: the single-row `record` keeps each sink's existing
    duplicate behaviour; only the BATCH append is idempotent, because only it is retried.
  - **A batch over the caps is REFUSED (413), never truncated.** The node reads a 2xx as "this
    range is stored" and advances its high-water mark past it, so a silently shortened batch would
    lose rows with nothing left to notice. Same reason an out-of-contract row rejects the WHOLE
    batch (422) rather than dropping itself.
  - **On the laptop, "finished" is QUIESCENCE, not a run-status read** (`telemetryIngest.ts`, a
    5-minute sweep). The node holds no execution index of its own — runs live on the mothership —
    so asking "which runs ended" would mean a remote read per candidate, the N+1 this bucket
    exists to avoid. A run that has produced no telemetry for 10 minutes is done as far as its
    telemetry is concerned, and a RESUMED run simply becomes a candidate again on its next quiet
    period. Candidate selection is ONE grouped query across the three sinks, anti-joined against a
    local `telemetry_ingest_state` high-water table (pruned on the same retention window, and
    always AFTER the rows it describes, since a mark is stamped at or after its newest row).
  - **The drain pages forwards on the `(createdAt, id)` keyset** so the mothership rebuilds the
    run's prompt-delta chain in capture order, with per-sink page sizes equal to the mothership's
    own per-request caps (a larger page would be refused whole and the drain would never advance).
    The reader lives on the local store as a local-facade differentiator, NOT as kernel port
    methods: only the laptop side of the sync reads this way.
  - **A failed upload leaves the run's mark ALONE** and one run's failure never parks the pass —
    the next sweep retries it from the beginning, which is safe precisely because the append is
    idempotent. Marking optimistically would lose a run's telemetry permanently and silently.
  - Tested in `packages/server/test/telemetryIngest.spec.ts` (auth pin, scope binding, the
    scope-stamping property, caps/byte backstop, whole-batch rejection, 503/500 edges, and the
    client round-trip), `runtimes/local/src/telemetryIngest.test.ts` (quiescence selection,
    forward paging across a shared millisecond, the retry-on-failure and resumed-run paths),
    `runtimes/local/src/sqlite/telemetryStore.test.ts` (the ingest reader + `recordMany`),
    `runtimes/local/src/mothership.test.ts` (the client wire shape), the three telemetry
    conformance suites (`recordMany` parity on D1 + Drizzle), and the shared cross-runtime suite
    (`core-workspaces.ts` asserts the endpoint is mounted + machine-gated on BOTH facades).
    **Still open in PR 5:** the READ-THROUGH fallback — a mothership-mode node rendering a run whose
    LOCAL rows have already been pruned still shows nothing, even though the mothership now holds
    them. The rows are readable on the mothership's own surfaces (that is what this slice bought);
    what is missing is a bounded machine read that lets the laptop fall back to them. Also
    deliberately out of scope: `provisioningLogRepository`, whose `executionId` is NULLABLE because
    an environment outlives the run that provisioned it, so "a finished run's rows" does not
    identify them; `subscriptionQuotaCycleRepository`, whose both scopes key on laptop-held
    credentials; and an LLM call that resolved NO run (`execution_id IS NULL` — an inline call whose
    scope named only the workspace), which the run-keyed sync has nothing to key an upload on. That
    last one is a real if narrow LOSS rather than a deferral: those rows stay local and the
    retention prune eventually takes them. It is tolerable because such a call is un-run-scoped by
    definition — no run surface would have shown it — and because the SPEND it represents is
    already remote in `tokenUsageRepository`, which the budget gate reads. Closing it needs a
    second, workspace-keyed candidate query, and is worth doing only if those rows turn out to
    matter to a deployment-wide view.

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
  (`workQueue.ts`) are two more local stores; the local-first TELEMETRY store
  (`telemetryStore.ts`, file `telemetry.sqlite`) is the fourth — see the telemetry bucket below,
  which is a DIFFERENT model from this pattern.
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
  (incl. `LOCAL_MOTHERSHIP_SETTINGS_DB` and `LOCAL_MOTHERSHIP_TELEMETRY_DB`) or they write real
  files under `~/.cat-factory`.
- **Drift guard.** `runtimes/node/test/mothership-allowlist.spec.ts` reflects the DRIZZLE repos only,
  so a local-sqlite repo needs NO allow-list entry; a repo that also has a Drizzle impl is classified
  `local` in that guard's `NON_REMOTE` map (the subscription trio already is), and a local-ONLY repo
  (e.g. `localSettings`) isn't reflected at all. The `node:sqlite` classes are covered by unit tests
  (`credentialStore.test.ts` / `localSettingsStore.test.ts`) asserting parity with the D1/Drizzle SQL.
- **NOT this pattern:** the telemetry repos are `telemetry`-bucket, not `local-sqlite` — they are
  local-FIRST + short-TTL-pruned + (once the second half of PR 5 lands) batch-synced-up, a different
  model from a plain laptop-only store. They live in their own `telemetry.sqlite` store, are named
  once in `LOCAL_FIRST_PERSISTENCE_REPOSITORIES` (which TYPES the composition), and reach their
  consumers by being layered over the remote registry rather than through a `NodeContainerOptions`
  seam — see `sqlite/telemetryStore.ts` + `telemetryRetention.ts`.

## Per-repository bucket checklist

Every persistence port, and where it lives in mothership mode. `remote` = mothership RPC;
`local-sqlite` = local `node:sqlite` store; `telemetry` = local-first + batched up; `excluded` =
never remotely invocable (mothership-internal cron).

> **This table is reconciled against the ground truth** — the server-side allow-list
> (`REMOTE_PERSISTENCE_METHODS` in `backend/packages/server/src/persistence/rpc.ts`) and the
> coverage-independent drift guard (`backend/runtimes/node/test/mothership-allowlist.spec.ts`,
> which classifies EVERY Drizzle repository method as `remote` / `pending` / `local` / `telemetry` /
> `admin` / `sweeper` / `onboarding` / `helper`). When in doubt, trust those two files over this
> table. `◑ part` = some methods remote, some still `pending` (the surface-completion backlog).

**Org / durable (remote — the mothership RPC):**

| Port                                     | Status  | Remote surface / what's still off                                                                  |
| ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `workspaceRepository`                    | ✅ done | board reads + rename/setDescription; `create` onboarding, `delete` sweeper                         |
| `blockRepository`                        | ◑ part  | board/run reads+writes + public-API `countActiveInternal`; unbatched `listByService` unused        |
| `executionRepository` (CAS/rev)          | ◑ part  | run surface; `listByService` pending, `listStale` sweeper                                          |
| `pipelineRepository`                     | ✅ done | full CRUD                                                                                          |
| `accountRepository`                      | ✅ done | reads only; `rename`/`updateSettings` admin, `create`/`ensurePersonal` onboarding                  |
| `membershipRepository`                   | ✅ done | reads only; `upsert`/`remove` admin                                                                |
| `userSettingsRepository`                 | ✅ done | self-scoped get/upsert (user-tier budget)                                                          |
| `riskPolicyRepository` (merge presets)   | ✅ done | full library CRUD                                                                                  |
| `modelPresetRepository`                  | ✅ done | full library CRUD                                                                                  |
| `sharedStackRepository`                  | ✅ done | full library CRUD                                                                                  |
| `workspaceSettingsRepository`            | ✅ done | get/upsert; `listByWorkspaceIds` sweeper                                                           |
| `serviceFragmentDefaultsRepository`      | ✅ done | get/set                                                                                            |
| `trackerSettingsRepository`              | ✅ done | get/put                                                                                            |
| `pipelineScheduleRepository`             | ◑ part  | schedule mgmt + runNow; `listByService` pending, sweeper reads internal                            |
| `serviceRepository`                      | ◑ part  | mount + board-composition + run-path reads; CRUD/`getByRepo` pending (GitHub sync)                 |
| `workspaceMountRepository`               | ◑ part  | mount mgmt + the per-publish fan-out read; batch cleanup / rehome reads pending                    |
| `notificationRepository`                 | ✅ done | inbox read/act/dismiss/escalate; retention prune sweeper                                           |
| `requirementReviewRepository`            | ✅ done | full get/upsert/deleteByBlock                                                                      |
| `docInterviewRepository`                 | ✅ done | run-path + interview window get/upsert/deleteByBlock                                               |
| `clarityReviewRepository`                | ✅ done | full get/upsert/deleteByBlock                                                                      |
| `brainstormSessionRepository`            | ✅ done | full get/upsert/deleteByBlockStage                                                                 |
| `consensusSessionRepository`             | ✅ done | full get/upsert                                                                                    |
| `initiativeRepository`                   | ✅ done | CRUD + rev-CAS; `listExecuting` sweeper                                                            |
| `kaizenGradingRepository`                | ◑ part  | run-path + screen reads; single-grade `get` internal, sweep reads internal                         |
| `kaizenVerifiedComboRepository`          | ◑ part  | `getByKey`/`listByWorkspace`; `upsert` (streak write) pending                                      |
| `agentRunRepository`                     | ✅ done | `getRef` (retry/stop entry); sweeper reads internal                                                |
| `bootstrapJobRepository`                 | ✅ done | start/poll/retry/stop mgmt; `listByService` pending                                                |
| `referenceArchitectureRepository`        | ✅ done | full library CRUD + retry re-resolve                                                               |
| `envConfigRepairJobRepository`           | ✅ done | full run-mgmt (list/get/insert/update)                                                             |
| `environmentTestRunRepository`           | ✅ done | whole repo; full self-test still gated on provisioning writes below                                |
| `environmentConnectionRepository`        | ✅ done | connection + handler mgmt (sealed `secretsCipher`)                                                 |
| `customManifestTypeRepository`           | ✅ done | full catalog CRUD (no secrets)                                                                     |
| `environmentRegistryRepository`          | ◑ part  | reads only; provision writes/access-cipher decrypt = secrets-delegation slice                      |
| `observabilityConnectionRepository`      | ✅ done | settings CRUD (sealed); gate-probe decrypt = secrets-delegation slice                              |
| `releaseHealthConfigRepository`          | ✅ done | per-block config CRUD                                                                              |
| `incidentEnrichmentConnectionRepository` | ✅ done | settings CRUD (sealed)                                                                             |
| `packageRegistryConnectionRepository`    | ✅ done | settings + decrypt-time reads (sealed)                                                             |
| `testSecretsRepository`                  | ◑ part  | inspector CRUD + run-path read (sealed); `listByWorkspace` no consumer yet                         |
| `runnerPoolConnectionRepository`         | ✅ done | connect/rotate/disconnect (sealed `secretsCipher`)                                                 |
| `binaryArtifactMetadataStore` (metadata) | ✅ done | metadata CRUD; bytes → per-account blob backend; retention sweeper                                 |
| `slackConnectionRepository`              | ✅ done | connect/disconnect (sealed `tokenCipher`); `getByTeam` inbound-OAuth internal                      |
| `slackSettingsRepository`                | ✅ done | per-workspace routing (no secrets)                                                                 |
| `slackMemberMappingRepository`           | ✅ done | per-account mention map (no secrets)                                                               |
| `promptFragmentRepository`               | ◑ part  | owner-scoped library mgmt; `listBySource` (repo-sync) pending                                      |
| `fragmentSourceRepository`               | ◑ part  | owner-scoped list + link; id-keyed sync mgmt pending                                               |
| `accountSkillRepository`                 | ✅ done | whole repo: catalog reads (run path) + the source-keyed sync writes                                |
| `skillSourceRepository`                  | ✅ done | account list + link + the id-keyed sync mgmt; global `listByRepo` internal                         |
| `documentRepository`                     | ◑ part  | run-path context reads; mgmt writes pending (module needs the connection repo)                     |
| `taskRepository`                         | ◑ part  | run-path context reads; mgmt writes pending (module needs the connection repo)                     |
| `githubInstallationRepository`           | ◑ part  | `getByWorkspace` + `listActiveForAccount` run-path reads; id-keyed / sync writes pending           |
| `repoProjectionRepository`               | ◑ part  | `list` (SPA + run path); sync/repo-write surface pending; `listByInstallation` internal            |
| `branchProjectionRepository`             | ◑ part  | `listByRepo` read; `upsertMany` sync pending                                                       |
| `pullRequestProjectionRepository`        | ◑ part  | `listByWorkspace` read; sync/per-repo reads pending                                                |
| `issueProjectionRepository`              | ◑ part  | `listByWorkspace` read; sync/per-repo reads pending                                                |
| `commitProjectionRepository`             | ⬜ todo | sync-write slice (all pending/sweeper/helper)                                                      |
| `checkRunProjectionRepository`           | ⬜ todo | sync-write slice (all pending)                                                                     |
| `userRepository`                         | ◑ part  | member-display reads (`get`/`listByIds`, co-membership scope); identity/auth reads leak hash → off |
| `invitationRepository`                   | ◑ part  | `listByAccount` read; `create`/`setStatus` admin, accept-invite lookups pre-auth                   |
| `emailConnectionRepository`              | ◑ part  | `getByAccount` read (sealed); connect/disconnect admin                                             |
| `passwordResetTokenRepository`           | ⬜ todo | pre-auth flow (all pending; `deleteExpired` sweeper)                                               |

**Excluded (never remotely invocable — admin-gated, so the token-scopes-accounts-not-roles rule keeps them off):**

| Port                        | Reason                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `accountSettingsRepository` | admin (read + write both `requireAdmin`; sealed but role-scoped) — NOT a remote TODO |

**Local (`node:sqlite` — per-user/per-deployment credentials + settings, never the mothership):**

| Port                                  | Status  | PR                                |
| ------------------------------------- | ------- | --------------------------------- |
| `providerApiKeyRepository`            | ✅ done | PR 1 (store)                      |
| `localModelEndpointRepository`        | ✅ done | PR 1 (store)                      |
| `providerModelCatalogRepository`      | ✅ done | local bucket                      |
| `providerSubscriptionTokenRepository` | ✅ done | PR 3 (local subscription bucket)  |
| `personalSubscriptionRepository`      | ✅ done | PR 3 (local subscription bucket)  |
| `subscriptionActivationRepository`    | ✅ done | PR 3 (local subscription bucket)  |
| `userSecretRepository`                | ✅ done | local bucket                      |
| `userRepoAccessRepository`            | ✅ done | local bucket (per-user redaction) |
| `environmentUserHandlerRepository`    | ✅ done | local bucket (per-user handlers)  |
| `localSettingsRepository`             | ✅ done | PR 3 (local subscription bucket)  |
| durable execution work queue          | ✅ done | PR 1 (in-proc) → PR 2 (durable)   |
| cached mothership machine token       | ✅ done | PR 3                              |

**Telemetry (local-first `node:sqlite` — PR 5; batch sync UP landed, read-through still to come):**

| Port                               | Status  | Notes                                                                         |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `llmCallMetricRepository`          | ✅ done | whole repo local (`summarizeByExecution` stopgap removed from the allow-list) |
| `agentContextSnapshotRepository`   | ✅ done | whole repo local                                                              |
| `agentSearchQueryRepository`       | ✅ done | whole repo local                                                              |
| `subscriptionQuotaCycleRepository` | ✅ done | whole repo local (both scopes key on laptop-held credentials)                 |
| `provisioningLogRepository`        | ✅ done | whole repo local (the node provisions the infra these rows describe)          |

Batch-ingesting a FINISHED run's rows up to the mothership (so hosted teammates can read them, and
they survive the local prune) has LANDED for the three run-scoped sinks, via
`POST /internal/telemetry/ingest` — see "Cross-cutting delegation". `provisioningLogRepository`
(nullable `executionId` — an environment outlives the run that provisioned it),
`subscriptionQuotaCycleRepository` (both scopes key on laptop-held credentials) and an LLM call
that resolved no run at all (`execution_id IS NULL`) are deliberately NOT ingested. What remains is
the READ-THROUGH fallback for a run whose local rows were pruned.

Two properties of the sweep are load-bearing and easy to undo by accident, because both failure
modes look like success:

- **Only a resolved `ingest` may advance a run's high-water mark**, so anything that did not upload
  must THROW. A client that returns a zeroed result when the node holds no machine token reads to
  the sweep as "this run had no rows", marks it, and hands the rows to the prune —
  `MachineTokenUnavailableError` exists to make that case a rejection.
- **Batches are budgeted by BYTES as well as row count.** The mothership refuses on either, so a
  page built to the row cap alone can sit permanently over the body cap: 413 forever, the same
  doomed page every sweep. A row too big to post even alone is skipped and REPORTED, never retried
  into a stall.

`tokenUsageRepository` is deliberately NOT in this bucket:

| Port                   | Status  | Notes                                                                   |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| `tokenUsageRepository` | ✅ done | budget SAFEGUARD, fully remote: rollup reads + `record` (`usageRecord`) |

## Cross-cutting delegation (not per-call repo proxies)

- **GitHub installation tokens** ✅ landed. `POST /internal/github/installation-token` (machine-authed,
  rate-limited per node, scoped by the installation's account binding) mints the mothership App's
  short-lived installation tokens for the laptop, **repo-scoped** via `repository_ids` to the live
  App-linked `github_repos` projection for the installation; `DelegatedAppTokenSource` consumes them
  as the push-token mint + the `FetchGitHubClient` token source when no `GITHUB_PAT` is set. The App
  private key never leaves the mothership, and a delegated token never grants more than the
  mothership projects. (Projection WRITES — sync ingest, `setMonorepo`, cursors — remain
  mothership-owned; the repo-write projection-refresh slice is still open.)

  > **Reality check (code vs plan).** GitHub token delegation (above), the persistence RPC, real-time
  > in BOTH directions, notification DELIVERY delegation, and telemetry INGEST (below) are all
  > IMPLEMENTED. The one remaining bullet that is DESIGN ONLY is PR 4's email half — no
  > `/internal/email` endpoint exists (a grep finds it only in this doc + ADR 0009). The six live
  > `/internal/*` routes today are `POST /internal/persistence`,
  > `POST /internal/github/installation-token`, `POST /internal/events/publish`,
  > `GET /internal/events/subscribe/:workspaceId`, `POST /internal/notifications/deliver`,
  > `POST /internal/telemetry/ingest`, and `GET /internal/foundational-services`
  > (+ `/:serviceId/contracts`).

- **Real-time — BOTH directions ✅ landed.** The OUTBOUND leg is
  built via the EXISTING cross-node `WebSocketPropagator` seam rather than a bespoke publisher: a
  `MothershipWebSocketPropagator` (`@cat-factory/local-server`) POSTs each engine event to the new
  machine-authed `POST /internal/events/publish`, layered over the local hub so every event fans to
  the laptop's own SPA AND the mothership. The mothership injects it into its OWN real-time fan-out
  via the `MachineEventRelay` seam (`@cat-factory/server`), implemented symmetrically on both facades
  — `LocalMachineEventRelay` (the Node hub / propagator) and `DurableObjectMachineEventRelay` (the
  per-workspace `WorkspaceEventsHub` Durable Object) — so hosted teammates see the local node's
  activity live. Account-scoped + default-deny exactly like the persistence RPC.
  The INBOUND leg landed on exactly the design sketched here and NOT on the per-runtime subscriber
  registry once feared: `GET /internal/events/subscribe/:workspaceId` hands the machine-authed
  handshake to the SAME per-workspace realtime `upgrade` seam (`gateways.realtime.upgrade`), so a
  subscribed node is just another socket in the workspace's room on either runtime, and the origin
  node's echo is suppressed by threading its stable subscribe `?cid=` through the outbound publish as
  `originConnectionId`. On the laptop, `MothershipEventSubscriber` holds one stream per workspace with
  a local subscriber (driven by the hub's new room-transition seam) and re-broadcasts into the bare
  hub. SPA wire protocol unchanged in both directions. See "Landed so far" for the full shape.
- **Notifications ✅ landed.** Row persists via the remote `notificationRepository`; IN-APP delivery
  rides the real-time upstream relay (the laptop's own in-app channel publishes through the layered
  propagator, so the frame reaches the mothership's browsers); **EXTERNAL** (Slack) delivery is
  mothership-side via `RemoteNotificationChannel` → `POST /internal/notifications/deliver`
  (machine-authed, account-scoped, identifiers-only so the mothership delivers its OWN row). Each
  facade wires the seam with its external channels only, so the two `/internal/*` surfaces never
  double-push the same notification. See "Landed so far" for the full shape.
  **Residual (later secrets-delegation slice):** delivery of a notification whose Slack connection
  was sealed by a LAPTOP under the LOCAL key — the mothership can't decrypt it, mirroring the
  observability gate-probe residual.
- **Email (PR 4 — deliberately NOT built; no reachable consumer today).** The design stands —
  `RemoteEmailSender` → `POST /internal/email/send`, mothership decrypts the account key and sends,
  keys never reach the laptop — but nothing on a mothership-mode node can currently reach the
  `EmailSender` port: its only consumers are `InvitationService` (whose `invitationRepository.create`
  / `setStatus` are admin-gated and therefore excluded from the RPC allow-list) and
  `PasswordResetService` (a pre-auth flow the mothership serves itself). Building the endpoint now
  would ship an untriggerable path. Revisit when a later slice adds the role dimension to the token
  scope (unblocking the invite surface) or an email NOTIFICATION channel lands — at which point it
  is a direct copy of the notification-delivery shape above.
- **Telemetry ingest ✅ landed (PR 5, second half).** The local-first CAPTURE half (store + local
  TTL pruner) and now the sync UP: the bulk `POST /internal/telemetry/ingest` (append-only,
  deliberately its OWN endpoint rather than allow-listed RPC methods — per-row remote writes are
  exactly what the bucket forbids) plus the node's quiescence-driven batch sweep. Batches are
  account-scoped like the persistence RPC, and the mothership STAMPS the batch's workspace + run
  onto every row it stores, so a node can only ever file telemetry for a run in a workspace it can
  already reach. The append is idempotent by row id (the ports' `recordMany`), which is what makes
  a lost-ack chunk safely retryable and what lets a failed upload leave the run's high-water mark
  alone. See "Landed so far" for the full shape.
  **Still open:** READ-THROUGH — a node rendering a run whose LOCAL rows were already pruned still
  shows nothing, though the mothership now holds them and its own surfaces render them. That needs
  a bounded machine read (never a bulk one), and is the last piece of PR 5.

## Phased delivery

- **PR 0 — this tracker doc.** ✅ landed.
- **PR 1 — vertical slice (the SPINE).** ✅ landed — the persistence-RPC spine + local consumer side.
  See "Landed so far". The board-load + run end-to-end surface that makes it functional landed under
  Phase 3 (the merge gate, **MET**).
- **PR 2 — real-time both directions + durable SQLite work queue.** ✅ **landed.** Durable SQLite
  work queue, real-time UPSTREAM (outbound) and real-time INBOUND (subscribe) are all in — see
  "Landed so far". **Remaining (carried to PR 6):** the local-sqlite conformance binding via a fake
  mothership server, which is a test-harness gap rather than a product one (the inbound leg is
  covered per-facade plus by the shared mounted-and-machine-gated assertion).

### Phase 3 — Functional repository surface (THE MERGE GATE)

✅ **MET.** The phase that makes mothership mode actually work. Split across several PRs (slices 1–4 +
the follow-up surface-completion slices in "Landed so far"). **Exit criteria — MET:** a mothership-mode
`buildLocalContainer` loads a board and drives a run to a persisted terminal state against a real RPC
backend, asserted by `mothership-integration.spec.ts` (green). The three parts of the work were:

1. **Route every direct-db store through the remote surface when `db` is undefined** — via the
   `pickRepoSource(remoteRepos, name, build)` seam (slice 3, extended in slice 4 for the
   `AgentContextBuilder` sub-helper repos, then documents/tasks/environments/fragments/**slack**).
   STILL TODO: the sub-helper surfaces genuinely off the board-load + run path — the document/task
   CONNECTION repos (which decrypt inside, so their whole integration module stays off) and
   environment PROVISION writes. (Telemetry repos are local-first — PR 5 gave them their own
   `node:sqlite` store, layered over the remote registry, instead of the best-effort no-ops they
   used to degrade to.)
2. **Widen `REMOTE_PERSISTENCE_METHODS`** to the board-load + run methods, each with a correct scope
   rule (`workspace` / `workspaceField` / `account` / `accountField` / `block` / `blockList` /
   `serviceList` / `service` / `serviceMount` / `usageRecord` / `owner` / `ownerField` /
   `visibility` / `selfUser` / `user` / `userList`). The
   boundary is security-sensitive: a machine token scopes ACCOUNTS not roles, so admin-gated mutations
   and global sweeper reads stay excluded. Ongoing surface-completion is the follow-up slices + the
   `pending` entries in the drift guard.
3. **Expose those repos in the mothership-side registry** (the dispatcher reflects over it) with
   round-trip + cross-account-scope tests + the fake-mothership integration test (slice 4).

Residual items (provisioned-env secret decryption; best-effort kaizen no-ops; the
document/task connection integration, blocked on the decrypt-inside connection repos) are NOT on the
basic board-load + run path. (Subscription activation and the Slack settings surface are no longer
residuals — PR 3 landed them; see "Landed so far".)

- **PR 4 — notifications + email + Slack delegation.** Notification/Slack DELIVERY delegation **✅
  landed** (`POST /internal/notifications/deliver` + `RemoteNotificationChannel` — see "Landed so
  far"). Email delegation is deliberately deferred until it has a reachable consumer (see
  "Cross-cutting delegation"). **Remaining:** mothership-side delivery of a laptop-sealed Slack
  connection (rides the secrets-delegation slice).
- **PR 5 — telemetry/logs local-first sync.** ◑ The local-first CAPTURE half (the `node:sqlite`
  telemetry store, the registry composition seam, the spend-ledger split, the local prune) and the
  batch sync UP (`POST /internal/telemetry/ingest`, the ports' `recordMany`, the node's
  quiescence-driven sweep) have both **landed** — see "Landed so far". **Remaining:** the
  read-through fallback, so a node still renders a run whose local rows were pruned.
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
