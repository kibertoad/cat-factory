# CLAUDE.md — architecture & flow notes

Orientation for working in this repo. Product docs: [`README.md`](./README.md),
[`backend/README.md`](./backend/README.md), `backend/docs/`. Vocabulary traps (block vs task vs card,
runner/executor/transport, `runtimes/cloudflare` = `@cat-factory/worker`) are resolved in
[`docs/glossary.md`](./docs/glossary.md). Every `backend/packages/*` and `backend/runtimes/*` carries an
`AGENTS.md` with its entry point and a "where things live" map; the repository layout is the root
README's table (CI-guarded). Design records: [`backend/docs/adr/`](./backend/docs/adr/); in-flight
initiatives: `docs/initiatives/`.

**This file holds the cross-cutting RULES plus an index of the runtime flows.** Keep it to what applies
across features: a rule already enforced by a typecheck, a CI guard, or a linked doc does not need
restating here, and flow-specific detail belongs in that flow's doc.

## Governing principle: clean design over quick solutions

Default to the well-factored design, not the fastest thing that passes.

- **Fix causes, not symptoms.** No special-case at the call site, `try/catch` swallow, defensive `if`, or
  magic constant standing in for a real fix.
- **Respect the existing seams.** Extend through the app-owned registries (`AgentKindRegistry`,
  `GateRegistry`, `JudgeRegistry`, `PipelineRegistry`, `TaskTypeRegistry`, `VcsProviderRegistry`,
  `StepResolverRegistry`, `FoundationalServiceRegistry`), the kernel ports, and the runtime
  `gateways`. Copy the nearest good citizen
  instead of inventing a one-off.
- **No shortcuts that create debt.** Don't hard-code what should be configured, widen a type to `any` to
  dodge a modelling problem, or leave a half-wired feature behind a TODO. If the clean solution needs a
  new port/method/table, add it (mirrored across runtimes).
- **Prefer deleting to accreting.** Remove the obsolete path rather than keeping it beside the new.

### Size budgets are a split trigger, NEVER a number to raise

`scripts/check-file-size.mjs` and oxlint's `max-lines-per-function` are ratchets: they may only go DOWN.
When your change pushes a file or function over budget, extract the concern your change touches into a
cohesive collaborator taking a small deps object of bound callbacks, leaving a thin delegate behind (the
model: the `RunDispatcher` controller extractions, `FetchGitHubClient` → `reviewPosting.ts`). A budget
number may only change in your PR when a split made it smaller. If you believe a split is impossible,
STOP and say so rather than bumping silently.

## Backwards compatibility is NOT a goal

Pre-1.0, no external consumers. Do NOT add migrations, shims, dual-read/dual-write paths, deprecation
windows, or "legacy" fallbacks to preserve old data or old wire shapes. When a change makes existing
rows, tokens, config, or request/response shapes obsolete, it is fine for them to break: prefer the clean
shape and let stale state be re-created. Flag the break in the changeset.

## PR workflow

**Always finish a task with a PR, unprompted.** When the work is done, branch, commit, push, open a PR.
Don't commit task work directly to `main` unless explicitly asked; if you started on `main`, branch off
it before committing.

**A PR description is a reviewer briefing, never a restated diff.** Give the context the diff cannot
show: the problem and why now, the decisions made (especially alternatives considered and rejected — say
what and why), and what to watch for when reviewing (behaviour changes, a flagged compatibility break,
the riskiest part). Leave out file lists, "tests added", line counts, change-by-change narration.

**Fixing an existing PR (review findings OR red CI) lands on THAT PR's own head branch, pushed
immediately** — this overrides any environment-supplied "develop on branch X" instruction naming a
different branch, because CI and reviewers only act on the PR head. Never a scratch branch, never a
second PR. CI tests `pull/<n>/merge`, not the bare head, so a failure can come from code the base gained
after the PR forked: merge `origin/main` into the PR branch, fix there, and push with
`git push origin HEAD:<pr-head-branch>`.

### Documentation-staleness sweep before every PR

Docs are part of the change and CI cannot catch staleness. Match the sweep to the blast radius (a
one-line internal fix needs none; a new export / env var / capability / flow does):

- The package's own `README.md` + `AGENTS.md`.
- The root `README.md`: the repository-layout row, plus a "What it supports" row for a new user-facing
  capability.
- This file, only for a new CROSS-CUTTING convention or a change to a flow it indexes. Detail about one
  flow goes in that flow's doc.
- A higher-level doc must POINT AT a new deeper doc rather than restate or omit it, or it is lost.

### Bigger initiatives get a tracker document

Multi-PR work (cross-cutting refactor, registry-by-registry migration, strangler conversion) gets a
tracker under `docs/initiatives/` with the first PR: goal and rationale, target pattern (link the pilot),
a per-item checklist with PR links updated each slice, and the gotchas the pilot surfaced. A tracker also
earns its keep when an initiative is REDIRECTED, so the next iteration doesn't re-propose a withdrawn
approach.

**When the committed scope completes, convert the tracker into a numbered ADR under `backend/docs/adr/`
(`NNNN-slug.md`, next free number) and `git rm` the tracker in the same PR.** Keep Context / Decision /
Rationale / Consequences; drop the checklists. Header shape: `# ADR NNNN: <title>` plus a `Status` /
`Date` / `Context layer` bullet block.

## Environment quirks

- **Do not validate Cloudflare auth before deployments.** Skip `wrangler whoami`; assume the login is
  correct.
- **Multi-line git messages: bash heredoc in the Bash tool, NOT a PowerShell here-string.** The Bash tool
  is POSIX sh, so `@'…'@` leaks literal `@` characters into the commit subject. Use
  `git commit -F - <<'EOF'`; `git commit --amend -F -` fixes a mangled message before pushing.
- **Worker tests fail on Windows** (`config wrangler validation failed`) — a pre-existing wrangler issue.
  Verify pure-logic changes from `backend/packages/orchestration` with `pnpm test:run`.
- **ALWAYS format/lint-fix the ENTIRE tree, never a subset.** `pnpm exec oxfmt .` from the root, or
  `pnpm lint:fix` for both. **NEVER** pass a path or glob to `oxfmt`/`oxlint`, for any reason: the only
  correct argument is `.`. On Windows the whole-tree run rewrites line endings across hundreds of files;
  that churn is expected and git's line-ending normalization absorbs it at commit time. Run it ONCE at
  the end and trust the result — do not diff, stash, or investigate why an untouched file was reformatted
  (it sweeps up pre-existing drift, which is correct).

## Keep the runtimes symmetric

**Any change to one runtime facade must land the symmetric change in every other.** Both facades serve
the same `@cat-factory/server` app behind the same kernel ports, so a new repository, port
implementation, table, migration, cron task, gateway, or wiring added to one has to land in the other (D1
migration ⇄ Drizzle schema + `pnpm db:generate`; a Cloudflare `scheduled` cron ⇄ a Node `setInterval`
sweeper; a D1 repo ⇄ a Drizzle repo).

**A facade-parity gap is a showstopper, not a follow-up**, even when the second runtime "degrades
gracefully". Land both runtimes AND a conformance assertion in the same change, or don't land it. "Node
has no X yet" is acceptable only for behaviour that genuinely cannot exist on a runtime (a
Cloudflare-Container-only execution path), never for runtime-neutral domain behaviour that merely needs a
repository wired.

**Cross-runtime conformance is the enforcement**: `@cat-factory/conformance` exposes
`defineConformanceSuite(harness)`, the key backend behaviour as runtime-neutral assertions parameterised
by a `ConformanceHarness`. The Worker runs it inside workerd against real D1; Node and local against real
Postgres (local building through `buildLocalContainer` so its wiring can't drift). So a repository that
maps a column differently, or an engine path only one facade wires, fails a test instead of shipping.

## Every new feature ships MOTHERSHIP-READY from its first implementation

Mothership mode ([`mothership-mode.md`](./docs/initiatives/mothership-mode.md)) is a third deployment
shape: the local node runs the engine with **no main database**, reaching every org/durable repository
over the `/internal/persistence` machine RPC. A feature that works only against a direct `db` handle is
**incomplete**, exactly as a Cloudflare-only feature is, and the failure is silent — an un-routed method
fails on a developer's laptop at runtime, sometimes as a dead panel, sometimes (on a hot path such as the
real-time fan-out) as a rejected engine publish that kills the run.

**A new repository method picks one of four buckets IN THE SAME PR.** There is no fifth outcome — "it
doesn't apply to mothership mode" is not one — and `pending` is a _migration_ state, not a landing pad
for new work. The tracker holds each bucket's implementation pattern:

- **`remote`** (the default for org/durable state) — allow-list it in `REMOTE_PERSISTENCE_METHODS`
  (`packages/server/src/persistence/rpc-allowlist.ts`) with a correct scope rule, plus a round-trip AND a
  cross-account-refusal test in `packages/server/test/persistenceRpc.spec.ts`. If no existing rule binds
  your arguments, add a rule — never widen an existing one to fit.
- **`local-sqlite`** (a per-user/per-deployment credential or local-runner knob) — implement the
  `node:sqlite` repo and thread the `NodeContainerOptions` override, so the feature is ON rather than
  silently off for lack of a `db`.
- **`telemetry`** (append-heavy, hot-path, short-retention run observability) — implement it in the local
  facade's `sqlite/telemetryStore.ts`, name it in `LOCAL_FIRST_PERSISTENCE_REPOSITORIES` (this TYPES the
  composition, so omitting it fails to compile), and prune it in `telemetryRetention.ts`. Do NOT also
  allow-list it. The test for whether state belongs here rather than `remote` is what READS it — the spend
  ledger has this write profile but its rollups gate org budgets, so it is `remote`.
- **`excluded`** (admin-gated, a sweeper, or otherwise mothership-internal) — say so in the drift guard's
  classification map, with the reason.

Also: **a new service reading a repo off `options.db` must route through `pickRepoSource`** or it is a
`TypeError` the moment the node boots without Postgres; **a new cross-cutting concern is its own
`/internal/*` endpoint** on BOTH facades behind the machine-token audience pin and account scope, never a
new hole in the persistence proxy; and **a new secret must state which key seals it** — a repo returning
its credential SEALED can go remote, one that decrypts INSIDE the repo cannot, because the mothership's
`ENCRYPTION_KEY` never reaches a laptop.

## No N+1 repository access

**Calling a single-row repository method inside a loop (`for`, `.map`, `Promise.all`) over a list is
BANNED**, in the service layer, the facade repos, and the HTTP layer alike. Instead:

- **Batch with one chunked `IN` query** via a `listByIds` / `listByFrameBlocks`-shaped port method,
  indexed into a `Map`. If no batch method exists, ADD one (mirrored D1 ⇄ Drizzle, with a conformance
  assertion). A read method needs no migration.
- **Reuse an already-fetched list** by indexing it into a `Map` rather than re-querying.
- **Hoist invariant reads out of the loop.**
- **Push counts/aggregates into SQL** (`COUNT`/`SUM`/`GROUP BY`), never reduce rows in JS.

Good citizens: `WorkspaceMountRepository.countByServiceIds`, `ServiceRepository.listByIds`,
`TaskRepository.listByRefs`, `BoardService.removeBlock`.

## Logging goes through the kernel `Logger` port, never a local logger interface

Every package logs through ONE injected interface — kernel's `Logger` (`ports/logging.ts`):
`debug`/`info`/`warn`/`error`, each `(msg, fields?)` (message FIRST), plus `child(bound)`.
`@cat-factory/server`'s `observability/logger.ts` is the ONLY place a logging library is named. Full
patterns: [`backend/docs/logging.md`](./backend/docs/logging.md).

- **A local `interface XLogger { warn(obj, msg?) }` is BANNED**, as is a bespoke
  `log?: (event, msg) => void` callback dependency. A package that can't see kernel is in the wrong layer.
- **A service takes `logger?: Logger` and normalises ONCE** (`this.log = deps.logger ?? noopLogger`) so it
  stays unit-testable standalone, but **`CoreDependencies.logger` is REQUIRED** — a facade that forgets to
  wire it must fail to typecheck rather than silently run the whole engine on `noopLogger`.
- **`.catch(() => {})` is BANNED; use `runBestEffort(logger, label, fn, fields)`** (kernel). It keeps the
  swallow — a best-effort path must NEVER propagate into its caller — and adds one `warn` naming the
  operation with the cause attached. Where a bespoke `catch` is genuinely right, still bind the cause with
  `describeError(error)`. `scripts/check-silent-catch.mjs` enforces this (detection in
  `scripts/silent-catch.mjs`, with fixtures — extend those when you touch it); EVERY spelling of an empty
  handler counts, including a body holding only a comment. A drop that genuinely needs no report keeps the
  idiom under a `// silent-catch-ok: <why>` comment. Out of scope: the executor/deploy harnesses (a source
  change there bumps the runner image) and the SPA (no logger yet).
- **`describeError` scrubs through `redactSecrets`**, because a `fetch`/spawn/SDK error routinely echoes
  the request URL or an auth header. Any OTHER field carrying command output, a URL, or model text goes
  through `redactSecrets` at the emit site. Never log an auth header or a decrypted credential — not even
  at `debug`, which operators turn on in production.
- **Correlate with `child`, not per-call spreads**: bind `{ workspaceId, executionId }` once at the top of
  the scope. Three seams do it for you: `mountRequestLogging` (mounted FIRST by both facades — mints or
  adopts `X-Request-Id`, binds a request-scoped child reachable as `requestLogger(c)`, and puts the id in
  every error envelope), `containerJobLog` (the workflow↔container seam; the same ids ride the job body so
  the harness binds them beside `jobId`), and the durable drivers. A request line logs the PATHNAME only —
  a query string carries the WS `?ticket=` and OAuth `?code=`.
