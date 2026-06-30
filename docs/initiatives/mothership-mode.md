# Initiative: mothership mode for local mode

**Status:** in progress (PR 1 spine landed) · **Owner:** core · **Started:** 2026-06-30

> This is the durable source of truth for a multi-PR initiative. Read it FIRST before picking
> up the next slice; update the checklist at the end of each PR.

### Landed so far

- **PR 0** — this tracker.
- **PR 1 (spine)** — the persistence-RPC core in `@cat-factory/server`: the `machine` token
  audience, the wire envelope + method allow-list + scope table + dispatcher
  (`src/persistence/rpc.ts`), the `Proxy`-backed `createRemoteRepositories`
  (`src/persistence/remoteRepositories.ts`), the `POST /internal/persistence` controller, and
  a unit test covering the full round-trip (reads, undefined/null, rev write-back, DomainError
  re-throw, allow-list, cross-account scope). BOTH facades attach their repository registry
  (`ServerContainer.repositories`) so either can be a mothership, guarded by a cross-runtime
  conformance assertion.
- **PR 1 (remaining)** — the local-facade *consumer* side: the `node:sqlite` credential store +
  local cipher, the `LOCAL_MOTHERSHIP_URL` switch composing remote + local repos in
  `buildLocalContainer`, the no-Postgres `startLocal` boot path with an in-process work runner,
  and the `config.mothership` SPA flag. The six pilot repos below are remotely *callable* now;
  this slice makes a local node *consume* them.

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
| `workspaceRepository`                                       | remote                                           | ⬜ todo | PR 1                            |
| `blockRepository`                                           | remote                                           | ⬜ todo | PR 1                            |
| `executionRepository` (CAS/rev)                             | remote                                           | ⬜ todo | PR 1                            |
| `accountRepository`                                         | remote                                           | ⬜ todo | PR 1                            |
| `membershipRepository`                                      | remote                                           | ⬜ todo | PR 1                            |
| `pipelineRepository`                                        | remote                                           | ⬜ todo | PR 1                            |
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
| `providerApiKeyRepository`                                  | local-sqlite                                     | ⬜ todo | PR 1                            |
| `localModelEndpointRepository`                              | local-sqlite                                     | ⬜ todo | PR 1                            |
| `providerSubscriptionTokenRepository`                       | local-sqlite                                     | ⬜ todo | PR 3                            |
| `personalSubscriptionRepository`                            | local-sqlite                                     | ⬜ todo | PR 3                            |
| `subscriptionActivationRepository`                          | local-sqlite                                     | ⬜ todo | PR 3                            |
| `localSettingsRepository`                                   | local-sqlite                                     | ⬜ todo | PR 3                            |
| durable execution work queue                                | local-sqlite (replaces pg-boss)                  | ⬜ todo | PR 1 (in-proc) → PR 2 (durable) |
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
- **PR 1 — pilot vertical slice (the spine).** `machine` audience; `registerPersistenceController`
  (scope + allow-list); `PersistenceRpcClient` + `createRemoteRepositories` for the 6 core domain
  repos; local `node:sqlite` store + local cipher with `providerApiKey` + `localModelEndpoint`;
  `LOCAL_MOTHERSHIP_URL` switch + no-Postgres `startLocal` boot with an **in-process** work runner;
  static `LOCAL_MOTHERSHIP_TOKEN` for now; `config.mothership` flag to the SPA. Conformance:
  rev/undefined/scope round-trip on both runtimes. **Proves:** a Postgres-free local node loads a
  hosted board and runs a real local-container execution persisted to the mothership.
- **PR 2 — real-time both directions + durable SQLite work queue.**
- **PR 3 — login-based onboarding + full repository surface** (+ the `db: undefined` audit in
  `buildNodeContainer`).
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
  excluded; every call account-scoped to the token. Treat the `/internal/persistence` surface as the
  highest-risk new code.
- **`db: undefined` audit.** `buildNodeContainer` constructs some repos directly from `options.db`
  (projection repos, blob backends) rather than from `options.repos` — each must tolerate a missing
  db in mothership mode and route through the composed repos. This is the single largest correctness
  risk; it gates PR 3.
- **Pre-1.0 = no back-compat.** No shims for the old siloed-Postgres local mode; mothership mode is a
  parallel boot path selected by `LOCAL_MOTHERSHIP_URL`.