- **`LOG_LEVEL`** is applied FIRST in each boot path and an unrecognised value falls back to `info`. The
  threshold is checked in the adapter, not on the pino instance — pino children snapshot their parent's
  level at creation.
- **Assert the evidence in tests** with kernel's `createRecordingLogger()`.

## A controller REFUSES by throwing a `DomainError`, never by building an envelope

`handleError` (`@cat-factory/server`'s `http/errorHandler.ts`) is mounted as `app.onError` on every
facade and is the ONE producer of the `{ error: { code, message, details } }` wire envelope. A hand-built
`c.json({ error: { code: 'unavailable' } }, 503)` is BANNED: an envelope literal structurally cannot
carry `details.reason` — the machine-readable code the SPA maps to translated copy and remedy actions.

- **The vocabulary is kernel's `domain/errors.ts`**, and every member takes `details`: `NotFoundError`
  404, `UnauthorizedError` 401, `ForbiddenError` 403, `ConflictError` 409, `ValidationError` 422,
  `CredentialRequiredError` 428, `RateLimitedError` 429, `UnavailableError` 503. Adding a status means
  adding a class plus its row in `STATUS_BY_CODE` and in the persistence-RPC `ERROR_STATUS` map — both are
  `Record<Code, …>`, so both fail to compile until mapped.
- **`code` is the STATUS CLASS; the machine-readable cause is `details.reason`.** Never invent a new
  `code` value to express a reason.
- **Guard with the total accessors**, not a nullable read plus an `if` at every route:
  `requireCapability(c.get('container').x, 'X is not configured')` and `requireUser(c, 'Sign in to …')`
  (`http/guards.ts`). A per-controller `requireX(c): X` that throws is the shape; a `requireX(c): X | null`
  paired with a local `unavailable()` thrower is what it replaced. The exception is a boolean FLAG
  (`cfg.passwordEnabled`) — no value to narrow, so it throws directly. **A capability behind a capability
  gets its OWN accessor** (a library module's `sourceService`, wired only when GitHub is), never a message
  borrowed from its parent, which would name a module the operator has already wired.
- **A guard whose value the route ignores uses the `assert*` twin**, never a discarded `require*`:
  `assertCapability` / `assertUser` return `void`, so the line reads as the refusal it is, where a bare
  `requireClarity(c)` statement reads as a no-op the next cleanup deletes with no test failing.
- **Rethrow, don't re-map.** Catching a `ConflictError` to re-emit it as `c.json({code:'conflict'})` drops
  its `reason`. The one deliberate exception is a handler that flattens distinct causes ON PURPOSE because
  the distinction is an ORACLE (password reset: "no such token" / "expired" / "used").
- **Three surfaces keep hand-built envelopes, each documented at the site**: the LLM/web-search proxy pair
  (each failure must be RECORDED on the call metric before responding, and they answer 402/413/502),
  `publicApiAuth`/`PublicDecisionController` (failures are DATA, so the contract handlers stay typed
  against their declared response schemas), and the `/internal` relay controllers (a different
  `{ ok: false }` shape their machine clients parse).
- **A test driving a controller through a bare `new Hono()` must mount `app.onError(handleError)`**, or
  every refusal reads as a 500.

## Caching goes through the app cache seam, never a homebrew Map

A per-service `Map` with a manual TTL, a module-global memo, or an ad-hoc `{ value, expiresAt }` store is
BANNED: it can't be invalidated across a scaled Node deployment. The seam is the kernel `AppCaches` port
(`kernel/src/ports/caching.ts`), implemented by `@cat-factory/caching` and exposed as `container.caches`.
Register a new entry on the interface, in `AppCachesProfile` plus both profiles, and build it in
`createAppCaches` — copy `repoProjection` or `fragmentDocumentBody`. Slice pattern:
[`caching-layer.md`](./docs/initiatives/caching-layer.md).

- **Invalidate on EVERY write** right after it commits. Invalidation, not the TTL, is the coherence story;
  a cached read with no invalidation on its write path is a bug.
- **Pass-through on the Worker for OUR OWN mutable state** (`enabled: false` in the isolate-safe profile):
  an isolate has no cross-isolate invalidation bus, so only immutable or sha/version-probed entries keep a
  real TTL there.
- **Wrap a nullable value** (`{ value: T | null }`) — layered-loader treats bare `null` as unresolved.

## Concurrency, idempotency, replay

The durable drivers REPLAY, and two writers routinely race. Each of these was learned from a real
data-loss bug; they bind any new write path.

- **A row that is ONE JSON blob is rev-guarded, never blind-upserted.** The iterative-review stores carry
  a `rev` and a `compareAndSwap`; `IterativeReviewService.mutateReview` loads, applies, CASes, and on a
  lost race RELOADS and RE-APPLIES on the winner's snapshot. So a mutation handed to it must be IDEMPOTENT,
  and notifications/dispatches go AFTER it resolves, on the returned value. Exhausting the bounded retries
  throws `ReviewContendedError` — a 409 to an HTTP caller AND the durable driver's re-drive signal.
- **"One live row per X" is a UNIQUE INDEX, never a transaction around delete-then-insert.** At Postgres'
  default READ COMMITTED a DELETE takes no predicate lock, so two publishers both delete nothing and both
  insert; SQLite serializes writers, so the same code is accidentally safe on D1 — which is the trap, since
  a sequential conformance test passes on both. Publish through one conflict-targeted upsert, assert the
  invariant with CONCURRENT writers, and heal pre-existing duplicates in the constraint-adding migration.
- **An external side effect in a replaying driver is guarded by an ATOMIC CLAIM taken BEFORE the effect**,
  never a marker written after. Such a design must answer "what if the claimer dies": `failed` is
  re-claimable, the terminal state is not, and `pending` becomes re-claimable past a TTL. **Commit the
  local state FIRST and run the outbound call behind it**, so an upstream outage costs the notification and
  never the data. **A claim that ERRORS must propagate, never degrade to "already done"** — the apply is
  idempotent precisely so the queue can retry.
- **First write wins where the row's value derives from a chain**; never an upsert. Streamed telemetry
  arrives twice with the same minted id, so both repos target the ID alone
  (`onConflictDoNothing({ target: id })` ⇄ `ON CONFLICT(id) DO NOTHING`, NOT `INSERT OR IGNORE`, which
  would also swallow a constraint violation on one runtime only). An upsert would recompute the prompt
  delta against a moved chain tip.
- **A published value must be FINAL.** A producer whose numbers can arrive late publishes through a gate
  that WITHHOLDS the row until the correction can no longer fire, rather than landing a zero and dropping
  the fix.
- **Idempotency by CONTENT beats a marker row** where the work is a file rewrite: re-read, recompute,
  byte-compare.

## Untrusted text crossing a rendered surface

Model- and user-authored text reaches PR bodies, tracker comments and telemetry, and those are parsed
surfaces, not inert string sinks. The end-to-end trust-boundary model — what stands between an
injected/hallucinating agent and a malicious commit landing, layer by layer with its residual gaps —
is [`backend/docs/security-model.md`](./backend/docs/security-model.md); a change to the write path
(token minting or credential PRECEDENCE, the push, the merge decision, a rendered surface, the
native-child env allow-list) updates that doc in the same PR.

- **Kernel's `hostMarkdown` is the boundary.** The host auto-links `#123` / `@name` / `!123`, a **closing
  keyword before an issue reference CLOSES that issue on merge**, a raw newline ends a table row, and an
  unbalanced fence swallows whatever follows — including the machine-readable JSON block of the
  verification report. Every hole goes through `cell`, `inline` or `prose`, which neutralise the auto-link
  triggers with numeric entities in ONE pass (chained `.replace()`s re-escape each other).
- **The harness carries byte-for-byte COPIES of a few kernel helpers** (`host-markdown.ts`,
  `normalizeProxyPhase`, `isSafeTestPath`) because the image builds from `src/` plus typescript and can
  depend on no workspace package. Each is pinned by a conformity test — change one, change the other.
- **Scrub with `redactSecrets` at COMPOSE time**, before any truncation, so prose and JSON stay
  consistent. A PR body is strictly more exposed than the telemetry DB.
- **Model-authored strings that become shell or git arguments are validated for MAGIC, not just
  traversal**: `--` stops a path being read as a revision but does nothing about `:(glob)**` or `*`. A
  refused input counts as an omission that is REPORTED, never a silent shortening.
- **Captured command output reaching a model is fenced through `fencedOutput`** (`captured-command.ts`),
  sized one tick longer than the longest backtick run in the body — a fixed ``` fence closes mid-tail and
  spills the rest, plus the instructions after it, into what the model reads as prose.

## Degrade loudly: state what is missing, derive what is computable

- **"Absent" and "zero" must never render the same.** A report section whose producing step didn't run
  says `status: 'absent'` with a note; a sink the deployment doesn't retain says `available: false`, not
  `count: 0`. A silently missing section reads exactly like a clean one.
- **Distinguish the causes that need different fixes.** "No model configured" / "wired but broken" / "over
  budget" are three status values, not one; "no repo" / "read failed" / "recognised nothing" likewise.
  Never infer a cause from the mere presence of an error.
- **Every cap records what it dropped**, and a cap that is NOT a plain prefix says so — a reader who
  assumes a prefix would conclude the tail was never considered.
- **The model JUDGES; the platform COMPUTES.** A ranking, a score ratio, a regression count is derived in
  code from the model's stated judgements, never read off the reply, or a list is ordered by something its
  own rationale doesn't explain.
- **A best-effort side channel LOGS its failures** through `runBestEffort`, or a swallowed classification
  failure surfaces only as a permanently broken feature.
- **A pass-through is the correct disposition for an unwired capability**, and it must be invisible to the
  domain: a gate with no provider, a judge with no assessor, an unset validation config are all
  byte-for-byte the prior behaviour.

## Git-provider-agnostic (VCS) naming: never re-hardcode GitHub

The platform talks to multiple VCS providers (`github` + `gitlab`, extensible). Reintroducing
GitHub-specific names or a hard-coded `github.com` / `provider: 'github'` in a shared path silently breaks
GitLab deployments.

- **Neutral identity vocabulary** (`kernel/src/domain/vcs-types.ts`): `VcsProvider`, `VcsRepoRef`
  (`{ repoId, owner, repo }`), `VcsConnectionRef` (`{ provider, connectionId }`). Persisted and wire types
  name fields `repoId` / `connectionId` / `provider`, NEVER `githubId` / `installationId`; GitHub maps on
  via `githubConnectionRef` / `githubInstallationId`, the only place the GitHub shape of those ids is
  known. `@cat-factory/contracts` mirrors the union as `vcsProviderSchema` (keep the member lists in step).
- **Provider is a deployment-level fact resolved through `ResolveRepoOrigin`**, mapping a repo to
  `{ cloneUrl, provider }`. In any clone/dispatch path ride
  `this.deps.resolveRepoOrigin ?? githubRepoOrigin` and pass `origin.provider` to the harness `RepoSpec`.
  Never build a `https://github.com/...` URL yourself; a new repo leg (peer, reference) copies the
  primary's resolution.
- **GitLab is ADAPTED INTO the canonical client**, not bolted on beside it: `FetchGitLabClient` implements
  the kernel `VcsClient` and `vcsBackedGitHubClient` presents it as a `GitHubClient`, so the GitHub-shaped
  service layer works unchanged. The engine reads gates/merge/`RepoFiles` through **`engineVcsClient`
  (`githubClient ?? gitlabEngineClient`)**; keep it distinct from the App-only `githubClient`, or a GitLab
  deployment offers a dead "GitHub Issues" source. Frontend repo discovery is the GitHub-shaped store
  returning GitLab projects via the adapter — do not add a second store.
- **Per-workspace PAT connect reuses `github_installations`**, writing a `provider: 'gitlab'` row with the
  PAT sealed by the deployment `SecretCipher`. When a facade has BOTH a GitHub App and GitLab connect, the
  `github` module reads through **`ProviderRoutingGitHubClient`**, which dispatches per installation by
  stored provider (memoised, so no N+1). Don't hand-roll a second per-provider client or fork the module;
  keep facades symmetric (`selectVcsConnectDeps` ⇄ `selectWorkerVcsConnectDeps`).
- **What the SPA may connect comes from `GET /workspaces/:ws/vcs/connect-options`**, never inferred from a
  connection read. Presentation switches in ONE place: `app/utils/vcs.ts` `Record<VcsProvider, …>`
  constants plus provider-parameterised `vcs.*` i18n keys. Adding a provider extends those Records (the
  typecheck fails until you do), never a component fork.
- The migration is incremental: kernel ports are neutralized, but entity types (`GitHubRepo`, the
  `github_repos`/`github_installations` tables) are still GitHub-named and reused as-is. Copy the NEUTRAL
  shape for new surfaces; an un-migrated neighbour is not license to name a field `githubId`.

## Migrations

### Resolving conflicting Drizzle migrations (post-merge)

Node's Postgres migrations (`backend/runtimes/node/drizzle/`) use drizzle-kit 1.x snapshot v8: a
content-addressed DAG (each `snapshot.json` has an `id` and a `prevIds` array), not a linear journal.
`src/db/schema.ts` is the source of truth and `pnpm db:generate` diffs it; `migrate()` applies folders in
timestamp order, so `prevIds` affects only the consistency analysis. A merge keeps both branches' folders
with no textual conflict, but the later branch's `prevIds` still points at the pre-merge tip, so
`db:check` fails with "Non-commutative migrations detected". (D1 has no such DAG; duplicate numeric
prefixes are fine.)

Do NOT hand-merge snapshot JSON or rerun `db:generate` (a table move triggers an interactive rename
prompt that can't run in a non-TTY shell). Instead:

1. Resolve conflicts in `src/db/schema.ts` first, keeping BOTH branches' columns.
2. From `backend/runtimes/node`, run
   `node scripts/rebase-migration-snapshot.mjs <later-migration-folder>` — it rewrites that snapshot's
   `ddl` from the merged schema and re-points `prevIds` at every other migration's leaf,
   non-interactively. It does not touch `migration.sql`.
3. Check `migration.sql` still encodes the delta to the merged schema.
4. Verify with `pnpm db:check`. Keep the symmetric D1 migration in step.

### Migration safety: boot drift-guard, recovery, self-healing FKs

Node boots by running `migrate()` BEFORE `boss.start()` (sequential, so a migration failure is the clean
top-level rejection).

- **Ledger↔schema drift.** The drizzle ledger lives in its own `drizzle` schema, so a hand
  `DROP SCHEMA public CASCADE` wipes the data while the ledger still claims everything is applied.
  `assertSchemaConsistent` probes for this and throws `DbSchemaInconsistentError` naming the recovery; any
  other failure becomes a `MigrationFailedError` mapping the pg code to a cause and hint. Recovery is
  deliberate and destructive: `pnpm --filter @cat-factory/node-server db:reset` drops ALL app-owned schemas
  together so the ledger can never outlive the data. **Never hand-drop `public` alone.**
- **Self-healing FK migrations (both runtimes).** A migration adding an `ON DELETE RESTRICT` FK must first
  delete/NULL pre-existing orphans, or it hard-fails with `23503`. Heal then constrain, mirrored in the
  Postgres `migration.sql` AND the D1 rebuild. Deleting orphaned experimental data is acceptable;
  swallowing the error is not.
- **Configurable schemas for a shared database (Node)**, all defaulting to prior behaviour: `DB_SCHEMA`
  relocates the app tables via `search_path`, `DB_MIGRATIONS_SCHEMA` moves the drizzle ledger,
  `DB_PGBOSS_SCHEMA` moves pg-boss's. Each must be a plain lowercase identifier.

Test harnesses never touch the base `DATABASE_URL` DB: they require a per-vitest-worker database and use
the `postgres` maintenance DB for the admin connection.

## Runtime facades

The backend is runtime-neutral by construction: the domain and HTTP layer know nothing about Cloudflare or
Node, and each facade supplies only its differentiators behind the shared kernel ports and the
`container.gateways` seam.

- **Cloudflare Worker** (`runtimes/cloudflare` = `@cat-factory/worker`): D1, Workflows for durable
  execution, Durable Objects for real-time and per-run Containers, queues/cron, the `workers-ai` binding.
- **Node** (`runtimes/node`): Postgres via Drizzle, **pg-boss** for durable execution (`PgBossWorkRunner`
  enqueues `execution.advance`; `driveExecution` runs the same advance/poll loop with plain sleeps;
  `signalDecision` re-enqueues a parked run). Real-time is a per-workspace `NodeRealtimeHub` plus
  `attachRealtime`, serving the SAME raw-WebSocket + `?ticket=` protocol via a `ws` server on the HTTP
  `upgrade` event (`@hono/node-server` can't upgrade from a Hono `Response`, and the SPA speaks raw
  WebSocket). **Multi-node** rides a layered propagator behind a narrow `LocalEventSink` seam — Redis
  pub/sub today, another adapter on the same port tomorrow; with no bus the layer is exactly the bare hub.
  The Worker needs none of this (its `WorkspaceEventsHub` DO is globally addressed, so propagation is
  inherent — a genuine Node-only concern, not a parity gap). Container steps dispatch to a workspace's
  self-hosted runner pool, which runs the same harness image and therefore serves EVERY dispatch kind with
  no opt-in allow-list; unconfigured, the composite serves inline kinds and fails container kinds loudly.
- **Local** (`runtimes/local`): the Node facade with per-run local containers
  (`LocalContainerRunnerTransport` over a `ContainerRuntimeAdapter` selected by `LOCAL_CONTAINER_RUNTIME`)
  and GitHub reached via a PAT — both the push token and a PAT-backed `FetchGitHubClient` wiring the CI
  gate + merge providers, so a local pipeline gates on real Actions CI and merges for real.
- **Model provisioning** is composed per facade from `CompositeModelProvider`. Unconfigured providers
  aren't registered, so `resolve` throws a clear error instead of failing deep in the SDK. **Locally-run
  models** (Ollama / LM Studio / llama.cpp / vLLM / custom OpenAI-compatible) are per-user endpoints
  appended to `GET /models` with NO API key; the base URL is forwarded server-side, so it is constrained to
  a loopback/LAN allow-list (`localRunnerUrlError`) at the write boundary and the test probe.
- **`deploy/preview`** carries the per-PR TEST environments for THIS repo (board wiring:
  [`docs/dogfooding.md`](./docs/dogfooding.md)). Three constraints bite when editing: the compose file must
  stay free of `include:` / cross-file `extends` / `privileged` and of bind mounts / `env_file` (so it
  stays runnable by hand); the SPA there is built with an EMPTY `apiBase`, because a preview's host port is
  only assigned at `up` time and same-origin is the only workable topology; and the workflow's per-PR
  resource NAMES are a contract with `cloudflareEnvironmentConfigSchema`'s two name templates — rename in
  one place, rename in both.

### Local container adapters

`LocalContainerRunnerTransport` starts the executor-harness image per run and re-attaches later steps to
it, keyed by the per-step `RunnerJobRef.jobId`. Docker/Podman/OrbStack/Colima share the Docker-CLI
adapter; Apple `container` has its own. Two contracts bite:

- **`endpoint()` must map an EXITED container to `undefined`** (so `resolve()` reads it as absent and
  `dispatchPerRun` re-creates it) while still THROWING for a fault against a live one. A runtime that
  can't tell the two apart (Apple) takes the `undefined` half.
- **A container dying mid-run needs a post-mortem** (`exitState()` + a scrubbed `logs()` tail) onto the
  failed view's `detail`, since `release()` removes it as the run settles. A re-dispatch removes it too, so
  the FIRST death's post-mortem is retained on `PipelineStep.firstEvictionDetail`.

Each adapter exposes a `localDind` capability threaded into `ExecutionService` as
`localTestInfraSupported`, so a runtime that can't nest containers refuses a local-infra Tester run at
start.

## Dependencies, releases, new packages

### The `minimumReleaseAge` supply-chain gate

Installs reject any registry package published inside the ~24h cutoff. The allow-list is
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.

- **Only wildcard namespaces WE OWN** belong there (`@cat-factory/*`, `@toad-contracts/*`).
- **Never add a per-version third-party exception**, and delete any that accrue (non-strict pnpm appends
  them silently).
- **When upgrading, pick the latest version that already satisfies the rule**
  (`npm view <pkg> time --json`), staying within the compatible major.
- **Do not touch the executor-harness** during a dependency sweep: its deps feed the published image, so
  bumping them is a separate image-bumping change.
- **The Vercel AI SDK family is held to the major that pairs with `workers-ai-provider`**: today `ai@^7` +
  `@ai-sdk/*@^4` (`openai-compatible@^3`, `amazon-bedrock@^5`).

### Releases & changesets

Versioning is changesets (root `pnpm changeset` / `ci:publish`). **Always add a changeset for a change to
a versioned package**; empty changeset for docs/CI/test-only. CI enforces this.

**Any change to what goes into the runner image** (harness `src/**`, `Dockerfile`, `tsconfig.json`, the
pinned `PI_*` args) MUST bump `@cat-factory/executor-harness`'s version AND the matching tag in
`deploy/backend/package.json`, `deploy/backend/wrangler.toml`, and `RECOMMENDED_HARNESS_IMAGE` in
`backend/runtimes/local/src/harnessImage.ts`; then `pnpm image:publish` + `pnpm deploy` from
`deploy/backend`. The deployment serves the Cloudflare managed-registry image, not GHCR, so the GHCR
auto-publish does not roll it out. **Reusing a tag does NOT deploy** (`wrangler deploy` diffs by tag
string), leaving new containers on stale code — the symptom is `Container dispatch failed (HTTP 404)`.
Only a fresh immutable tag forces the rollout.

The release PR re-syncs the pins automatically, so don't hand-fix a red release PR. Consequence: the
released tag may differ from the one the feature PR published; content is identical, but the
managed-registry image for the released tag is only built at the next `image:publish` + `deploy`.
`pnpm sync:image-tags` reconciles by hand; `scripts/check-runner-image-tag.mjs` is the CI guard.

### Adding a new published package

A folder is not wired up by existing (two packages once published as empty shells because a bare
`pnpm publish` skipped the build and `dist/` is gitignored).

- **Full publish contract in `package.json`**, copied from `packages/gates`: `"files": ["dist"]`,
  `main`/`types`/`exports` at `./dist`, `publishConfig.access: "public"`, a `build` script, and a mandatory
  **`"prepublishOnly": "pnpm run build"`** hook.
- **Register it in `backend/tsconfig.build.json`** `references`. A package reachable only transitively
  drops out the moment that reference goes away.
- **Add a changeset** and **a row in README.md's repository-layout tables** (CI guards both).
- **Check knip knows about a dynamically-imported dependency** (`ignoreDependencies` in `knip.jsonc`).

Verify with `rm -rf dist && pnpm publish --dry-run --no-git-checks` from the package dir.

### Run the CI guard scripts locally before committing

> **Do NOT run `pnpm lint:knip` or `node scripts/check-package-catalog.mjs` locally.** They are slow and
> CI's `Build & typecheck` job is authoritative for both.

- `node scripts/check-file-size.mjs` — the file-size ratchet (split, don't raise).
- `node scripts/check-silent-catch.mjs` — bans `.catch(() => {})` in backend non-test source.
- `node scripts/check-component-imports.mjs` — requires every layer component used in a Vue
  template to be imported by path (a bare tag renders nothing, silently). See
  [`frontend/app/README.md`](./frontend/app/README.md#always-import-a-layer-component-explicitly).
- `node --test 'scripts/*.test.mjs'` runs both guards' own fixtures (CI runs all three).
- `pnpm exec changeset status --since=origin/main` — after committing locally.
- `pnpm lint:monorepo` (sherif) — cross-package dependency-version consistency.
- `pnpm check:publish` (after `pnpm build`) — publish-artifact integrity.
- `node scripts/check-runner-image-tag.mjs --since origin/main` — whenever anything image-affecting
  changed.
- `pnpm lint:fix` (whole tree) and `pnpm exec turbo run typecheck --filter=<touched package>` (typecheck
  covers tests, which the build configs exclude).

## Execution flow (the canonical async + observable pattern)

The gold standard for long-running agent work; anything new that runs an agent in a container mirrors it.

1. `ExecutionService.start()` (orchestration `src/modules/execution/`) creates an `ExecutionInstance` with
   steps and hands off to the durable driver.
2. `ExecutionWorkflow` (worker `infrastructure/workflows/`) is one Cloudflare Workflows instance per run,
   looping `advanceInstance` and parking on `waitForEvent` for human decisions. A cron sweeper re-drives
   runs whose instance died.
3. `ContainerAgentExecutor.startJob()` dispatches asynchronously (`/run`, non-blocking, returns a
   `jobId`); `pollJob()` polls and lifts `view.progress` into `subtasks`.
4. In the container, `runPi()` streams Pi's JSON-line events and `parseTodoProgress()` turns the todo
   tool's output into `{completed, inProgress, total}` via `onProgress` → `JobRegistry` → `JobView.progress`.
5. `ExecutionService.pollAgentJob()` writes `step.subtasks`/`step.progress` plus a THROTTLED
   `step.lastActivityAt` folded from the harness heartbeat (which keeps `updated_at` fresh so the
   stale-run sweeper doesn't orphan a quiet-but-alive job; ADR 0026 D3.1), then upserts and emits.
6. Events reach the browser by PUSH: `DurableObjectEventPublisher` → the `WorkspaceEventsHub` Durable
   Object (hibernatable WebSockets, one per workspace) → SPA `useWorkspaceStream.ts` → store → components.

**A dispatch records what the poll site cannot re-derive** (`recordDispatchAttribution`): the job settles
on the durable poll path, which rebuilds the handle from the STEP alone, so the resolved `model`, the
leased `subscriptionTokenId` and the run's `initiatedByUserId` are persisted on the step at dispatch and
re-supplied when polling. Anything a new executor resolves at dispatch and reads back off the handle must
join them, or it is silently absent in production — the symptom is attribution landing as
"unknown"/nobody, never an error.

## Harness rules

**Per-job state: NEVER a process- or HOME-global.** Anything the executor-harness stages for ONE job is
scoped to that job — explicit child env, or a per-job directory. Never `process.env`, never a dotfile
under `HOME`. This is a correctness rule: a global LOOKS per-job in a container, where one job owns the
process and `HOME`, but the local native transport (`LOCAL_NATIVE_AGENTS`, `LocalProcessRunnerTransport`)
serves EVERY concurrent `ambientAuth` job from ONE long-lived host process whose `HOME` is the developer's
own. Container tests keep passing while one job leaks into a sibling and files the developer owns are
destroyed.

- **`RunOptions.agentEnv`** → `SubscriptionRunOptions.extraEnv`, merged over the inherited env when the
  agent CLI is spawned; layer onto it with `withAgentEnv`. **Anything the HARNESS spawns itself must be
  passed `agentEnv` explicitly**, since a child of the harness inherits nothing.
- **A per-job directory** created in `handleAgent` for an `ambientAuth` job and removed with it — the
  private-registry npmrc goes there via `npm_config_userconfig`, because writing or clearing the real
  `~/.npmrc` corrupts the developer's own config.
- **State with no per-job form is NOT WRITTEN AT ALL** rather than written globally: a repo-sourced Claude
  Skill installs natively only into an isolated `CLAUDE_CONFIG_DIR`, and an ambient run reads it from the
  checkout's `.cat-context/skill/`. When you move state to the checkout, move the PROMPT with it. `~/.pi/*`
  is HOME-global only because the Pi harness never runs natively; do not extend that assumption.
- **Add a test that two concurrent jobs keep new per-job state separate** — the container path alone will
  not catch the regression.

**Any harness-spawned, activity-SILENT phase MUST feed the inactivity watchdog** on a 30s heartbeat.
`JOB_INACTIVITY_MS` (10 min) is tighter than a command's own watchdog, so without it a slow build or cold
install aborts the run as "inactivity". The agent's own stream emits activity; a raw `spawn` does not. A
phase's own watchdog is DERIVED from the configured `JOB_MAX_DURATION_MS`, never a constant sized against
today's default.

**A source change here bumps the runner image** (see Releases & changesets), which is why the harness is
out of scope for the silent-catch guard and why anything duplicated from kernel is pinned by a conformity
test.

## Gates vs agents (the step taxonomy)

A step's `agentKind` puts it in one of four buckets, and most engine handling keys off which:

- **Agents** — a container or inline LLM does the work (`coder`, `architect`, `spec-writer`, `tester`,
  `merger`, the companions). Dispatched via `CompositeAgentExecutor`; container kinds park on
  `awaiting_job`.
- **Polling gates** — `ci`, `conflicts`, `post-release-health`. A gate runs a **programmatic precheck**
  against a provider and only escalates to a helper container agent (`ci-fixer` / `conflict-resolver` /
  `on-call`) on a negative verdict; skip-unless-needed is the whole point. ONE generic machine drives every
  gate (`evaluateGate` / `dispatchGateHelper` / `pollGate`, parking on `awaiting_gate`); a
  `GateDefinition` supplies only `wired()`, `probe()` (pass/pending/fail), `helperKind` and `onExhausted`,
  and live state is `step.gate`. **Adding a gate is a new registry entry, never another
  `evaluateX`/`pollX`/`awaiting_x` triple** — ergonomics:
  [`custom-agent-gate-ergonomics.md`](./backend/docs/custom-agent-gate-ergonomics.md). The built-ins ship
  as `@cat-factory/gates` through the same public seam a deployment uses, and `defaultGateRegistry()` is
  EMPTY, so a container built with no injected registry installs them itself. Pure gate logic lives in
  kernel (`domain/gate-logic.ts`) so a gate package never depends on orchestration.
  **`resolveHelperCompletion`** is the seam for an INVESTIGATE-don't-fix helper (`on-call` never reverts),
  settling the gate without re-probing.
- **One-shot engine steps** — `tracker`, `deployer`, `requirements-review`. Bespoke handling; not gates
  because they don't poll-or-escalate.
- **Judges** — an inline LLM scores work against a rubric and the engine compares it to a per-task
  threshold, disposing: advance / park / bounce the producing step with findings as `rework` / fail.
  **Adding a judge is a new registry entry**; one driver (`JudgeStepController.evaluate`) owns the state
  machine and a `JudgeDefinition` supplies rubric, `parseVerdict`, `threshold`/`attemptBudget`, `onFail`,
  `bounceTargets`. State rides `step.judge` (no side table, so runtime-symmetric) and survives
  `resetStepForRerun`, or a bounce would erase the verdict it loops on. A failing verdict never silently
  advances: a spent budget or no bounce target degrades to a park. A judge is NOT a gate (no cheap
  precheck, no pending state, always costs a model call) and NOT a `StepCompletionResolver` (which can't
  park or loop). Model: [`judge-registry.md`](./docs/initiatives/judge-registry.md).
- **The `merger` resolver is a privileged built-in, deliberately NOT externalized.** It owns terminal block
  status (`ownsTerminalStatus`) and executes a policy-gated real merge, so it keeps engine-internal access
  rather than the minimal public `ResolverContext`. The public step-resolver seam is scoped to light
  follow-up; `ownsTerminalStatus` is built-in-only.

**A step's presence may be conditional on the task estimate; a HUMAN GATE never is.** Estimate gating
(`StepGating` → `shouldRunGatedStep` → `RunDispatcher.skipGatedStep`) skips a step when an earlier
`task-estimator`'s scores fall below its thresholds, and that is what lets ONE pipeline cover a range
that would otherwise need several near-identical presets (see
[`pipeline-catalog-collapse.md`](./docs/initiatives/pipeline-catalog-collapse.md)). Three rules bind it:

- **Gatability is a per-kind CAPABILITY, declared, and OFF by default** — `isGatableKind`
  (`agents/kinds/gatable.ts`), a `BUILTIN_GATABLE_KINDS` set beside the `AgentKindRegistry.gatable()`
  override, since built-in kinds are not registry entries. Gate a kind whose output later steps read as
  CONTEXT; never one some other mechanism reads STRUCTURALLY. `merger` is the sharpest case — its mere
  presence in `instance.steps` is what makes a committing kind deliver via a PR (`runOpensPr`), so a
  skipped merger opens a PR nothing merges. `deployer` provisions what its consumer reads,
  `conflicts`/`ci` are the guards, `bug-intake` is the run's subject. **A new kind whose absence would
  break rather than merely thin a run must stay unlisted**, and the default already does that for you.
- **A skipped producer CASCADES onto its companion** (`producerWasSkipped`), evaluated at the
  companion's own turn off the persisted `step.skipped` — a lookahead would not survive a durable
  replay. Without it a companion grades whichever step happened to precede it, sounding confident
  about the wrong artifact. So a companion needs no gate of its own to track its producer, and giving
  it a duplicate threshold is a second copy to keep in sync.
- **A step may not carry both `gates[i]` and enabled `gating`** (`assertValidGating`). The estimate may
  ADD a human checkpoint — that is what gating a `human-review` step on risk does — but never cancel an
  approval pause the author asked for, or a model's own triage decides nobody needs to look. Policy
  floors belong on the merge preset's `classRules`, keyed on the COMPUTED change class rather than the
  model's opinion.

The same precheck-first idea applies inline: `hasNotesToIncorporate` short-circuits
`runIncorporationCycle` so the rework + re-review LLM calls are skipped when the human left nothing to
fold in.

## Pipeline flows

An INDEX: what each flow is, plus the trap a change would hit. The linked doc is the authority — new flow
detail belongs there, not here. The cross-cutting rules these flows established are stated once above
(concurrency/idempotency, untrusted text, degrade loudly, harness rules).

**Built-in catalog lifecycle** — built-ins are COPIED into each workspace at creation (`seedPipelines()`,
`kernel/src/domain/seed.ts`), so code and rows drift. `reseed` inserts a new one and adopts an updated one
(bump its `version` — that increment is the whole drift signal); `remove` deletes a withdrawn one; all
three key off the CATALOG, never the stored row. **Retiring a built-in is TWO edits and doing only the
first is a silent no-op**: delete the definition AND name it in `buildRetiredPipelines()`. The tombstone
is what flips an existing row from read-only to removable, and it must be a POSITIVE assertion — "absent
from the catalog" also describes a deployment's own pipelines whenever their package isn't wired. Never
add a filter to `seedPipelines()`. A deployment retires its own via
`PipelineRegistry.retire(id, { replacedBy })`, cannot retire a built-in, and `replacedBy` is an ID
resolved against the stored row AND the catalog, never prose. Deleting a pipeline a recurring SCHEDULE
points at is refused 409, paused included.

**Repo bootstrap** — mirrors the execution pattern: `BootstrapService` → `bootstrap_jobs` →
`BootstrapWorkflow` polling the idempotent `pollBootstrapJob()`, then links the repo to the block and
flips the frame to `ready`. Pre-flights that the target repo is empty; the prompt goes to Pi's global
`~/.pi/agent/AGENTS.md`, outside the checkout, so it never lands in the bootstrapped repo.

**Service blueprints** — a Blueprinter agent decomposes a repo into service → modules and persists it IN
THE REPO under `blueprints/`: no table, because the files are the truth and the board is the projection.
The map stops at modules and tasks are authored by people, so `reconcileBlueprint` matches by name, adds
missing, refreshes descriptions, and **NEVER deletes or touches authored tasks**.

**In-repo spec implementation state** — `requirementItem.state` (`aspirational` ⇄ `established`) keeps an
agreed-but-unbuilt requirement out of build prompts as standing behaviour. A FIELD, never a `spec/`
sub-folder. `specPromotionPostOp` is the ONE author, keyed on the tester kinds' verdicts: only `met`
promotes, and **it NEVER demotes** — a run whose blast radius never touched a behaviour would otherwise
strip it. `coerceRequirement` defaults a garbled state to `aspirational`, so a model cannot promote by
assertion. Design and the withdrawn alternative:
[`service-acceptance-criteria.md`](./docs/initiatives/service-acceptance-criteria.md).

**Requirements review** — the FIRST step of the default pipelines, handled inline in the engine
(`RequirementReviewService`, orchestration `modules/requirements/`, table `requirement_reviews`). The
reviewer raises severity-tagged findings, the run parks, and the dedicated window drives an iterative
loop: answer/dismiss → an incorporation companion folds the answers into ONE document → re-review
converges (`incorporated`), continues (`ready`), or hits the cap (`exceeded`, where the human picks
extra-round / proceed / stop-reset). Findings at or below `maxRequirementConcernAllowed` auto-pass; cap
and tolerance live on the merge preset. Pass-through when the reviewer model isn't wired.

- **This stage settles the PRODUCT / BUSINESS layer ONLY** — the technical layer belongs to the later
  `architect` and `researcher` steps, which have the repo and `tech-spec/` in hand. A technical finding
  here asks a product owner something they cannot answer and buries the questions only they can. The
  boundary is ONE shared `PRODUCT_SCOPE_BOUNDARY` block folded into all THREE prompts of the flow
  (`prompts/requirements.ts`) plus the user prompts in `requirements.logic.ts`, because it only holds if
  every agent honours it. Editing any of them means bumping its number in `kinds/versions.ts`.
- **Headless callers drive the SAME loop** over `/api/v1/runs/:runId/decisions`, on the `decide` rung of
  the scope ladder (`read ⊂ write ⊂ decide ⊂ admin`). **Do not add a park timeout: a parked run waits for
  a human indefinitely by design** — the backstops are the workspace in-flight cap and
  `POST /api/v1/jobs/:id/cancel`.
- **An inline reviewer has no checkout, so the platform must TELL it what system the work is about.** The
  context carries the owning service (+ its `spec/overview.md` intent), and an unresolved one is stated as
  `NOT STATED` rather than omitted — a bare title identifies no software, and an omission reads like a
  task whose product is obvious, so the model invents one and the next incorporation makes the invention
  authoritative. The `NO_ASSUMED_PRODUCT` directive on every prompt in the flow is the other half; the
  renderer is shared (`modules/review/product-context.ts`) because the rule only holds if the reviewer,
  the dialogue and the incorporation editor all honour it.
- **A derived subject NEVER displaces the requester's words.** An incorporated document, a brainstormed
  direction and a clarified bug report are all rendered ABOVE the original description, which stays in the
  prompt labelled as the original request. Substituting it was how one pass's drift became permanent: the
  derived text is authoritative on the next pass, so nothing downstream could still see what was asked for.
- **The Writer's provider-hosted web search is WITHHELD when the system is unidentified**
  (`productIsIdentified`), because a model-composed query about a guessed product comes back with real
  sources about unrelated software — an invention that now reads as researched. Its `groundedIn`
  provenance (`standard` / `project-spec` / `web` / `general-practice`) is reported per suggestion, and an
  unreported level stays NULL rather than defaulting.
- **These kinds run as bare inline `generateText` calls**, so they bypass `systemPromptFor` and take their
  prompts from `INLINE_ENGINE_SYSTEM_PROMPTS` as `{ role, directives }` pairs, composed per call through
  `IterativeReviewService.systemPromptFor` so a **per-workspace prompt override applies to the role half
  only**. Adding an inline engine kind means adding it there, SPLIT — one added with its directives inside
  `role` runs fine and fails only later, as a workspace that edited it loses its JSON output contract.

**Inbound tracker webhooks** — verify HMAC over the RAW body BEFORE any parse, ack 202, hand off through
`gateways.trackerWebhook`; the provider owns verify + parse. The workspace rides the PATH and the
per-connection secret authenticates (scanning every workspace's connections would be a deployment-wide
N+1 on an unauthenticated POST); the secret lives in the sealed credential bag, so **no new table**, and
an unconfigured one **FAILS CLOSED**. Push never replaces the `bug-intake` reconciliation sweep, and a
qualifying issue event FIRES that schedule rather than re-implementing intake. Ticket-comment replies take
explicit first-token commands only and route through the SAME service methods the SPA calls — **never a
parallel mutation path into the engine** — behind three guards on reply text (identity,
data-not-instructions, the iteration budget). Doc:
[`tracker-webhook-intake.md`](./docs/initiatives/tracker-webhook-intake.md).

**Bug hunt** — scan a tracker board's open + UNASSIGNED bugs, rate impact against complexity, adopt one
onto `pl_bugfix`. **Persists NOTHING**, so runtime symmetry is by construction. **One vendor call per scan
is a hard requirement**; a caller-supplied board scope is quoted or shape-validated (`assertBoardSlug`)
before it reaches a vendor query; and the rating takes `isOverBudget`, being the platform's first billable
call that no run start gates — **any future un-run-scoped LLM call owes the same guard**. Doc:
[`bug-hunt.md`](./backend/docs/bug-hunt.md).

**Implementation-fork decision** — an optional two-phase `coder` step that proposes materially different
implementations and parks for a human. A container job can't pause mid-run, so the park sits BETWEEN two
dispatches on the same step: a read-only `fork-proposer` helper, the `fork-proposal` interceptor (falling
through on `single_path` / <2 usable forks), then a CAS-recorded choice folded into the `build` prompt as a
binding directive. Rides `step.forkDecision`; primary repo only. Doc:
[ADR 0022](./backend/docs/adr/0022-coder-fork-decision.md).

**Dependency prepopulation** — one declared install command run before the agent's first turn. Shares the
`validation_configs` row but rides the BASE job body rather than only a PR-opening dispatch, and **that
threading difference IS the feature**. **NEVER a gate**: a check is a VERDICT about the work, an install is
SETUP, so every failure becomes a prompt NOTE and the run continues. One `prepopulateDependencies` seam,
pinned structurally by `dependency-install.coverage.test.ts`; what it materialises is git-excluded by
DIFFING untracked paths either side, never by naming well-known directories. Doc:
[`agent-dependency-prepopulation.md`](./docs/initiatives/agent-dependency-prepopulation.md).

**Foundational services** — a tiered (builtin ⊕ account ⊕ workspace) catalog of the shared
capabilities an org already runs, each with a description and its API contracts (OpenAPI 3.x /
`@toad-contracts/core` / `@lokalise/api-contract`), registered in a deployment's CODE on the
app-owned `FoundationalServiceRegistry`, uploaded directly, or synced from a linked repo through the
SAME `repoSourceSync` engine the fragment + skill libraries use. **The code-registered `builtin` tier
holds no rows** — the merge reads the registry — so a deployment's estate is present from a
workspace's first request and cannot drift from its definitions, and boot validation holds each one
to the same schema and document checks the write boundary applies. **A contract set is validated as
a SET** (at least one document per declared format references that library), because a contract
module is a module GRAPH and only its entry point names the library. **The catalog and the CONTRACTS are two
separate reads and two separate tables, and that split IS the feature**: a `foundational-catalog`
kind (the architect) is folded identity + capability tags + indexed operation NAMES with no document
bodies, while a `foundational-contracts` kind (the researcher, the coder) gets the full documents for
exactly the ids the design DECLARED in its machine-read fenced block. Both arrive as injected
`.cat-context/` files, so the container, inline and consensus paths need no new prompt field. Three
downstream states are kept apart because each needs a different reaction — no declaration at all
("nothing was checked"), an empty one ("no shared service applies") and an id the catalog does not
know (named, with "do not guess at its API"). A FOURTH state is the operation list itself: empty
means "declares nothing" for a format we parse and "nobody looked" for one we do not, so
`operationsAreIndexable` (contracts) is the ONE place that distinction lives and every renderer
branches on it. A contract MODULE is read statically and reports its own coverage — the
`defineApiContract(` anchor count is the declaration count, so whatever the extractor could not read
rides `omittedOperations` rather than passing as a complete list. **Routing is by TRAIT, never a
kind-id list**, so a deployment's own design/implementer kinds opt in by declaring one. A tier opts
OUT of what it INHERITS (a board of its account's, either of a deployment builtin) through a
suppression sub-resource mounted at BOTH scopes, never a delete: a delete drops that tier's own
registration and its documents, where a suppression destroys nothing — which is why RESTORING one
hard-deletes the tombstone rather than clearing its `deletedAt` (that would revive an EMPTY override
that wins the merge), and why the suppression LIST is its own read (a suppressed id is by
construction absent from the merged catalog, so nothing else could offer the way back). Doc:
[ADR 0031](./backend/docs/adr/0031-foundational-services.md).

**Binary-output steps** — a kind carrying the `binary-output` trait (a deployment's image
generator; no built-in carries it) generates BINARY artifacts and stores them through a
foundational service its step SELECTS from that same catalog (`stepOptions.binaryOutput`: a
`asset-storage`-capability-tagged storage service + context services that scope the generation),
never through the platform's artifact store, which holds run evidence rather than deliverables.
The join is the step's own config, not a design's declaration, so presence is refused structurally
at save + start and resolution re-validates against the catalog at every admission; the injected
`binary-output/` brief states every gap (an ABSENT brief itself means "do not upload — report"),
and what the agent declares it stored lands on `PipelineStep.binaryOutputs` with every loss
bookkept. Doc:
[`binary-output-foundational-storage.md`](./docs/initiatives/binary-output-foundational-storage.md).

**Compose layers** — a service's `StackRecipe` and a `SharedStack` each name an ORDERED list of
`ComposeFileRef` layers: a bare in-repo path, or an explicit `inline` / `repo` source read
checkout-free through the workspace's VCS connection. That is what lets a deployment declare infra
dependencies IN CODE (`seedSharedStacks`) rather than through a form. **The project directory anchors
on the first `path` layer, NEVER the first layer** — compose resolves every layer's relative build
contexts, binds and `env_file`s against `--project-directory`, so prepending an `inline` layer must
not move that anchor to the checkout root; the host-escape `baseDepth` derives from the SAME
directory, so a foreign layer's own nesting can never widen what the guard tolerates in the primary
checkout. Placement is PURE and shared (kernel `domain/compose-sources.ts`), resolution is ONE seam
(`planComposeLayers`), and a materialized layer's path is keyed by POSITION so same-basename layers
can't collide. **`SharedStack.cloneUrl` is nullable and what forces one is reading a COMMITTED file**
(`composeBringUpNeedsRepo`), refused at the WRITE boundary on the MERGED entity because
`composeFiles` and `cloneUrl` patch independently. **Seeds are idempotent by NAME, never
overwritten**, so an operator's later edit survives every boot. Doc:
[`stack-recipes-and-shared-stacks.md`](./docs/initiatives/stack-recipes-and-shared-stacks.md).

**Pre-PR validation** — per-frame install/lint/test/build commands run after the agent settles and before
the PR opens; red re-enters the agent loop with the captured output and only a green checkout opens a PR.
**Autodetection SUGGESTS, it never writes**, and an opinionated gate (`cargo fmt --check`, `-D warnings`)
is suggested only when its config file is checked in. Threaded onto the job body, so it works on all three
transports; the loop lives in the harness, generic off the body with no `switch(agentKind)`. Unconfigured
is byte-for-byte the old behaviour. Doc:
[`pre-pr-validation.md`](./docs/initiatives/pre-pr-validation.md).

**Bugfix reproduction proof** — the declared reproduction command against the pre-fix tree and the PR
tree; only red-then-green is proof. **SYMMETRY is the safety property and the only defence against a false
`reproduced`**: identical worktrees, setup command and declared test files, so an environmental defect
fails BOTH and red-then-red is `inconclusive`. Target **`baseSha`** specifically (the coding clone is
`--depth 1`, so `HEAD~1` isn't in history) and apply the **declared PATHS only** onto the base worktree, or
a whole-tree checkout drags the fix across and greens it. A failure REPAIRS, then degrades to
`inconclusive` with the PR still opening — the opposite disposition from validation, because a red check
means the WORK is broken while an unproven reproduction means the EVIDENCE is weak. Doc:
[`bugfix-reproduction-proof.md`](./docs/initiatives/bugfix-reproduction-proof.md).

**Pipeline PR descriptions** — the agent writes its reviewer briefing to `.cat-pr-description.md`
(requested **only when `opensPr`**, since an in-place fixer amends a PR whose description it doesn't own)
and the harness lifts it onto `openPullRequest` scrubbed, capped and git-excluded; absent ⇒ the
dispatch-time `prBody()` fallback, which marks itself agent-less. The sentinel name is kept in sync agents
⇄ harness, so changing it means an image bump. `MAX_PR_BODY_CHARS` (15k) plus the report's
`MAX_SECTION_CHARS` (50k) must stay under the host's 65,536 limit, or the report silently stops
publishing. **A RESUMED run must refresh the PR it already opened** (`refreshExisting`), but only when the
text is the agent's own briefing — refreshing from the fallback would clobber a human's edit.

- **When the target repo ships a PR TEMPLATE, the briefing IS that template, filled in** (`pr-template.ts`,
  which owns the discovery rules and the reasoning behind each). Neither host applies a template to an
  API-created pull request — only to the web form a human opens — so nothing fails to say so, and our PRs
  are the only ones on the repo missing the structure its reviewers read. The AGENT fills it, in the prompt
  that already asks for a briefing: the sections are questions only whoever did the work can answer, so
  stuffing the briefing under the first heading gives the template's shape and none of its meaning.
- **Three things about it are load-bearing beyond that module.** It rides EVERY agent pass, or a
  validation/reproduction REPAIR pass — a fresh agent still carrying the description guidance — replaces
  the filled template with a free-form briefing. The sentinel is then read with **`titleFromHeading:
false`**, because the headings are now the REPO's and `splitTitle`'s lone-`#` rule would retitle the PR
  after the template's top heading and delete it from the body; a new read site owes the same flag. And
  `pr-template.coverage.test.ts` CLASSIFIES every agent-running mode as PR-opening or not, because a new
  PR-opening mode that skips this compiles and passes every behavioural test; it cannot anchor on
  `openPullRequest(`, which runs in the push phase long after the prompt was composed.

**Consensus panels** — an eligible step can run as a multi-model PANEL instead of a single agent
(`@cat-factory/consensus`, `CONSENSUS_ENABLED`). REVIEW kinds are the point, and the frontend mirror
`CONSENSUS_ELIGIBLE_KINDS` is hand-synced — extend both.

- **A panel participant has NO checkout, and every layer preparing for it must know.**
  `dispatchDeliversCheckout` (`@cat-factory/agents`) is the ONE definition, used by the executor's ROUTING
  and by the engine as `RepoOpContext.deliversCheckout`, and it is deliberately FAIL-SAFE: being wrong
  that way hands a container agent an inlined diff it didn't need, while being wrong the other way has a
  panel reviewing from filenames while sounding confident. A preOp BRANCHES on it rather than assuming a
  filesystem, naming what it could not inline as unreviewable instead of passing it off as reviewed, and
  `INLINE_PANEL_SURFACE` is appended LAST so a workspace prompt override cannot drop it.
- **`userPromptFor` folds `injectedContextFiles` for every INLINE caller** and not the container path, at
  the wrapper level — it must be the wrapper, because `buildBaseUserPrompt` returns early for a kind that
  authors its own user prompt, and those are exactly the kinds whose whole input arrives as context files.
  The fold is budgeted, states what it dropped, and EXCLUDES standards files, which reach an inline caller
  through the SYSTEM prompt at `standardsVerbosityFor`.
- **The tier is chosen by the ENGINE at dispatch, never by the executor.** A step declares `participants`
  inline or `consensus.groupIds` (a SET, not a precedence list, of workspace groups each carrying an
  estimate bar); `resolveConsensusConfig` reads them in ONE batched `listByIds` and the pure
  `selectConsensusGroup` picks the most demanding tier the estimate clears, deterministically so a
  re-driven run re-picks the SAME tier. `applyConsensusGroup` **drops the step's `gating`** — selection IS
  the gate. That is what keeps the group library OUT of the optional package: the executor only ever
  receives an already-decided `ConsensusStepConfig`. A gated group MUST name a threshold ("always applies"
  is `enabled: false`), and deleting a group degrades the step to its remaining tiers rather than rewriting
  pipelines.

**Merge lifecycle** — turns an open PR into a merged one, gated on REAL CI and a REAL merge, so a task is
`done` only when its PR actually merged.

- **`ci` (polling gate)**, auto-inserted second-to-last: reads the PR head's check runs via
  `CiStatusProvider` and aggregates with `ci.logic.ts` — green/none advances with nothing spun up, pending
  sleeps `ciPollInterval`, failure dispatches `ci-fixer` up to `ciMaxAttempts` then raises `ci_failed`.
  **`ci-fixer`** clones the PR head and pushes back onto the SAME branch.
- **`merger`** (last standard step) clones the PR head, scores the diff and returns ONLY a JSON
  assessment, making no commits; `resolveMergerStep` compares it to the task's merge threshold preset and
  either merges for real (block `done`) or raises `merge_review` leaving the block `pr_ready`. A pipeline
  with no merger raises `pipeline_complete` instead of auto-`done`.
- **Merge threshold presets** — a per-workspace library selected via `Block.mergePresetId`, carrying the
  auto-merge ceilings, `ciMaxAttempts`, the requirements-review knobs and the per-class `classRules` map.
- **Merge track record** — a **best-effort side channel** persisting each decision to
  `merge_track_records`. Classification is pure backend TS over ONE VCS call, deliberately not in the
  harness (no image bump); classes rank `docs < test < dependency < config < source < schema` and a mixed
  diff takes the HIGHEST present, which is what makes a per-class rule safe. An unreadable diff yields
  `unknown` and **`unknown` never matches a rule**, so a VCS outage can't change policy. Precedence:
  `autoMergeEnabled: false` > the class rule > the credibility + threshold comparison. Doc:
  [`merge-track-record.md`](./docs/initiatives/merge-track-record.md).
- **Notifications** are a human-actionable surface, not a mid-pipeline gate: the canonical row is
  persisted and pushed in-app behind a `NotificationChannel` port, with `CompositeNotificationChannel` as
  the seam for other channels. `WebhookNotificationChannel` (per-workspace HTTPS, HMAC-signed with a sealed
  secret through the SSRF-guarded `safeFetch`) exists because a headless caller has no in-app inbox; being
  EXTERNAL, it composes into that set on both facades.
- **A notification is NOT the run's lifecycle**, and the happy path raises none — a pipeline whose `merger`
  merges its own PR settles with an empty inbox. So the same registered endpoint also carries run-lifecycle
  events through the kernel `RunLifecycleSink` port (`run.started` / `run.completed` / `run.failed`), built
  beside the channel by `buildNotificationWebhookSupport` from the SAME row and cipher so a facade cannot
  wire one and forget the other, and driven through the ONE `signedDelivery.ts` retry/SSRF/signature core —
  those are properties of the ENDPOINT, not of the payload, and a second copy is a second place to get the
  SSRF guard wrong. **The started edge rides the ONE hand-off funnel every start path ends with
  (`handOffLiveRun`) and is exactly once — announced LAST, after the block is committed and the durable
  runner has the run, because an outbound call must never sit between a claim and the local write it
  belongs to; the terminal edges hook the emit funnel and are AT-LEAST-ONCE by design**, carrying a
  `<runId>:<event>` dedupe id — a run reaches `done` from four sites, and a claim table would buy
  exactly-once for an effect a receiver collapses with one id comparison. **A receiver dedupes on that
  id, never on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two deliveries of one transition
  are not byte-identical. Doc: [ADR 0030](./backend/docs/adr/0030-public-api-surface.md).

**PR verification report** — the ENGINE, not the agent, keeps a report of captured facts on every run's
PR, as a managed section of the PR BODY delimited by `<!-- cat-factory:verification-report:start -->` /
`:end`. The markers ARE the identity, so the write is idempotent with NO persisted state. It is an engine
HOOK on step settlement — one call in `RunDispatcher.recordStepResult`, positioned AFTER
`applyTerminalStepResolver` and BEFORE `finalizeBlock` — not a pipeline step, which would need inserting
into all 15 built-ins, would never exist for deployment-authored ones, and would never be reached by a run
that fails part-way. Composed from state already in memory (the CI gate's RECORDED verdict, never a
re-probe that can disagree with what the gate acted on). Best-effort always, with a per-workspace opt-out
checked BEFORE anything is read. Doc:
[`pr-verification-report.md`](./docs/initiatives/pr-verification-report.md).

**Post-release health** — the LAST standard step: watch monitors/SLOs for a window and, on a regression,
spawn an `on-call` agent to investigate. **It never auto-reverts.** The kernel `ReleaseHealthProvider`
port is vendor-neutral, served by `RegistryReleaseHealthProvider` (per-vendor adapters, today only
Datadog) which owns connection loading, decryption, config resolution and the verdict reduction — an
adapter is just the vendor reads, so a second provider is a new registry entry. Credentials live sealed in
`observability_connections`, never in containers. `on-call` is resolved specially by `resolveOnCallStep`:
raise `release_regression`, best-effort enrich any open incident (the `IncidentEnrichmentProvider` port
annotates, never re-alerts, since those systems page off the same signals), finish the gate.

## Custom agents (manifest-driven extension over `RepoFiles`)

A deployment ships its own agent kinds without forking and without rebuilding the harness image.
Governing principle: **zero `switch(agentKind)` in the container** — the harness is a generic
LLM-over-a-checkout runner and all deterministic work is backend TypeScript. Full model:
[`custom-agents.md`](./backend/docs/custom-agents.md); role authoring:
[`custom-agent-roles.md`](./backend/docs/custom-agent-roles.md); capabilities:
[ADR 0029](./backend/docs/adr/0029-agent-kind-capabilities.md).

- **Three stages**, of which the container runs only the middle: `preOps` (backend TS committing a
  targeted subset via the `RepoFiles` port — a per-run, checkout-free HTTP facade, so runtime-symmetric) →
  `agent` → `postOps` (backend TS parsing `result.custom`, rendering artifacts, committing). Registration
  is by reference on the app-owned registries. `ExecutionService` runs the hooks around dispatch over a
  `RepoFiles` bound by the facade-wired `resolveRunRepoContext`; unwired means the hooks skip.
- **Capabilities are `skills` and `toolServers`**, registered on the SAME `AgentKindRegistry` (they are
  capabilities OF agent kinds, like traits) and attachable to a built-in kind via `assignSkills` /
  `assignToolServers`. **Skills resolve in the ENGINE**; **tool servers resolve in the container
  EXECUTOR**, because what is servable depends on the resolved HARNESS and the facade-wired credential
  resolver, neither of which the runtime-neutral engine knows.
- **A tool-server credential is declared BY NAME** and resolved through the kernel `ToolSecretResolver`
  port, so a server needs no table and no UI. The VALUE rides the job body only; `context.toolServers` is
  the non-secret projection the prompt and telemetry see. The default env resolver is a TRUST BOUNDARY — a
  definition names both the key it wants and the endpoint it reaches — so a deployment installing
  third-party agent packages passes `{ allowKeys }`.
- **`allowedTools` is SCOPING, never a security boundary**, and claude-code's `--allowedTools` must ALWAYS
  carry the CLI's built-in tool names too (an allow-list is whole-session, not MCP-scoped). An `http`
  server must be `https` or loopback, refused at registration AND at the job boundary.
- **A capability that can't be honoured is STATED to the agent, never silently dropped** (Pi has no MCP
  client; an ambient Codex run has no per-run config home; a required secret didn't resolve), so it plans
  around the gap instead of discovering it mid-run.
- **The harness MATERIALISES, never decides**, into PER-JOB paths — never HOME-global, never the checkout.
  Changing what it writes means an image bump.
- **NOT yet done**: the built-in agents aren't migrated to this model; their rendering still lives in the
  harness. Converting them one at a time (parity-gated, image-bumped) is the remaining strangler work.

## Per-workspace agent prompt overrides

A workspace can replace any agent kind's system prompt from the pipeline builder and switch back through
the full history of what it has run.

- **The store is an APPEND-ONLY revision log** (`agent_prompt_revisions`, keyed
  `(workspace, agent_kind, revision)`) and the HIGHEST revision is live: no update, no delete. Going back
  to what the product ships appends a revision whose `text` is **NULL** — a real state, distinct from a
  kind nobody edited, which keeps the workspace tracking the shipped prompt as it is bumped instead of
  pinning today's wording. **The composite key is the concurrency control**: a second editor's insert
  COLLIDES and `AgentPromptService` re-reads the head to raise `prompt_revision_conflict`. **Never turn
  that insert into an upsert** — last-write-wins would silently discard one of two people's prompts.
- **An override replaces the SHIPPED TRACK PROMPT, never the whole system prompt.**
  `systemPromptFor(kind, registry, override?)` re-applies the surface directives and trait guidance on
  top, because those are invariants of how the platform runs a kind rather than editorial content — so the
  editor shows, and an override supplies, `baseSystemPromptFor`.
- **An invariant reaches a shipped prompt by TWO routes and only one survives an override.**
  `applySurfaceDirectives` APPENDS, but a built-in track prompt carries the same rule INLINE. Replace the
  track prompt and the double-append guard reads "already has it" about a string that no longer exists, so
  every kind whose deliverable IS its reply silently loses the rule and returns an empty reply the harness
  fails the run on. `restoreShippedInvariants` closes that by diffing against the fully composed SHIPPED
  prompt. **A new engine-enforced fragment belongs in `OVERRIDE_PRESERVED_FRAGMENTS`**, or an override can
  delete it.
- **The engine resolves the override ONCE per dispatch** onto `AgentRunContext.systemPromptOverride`, so
  the container, inline and consensus paths cannot disagree about which prompt a step ran under. **A new
  prompt-assembly site must honour it.** A step records the revision it ran under
  (`PipelineStep.promptRevision`, absent ⇒ shipped), which Kaizen keys its `(prompt, agent, model)` combo
  off.
- **A per-kind GENERATION setting is the sibling store, not another revision log.** The
  output-token ceiling rides `workspace_agent_settings` (per workspace, per kind, edited in the same
  editor), resolved by the SAME once-per-dispatch rule onto `AgentRunContext.maxOutputTokens` with a
  pipeline step's `stepOptions.maxOutputTokens` winning over it. It UPSERTS where the prompt log
  appends — a scalar someone retypes, not authored text a lost update would destroy — and
  "inheriting" is the row's ABSENCE, never a stored null. Ceilings are advisory on the
  subscription-CLI inline path. Doc:
  [`configurable-agent-output-budgets.md`](./docs/initiatives/configurable-agent-output-budgets.md).
- **A code-registered VARIANT is the same unit of text, one tier out.**
  `registerVariant({ id, baseKind, systemPrompt | promptAddition })` (`@cat-factory/agents`) gives a
  deployment an alternate prompt for an EXISTING kind, selected per step via
  `stepOptions.agentVariantId`. It is deliberately NOT a kind: a kind id is what every un-migrated
  `switch(agentKind)` keys off, so a new id would dispatch down the generic path and quietly do the
  wrong thing, whereas a varied step records the BASE kind and every behavioural decision is
  unchanged. **A variation needing different BEHAVIOUR is a different kind.** The engine resolves it
  in the SAME once-per-dispatch place as the workspace override and emits it through the SAME
  `systemPromptOverride` field, so no executor branches on it and the invariants above hold for it
  unchanged; the WORKSPACE override wins as the narrower tier, and a `promptAddition` then folds onto
  the workspace's text rather than the shipped text — which is why an addition, not a replacement, is
  the default a variant should reach for.
- **A step is varied by ASKING; what the dispatch DID with the ask is a separate recorded fact.**
  Because the workspace out-ranks the deployment on the same text, a selected variant routinely
  reaches the prompt only partly (its addition survives, its replacement does not) or not at all
  (displaced with no addition, or withdrawn mid-run). So the dispatch pins `step.promptVariant`
  `{ id, applied, fingerprint? }` beside `promptRevision`, warns on every losing disposition, and
  **every reader keys off the PIN, never off `stepOptions.agentVariantId`** — a panel or a metric
  reading the ask reports a variation that never ran, which reads as confirmation rather than as the
  absence it is. The `fingerprint` covers the text the variant CONTRIBUTED, so Kaizen cannot let a
  re-worded variant inherit the verified streak its previous wording earned (re-registering an id is
  a supported way to re-word one), and a variant that contributed nothing stays out of the key
  entirely.
- **`BESPOKE_CONTAINER_SYSTEM_PROMPTS` is SPLIT into `{ role, directives }`** because `merger` and
  `on-call` dispatch a bespoke constant instead of their role prompt, bypassing `applySurfaceDirectives`.
  The role is editable; the directives (the JSON contract the engine parses, on-call's read-only
  guardrail) are re-appended on top. **Adding another such kind means adding it there, split** — one added
  with its directives inside `role` compiles and dispatches fine, and fails only later as a workspace that
  edited it losing its guardrail.
- **The sandbox shares ONE unit of text with this feature**: a stored sandbox `systemText` and a stored
  override are both the BASE prompt, composed at RUN time through the same override path production uses,
  so a candidate is graded on what would actually be sent. Promote is `POST /agent-prompts/:kind/promote`,
  NOT a sandbox route — it writes the live prompt, so it answers to `settings.manage` rather than the
  sandbox's `integrations.manage`.

## Telemetry & agent-context observability

Three sinks live in a dedicated telemetry store, separate from the transactional domain (append-heavy,
high-volume, short-retention): a required `TELEMETRY_DB` D1 database on Cloudflare and a `telemetry`
Postgres schema on Node, all pruned to `LLM_CALL_METRICS_RETENTION_DAYS`. Parity is asserted by
`defineAgentContextSuite`, and Cloudflare fails fast at build if `TELEMETRY_DB` is unbound. Gaps and the
plan to close them: [`observability-logging-gaps.md`](./docs/initiatives/observability-logging-gaps.md).

- **`llm_call_metrics`** — per LLM call. **THREE producers converge on the ONE `LlmObservabilityService`
  and a new one must too**: the proxy; the subscription harnesses (Claude Code / Codex bypass the proxy, so
  the harness lifts metrics off each CLI's event stream); and INLINE calls, through the kernel
  `InlineLlmCallRecorder` port. An inline call SERVED BY a harness CLI is both at once — it reaches the
  store through the inline port, carrying per-call rows lifted off the CLI's stream — which is why the
  model owns them and the instrumentation stands down (below), not a fourth producer.
- **`agent_context_snapshots`** — the complete context an agent was PROVIDED per dispatch, including the
  full content of injected `.cat-context/*` files, which the agent reads via tools and which therefore
  never reach proxy telemetry. A redacted allow-list projection, never a token or credential-bearing URL.
- **`agent_search_queries`** — one row per web search a container agent PERFORMED.

Rules that bind new work here:

- **The provider takes EXACTLY ONE exit per inline call.** `record` already fans out to the external trace
  sink, so a recorded call must NOT also hit the provider's own `traceSink` — that doubles every inline
  generation on Langfuse/OTel. A facade never assembles the pair by hand: `createInlineInstrumentation`
  builds both exits from ONE sink instance. Bodies reach the recorder as THUNKS, so a prompts-off
  deployment never pays to serialise a prompt the gate is about to drop.
- **The inline instrumentation is a middleware around a RESOLVED model, so it only ever sees what the wrap
  beneath it returned — and one facade wrap SUBSTITUTES that model.** It shipped innermost, inside
  `createScopedModelProviderResolver`, where local mode's subscription-inline wrap (which answers a harness
  ref with its own `CliInlineLanguageModel` instead of delegating) was invisible to it: on the default local
  shape every inline step on a host `claude`/`codex` login recorded zero calls while the same step on a
  metered API model recorded fine. **A facade never composes that order by hand** —
  `wrapResolverWithTelemetry(resolver, instrument, limiter)` (`@cat-factory/server`) owns it, for the same
  reason `createInlineInstrumentation` owns the exit pair: the wrong order still typechecks and still records
  every non-substituted call, so nothing fails until it is the deployment you don't test on. The limiter
  stays outermost, so a queue wait is never counted as generation time.
- **A model served by a harness CLI files its OWN calls, and the middleware around it STANDS DOWN.** One
  `doGenerate` on `CliInlineLanguageModel` is not one model call — the CLI runs a whole tool loop behind it,
  routinely 16+ calls over eight minutes — so the middleware could only ever report it as ONE lumped row,
  only once the subprocess exited, and (a rejection carries no usage) as ZEROS whenever the run was killed.
  The model therefore takes the facade's recorder and files each call the CLI reports, live; the middleware
  asks `reportsOwnLlmCalls(model)` and returns it unwrapped, because two producers for one call would double
  every token in the step's rollup. **The model is ASKED, never a facade told**: the instrumentation sits
  outside the wrap that substitutes the model (it has to — above), so it cannot know what the inner wrap
  returned. Each row carries the model the CLI says SERVED that call (`call.model ?? requested`, the same
  precedence `makeHarnessCallRecorder` applies), because cost is derived per row from `(model, token classes)`
  and a CLI serves some calls with a cheaper model of its own. **The step-level row carries the SHORTFALL, not
  a lump**: the terminal cumulative usage minus what the per-call rows accounted for, so a CLI that narrates
  nothing (`codex exec`) still gets the one row the SDK boundary knows, a fully-narrated step gets none (it
  would double every token), and a PART-narrated one gets the remainder rather than silently under-reporting
  — which is what an "aggregate only when nothing was costed" rule did. An uncosted turn is never filed as a
  zero row, and that rule lives with the model, so it holds for both transports. Only Claude Code's
  `stream-json` is parsed per call, through the container harness's `createClaudeRunTelemetry`
  (`@cat-factory/executor-harness/claude-call-aggregator`) — the ONE fold, imported rather than
  re-implemented, because folding per ENVELOPE instead of per `message.id` inflated a measured 1.47M tokens to
  5.53M and both paths had to learn that once. **That fold reconstructs a transcript in the DRIVER's process,
  so both of its bounds are load-bearing on the backend**: `MAX_TRANSCRIPT_CHARS` (which states what it
  stopped retaining) and the `bodies` switch, off when `LLM_RECORD_PROMPTS` is — a body the store will drop
  must not be assembled, since unlike every other body it is BUILT rather than merely passed as a thunk.
- **Run attribution falls back to the credential SCOPE, which names the block's LAST run, not necessarily a
  live one.** A per-call `catFactoryObservability({ executionId })` wins; absent, the wrap threads
  `scope.executionId`, because most inline sites tag only the workspace and such a row is worse than
  unrecorded — it is IN the store and absent from every run-scoped read (`listByExecution`, a step's rollup,
  `/api/v1/debug/runs/*`), which reads as a step that spent nothing. `block.executionId` is NOT cleared when
  a run settles, so `resolveBlockRunContext` drops the id for a TERMINAL run (keeping the initiator, which
  the key pool still scopes by): a stale id would report spend against a finished run's rollup, and unlike a
  null nothing about it looks wrong. Both absent ⇒ null, the honest answer for a genuinely un-run-scoped
  call. **A NEW inline caller on the run path must build its scope with the run in it** — a call that
  generates on the run path but resolves its own scope, like a fragment brief, carries the run on its input.
  The precedence itself is ONE function, `resolveInlineAttribution`, because both inline producers apply it.
- **State what a producer does NOT know rather than filling a field with a guess**: an inline call has
  `httpStatus` null, `phase` `''` and `upstreamMs === totalMs`, so the derived overhead is a real 0.
  `turnIndex` is null for a plain `generateText` (no turn concept) and REAL for a harness-CLI call, whose
  stream numbered it; `turn_index` is NULLABLE and never 0, or a proxied call would sort to the front of its
  phase. A harness-CLI row likewise says `durationMs` 0 and `requestMaxTokens` null — the CLIs expose no
  per-call timing and apply their own ceiling, so this step's elapsed time or our ignored ask would both be
  fabrications.
- **The input side is THREE orthogonal classes, never a lump.** `promptTokens` is FRESH input with
  `cacheReadTokens` + `cacheWriteTokens` beside it, priced ~1x / ~0.1x / 1.25-2x base input — a cache WRITE
  costs more than fresh — so a producer that sums them makes a loop that keeps invalidating its prefix read
  look exactly like one riding a warm cache. Normalise at the source through the SINGLE
  `readInputTokenClasses`, which subtracts where the vendor reports an INCLUSIVE prompt count and leaves
  the already-exclusive field alone where it reports them apart, and **reads the two cache classes
  INDEPENDENTLY** — an OpenAI-shaped gateway fronting Anthropic reports both on one payload. A count
  crossing a wire boundary is read LENIENTLY, since a runner pool runs whatever image its workspace
  pinned. **On every SPA surface the headline `↑` is the TOTAL of the three, with the classes as the
  breakdown.** Doc:
  [`token-telemetry-per-class-and-cost.md`](./docs/initiatives/token-telemetry-per-class-and-cost.md).
- **Every row is stamped with the PHASE that spent it, by whoever OWNS the boundary, never reconstructed
  downstream** — the harness stamps at EMIT time (not drain time), and the Pi path carries it on the proxy
  URL because Pi has no per-request header to set. `''` is a REAL slice, filed as unattributed rather than
  guessed at from the agent kind. **The BACKEND declares the phase-tagged route** (`proxyPhasePath` on the
  job body) and the harness tags only when told: never assume image and backend are a matched set, since a
  pool pins its own image and an image ahead of its backend would 404 EVERY model call. Doc:
  [`token-burn-instrumentation.md`](./docs/initiatives/token-burn-instrumentation.md).
- **The rollup is ONE aggregate at the `(agentKind, phase)` grain** and every coarser view is a pure fold
  over it (kernel `domain/llm-rollup.ts`), running on EVERY step settlement. **A new consumer folds; it
  does not add a query.**
- **Gating**: the snapshot and the search queries require BOTH `LLM_RECORD_PROMPTS` AND the per-workspace
  `storeAgentContext` (the operator opt-out wins). **That double gate governs every path that captures a
  model BODY**, the EXTERNAL trace fan-out included, on the proxied AND inline paths. It is ONE shared
  helper, kernel's `createStoreAgentContextGate`, precisely because the two paths diverged; a read that
  THROWS fails closed, because an unreadable settings row is not consent. **Any service in front of this
  store needs its `workspaceSettingsRepository`**, or that gate is OPEN and an opted-out workspace's bodies
  are retained anyway.

**Remote debugging reads** (`/api/v1/debug/*`) expose the same sinks to an external caller — in practice an
LLM diagnosing a run — under one rule a new endpoint must obey too: **a response's size has to be
computable BEFORE the request.** So fan-out lists never carry bodies, slicing/filtering/searching happen in
SQL, every body is a `debugText` reachable at any offset, and keyset cursors ride the `(createdAt, id)`
COMPOSITE because telemetry is appended in same-millisecond bursts. Scope is `read`, deliberately not
`admin`. Full model: [`debug-api.md`](./backend/docs/debug-api.md).

**External trace destinations** go through ONE kernel port (`LlmTraceSink`) and never a second recording
path: two packages implement it and `composeTraceSinks([…])` collapses them into
`CoreDependencies.llmTraceSink`, so **adding a destination is a new implementation composed into that
array, never a new call site.** Every sink is opt-in on a FULL config, **never throws into the caller**,
and honours `LLM_RECORD_PROMPTS` (usage and timing still export; bodies don't). The OTel package is the one
place the runtimes deliberately differ in TRANSPORT, not behaviour (workerd can't run the official SDK),
sharing `src/mapping.ts` pinned equal by `conformity.test.ts` — so span names, attributes and metric names
change in the mapping layer. Deployment-level metrics are the dual, swept per account and opt-in on top of
the base exporter:
[`platform-operator-observability.md`](./docs/initiatives/platform-operator-observability.md).

## Board / service / repo-linkage model

- A "service" is a `Block` with `level: 'frame'`, `parentId: null`. Modules are sub-frames; tasks are
  leaves.
- **A Block carries no repo fields.** Repo↔block linkage lives in the `github_repos` projection via its
  `block_id` column, and **execution resolves the repo at runtime** via
  `resolveRepoTarget(workspaceId, blockId)`, which walks the block's ancestry to the enclosing service
  frame and reads that frame's `Service.repoGithubId` — the SOLE linkage, and the only one carrying a
  monorepo `directory`. **There is deliberately NO "first repo" fallback**: an unlinked chain THROWS a
  `ValidationError`, because guessing once pushed a simple-service task into someone else's repo. So a
  bootstrapped repo becomes a board service only once its projection row is linked to the frame's block
  id. A workspace has exactly ONE VCS installation but may have MANY repos.
- **A step's prompt names the service the work belongs to** — `AgentRunContext.ownService`, derived by
  the engine from that same ancestry walk (kernel's `describeOwnService`). It is a DISCRIMINATED result,
  not a nullable one, and "not under a service" is RENDERED rather than omitted: a bare task title names
  no software, so a silent omission reads like a task whose product is obvious and the model supplies one
  (see the requirements-review flow entry). The inline reviewers resolve the same thing through
  `IterativeReviewService.resolveOwnService`.
- **A service frame's board POSITION (and any size override) lives on its `WorkspaceMount`, not on the
  Block**, because one shared service sits at a different spot on every board that mounts it: `moveBlock`
  writes the mount and the frame block row's own `position` is frozen at creation. **Every frame-returning
  read therefore projects through kernel's `applyMountLayout`** — the snapshot and each single-block
  `BoardService` mutation response alike. Skipping it is silent: nothing fails, the SPA just upserts the
  authoritative block a mutation returned and the frame JUMPS to coordinates no board shows it at (the
  resize path is where users hit this, because a `size`-only edit is the one frame patch with no other
  visible effect).
- Drag-drop: `useBlockDrag.ts` → `POST /blocks/:id/reparent` → `BoardService.reparent()`. Tasks move into
  frames or modules, modules into frames; frames cannot nest (`canReparent` in `board.logic.ts`).

## End-to-end (assembled-product) coverage

Where conformance asserts backend behaviour port-by-port, the Playwright suite (`backend/internal/e2e`)
covers the assembled product: real Chromium → real SPA → real Node backend (real Postgres, real pg-boss,
real WebSocket push). Only EXTERNAL deps are faked, so it needs no secrets/Docker/network. Spec-writing
mechanics and the Specs table: [`backend/internal/e2e/README.md`](./backend/internal/e2e/README.md).

- **What e2e is FOR**: what only the assembled product shows, above all the live WebSocket-pushed UI
  round-trip. A pure backend side-effect belongs in conformance. Anything needing a real outbound call must
  be mocked at the backend's OUTBOUND boundary, never in the browser.
- **Spec shape (mandatory)**: seed/trigger over REST, then assert only on LIVE pushed UI updates. No
  reloads, no fixed sleeps, no canvas drag/zoom; only web-first assertions on the named timeouts in
  `tests/helpers.ts`.
- **Selectors are `data-testid`, always.** Covering a flow whose affordance has none means ADDING the test
  id first (a behaviour-neutral frontend change) plus a patch changeset.

### A flaky e2e test is a BLOCKING bug: investigate and deflake, NEVER retry

**A flaky spec must always be root-caused. A green-on-retry run is NOT a pass.** Playwright enforces this
(`failOnFlakyTests: true`): first-attempt-fail then retry-pass reports the shard RED on purpose. The retry
exists ONLY to capture the trace.

- **Do NOT re-run CI hoping for green, bump `retries`, skip the spec, or dismiss it as a boot flake.**
- **Reproduce, then root-cause.** A flake almost always exposes a REAL race: a live event applied between a
  snapshot's fetch and its store-commit, a subscribe-after-broadcast gap, a status rendering from a
  clobbered store. Fix the SOURCE (usually a frontend store reconcile or a `helpers.ts` readiness gate) and
  add a unit test pinning the race.
- **Never paper over it in the spec**: no sleep, no bumped timeout, no reload (which hides exactly the
  live-push bug the suite exists to catch).
- **The bar for "fixed" is deterministic, not lucky**: a high-count `--repeat-each` pass locally AND the
  root-cause fix with its regression test in the same change.

### Real-time store coherence: avoid the full-refresh CLOBBER

Most of those flakes are one recurring product bug: a stale full-snapshot refresh clobbering newer live
state. The SPA has two delivery shapes and mixing them wrong drops live-added state with NO event left to
restore it.

- **Know how your entity is delivered.** A `board` event is COARSE: no payload, only a debounced full
  `workspace.refresh()`, and `hydrate` REPLACES whole lists. A spawned task/module block reaches the
  browser ONLY this way. Targeted events (`execution`/`bootstrap`/`initiative`) carry the entity and
  `upsert` it, so they don't clobber. Prefer a targeted upsert for anything that must appear reliably.
- **Full refreshes MUST be monotonic.** Two `refresh()` calls can be in flight; a staler one resolving
  later overwrites the newer. `workspace.refresh()` guards this with a sequence. Do not reintroduce an
  unguarded `hydrate(await fetch())`, and apply the guard to any new coalesced refresh path.
- **Never gate readiness on a snapshot a later resync can undo.** The on-connect resync flips `connected`
  only after it settles (which is why e2e gates on `data-connected`).
- **A REPLACE-style `hydrate` must never silently drop live-only state.** Either fold that state into the
  snapshot or reconcile rather than replace.
- **An action's OPTIMISTIC ECHO is a clobber too, and it bypasses both guards above.** A store that awaits
  a mutation and then assigns the returned sub-state onto the cached run (`step.forkDecision`,
  `step.prReview`, `step.judge`, `step.followUps`) is writing straight past `upsert`'s `rev` check. Where
  the mutation WAKES THE DRIVER, the driver's next emit routinely beats the HTTP response, so the echo puts
  the run back — and if the run then parks, nothing emits again and the newer state is gone for good (the
  fork-chat reply that vanished, leaving a "thinking…" bubble spinning). Every echo therefore goes through
  `execution.echoAfter(executionId, send, apply)`, which captures the run's `rev` before the request and
  drops the echo if anything advanced it. Never hand-roll the await-then-assign.
- **Pin it with a store-level unit test** (`stores/workspace.spec.ts` for refreshes,
  `stores/execution.spec.ts` for echoes): drive the two orderings and assert the fresher one wins.

## Basic vs advanced interface mode (frontend)

The SPA renders at one of two tiers: `basic` (the shipped default — the everyday surface) and `advanced`
(everything). Resolution is `NUXT_PUBLIC_UI_MODE` → the user's persisted choice → `basic`, in
`stores/uiMode.ts`. Full model:
[`frontend/app/README.md`](./frontend/app/README.md#interface-modes-basic--advanced).

**A new user-facing surface must decide its tier, and the answer is never "ignore this".**

- **A nav destination declares `advanced: true`** in `modular/nav-contributions.ts`. It is a SEPARATE axis
  from the RBAC `gate` and both must pass — never fold the tier into a `gate` predicate. **The bar is
  whether the EVERYDAY DELIVERY LOOP needs it** — plan work on a board, run it, review and merge it — not
  how advanced the surface feels. `nav-contributions.spec.ts` pins the advanced set against a table naming
  each item's kind AND reason, so a promotion has to write that claim down.
- **A less-used option inside a surface** reads `useUiModeStore().isAdvanced`. **HIDE, never disable, and
  only ever hide an OVERRIDE**: what remains must be exactly the default the hidden field would have shown,
  so a basic-mode user gets fewer choices, never different behaviour. Anything carrying an input NOTHING
  else supplies stays in BOTH tiers however advanced it feels.
- **Gate an override control on `showOverrideField(isAdvanced, ...values)`, NOT on `isAdvanced` alone**
  (`utils/uiMode.ts`). The hide rule holds only while the override is UNSET, which is guaranteed at
  CREATION time but never for an EXISTING entity: a block can already carry an override written by a
  teammate on the advanced tier, by the API, or by this user before switching down. The helper keeps the
  control whenever any value it edits is set (`false` counts — a tri-state `false` is a choice, not
  absence), and **it gates SECTIONS as readily as fields**.
- **A whole AUTHORING affordance may be tier-scoped**, but only when the tier hides the ability to CREATE
  and never the ability to SEE. Hide a create button whose product is only visible behind that same button
  and a basic-mode user is acted on by state they cannot find.
- **Never mark the way BACK as `advanced`.** The `ui-mode` palette entry and the sidebar switcher stay
  visible in basic mode, or the tier is a one-way door for a user who never finds the switcher.
- **An e2e spec whose subject is not the tier pins it** with `useAdvancedInterfaceMode(page)` before
  `openBoard`.

**Agent tiers are a SEPARATE axis.** An agent kind declares `presentation.tier` (`basic` / `intermediate`
/ `advanced`) and the two surfaces enumerating the whole catalog show the selected tier and everything
BELOW it. The vocabulary and the cumulative predicate live in `@cat-factory/contracts`. **Never fold this
into `isAdvanced`**: the interface mode decides which SURFACES exist, the tier decides how much of one
surface's catalog is LISTED, and the tier control must stay visible in basic mode since it is the only
route to what it hides. A new BUILT-IN kind declares its tier in `utils/catalog.ts` (`catalog.spec.ts`
fails otherwise); only a deployment-registered kind may take the `intermediate` default. A tier filter
over EXISTING settings keeps what is already set, and a narrowed list SAYS how much it is holding back.

## Internationalization (i18n)

All user-facing SPA copy goes through `@nuxtjs/i18n`; never hard-code a display string. The
`@cat-factory/app` layer ships the base `en` locale, and a downstream deployment overrides by dropping its
own files (the per-layer deep-merge is the override seam, consumer wins key by key).

- `frontend/app/i18n/locales/<locale>.json` — the catalogs (the v9+ `i18n/` convention, NOT
  `app/locales/`).
- `frontend/app/i18n/i18n.config.ts` — runtime vue-i18n behaviour only (fallback locale, the named
  `numberFormats`/`datetimeFormats`). Messages are deliberately NOT here so the module can deep-merge
  across the `extends` chain. Referenced as the BARE filename `vueI18n: 'i18n.config.ts'`, never
  `layerDir`-anchored.
- `package.json` `files` MUST include `"i18n"`. Release-blocking.

**Adding a string**: add the key to `en.json` under the feature namespace, resolve with
`t('feature.area.key')`, and format numbers/dates through `$n`/`$d` (the named formats), never raw `Intl`.

**Key conventions**: one namespace per feature; **leaf keys mirror the enum/code value verbatim** so a
dynamic lookup is total; **no cross-key concatenation** (a full sentence is ONE key with `{named}`
placeholders, plurals use the pipe form).

**Component mechanics that bite:**

- `useI18n` is auto-imported; destructure in `<script setup>` and use those fns in the template so the
  typed-key check sees literal keys. Never `import` it.
- Plural + interpolation: `t(key, { vendor, count }, count)`, where the THIRD arg is the choice.
- **Code/format-example placeholders stay INLINE**, not in the catalog — required when they contain
  `{`/`}` (vue-i18n metacharacters). Only prose placeholders get a key. Same for brand names.
- **No HTML in message bodies**: drop mid-sentence `<strong>`, or use `<i18n-t>` with slots.
- For a vendor/enum-keyed set, build an array of STATIC literal `t()` keys, one per member. Reserve the
  runtime-assembled key + exhaustive `Record` guard for lookups genuinely unknown until runtime.
- Straight quotes, no em-dashes in new entries.

**Translator descriptions (`@<key>` siblings): default to NONE.** They live only in `en.json` and are notes
to a translator, never runtime data. Add one ONLY when a competent translator seeing the English and the
key path could plausibly get it wrong: homograph / part-of-speech ambiguity (`@close`), proper nouns that
must NOT be translated (`@kaizen`), umbrella strings hiding cases the text doesn't show,
placeholder/format constraints, or plural-form requirements beyond English's two.

**Backend strings**: the backend does not localize prose. A localizable condition emits a machine-readable
`error.details.reason`/`code` that the SPA maps to a frontend key (the `usePipelineErrorToast.ts`
pattern). The wire vocabulary lives in `@cat-factory/contracts`, so the SPA imports the SAME source of
truth — `ApiErrorCode` (the status class on `error.code`) as well as the per-surface `reason` unions.

**Raw backend prose is DETAIL, never the description.** Even with no `reason` to key off, a failure is
described from its STATUS CLASS through an exhaustive `Record<ApiErrorCode, …>` of translated copy, and
the untranslated `message` (plus a validation 400's `issues` and the envelope's `requestId`) is reached
through a "Show details" disclosure that reveals it in place. So a non-English user is never handed
English as the primary explanation, and the elaborate operator remedies the backend does write stay one
click away rather than being dropped. A new failure-presenting surface copies that split.

**Drift guards** (oxlint has no `no-raw-text` rule, so these replace it):

1. **Typed message keys** make a statically written unknown `t('literal.key')` a typecheck failure. This
   does NOT cover a runtime-assembled key.
2. For enum→key lookups, guard with an **exhaustive `Record<TheEnum, string>`** keyed off the contracts
   union, plus a runtime `te()` fallback. Never rely on tier 1 alone for a reason/status-keyed lookup.
3. `pnpm --filter @cat-factory/app run i18n:check` hard-fails on MISSING keys and reports unused ones as
   non-blocking warnings (the catalog legitimately seeds keys ahead of use).
4. **Locale parity**: `i18n-locale-parity.mjs --since origin/<base>` requires a PR that adds, changes, or
   removes an `en.json` key to make the SAME change in every other locale. It is change-coupling against
   the merge-base, NOT full key parity.

**Translate for real: NEVER ship an English string as a non-`en` value.** The parity gate checks only that
the key exists, so it will pass a verbatim English copy — and that copy is a bug. The only values that may
legitimately match `en` are proper nouns identical across languages (`DeepSeek`, `AWS Bedrock`). If you
genuinely cannot produce a translation, say so in the PR rather than committing a placeholder that reads
as done.

Migration is incremental: when you touch a component, lift its visible copy into the catalog.

## Workspace RBAC enforcement

Per-workspace authorization (ADR [`0025-workspace-rbac`](./backend/docs/adr/0025-workspace-rbac.md)) is
enforced in exactly three shared places, never re-derived per controller:

1. **Resolution + the 404 hide** — `mountAuthGate` calls the single `loadWorkspaceAccess` on every
   `/workspaces/:ws/*` request, publishes `{ role, permissions }` on the context, and returns the SAME 404
   for a denied or absent board. Roles (`admin | member | viewer`) map onto seven permissions via a fixed
   kernel table.
2. **The viewer write floor** — also in the gate: any non-GET/HEAD requires `≥ member`, covering the whole
   member tier with zero per-controller code. Its sole exemption is the read-only WS ticket mint.
3. **The admin-tier permission gate** — `requireWorkspacePermission(perm)`, a Hono middleware mounted ONCE
   at the top of each admin controller. It gates every write the controller serves (now and future) while
   letting reads through, and runs BEFORE the handler's 503/lookup so an unauthorized member gets a clean
   403 without learning whether the integration is wired. Co-located with the mount, not a central
   path→permission table, so new routes inherit the right gate. Each admin controller maps to exactly ONE
   permission; `WorkspaceController` and `WorkspaceMemberController` mix gated and ungated writes, so they
   use the imperative `requirePermission(c, perm)` per handler.

Adding a route to an admin controller needs no authz code. Adding a NEW admin controller: mount the
middleware and add a `member 403` case to `defineWorkspaceRbacSuite`. Dev-open resolves no access object
and allows everything, so conformance MUST run auth-enabled or it passes vacuously.

## Conventions

- **Hexagonal layering**: controllers (`@cat-factory/server`) → services (orchestration/integrations) →
  ports (kernel). Infra adapters live in each facade and implement the ports + the `gateways` seam, wired
  via constructor injection of one `dependencies` object. Opt-in integrations wire only when configured.
- **Folded best-practice standards are two-tier, and the brief travels WITH its body.** An implementer kind
  (the `brief-standards` trait) re-sends its whole system prompt on every turn of a long loop, so it folds
  a fragment's condensed `brief` instead of the full `body`; reviewer/planner kinds keep the full text. Two
  rules: **`brief` is resolved alongside the body it condenses and NEVER re-looked-up by id** (a
  workspace/account row may override a built-in id, and re-resolving would fold the built-in's condensed
  text over the tenant's standard), and **every `composeBlockSystemPrompt` call site threads
  `standardsVerbosityFor(kind, registry)`** — a new compose site that forgets it silently restores the full
  bodies. Resolution lives on the RUN path (`resolveBodiesForRun`), never the write path, because a
  document-backed standard has no write to hook, and staleness is a FINGERPRINT of the condensed body
  rather than a change feed. **Every failure on that path folds the FULL BODY**, and an over-long
  generation is REFUSED rather than truncated: a brief optimises how a standard is STATED and may never
  change what it REQUIRES. Authoring:
  [`prompt-fragments/README.md`](./backend/packages/prompt-fragments/README.md); design:
  [`auto-generated-fragment-briefs.md`](./docs/initiatives/auto-generated-fragment-briefs.md).
- **Final answer must land in the reply, not the reasoning channel.** Any agent whose deliverable IS its
  final reply (spec-writer, blueprinter, merger, on-call, task-estimator, the tester report, the
  reviewers/companions, the requirements reviewer) MUST append the shared `FINAL_ANSWER_IN_REPLY` fragment:
  some reasoning models emit the whole answer into their private channel and return an empty visible reply,
  which the harness reads as unusable and fails the run. Do NOT append it to side-effect agents whose
  product is a pushed commit (coder, ci-fixer, conflict-resolver, mocker, playwright,
  business-documenter): they legitimately end with no final text. Editing a versioned prompt means bumping
  its number.
- **Frontend extension seams**, all contributed through the one `registerAppModule` registry
  (`app/modular/registry.ts`) — the frontend analogue of the backend registries, with the layer's install
  plugin at `enforce: 'post'` so consumer registration runs first. Adoption is phased:
  [`modular-vue-adoption.md`](./docs/initiatives/modular-vue-adoption.md).
  - **Result views**: an agent step opens the generic prose panel UNLESS its archetype declares a
    `resultView` id (`app/utils/catalog.ts`), which `StepResultViewHost.vue` resolves from the
    `resultViews` slot. **Anything EVERY window must show goes in `ResultWindowShell.vue`, never in the
    windows** — the shell resolves the step itself rather than via a per-window prop, so a window can't opt
    out or forget it. **A step-backed window's run details come from `useResultViewRunMeta(viewId, …)`**,
    never hand-derived off `useResultView`'s `stepIndex`: a window opened OFF-PATH carries a block id and
    NO step index, so reading `stepIndex` alone blanks the model, the run id and the token telemetry on
    exactly the entry point people use.
  - **Inspector panels**: a subject-keyed panel group, not a `v-if` monolith. Each sub-panel is a
    `PanelEntry<Block>` (`{ id, component, when(block), order }`) in the `inspectorPanels` slot, rendered
    by `<PanelsOutlet>`, so a consumer contributes its own with no `InspectorPanel.vue` edits.
  - **Overlays**: contributed to the `appOverlays` slot and opened via
    `useAppOverlays().open(id, subject?)`, with a single `<AppOverlayHost>` mounting the entry matching
    `ui.activeOverlay`. Duplicate ids fail fast at boot; a dangling open degrades to nothing.
- **Tests**: Worker integration tests use real `workerd` + real local D1; Node tests use real Postgres
  (`DATABASE_URL`). Only the LLM is faked. Run the full suite with `pnpm test:run` from the root.
- **Always run `typecheck`/`test:run`/`build` through Turbo from the repo root**, never a package's raw
  script from inside its directory. Turbo's `^build` edge only fires through Turbo; bypassing it surfaces
  as spurious `TS2307 Cannot find module '@cat-factory/contracts'`. To scope, filter instead of `cd`:
  `pnpm exec turbo run typecheck --filter=@cat-factory/app`. (The exception is a task with no build deps,
  e.g. the i18n check.)
