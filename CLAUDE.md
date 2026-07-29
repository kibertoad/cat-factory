# CLAUDE.md — architecture & flow notes

Orientation for working in this repo. Product docs live in [`README.md`](./README.md),
[`backend/README.md`](./backend/README.md) and `backend/docs/`. Vocabulary traps (block vs task vs
card, runner/executor/transport, `runtimes/cloudflare` = `@cat-factory/worker`) are resolved in
[`docs/glossary.md`](./docs/glossary.md). Every `backend/packages/*` and `backend/runtimes/*`
carries an `AGENTS.md` with its entry point and a "where things live" map. Design records live in
[`backend/docs/adr/`](./backend/docs/adr/); in-flight initiatives in `docs/initiatives/`.

This file holds the rules and the cross-file runtime flows. When a section names an ADR or
initiative doc, that doc is the authority; read it before changing the flow.

## Governing principle: clean design over quick solutions

Default to the well-factored design, not the fastest thing that passes. When a hack and a proper
solution diverge, take the proper one even when it costs more up front.

- **Fix causes, not symptoms.** No special-case at the call site, `try/catch` swallow, defensive
  `if`, or magic constant standing in for a real fix.
- **Respect the existing seams.** Extend through the app-owned registries (`AgentKindRegistry`,
  `GateRegistry`, `JudgeRegistry`, `PipelineRegistry`, `TaskTypeRegistry`, `VcsProviderRegistry`,
  `StepResolverRegistry`), the kernel ports, and the runtime `gateways`. Copy the nearest good
  citizen instead of inventing a one-off.
- **No shortcuts that create debt.** Don't hard-code what should be configured, widen a type to
  `any` to dodge a modelling problem, or leave a half-wired feature behind a TODO. If the clean
  solution needs a new port/method/table, add it (mirrored across runtimes).
- **Prefer deleting to accreting.** Backwards compatibility is a non-goal, so remove the obsolete
  path rather than keeping it beside the new one.

### Size budgets are a split trigger, NEVER a number to raise

`scripts/check-file-size.mjs` and oxlint's `max-lines-per-function` are ratchets: they may only go
DOWN. When your change pushes a file or function over budget, **split along a cohesive seam**.
Raising the number is a failed task, not "just this once".

The model is extracting a cohesive collaborator the god-file delegates to: the `RunDispatcher`
controller extractions (`DeployerStepController`, `RunRepoOpsController`,
`PrReviewResolutionController`), each taking a small deps object of bound callbacks with a thin
delegate left behind; `FetchGitHubClient` → `reviewPosting.ts`; a giant conformance `describe`
moved into its own `suites/*.ts`. Pull out the concern your change touches. A budget number may
only change in your PR when a split made it smaller. If you believe a split is impossible, STOP
and say so rather than bumping silently.

## Backwards compatibility is NOT a goal

Pre-1.0, no external consumers. Do NOT add migrations, shims, dual-read/dual-write paths,
deprecation windows, or "legacy" fallbacks to preserve old data or old wire shapes. When a change
makes existing rows, tokens, config, or request/response shapes obsolete, it is fine for them to
break: prefer the clean shape and let stale state be re-created. Flag the break in the changeset;
don't engineer around it.

## PR workflow

**Always finish a task with a PR, unprompted.** When the work is done, branch, commit, push, open
a PR. Don't commit task work directly to `main` unless explicitly asked; if you started on `main`,
branch off it before committing.

**A PR description is a reviewer briefing, never a restated diff.** Write it to give the reviewer
the context the diff cannot show: the problem being solved and why now, the decisions made along
the way (especially where an alternative was considered and rejected — say what and why), and what
to be aware of or look out for when reviewing (behaviour changes, a flagged compatibility break,
the riskiest or least-certain part of the change, anything that only makes sense with background
the reviewer may lack). Leave out everything the diff already states: file lists, "tests added",
line counts, or a change-by-change narration. A description that could be regenerated mechanically
from the diff has told the reviewer nothing.

**Fixing an existing PR (review findings OR red CI) lands on THAT PR's own head branch, pushed
immediately.** This overrides any environment-supplied "develop on branch X" instruction naming a
different branch. A separate `claude/ci-fix-*` or scratch branch is never the right target: CI and
reviewers only act on the PR head. Do not open a second PR to carry the fix.

CI tests the PR merged into the base (`pull/<n>/merge`), not the bare head, so a failure can come
from code the base gained after the PR forked. Reproduce by merging `origin/main` into the PR
branch, fix there, and push with `git push origin HEAD:<pr-head-branch>`.

### Documentation-staleness sweep before every PR

Docs are part of the change. CI cannot catch staleness (`check-package-catalog.mjs` only verifies
a row exists, never that its content is current). Walk outward from what you touched:

- The package's own `README.md` + `AGENTS.md` for a new export, env var, config field, behaviour.
- The root `README.md`: refresh the package's repository-layout row, and add/adjust a
  "What it supports" row for a new user-facing capability.
- This file, when you change a flow it describes or establish a new convention.
- Cross-references: a higher-level doc must POINT AT the deeper doc rather than restate or omit
  it. A new ADR / `backend/docs/*` page / initiative tracker needs a reference from where a reader
  starts, or it is lost.

Match the sweep to the blast radius. A one-line internal fix needs none; a new
export/env var/capability/flow does.

### Bigger initiatives get a tracker document

For multi-PR work (cross-cutting refactor, registry-by-registry migration, strangler conversion),
create a tracker under `docs/initiatives/` with the first PR. Capture the goal and rationale, the
target pattern (link the pilot), a per-item status checklist with PR links updated at the end of
each slice, and the gotchas the pilot surfaced. A tracker also earns its keep when an initiative
is REDIRECTED: `docs/initiatives/service-acceptance-criteria.md` records why an approach was
withdrawn, so the next iteration doesn't re-propose it.

**When the committed scope completes, convert the tracker into a numbered ADR under
`backend/docs/adr/` (`NNNN-slug.md`, next free number) and `git rm` the tracker in the same PR.**
Keep Context / Decision / Rationale / Consequences; drop the slice checklist and per-file tables.
Header shape: `# ADR NNNN: <title>` plus a `Status` / `Date` / `Context layer` bullet block.

## Environment quirks

- **Do not validate Cloudflare auth before deployments.** Skip `wrangler whoami`; assume the login
  is correct.
- **Multi-line git messages: bash heredoc in the Bash tool, NOT a PowerShell here-string.** The
  Bash tool is POSIX sh, so `@'…'@` leaks literal `@` characters into the commit subject. Use
  `git commit -F - <<'EOF'`. `git commit --amend -F -` fixes a mangled message before pushing.
- **Worker tests fail on Windows** (`config wrangler validation failed`). Pre-existing wrangler
  issue. Verify pure-logic changes from `backend/packages/orchestration` with `pnpm test:run`.
- **ALWAYS format/lint-fix the ENTIRE tree, never a subset.** `pnpm exec oxfmt .` from the root, or
  `pnpm lint:fix` for both. **NEVER** pass a path or glob to `oxfmt`/`oxlint`, for any reason: the
  only correct argument is `.`. On Windows the whole-tree run rewrites line endings across hundreds
  of files; that churn is expected and git's line-ending normalization absorbs it at commit time.
  Run it ONCE at the end and trust the result: do not diff, stash, or investigate why an untouched
  file was reformatted (it sweeps up pre-existing drift, which is correct).

## Keep the runtimes symmetric

**Any change to one runtime facade must land the symmetric change in every other.** Both facades
serve the same `@cat-factory/server` app behind the same kernel ports, so a new repository, port
implementation, table, migration, cron task, gateway, or wiring added to one has to land in the
other (D1 migration ⇄ Drizzle schema + `pnpm db:generate`; a Cloudflare `scheduled` cron ⇄ a Node
`setInterval` sweeper; a D1 repo ⇄ a Drizzle repo).

**A facade-parity gap is a showstopper, not a follow-up**, even when the second runtime "degrades
gracefully". Land both runtimes AND a conformance assertion in the same change, or don't land it.
"Node has no X yet" is acceptable only for behaviour that genuinely cannot exist on a runtime
(a Cloudflare-Container-only execution path), never for runtime-neutral domain behaviour that
merely needs a repository wired.

## Every new feature ships MOTHERSHIP-READY from its first implementation

Mothership mode ([`docs/initiatives/mothership-mode.md`](./docs/initiatives/mothership-mode.md)) is
a third deployment shape, not an optional add-on: the local node runs the engine with **no main
database**, reaching every org/durable repository over the `/internal/persistence` machine RPC. So a
feature that works only against a direct `db` handle is **incomplete**, exactly as a Cloudflare-only
feature is. Retrofitting is what the slice-by-slice `pending` backlog in the tracker IS — do not add
to it.

This applies to every feature, not only ones that feel "org-scoped": the classification below has
exactly four outcomes, and **"it doesn't apply to mothership mode" is not one of them**.

- **New repository method → decide its bucket IN THE SAME PR**, and make the decision real:
  - **`remote`** (the default for org/durable state) — add it to `REMOTE_PERSISTENCE_METHODS`
    (`backend/packages/server/src/persistence/rpc-allowlist.ts`) with a correct scope rule, plus a round-trip
    AND a cross-account-refusal test in `packages/server/test/persistenceRpc.spec.ts`. If no
    existing rule binds your arguments, add a rule — never widen an existing one to fit.
  - **`local-sqlite`** (a per-user/per-deployment credential or local-runner knob) — implement the
    `node:sqlite` repo per the tracker's bucket pattern and thread the `NodeContainerOptions`
    override, so the feature is ON in mothership mode rather than silently off for lack of a `db`.
  - **`telemetry`** (append-heavy, hot-path, short-retention run observability) — implement the
    `node:sqlite` repo in the local facade's `sqlite/telemetryStore.ts`, name it in
    `LOCAL_FIRST_PERSISTENCE_REPOSITORIES` (`rpc-allowlist.ts` — this TYPES the composition, so
    omitting it fails to compile), and give it a prune in `telemetryRetention.ts`. Do NOT also
    allow-list it: the two tables are complements and the drift guard asserts they stay disjoint.
    The test for whether state belongs here rather than `remote` is what READS it — the spend
    ledger has this write profile but its rollups gate org budgets, so it is `remote`.
  - **`excluded`** (admin-gated, a sweeper, or otherwise mothership-internal) — say so in the drift
    guard's classification map with the reason. `pending` is a _migration_ state, not a landing pad
    for new work.
- **New service reading a repo directly off `options.db`** must route through `pickRepoSource`, or
  it is a `TypeError` the moment the node boots without Postgres.
- **A new cross-cutting concern is its own `/internal/*` endpoint**, mounted on BOTH facades behind
  the machine-token audience pin and account scope — never a new hole in the persistence proxy. Copy
  the notification-delivery / events-relay shape.
- **A new secret must state which key seals it.** A repo that returns its credential SEALED can go
  remote; one that decrypts INSIDE the repo cannot, because the mothership's `ENCRYPTION_KEY` never
  reaches a laptop. Design for the sealed shape rather than discovering the block later.
- **Assert it, don't assume it.** The `[mothership]` conformance config and
  `runtimes/node/test/mothership-allowlist.spec.ts` are the guards; a feature on the board-load or
  run path that they don't exercise is untested in this deployment shape.

The failure mode this rule exists to prevent is silent: an un-routed method doesn't fail at build or
review, it fails on a developer's laptop at runtime — sometimes as a dead panel, sometimes (when the
call sits on a hot path such as the real-time fan-out) as a rejected engine publish that takes the
run down with it.

## No N+1 repository access

**Calling a single-row repository method inside a loop (`for`, `.map`, `Promise.all`) over a list
is BANNED**, in the service layer, the facade repos, and the HTTP layer alike. Instead:

- **Batch with one chunked `IN` query** via a `listByIds` / `listByFrameBlocks` /
  `countByServiceIds`-shaped port method, indexed into a `Map`. If no batch method exists, ADD one
  (mirrored D1 ⇄ Drizzle, with a conformance assertion). A read method needs no migration.
- **Reuse an already-fetched list** by indexing it into a `Map` rather than re-querying.
- **Hoist invariant reads out of the loop.**
- **Push counts/aggregates into SQL** (`COUNT`/`SUM`/`GROUP BY`), never reduce rows in JS.

Good citizens: `WorkspaceMountRepository.countByServiceIds`, `ServiceRepository.listByIds`,
`AccountRepository.listByIds`, `TaskRepository.listByRefs`, `BoardService.removeBlock`.

## Logging goes through the kernel `Logger` port, never a local logger interface

Every package logs through ONE injected interface — kernel's `Logger` (`ports/logging.ts`):
`debug`/`info`/`warn`/`error`, each `(msg, fields?)`, plus `child(bound)`. Message FIRST, fields
second (the shape the executor-harness already declares, so backend and container lines share a
convention). `@cat-factory/server`'s `observability/logger.ts` is the ONLY place a logging library
is named: it adapts pino onto the port. Full patterns:
[`backend/docs/logging.md`](./backend/docs/logging.md).

- **Declaring a local `interface XLogger { warn(obj, msg?) }` is BANNED.** That was the pre-port
  stopgap and every instance has been retired; a package that can't see kernel is in the wrong
  layer. Same for a bespoke `log?: (event, msg) => void` callback dependency.
- **A service takes `logger?: Logger` and normalises ONCE** (`this.log = deps.logger ?? noopLogger`)
  so it stays unit-testable standalone, but **`CoreDependencies.logger` is REQUIRED** — a facade
  that forgets to wire it fails to typecheck rather than silently running the whole engine on
  `noopLogger`, which is how the Worker originally shipped. `container.logger` exposes the same
  instance to controllers and facade sweepers.
- **`.catch(() => {})` is BANNED; use `runBestEffort(logger, label, fn, fields)`** (kernel). It keeps
  the swallow — a best-effort path must NEVER propagate into its caller — and adds one `warn` naming
  the operation with the cause attached. Where a bespoke `catch` is genuinely right, still bind the
  cause with `describeError(error)` instead of discarding it. `scripts/check-silent-catch.mjs`
  enforces this over `backend/packages` + `backend/runtimes`; a drop that genuinely needs no report
  keeps the idiom under a `// silent-catch-ok: <why>` comment, which is a sentence a reviewer reads.
  EVERY spelling of an empty handler counts, including a body holding only a comment — the guard
  masks comments/strings before matching, so its detection lives in `scripts/silent-catch.mjs` with
  fixtures beside it; extend those when you touch it.
  The executor/deploy harnesses are out of scope (a source change there bumps the runner image, so
  they batch into one slice) and so is the SPA (it has no logger to report through yet).
- **`describeError` scrubs through `redactSecrets`**, because a `fetch`/spawn/SDK error routinely
  echoes the request URL or an auth header. Any OTHER field carrying command output, a URL, or model
  text goes through `redactSecrets` at the emit site. Never log an auth header or a decrypted
  credential — not even at `debug`, which is a level operators turn on in production.
- **Correlate with `child`, not per-call spreads**: bind `{ workspaceId, executionId }` once at the
  top of the scope so a deeply nested emit still carries them.
- **`LOG_LEVEL`** (`process.env` on Node/local, a wrangler var on the Worker) is applied FIRST in
  each boot path; an unrecognised value falls back to `info`. The threshold is checked in the
  adapter, not on the pino instance — pino children snapshot their parent's level at creation.
- **Assert the evidence in tests** with kernel's `createRecordingLogger()`; a child writes into the
  same `lines` array, so correlation fields are assertable too.

## A controller REFUSES by throwing a `DomainError`, never by building an envelope

`handleError` (`@cat-factory/server`'s `http/errorHandler.ts`) is mounted as `app.onError` on every
facade and is the ONE producer of the `{ error: { code, message, details } }` wire envelope. A
hand-built `c.json({ error: { code: 'unavailable' } }, 503)` is BANNED: an envelope literal
structurally cannot carry `details.reason` — the machine-readable code the SPA maps to translated
copy and to its remedy actions — which is how ~120 of them accumulated with the reason smuggled
into the `code` slot instead.

- **The vocabulary is kernel's `domain/errors.ts`**, and every member takes `details`:
  `NotFoundError` 404, `UnauthorizedError` 401, `ForbiddenError` 403, `ConflictError` 409,
  `ValidationError` 422, `CredentialRequiredError` 428, `RateLimitedError` 429,
  `UnavailableError` 503. Adding a status means adding a class plus its row in `STATUS_BY_CODE`
  and in the persistence-RPC `ERROR_STATUS` map — both are `Record<Code, …>`, so both fail to
  compile until mapped.
- **`code` is the STATUS CLASS; the machine-readable cause is `details.reason`.** Never invent a
  new `code` value to express a reason.
- **Guard with the total accessors**, not a nullable read plus an `if` at every route:
  `requireCapability(c.get('container').x, 'X is not configured')` and
  `requireUser(c, 'Sign in to …')` (`http/guards.ts`), the siblings of `param()`. A per-controller
  `requireX(c): X` that throws is the shape; a `requireX(c): X | null` paired with a local
  `unavailable()` thrower is the shape it replaced — that `| null` is what forced every route to
  restate the guard, and 51 controllers had each declared their own copy of the thrower. The
  exception is a boolean FLAG (`cfg.passwordEnabled`): there is no value to narrow, so it throws
  directly. **A capability behind a capability gets its OWN accessor** — a library module's
  `sourceService` (wired only when GitHub is), the environment self-test — rather than a guard
  restated at each route, and never a message borrowed from its parent, which would name a module
  the operator has already wired.
- **A guard whose value the route ignores uses the `assert*` twin**, never a discarded `require*`.
  `assertCapability` / `assertUser` (and a per-controller `assertXWired`) return `void`, so the
  line reads as the refusal it is; a bare `requireClarity(c)` statement reads as a no-op, and the
  next mechanical cleanup deletes it with no test failing.
- **Rethrow, don't re-map.** Catching a `ConflictError` to re-emit it as `c.json({code:'conflict'})`
  drops its `reason`; let it propagate. The one deliberate exception is a handler that flattens
  distinct causes ON PURPOSE because the distinction is an ORACLE (password reset: "no such token"
  vs "expired" vs "used").
- **Three surfaces keep hand-built envelopes, each documented at the site**: the LLM/web-search
  proxy pair (each failure must be RECORDED on the call metric before responding, and they answer
  402/413/502 — statuses no domain class covers; they always carry a `code` and never echo an
  upstream exception's text, which can hold the request URL or an auth header),
  `publicApiAuth`/`PublicDecisionController` (failures are DATA, so the contract handlers stay
  typed against their declared response schemas), and the `/internal` relay controllers (a
  different `{ ok: false }` wire shape their machine clients parse).
- **A test that drives a controller through a bare `new Hono()` must mount
  `app.onError(handleError)`**, or every refusal reads as a 500.

## Caching goes through the app cache seam, never a homebrew Map

A per-service `Map` with a manual TTL, a module-global memo, or an ad-hoc `{ value, expiresAt }`
store is BANNED: it can't be invalidated across a scaled Node deployment. The seam is the kernel
`AppCaches` port (`kernel/src/ports/caching.ts`), implemented by `@cat-factory/caching`
(`createAppCaches`, on `layered-loader`), exposed as `container.caches`. Full model:
[`docs/initiatives/caching-layer.md`](./docs/initiatives/caching-layer.md).

To cache a new slow-moving read, add a slice:

- **Register it** on the `AppCaches` interface, in `AppCachesProfile` plus both
  `DEFAULT_APP_CACHES_PROFILE` and `ISOLATE_SAFE_APP_CACHES_PROFILE`, and build it in
  `createAppCaches`. Copy `repoProjection` (per-scope DB read) or `fragmentDocumentBody`
  (version-probed external read).
- **Read through it** in the owning service, grouped by the invalidation scope.
- **Invalidate on EVERY write** right after it commits. Invalidation, not the TTL, is the
  coherence story; a cached read with no invalidation on its write path is a bug.
- **Pass-through on the Worker for OUR OWN mutable state** (`enabled: false` in the isolate-safe
  profile): an isolate has no cross-isolate invalidation bus. Only immutable or sha/version-probed
  entries keep a real TTL there.
- **Wrap a nullable value** (`{ value: T | null }`), since layered-loader treats bare `null` as
  unresolved.
- Multi-node invalidation is free: the Node facade injects a Redis notification pair when
  `REDIS_URL` is set. The consuming service never sees it.

## Git-provider-agnostic (VCS) naming: never re-hardcode GitHub

The platform talks to multiple VCS providers (`github` + `gitlab`, extensible). Reintroducing
GitHub-specific names or a hard-coded `github.com` / `provider: 'github'` in a shared path is a
bug: it silently breaks GitLab deployments.

- **Neutral identity vocabulary** (`kernel/src/domain/vcs-types.ts`): `VcsProvider`, `VcsRepoRef`
  (`{ repoId, owner, repo }`), `VcsConnectionRef` (`{ provider, connectionId }`). Persisted and
  wire types name fields `repoId` / `connectionId` / `provider`, NEVER `githubId` /
  `installationId`. GitHub maps on via `githubConnectionRef` / `githubInstallationId`, the only
  place the GitHub shape of those ids is known. `@cat-factory/contracts` mirrors the union as
  `vcsProviderSchema` (keep the member lists in step). `ReferenceRepo` is the reference citizen.
- **Provider is a deployment-level fact resolved through `ResolveRepoOrigin`**
  (`ContainerAgentExecutor.ts`), mapping a repo to `{ cloneUrl, provider }`. In any clone/dispatch
  path ride `this.deps.resolveRepoOrigin ?? githubRepoOrigin` and pass `origin.provider` through to
  the harness `RepoSpec`. Never build a `https://github.com/...` URL yourself. A new repo leg
  (peer, reference) copies the primary's origin resolution.
- **GitLab is ADAPTED INTO the canonical client**, not bolted on beside it: `FetchGitLabClient`
  implements the kernel `VcsClient`, and `vcsBackedGitHubClient` presents it as a `GitHubClient` so
  the GitHub-shaped service layer works unchanged. The engine reads gates/merge/`RepoFiles` through
  **`engineVcsClient` (`githubClient ?? gitlabEngineClient`)**; keep it distinct from the App-only
  `githubClient`, or a GitLab deployment offers a dead "GitHub Issues" source. Frontend repo
  discovery is the GitHub-shaped store returning GitLab projects via the adapter; do not add a
  separate GitLab store.
- **Per-workspace PAT connect reuses `github_installations`.** `VcsPatConnectionService` validates
  the PAT, seals it with the deployment `SecretCipher`, and writes a `provider: 'gitlab'` row. When
  a facade has BOTH a GitHub App and GitLab connect, the `github` module reads through
  **`ProviderRoutingGitHubClient`**, which dispatches per installation by stored provider (memoised,
  so no N+1). Don't hand-roll a second per-provider client or fork the module; keep facades
  symmetric (`selectVcsConnectDeps` ⇄ `selectWorkerVcsConnectDeps`). This is the connect surface
  only; the engine's gate/merge still rides `engineVcsClient`.
- **What the SPA may connect comes from `GET /workspaces/:ws/vcs/connect-options`**
  (`VcsConnectController`), never inferred from a connection read. Presentation switches in ONE
  place: `app/utils/vcs.ts` `Record<VcsProvider, …>` constants plus provider-parameterised `vcs.*`
  i18n keys. Adding a provider extends those Records (the typecheck fails until you do), never a
  component fork.
- The migration is incremental: kernel ports are neutralized, but entity types (`GitHubRepo`, the
  `github_repos`/`github_installations` tables) are still GitHub-named and reused as-is. Copy the
  NEUTRAL shape for new surfaces; an un-migrated neighbour is not license to name a field
  `githubId`.

## Migrations

### Resolving conflicting Drizzle migrations (post-merge)

Node's Postgres migrations (`backend/runtimes/node/drizzle/`) use drizzle-kit 1.x snapshot v8: a
content-addressed DAG, not a linear journal. Each `snapshot.json` has an `id` and a `prevIds` array;
there is no `meta/_journal.json`. `src/db/schema.ts` is the source of truth; `pnpm db:generate`
diffs it. `migrate()` applies folders in timestamp order, so `prevIds` affects only the consistency
analysis.

A merge keeps both branches' folders with no textual conflict, but the later branch's `prevIds`
still points at the pre-merge tip, so `db:check` fails with "Non-commutative migrations detected".
(D1 has no such DAG; duplicate numeric prefixes are fine.)

Do NOT hand-merge snapshot JSON or rerun `db:generate` (a table move triggers an interactive rename
prompt that can't run in a non-TTY shell). Instead:

1. Resolve conflicts in `src/db/schema.ts` first, keeping BOTH branches' columns.
2. From `backend/runtimes/node`, run
   `node scripts/rebase-migration-snapshot.mjs <later-migration-folder>`. It rewrites that
   snapshot's `ddl` from the merged schema and re-points `prevIds` at every other migration's leaf,
   non-interactively. It does not touch `migration.sql`.
3. Check `migration.sql` still encodes the delta to the merged schema.
4. Verify with `pnpm db:check`. Keep the symmetric D1 migration in step.

### Boot drift-guard, recovery, self-healing FK migrations

Node boots by running `migrate()` BEFORE `boss.start()` (sequential, so a migration failure is the
clean top-level rejection).

- **Ledger↔schema drift.** The drizzle ledger lives in its own `drizzle` schema, so a hand
  `DROP SCHEMA public CASCADE` wipes the data while the ledger still claims everything is applied.
  `assertSchemaConsistent` probes for this and throws `DbSchemaInconsistentError` naming the
  recovery; any other failure becomes a `MigrationFailedError` mapping the pg code to a cause and
  hint. Recovery is deliberate and destructive: `pnpm --filter @cat-factory/node-server db:reset`
  drops ALL app-owned schemas together (`public`, `telemetry`, `sandbox`, `provisioning`, `drizzle`,
  `pgboss`) so the ledger can never outlive the data. Never hand-drop `public` alone.
- **Self-healing FK migrations (both runtimes).** A migration adding an `ON DELETE RESTRICT` FK
  must first delete/NULL pre-existing orphans, or it hard-fails with `23503`. Heal then constrain,
  mirrored in the Postgres `migration.sql` AND the D1 rebuild. Deleting orphaned experimental data
  is acceptable; swallowing the error is not.
- **Configurable schemas for a shared database (Node), all defaulting to prior behaviour:**
  `DB_SCHEMA` relocates the app tables via `search_path`, `DB_MIGRATIONS_SCHEMA` moves the drizzle
  ledger, `DB_PGBOSS_SCHEMA` moves pg-boss's schema. Each must be a plain lowercase identifier;
  `db:reset` reads the same env. The named schemas (`telemetry`/`sandbox`/`provisioning`) are fixed.

Test harnesses never touch the base `DATABASE_URL` DB: they require a per-vitest-worker database
and use the `postgres` maintenance DB for the admin connection.

## Layout

One pnpm workspace. Published libraries in `backend/packages/*` and `frontend/app`, runtime facades
in `backend/runtimes/*`, private packages (harnesses + conformance) in `backend/internal/*`, example
deployments in `deploy/*`. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the publish table and each
package's `AGENTS.md` for its internals.

The backend is runtime-neutral by construction: the domain and HTTP layer know nothing about
Cloudflare or Node, and each facade supplies only its differentiators (persistence, durable jobs,
real-time transport, model provisioning).

- `frontend/app` — `@cat-factory/app`, the reusable Nuxt layer (`ssr: false`) consumed via
  `extends`. Stores/composables/components/types under `app/`.
- `backend/packages/contracts` — Valibot wire contracts shared by SPA + backends.
- `backend/packages/kernel` — shared vocabulary: domain types, pure logic/constants, and ALL
  repository/port interfaces (`src/ports/*`).
- `backend/packages/orchestration` — the delivery-workflow engine and domain composition root
  (`src/modules/*`, `createCore()` in `src/container.ts`).
- `backend/packages/integrations` — opt-in integration services (GitHub, documents, tasks,
  environments, runner pools) behind kernel ports.
- `backend/packages/agents` — agent catalog + prompt composition, and the AI provisioning facade
  (`CompositeModelProvider`, the single-provider resolvers, `providerEndpoints`). OpenRouter and
  LiteLLM are plain OpenAI-compatible entries.
- `backend/packages/server` — `@cat-factory/server`, the runtime-neutral HTTP layer: all Hono
  controllers, middleware, request helpers, HMAC + OAuth helpers, the runtime `gateways` interfaces,
  the `AppConfig` contract, the dialect-agnostic row↔domain mappers, and `registerCoreControllers`.
  Controllers resolve everything from `c.get('container')`.
- Opt-in packages, each mixed into a facade only when configured: `provider-bedrock`,
  `provider-cloudflare`, `provider-s3`, `consensus`, `gitlab`, `observability-langfuse`,
  `observability-otel`, `caching`, `eks`, `gates`, `sandbox` (+ `sandbox-fixtures`), `spend`,
  `workspaces`, `prompt-fragments`, `cli`.
- `backend/runtimes/cloudflare` — `@cat-factory/worker`: D1 repos, DI composition root, Durable
  Objects, Workflows, Containers, `scheduled`/`queue` handlers, CF gateway impls. Ships its D1
  `migrations/` (pre-1.0 history squashed into `0001_init.sql`). Its `wrangler.toml` is a
  stripped test/dev config.
- `backend/runtimes/node` — `@cat-factory/node-server`: the same Hono app over `@hono/node-server`,
  Drizzle/Postgres repositories, pg-boss durable execution, Node gateways and model provisioning.
  `DATABASE_URL` selects the database; `migrate()` bootstraps on boot. Exposes composition seams
  (`resolveTransport`, `mintInstallationToken`, `githubClient`, an injected `buildContainer`, a
  `host` bind address).
- `backend/runtimes/local` — `@cat-factory/local-server`: the Node facade with two differentiators.
  Agent jobs run as per-run local containers (`LocalContainerRunnerTransport` over a
  `ContainerRuntimeAdapter` selected by `LOCAL_CONTAINER_RUNTIME`), and GitHub is reached via a PAT.
  See "Local container adapters" below.
- `backend/internal/executor-harness` — the payload running inside each per-run container (the Pi
  coding-agent harness). Published to npm; its version doubles as the Docker image tag.
- `backend/internal/{benchmark,smoketest,deploy}-harness` — headless benchmarking (`cat-bench`),
  the Pi smoketest (`cat-smoke`), and the Kubernetes manifest renderer for ephemeral environments.
- `backend/internal/e2e` — the Playwright end-to-end suite. `backend/internal/conformance` — the
  cross-runtime conformance suite plus the canonical `FakeAgentExecutor`.
- `backend/internal/example-custom-agent` — a worked example of a company-authored agent package,
  registered purely through the public app-owned registries. See "Custom agents".
- `deploy/{backend,node,local,frontend}` — example deployments carrying the production config
  (`wrangler.toml` / `Dockerfile` / `.env.example`) on top of the libraries.
- `deploy/preview` — the per-PR TEST environments for THIS repo (not a package): the
  single-origin compose stack a local deployment provisions, and the reference preview WORKFLOW
  the built-in `cloudflare` environment backend drives over the VCS Deployments API. Board
  wiring lives in [`docs/dogfooding.md`](./docs/dogfooding.md). Three constraints bite when
  editing them: the compose file must stay free of `include:` / cross-file `extends` /
  `privileged` (refused outright) and of bind mounts / `env_file` (so it stays runnable by
  hand); the SPA there is built with an EMPTY `apiBase` because a preview's host port is only
  assigned at `up` time, so same-origin is the only topology that can work; and the workflow's
  per-PR resource NAMES are a contract with `cloudflareEnvironmentConfigSchema`'s two name
  templates — rename in one place and you must rename in the other.

### Local container adapters

`LocalContainerRunnerTransport` starts the executor-harness image per run and re-attaches later
steps to it, keyed by the per-step `RunnerJobRef.jobId`. Docker/Podman/OrbStack/Colima share the
Docker-CLI adapter; Apple `container` has its own (VM-per-container, addressed by deterministic
name). Two contracts bite:

- **`endpoint()` must map an EXITED container to `undefined`** (so `resolve()` reads it as absent
  and `dispatchPerRun` re-creates it) while still THROWING for a fault against a live one. A docker
  adapter that let `docker port`'s "no public port published" escape killed the fresh-container
  recovery and reported that CLI line as the run's cause of death. A runtime that can't tell the two
  apart (Apple) takes the `undefined` half.
- **A container dying mid-run needs a post-mortem** (`exitState()` + a scrubbed `logs()` tail) onto
  the failed view's `detail`, since `release()` removes it as the run settles. A re-dispatch removes
  it too, so the FIRST death's post-mortem is retained on `PipelineStep.firstEvictionDetail`.

Each adapter exposes a `localDind` capability threaded into `ExecutionService` as
`localTestInfraSupported`, so a runtime that can't nest containers refuses a local-infra Tester run
at start (`tester-infra.logic.ts`).

## Dependencies, releases, new packages

### The `minimumReleaseAge` supply-chain gate

Installs reject any registry package published inside the ~24h cutoff. The allow-list is
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.

- **Only wildcard namespaces WE OWN** belong there (`@cat-factory/*`, `@toad-contracts/*`).
- **Never add a per-version third-party exception**, and delete any that accrue (non-strict pnpm
  appends them silently).
- **When upgrading, pick the latest version that already satisfies the rule** (`npm view <pkg> time
--json`), staying within the compatible major. Pass the explicit compliant version rather than
  excluding it.
- **Do not touch the executor-harness** during a dependency sweep: its deps feed the published
  image, so bumping them is a separate image-bumping change.
- **The Vercel AI SDK family is held to the major that pairs with `workers-ai-provider`**: today
  `ai@^7` + `@ai-sdk/*@^4` (`openai-compatible@^3`, `amazon-bedrock@^5`). Do not bump past those
  until `workers-ai-provider` ships peers that accept it.

### Releases & changesets

Versioning is changesets (root `pnpm changeset` / `ci:publish`). **Always add a changeset for a
change to a versioned package**; empty changeset for docs/CI/test-only. CI enforces this.

**Any change to what goes into the runner image** (harness `src/**`, `Dockerfile`, `tsconfig.json`,
the pinned `PI_*` args) MUST bump `@cat-factory/executor-harness`'s version AND the matching tag in
`deploy/backend/package.json`, `deploy/backend/wrangler.toml`, and `RECOMMENDED_HARNESS_IMAGE` in
`backend/runtimes/local/src/harnessImage.ts`; then `pnpm image:publish` + `pnpm deploy` from
`deploy/backend`. The deployment serves the Cloudflare managed-registry image, not GHCR, so the
GHCR auto-publish does not roll it out. **Reusing a tag does NOT deploy** (`wrangler deploy` diffs
by tag string), leaving new containers on stale code, which surfaces as
`Container dispatch failed (HTTP 404)`. Only a fresh immutable tag forces the rollout.

The release PR re-syncs the pins automatically (the root `version` script runs
`scripts/sync-runner-image-tags.mjs`), so don't hand-fix a red release PR. Consequence: the released
tag may differ from the one the feature PR published; content is identical, but the managed-registry
image for the released tag is only built at the next `image:publish` + `deploy`. `pnpm
sync:image-tags` reconciles by hand; `scripts/check-runner-image-tag.mjs` is the CI guard.

### Adding a new published package

A folder is not wired up by existing. (`@cat-factory/gitlab` and `provider-s3` once published as
empty shells because a bare `pnpm publish` skipped the build and `dist/` is gitignored.)

- **Full publish contract in `package.json`**, copied from `packages/gates`: `"files": ["dist"]`,
  `main`/`types`/`exports` at `./dist`, `publishConfig.access: "public"`, a `build` script, and a
  mandatory **`"prepublishOnly": "pnpm run build"`** hook (the guardrail for every publish path
  that doesn't pre-build).
- **Register it in `backend/tsconfig.build.json`** `references`. A package reachable only
  transitively drops out the moment that reference goes away.
- No `pnpm-workspace.yaml` edit needed (`backend/packages/*` is globbed).
- **Add a changeset** and **a row in README.md's repository-layout tables** (CI guards both).
- **Check knip knows about a dynamically-imported dependency** (`ignoreDependencies` in
  `knip.jsonc`, the `ioredis`/`layered-loader` pattern).
- Keep the runtimes symmetric if it's shared behaviour both facades wire.

Verify with `rm -rf dist && pnpm publish --dry-run --no-git-checks` from the package dir.

### Run the CI guard scripts locally before committing

> **Do NOT run `pnpm lint:knip` or `node scripts/check-package-catalog.mjs` locally.** They are slow
> and CI's `Build & typecheck` job is authoritative for both.

- `node scripts/check-file-size.mjs` — the file-size ratchet (split, don't raise).
- `node scripts/check-silent-catch.mjs` — bans `.catch(() => {})` in backend non-test source.
  `node --test 'scripts/*.test.mjs'` runs that guard's own fixtures (CI runs both).
- `pnpm exec changeset status --since=origin/main` — after committing locally.
- `pnpm lint:monorepo` (sherif) — cross-package dependency-version consistency.
- `pnpm check:publish` (after `pnpm build`) — publish-artifact integrity.
- `node scripts/check-runner-image-tag.mjs --since origin/main` — whenever anything
  image-affecting changed.
- `pnpm lint:fix` (whole tree) and `pnpm exec turbo run typecheck --filter=<touched package>`
  (typecheck covers tests, which the build configs exclude).

## Execution flow (the canonical async + observable pattern)

The gold standard for long-running agent work; anything new that runs an agent in a container
mirrors it.

1. `ExecutionService.start()` (orchestration `src/modules/execution/`) creates an
   `ExecutionInstance` with steps and hands off to the durable driver.
2. `ExecutionWorkflow` (worker `infrastructure/workflows/`) is one Cloudflare Workflows instance per
   run, looping `advanceInstance` and parking on `waitForEvent` for human decisions. A cron sweeper
   re-drives runs whose instance died.
3. `ContainerAgentExecutor.startJob()` dispatches asynchronously (`/run`, non-blocking, returns a
   `jobId`); `pollJob()` polls and lifts `view.progress` into `subtasks`.
4. In the container, `runPi()` streams Pi's JSON-line events; `parseTodoProgress()` turns the todo
   tool's output into `{completed, inProgress, total}` via `onProgress` → `JobRegistry` → the
   `/jobs/{id}` `JobView.progress`.
5. `ExecutionService.pollAgentJob()` writes `step.subtasks`/`step.progress` plus a THROTTLED
   `step.lastActivityAt` folded from the harness heartbeat (which keeps `updated_at` fresh so the
   stale-run sweeper doesn't orphan a quiet-but-alive job; ADR 0026 D3.1), then upserts and emits.
6. Events reach the browser by PUSH: `DurableObjectEventPublisher` → the `WorkspaceEventsHub`
   Durable Object (hibernatable WebSockets, one per workspace) → SPA `useWorkspaceStream.ts` →
   store → `TaskExecution.vue` / `PipelineProgress.vue`.

## Per-job state in the harness: NEVER a process- or HOME-global

**Anything the executor-harness stages for ONE job must be scoped to that job: explicit child env,
or a per-job directory. Never `process.env`, never a dotfile under `HOME`.** This is a correctness
rule.

The trap is that a global LOOKS per-job in a container, where one job owns the process and `HOME`.
The local native transport (`LOCAL_NATIVE_AGENTS`, `LocalProcessRunnerTransport`) breaks both
invariants: ONE long-lived host process serves EVERY concurrent `ambientAuth` job, and its `HOME` is
the developer's own. Container tests keep passing while one job leaks into a sibling and files the
developer owns are destroyed.

- **`RunOptions.agentEnv`** → `SubscriptionRunOptions.extraEnv`, merged over the inherited env when
  the agent CLI is spawned; layer onto it with `withAgentEnv`. **Anything the HARNESS spawns itself
  must be passed `agentEnv` explicitly** (the frontend stand-up's install/build, the ralph
  validation command), since a child of the harness inherits nothing.
- **A per-job directory** created in `handleAgent` for an `ambientAuth` job and removed with it.
  The private-registry npmrc goes there (via `npm_config_userconfig`, seeded from the developer's),
  because writing or clearing the real `~/.npmrc` corrupted the developer's own config.
- **State with no per-job form is NOT WRITTEN AT ALL** rather than written globally: a repo-sourced
  Claude Skill installs natively only into an isolated `CLAUDE_CONFIG_DIR`, and an ambient run reads
  it from the checkout's `.cat-context/skill/`. When you move state to the checkout, move the PROMPT
  with it: `renderSkillForHarness` keys off `ambientAuth` as well as the harness.

`~/.pi/*` and `~/.config/rpiv-web-tools` remain HOME-global only because the Pi harness never runs
natively (`NativeRoutingRunnerTransport` routes `ambientAuth` jobs to the host process and
everything else to a container). Do not extend that assumption to new state.

**Add a test that two concurrent jobs keep new per-job state separate.** The container path alone
will not catch the regression.

## Gates vs agents (the step taxonomy)

A step's `agentKind` puts it in one of four buckets, and most engine handling keys off which:

- **Agents** — a container or inline LLM does the work (`coder`, `architect`, `spec-writer`,
  `tester`, `merger`, the companions). Dispatched via `CompositeAgentExecutor`; container kinds park
  on `awaiting_job`.
- **Polling gates** — `ci`, `conflicts`, `post-release-health`. A gate runs a **programmatic
  precheck** against a provider and only escalates to a helper container agent (`ci-fixer` /
  `conflict-resolver` / `on-call`) on a negative verdict. Skip-unless-needed is the whole point: a
  green precheck advances with nothing spun up. ONE generic machine drives every gate
  (`evaluateGate` / `dispatchGateHelper` / `pollGate`, parking on `awaiting_gate`); a
  `GateDefinition` supplies only `wired()`, `probe()` (pass/pending/fail), `helperKind`, and
  `onExhausted`. Live state is `step.gate`. **Adding a gate is a new registry entry, never another
  `evaluateX`/`pollX`/`awaiting_x` triple.**
  - The built-ins ship as **`@cat-factory/gates`**, registered through the same public seam a
    deployment uses. The registry is an app-owned `GateRegistry` threaded through
    `CoreDependencies.gateRegistry`; `defaultGateRegistry()` is EMPTY, so a container built with no
    injected registry installs the built-ins itself. Providers are still wired deployment-global via
    `wireCiStatusProvider` / `wireMergeabilityProvider` / `wireReleaseHealthProvider` /
    `wireIncidentEnrichment`. A gate is a pass-through until its provider is wired. Pure gate logic
    lives in kernel (`domain/gate-logic.ts`) so a gate package never depends on orchestration.
  - **`resolveHelperCompletion`** is the seam for an INVESTIGATE-don't-fix helper (`on-call` never
    reverts), settling the gate without re-probing. Absent means the default re-probe loop.
- **One-shot engine steps** — `tracker`, `deployer`, `requirements-review`. Bespoke handling; not
  gates because they don't poll-or-escalate.
- **Judges** — an inline LLM scores work against a rubric, the engine compares to a per-task
  threshold (`judgeMinScore` on the merge preset) and disposes: advance / park / bounce the
  producing step with findings as `rework` / fail. See
  [`docs/initiatives/judge-registry.md`](./docs/initiatives/judge-registry.md).
  **Adding a judge is a new registry entry.** One driver (`JudgeStepController.evaluate`) owns the
  state machine; a `JudgeDefinition` supplies rubric, `parseVerdict`, `threshold`/`attemptBudget`,
  `onFail`, `bounceTargets`.
  - A judge is NOT a gate (no cheap precheck, no pending state, always costs a model call) and NOT a
    `StepCompletionResolver` (which can't park or loop).
  - The app-owned `JudgeRegistry` is EMPTY by default. The verdict producer is the injectable
    `JudgeAssessor`; `createCore` builds the inline `JudgeService` from deps every facade already
    wires, so judges need no per-facade wiring, and an absent assessor makes every judge step a
    pass-through.
  - State rides `step.judge`, no side table, so it is runtime-symmetric by construction. It survives
    `resetStepForRerun`, or a bounce would erase the verdict it loops on.
  - A rubric's per-workspace override is a prompt-library fragment (`JudgeRubric.fragmentId`), which
    is why this adds no rubric table.
  - A failing verdict never silently advances: a spent budget or no bounce target degrades to a park.
- **The `merger` resolver is a privileged built-in, deliberately NOT externalized.** It owns
  terminal block status (`ownsTerminalStatus`) and executes a policy-gated real merge, so it keeps
  engine-internal access rather than the minimal public `ResolverContext`. The public step-resolver
  seam is scoped to light follow-up (output reshaping, notification, repo follow-up);
  `ownsTerminalStatus` is built-in-only. That is also why the merger wasn't rewritten onto the judge
  machine.

The same precheck-first idea applies inline: `hasNotesToIncorporate` short-circuits
`runIncorporationCycle` so the rework + re-review LLM calls are skipped when the human left nothing
to fold in.

## Pipeline flows

Each flow below is a cross-file runtime path. Where an ADR or initiative doc exists, it is the
authority.

### Repo bootstrap (async + observable + board-integrated)

Adapts a reference architecture (or scaffolds) into a pre-created empty repo and force-pushes.
Mirrors the execution pattern: `POST /workspaces/:ws/bootstrap/jobs` returns immediately with a
`running` job. `BootstrapService.bootstrap()` pre-flights the connection, inserts a `bootstrap_jobs`
row, dispatches, materialises a provisional service frame, and starts the durable driver.
`BootstrapWorkflow` polls via `pollBootstrapJob()` (idempotent, so replays are safe), which on
success links the repo to the block and flips the frame to `ready`, on failure marks it `blocked`.
`ContainerRepoBootstrapper` is a thin layer on the shared `RunnerJobClient` seam (no direct
container binding), pre-flighting that the target is empty (`isBootstrapBoilerplate`). The harness
writes the prompt to Pi's global `~/.pi/agent/AGENTS.md` (outside the checkout, so it never lands in
the bootstrapped repo) and `reinitAndPush()`es one commit. Success also starts the blueprint-only
`pl_blueprint` pipeline against the new frame.

### Service blueprints (in-repo map + board population)

A Blueprinter agent (`agentKind: 'blueprints'`, a normal pipeline step) decomposes a repo into
service → modules and persists it IN THE REPO under `blueprints/` (`blueprint.json`, `overview.md`,
`modules/<slug>.md`, `version.json`). The map stops at modules; tasks are authored by people.
`parseBlueprintService` (Valibot) enforces the shape at ingest. The harness commits onto the branch
(no history reset). The branch is the prior `coder` step's PR branch when present (mode `update`),
else the default branch (mode `create`). `ExecutionService.recordStepResult` ingests the tree and
`BoardScanService.reconcileBlueprint` updates the frame in place: match modules by name, add
missing, refresh descriptions, NEVER delete, never touch authored tasks. Nothing is persisted to a
blueprint table; the in-repo files are the source of truth and the board is the projection.

### In-repo spec implementation state (`aspirational` ⇄ `established`)

`spec/` is PRESCRIPTIVE ("what must be TRUE"); `requirementItem.state` is what lets it also say what
is true YET — `aspirational` (agreed via the spec diff's PR review, not observed) or `established` (a
tester exercised its acceptance criteria and they passed). Without it an agreed-but-unbuilt
requirement enters every build prompt as standing behaviour and draws a spurious `not_met` on
unrelated runs. Design + the withdrawn alternative:
[`docs/initiatives/service-acceptance-criteria.md`](./docs/initiatives/service-acceptance-criteria.md).

- **A FIELD, never a `spec/` sub-folder**: a folder encodes state in the path, so every promotion
  becomes a file move and state can't be read without walking the tree.
- **The split reaches an agent through the RENDERED FILES, not the prompt.** The build/test prompts
  don't interpolate the spec (the agent reads `spec/` from its checkout), so the group markdown splits
  the halves under headings that state what each MEANS, and the Gherkin render tags an aspirational
  scenario `@aspirational` (skippable) plus a `# requirement: <id>` anchor. The prompts carry only the
  matching RULE. An agent handed an undifferentiated list of behaviours assumes it was asked to build
  them.
- **Promotion has exactly ONE author: `specPromotionPostOp`** (`@cat-factory/agents`), keyed on the
  tester kinds, off `testReport.requirementVerdicts`. Chosen over the spec-writer's own update pass
  because the writer runs 0–1 steps behind the requirements gate while the tester runs near the back:
  routing promotion through it would defer every promotion to the NEXT run and hand a deterministic,
  evidence-backed change to a model that cannot see the evidence. Only `met` promotes.
- **It NEVER demotes** — a run whose blast radius never touched a behaviour would otherwise strip the
  service's standing behaviour on every unrelated PR. A real regression is a `not_met` on an
  `established` requirement: a failing test the run answers for, not a spec edit. The PR
  verification report is where that lands — it COUNTS and marks regressions
  (`requirements.regressions`) so the distinction reaches a human rather than only a prompt.
- **Idempotent by CONTENT** (re-read, recompute, byte-compare), which is the durable driver's replay
  answer. No marker row.
- **It rewrites ONLY a shard that round-tripped byte-for-byte.** `readServiceSpec` SALVAGES (a
  requirement past a cap the lenient writer never enforced is dropped so the rest of the tree
  survives the read), so re-rendering from that view would commit the drop — a state flip on one
  requirement deleting an unrelated one. Every group shard is diffed against a baseline render taken
  BEFORE the flip; a mismatch leaves the shard, its markdown AND its scenarios' tags untouched, so
  the shard and the Gherkin can never disagree. A path the render would CREATE is skipped too:
  promotion flips a field, it never restructures the tree.
- **It lands on the PR branch, or on BASE when no PR is open.** The second case is a tester-only
  regression sweep: the tester exercised that tree, and there is no PR to defer the bookkeeping to.
  Pinned by a conformance assertion on the commit's branch.
- **The Gherkin files are SEED-ONCE**, so promotion does NOT re-render them (that would discard a
  pass-2 polish): it surgically drops the stale `@aspirational` token from the tag line below the
  `# requirement: <id>` anchor, and no-ops when a polished file lost the anchor. The anchor LEADS the
  tag line (a comment between tags and `Scenario:` is not portable across Gherkin parsers). The JSON
  shard is the source of truth for state; the tag is a runner convenience.
- **The spec-writer must never claim `established`** — the prompt says so, and `coerceRequirement`
  defaults an absent/garbled `state` to `aspirational`, so a model cannot promote by assertion.
- **The human surface is the SPA and is FRONTEND-ONLY**: `ServiceSpecWindow.vue` badges each
  requirement's state (per-group rollup + state filter, counting in `ServiceSpecWindow.logic.ts`)
  and `StepTestReport.vue` renders the tester's `requirementVerdicts`. `ServiceSpecView` already
  carries `state` and the verdicts already ride `step.testReport`, so surfacing either needs no
  endpoint and no backend change. Both are enum-keyed lookups, so both take the exhaustive
  `Record` guard over the closed union, but their FALLBACKS differ on purpose: a state coerces to
  `aspirational` (the cautious answer, and the one the domain gives), while a verdict does NOT
  coerce — there is no cautious verdict, so an unknown one renders the raw code in a colour
  distinct from all three known ones rather than borrowing `not_covered`'s grey and reading as
  "we didn't check". The state filter is sticky across groups, so the emptied-group notice carries
  a reset; the filter chips reuse the badge labels rather than duplicating catalog keys.

### Requirements review (iterative gate step + dedicated window)

The FIRST step of the default pipelines, handled inline in the engine (not a container agent). The
reviewer inspects a block's collected requirements and raises severity-tagged findings; the run
parks and the dedicated window drives an iterative loop until convergence.

**This stage settles the PRODUCT / BUSINESS layer ONLY** — what the software must do, the rules
that govern it, and business-level quality expressed as an outcome. The technical layer belongs to
the later `architect` and `researcher` steps, which refine it with the repository and the in-repo
`tech-spec/` in hand. A technical finding here is not a bonus: it asks a product owner something
they cannot answer and buries the questions only they can, which is what stalls the loop. The
boundary is ONE shared `PRODUCT_SCOPE_BOUNDARY` block folded into all THREE prompts of the flow
(`prompts/requirements.ts` — reviewer, incorporation editor, Requirement Writer) plus the matching
user prompts in `requirements.logic.ts`, because it only holds if every agent honours it: an editor
that writes a design into the incorporated document undoes a reviewer that stayed product-level.
Editing any of them means bumping its number in `kinds/versions.ts`.

1. Findings raised; the human answers or dismisses each.
2. An incorporation companion folds answers into ONE standard-format document (status `merged`).
3. Re-review runs against that document (`iteration++`): converges (`incorporated`, run advances),
   continues (`ready`), or hits the cap (`exceeded`).
4. At the cap: **extra-round**, **proceed**, or **stop-reset** (block returns to `planned`; the last
   incorporated doc survives as a base).
5. **Auto-pass**: findings at or below `maxRequirementConcernAllowed` record but don't gate.

Cap and tolerated severity live on the merge preset (`maxRequirementIterations` default 6,
`maxRequirementConcernAllowed` default `none`). There is no quality-companion grade gate.

`RequirementReviewService` (orchestration `modules/requirements/`) owns review/reply/incorporate;
the pure `disposeReview` decides auto-pass / awaiting / exceeded. Downstream,
`resolveReworkedRequirements` substitutes the incorporated doc as the block description for
`task`-level blocks and DROPS `contextDocs`/`contextTasks` (already folded in). The rework call
rejects a length-truncated document rather than persisting a silently-incomplete spec. Persistence
is `requirement_reviews`, mirrored D1 ⇄ Drizzle, asserted by conformance. Pass-through when the
reviewer model isn't wired.

**A review row is ONE JSON blob, so every mutation is rev-guarded — never a blind `upsert`.** The
three iterative-review stores (requirements / clarity / brainstorm) carry a `rev` and a
`compareAndSwap`; `IterativeReviewService.mutateReview` loads, applies the mutation, CASes, and on
a lost race RELOADS and RE-APPLIES on the winner's snapshot. A whole-row write from a stale read
would drop whatever a second writer settled meanwhile — and since incorporation refuses to run
while any finding is `open`, a lost dismissal wedges the loop on a phantom open item. Two
consequences for new code: a mutation passed to `mutateReview` must be idempotent (it can run
several times, so notifications/dispatches go AFTER it resolves, on the returned review), and a
fresh review run is published with the atomic `replaceForBlock` / `replaceForBlockStage`, never a
`delete` followed by an `upsert` — the pair can interleave into two live reviews for one block.
Giving up after the bounded retries throws `ReviewContendedError`, which is a 409 for an HTTP
caller AND the durable driver's re-drive signal in `advanceInstance` (the incorporation cycle's
mutation carries paid-for LLM output, so failing the run there would discard it).

**"One live row per block" is a UNIQUE INDEX, never a transaction around delete-then-insert.**
`replaceForBlock` is a single conflict-targeted upsert against
`(workspace_id, block_id[, stage])`. Wrapping a DELETE and an INSERT in a transaction does NOT
give this: at Postgres' default READ COMMITTED a DELETE takes no predicate lock, so two concurrent
publishers both delete nothing and both insert. SQLite serializes writers, so the same code is
accidentally safe on D1 — which is exactly the trap, since the sequential conformance test passes
on both. Assert an invariant like this with CONCURRENT writers, and enforce it with a constraint;
a constraint-adding migration heals pre-existing duplicates first (D1 `0066` ⇄ Drizzle).

**Headless callers drive the SAME loop** over `/api/v1/runs/:runId/decisions`
(`PublicDecisionController`), delegating to the same service methods, gated on the `decide` rung of
the scope ladder (`read ⊂ write ⊂ decide ⊂ admin`). **Do not add a park timeout: a parked run waits
for a human indefinitely by design**; the backstops are the workspace in-flight cap and
`POST /api/v1/jobs/:id/cancel`. `ExecutionInstance.intakeOrigin` records how a run entered.

**A HEADLESS park also ECHOES its open findings onto the linked tracker issue(s)**, opt-in per
workspace (`writebackQuestionsOnPark`, per-task override, resolved via `resolveWritebackFlag`).
Every park funnels through `ReviewGateController.park()`, which consults the pure
`shouldPostReviewQuestions`. Two rules govern this: it rides the **requirements** subject only
(the clarity gate already echoes its own questions, so opting it in would double-post), and because
the post runs in the replaying durable driver it is idempotent by an ATOMIC CLAIM on
`review_question_posts` taken BEFORE the comment, never a marker written after. A `failed` claim is
re-claimable, `posted` is terminal, and a `pending` one is re-claimable after
`REVIEW_QUESTION_POST_CLAIM_TTL_MS` so a poster killed mid-post self-heals (a claim-before-post
design must always answer "what if the claimer dies"). No wall-clock deadline: a timeout can't
distinguish "never landed" from "landed slowly". **The park commits FIRST**, the echo runs behind
it. The comment body is untrusted model-authored text on a host-parsed surface, so every hole
crosses `hostMarkdown` and `redactSecrets`.

### Inbound tracker webhooks (push intake + ticket replies)

Trackers PUSH as well as poll. `POST /webhooks/tasks/:source/:workspaceId` (`TaskWebhookController`)
copies the GitHub VCS receiver step for step: verify HMAC over the RAW body BEFORE any parse, ack
202 fast, hand the parsed event to the facade's queue, fall back to inline when none is bound.
Design: [`docs/initiatives/tracker-webhook-intake.md`](./docs/initiatives/tracker-webhook-intake.md).

- **The provider owns verify + parse** (`TaskSourceProvider.webhook`), as VCS providers own theirs;
  a source without the capability is 404ed rather than accepted into a void. All three vendors sign
  HMAC-SHA256 over the raw body and differ only in header + prefix, so the crypto is ONE helper.
- **The workspace rides the PATH; the per-connection secret authenticates.** A tracker delivery
  carries no installation id, and scanning every workspace's connections for one whose secret
  verifies would be a deployment-wide N+1 on every unauthenticated POST. The secret lives in the
  connection's sealed credential bag under `webhookSecret` (**no new table**), managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` and returned exactly once —
  `PATCH` edits the reply allow-list WITHOUT rotating, or tightening it would take deliveries down.
  **An unconfigured secret FAILS CLOSED** (503): an empty HMAC key is one an attacker also has.
- **Async hand-off is the `gateways.trackerWebhook` seam**: a `TRACKER_SYNC_QUEUE` consumer on the
  Worker ⇄ the pg-boss `tracker.sync` worker on Node ⇄ the shared `InlineTrackerWebhookIngest`. The
  message carries the already-verified, already-PARSED event, so it holds no secret, no vendor shape.
- **Push is the fast path, NEVER the only path.** The recurring `bug-intake` schedule is unchanged
  and remains the reconciliation sweep for missed deliveries.
- **A qualifying issue event FIRES THE SCHEDULE; it never re-implements intake.** The pure
  `issueEventMatchesIntake` gates `RecurringPipelineService.triggerForIssueEvent`, which calls the
  same non-forced `fire` the cron sweeper calls — so one intake implementation, inherited overlap
  protection, and no webhook-fired on-demand schedule. The predicate **fails open** on a field the
  payload omits: a false positive costs one no-op run, a false negative costs silent latency.
- **A ticket comment can ANSWER a parked requirements review**, closing the loop the question echo
  above opens. Explicit commands only, never natural-language guessing: `@cat-factory answer <itemId>
…` / `dismiss <itemId>` / `proceed` / `stop` / `extra-round`, trigger as the line's FIRST token, an
  `answer` continuing onto following lines. A comment with no RECOGNISED verb is ignored entirely —
  a bare `@cat-factory` mention is discussion, not a command sheet, and acking it would turn every
  thread into a bot conversation. Every mutation routes through the SAME service methods the SPA and
  `PublicDecisionController` call, so **never a parallel mutation path into the engine**. A reply
  that leaves nothing open auto-incorporates.
- **Three safety layers on reply text**, because on a public repo anyone can write one. (1) IDENTITY:
  the platform's OWN comments are refused first — by the vendor bot flag where there is one, and by
  the structural `isPlatformAuthoredComment` marker check everywhere, since Linear flags no bots and
  the default allow-list admits any author; an ack that could re-enter its own ingest is an unbounded
  comment loop, not a duplicate. Then the connection's optional `webhookReplyAllow` list. An
  unauthorized reply is dropped SILENTLY — replying would confirm the hook exists. (2) DATA, NOT
  INSTRUCTIONS: reply text becomes `item.reply`, capped and `redactSecrets`-scrubbed, and no verb
  reaches outside the review. (3) BUDGET: the per-review iteration cap bounds the LLM cycles.
- **Idempotency is an ATOMIC CLAIM on `tracker_comment_ingests`** taken BEFORE anything is applied,
  copied from `review_question_posts` including its answer to "what if the claimer dies" (`failed`
  re-claimable, `applied` terminal, `pending` re-claimable past
  `TRACKER_COMMENT_INGEST_CLAIM_TTL_MS`). **A claim that ERRORS must propagate, never degrade to
  "already ingested"**: the apply is idempotent precisely so the queue can retry, and swallowing it
  drops a reporter's answer while reporting success.
- **Commit the state, THEN talk to the tracker.** The reply is applied and its marker settled before
  the `postReviewReplyAck` follow-up, so a tracker outage costs the ack and never the answer.

### Bug hunt (interactive board scan + impact/effort rating)

The human-driven dual of the recurring `bug-intake` step: pick a connected tracker + one of its
boards, rate that board's open + UNASSIGNED bugs on impact against complexity, confirm one, and it
is adopted as a `bug` task on `pl_bugfix` with its run started. Design:
[`backend/docs/bug-hunt.md`](./backend/docs/bug-hunt.md).

- **It persists NOTHING** — no table, no migration. A hunt is a live provider read plus a model
  call, and the response IS the state. Runtime symmetry is therefore by construction (providers +
  the shared `createTasksModule`); what conformance pins is the WIRING, not a schema.
- **`listBoards` / `listBugCandidates` are new OPTIONAL `TaskSourceProvider` capabilities** riding
  the SAME `IssueIntakeQuery` vocabulary as intake (which gained `unassignedOnly`). **One vendor
  call per scan is a hard requirement**: every vendor's list endpoint already returns the whole
  issue payload, so a per-candidate detail fetch would be 40 round trips for data we were
  discarding. Predicates are pushed into the vendor query, the already-adopted exclusion is one
  batched `listByWorkspace` read.
- **A caller-supplied board scope is QUOTED or SHAPE-VALIDATED before it reaches a vendor query.**
  A hunt's board arrives in a request body, so GitHub's unquotable `repo:` qualifier is checked as
  `owner/repo` (`assertBoardSlug`) — a scope carrying a second qualifier would silently contradict
  the `is:open` / `no:assignee` narrowing the whole surface promises. The scan asks for ONE past
  the cap so `truncated` distinguishes "exactly 40" from "40 and more".
- **The rating answers to the spend safeguard.** It is the platform's first billable model call
  that no run start gates, so `BugHuntService` takes `isOverBudget` (the narrow predicate, not the
  spend package) and reports `over_budget` — its own status, because an exhausted budget is not a
  broken model. Any future un-run-scoped LLM call owes the same guard.
- **The model RATES; the platform RANKS.** `bugHuntScore` computes the impact/effort ratio from the
  two 1-5 judgements — never read off the reply, or the list is sorted by something its own
  rationale doesn't explain. Verdicts are joined onto the PROVIDER's rows by `externalId`, so a
  verdict naming an issue the board never returned is dropped rather than surfaced.
- **Degradation is stated, never silent.** `analysisStatus` distinguishes `unavailable` (no model
  configured) from `failed` (wired but broken) from `over_budget` because they need different
  fixes; either way the scan is still returned, with an unassessed candidate carrying a null
  `analysis` and sorting last. A swallowed ranking failure is LOGGED by the assessor, or a revoked
  key surfaces only as a permanently unranked hunt. Same rule on the read side: "this tracker cannot
  list boards" is a `details.reason` the SPA maps to a free-text field, never inferred from the
  presence of an error — a tracker outage would otherwise wear the same clothes.
- **The adopt is split like intake's**: `BugHuntService` imports + creates the task (through
  `createTaskFromIssue`'s new optional `taskType`/`pipelineId` shape), the CONTROLLER starts the run
  behind the personal-credential gate. A failed start deliberately KEEPS the task — unlike the
  public API's anonymous anchor, it is one the user explicitly adopted.

### Implementation-fork decision (two-phase Coder step)

Optional phase on the `coder` step surfacing materially different implementations BEFORE code is
written, then parking for a human to pick, enter their own, or chat. Rides `step.forkDecision` (no
side table, so runtime-symmetric like `followUps`). Gated on the Estimator's estimate via
`riskPolicySchema.forkDecision` plus a per-task tri-state. Design:
[`backend/docs/adr/0022-coder-fork-decision.md`](./backend/docs/adr/0022-coder-fork-decision.md).

A container job can't pause mid-run, so the park sits BETWEEN two dispatches on the same step:
Phase A dispatches the read-only `fork-proposer` explore kind as a helper; its completion is caught
by the `fork-proposal` interceptor, which either falls through (`single_path`, <2 usable forks) or
mints fork ids and parks. Chat rides the transient re-entry protocol (`pendingForkChat` +
`reentrantForkDecision`), computing the reply INLINE in the durable driver and re-parking with a
fresh approval id; `maxChatTurns` (default 15) is a hard budget. Phase B CAS-records the choice,
re-arms the step, and `AgentContextBuilder` folds `buildImplementationChoice` into the `build`
prompt as a binding directive. Pass-through everywhere it can't run. Scoped to the primary repo.

### Pre-PR validation (checks in the container BEFORE the PR opens)

A service frame can declare install/lint/test/build commands the harness runs against the checkout
after the agent settles and before the PR opens. A failure feeds back into the agent loop with the
captured output; only a green checkout opens a PR. Design:
[`docs/initiatives/pre-pr-validation.md`](./docs/initiatives/pre-pr-validation.md).

- **Config is per SERVICE FRAME**, resolved up the frame chain (`validation_configs`, D1 ⇄ Drizzle →
  `ValidationConfigRepository` → `ValidationConfigService` → controller → inspector panel).
  `maxAttempts` (default 3) lives on the SAME row as the commands, not the merge preset.
- **Autodetection SUGGESTS, it never writes.** The panel's "Detect" button reads the repo root
  through `resolveRunRepoContext` and fills the UNSAVED rows; the operator still saves. Rules are
  pure kernel (`domain/validation-detection.ts` composes, `validation-detectors.ts` is one function
  per ecosystem — adding one is a new function plus a `ValidationEcosystem` member), the read is
  `detectValidationChecksFromRepo` (ONE root listing, then a file read only for a manifest the
  listing proved exists). A command is suggested only on the repo's own evidence — a declared
  script/target, or the ecosystem's canonical non-opinionated verification; an opinionated gate
  (`cargo fmt --check`, `-D warnings`) needs its config file checked in, or the very first run is
  red for something no agent caused. Task runners (make/just/task) are a FALLBACK tier, never
  suggested beside a language ecosystem. "No repo", "read failed" and "recognised nothing" are
  three distinct `status` values, never one empty list.
- **Threading**: `resolveValidationChecks` → `AgentRunContext.validationChecks` → the job body, only
  when that dispatch OPENS a PR. `AgentContextBuilder` walks the frame ancestry ONCE per dispatch
  and reuses that frame for every frame-scoped resolver. Riding the job body means it works on all
  three transports with no transport-specific wiring.
- **The loop lives in the harness** (`executor-harness/src/validation-checks.ts`): run → if red and
  budget remains, re-run the agent with `buildRepairPrompt` (the 16k output tail, any UNCOMMITTED
  new files, and an explicit "do not weaken the checks" rule) → re-check. Budget spent means an
  ERROR result and NOTHING opened. Generic machinery keyed off the body; no `switch(agentKind)`.
- **Per-job state, absolutely** (cwd + `agentEnv` as arguments), pinned by a concurrency test.
- **Any harness-spawned, activity-SILENT phase MUST feed the inactivity watchdog** on a 30s
  heartbeat: `JOB_INACTIVITY_MS` (10 min) is tighter than a command's own watchdog (15 min), so
  without it a slow build aborts the run as "inactivity". Applies to any new harness-run phase (the
  agent's own stream emits activity; a raw `spawn` does not).
- **Captured output** is scrubbed with `redactSecrets` BEFORE truncation (16k to the agent, 4k on
  the wire) and reaches the step both live (`RunnerJobView.validationReport`, latest-value publish)
  and terminally, rendered by the shared `ResultWindowShell` trailing section.
- **Unconfigured means byte-for-byte the old behaviour.** A run that produced no work skips the
  loop; a config-store read failure degrades to "no checks" rather than failing the dispatch.

### Bugfix reproduction proof (the SECOND pre-PR phase: evidence, never a gate)

Runs the declared reproduction command against TWO trees (pre-fix and the PR tree) and publishes
both exit codes. Only red-then-green is proof. Design:
[`docs/initiatives/bugfix-reproduction-proof.md`](./docs/initiatives/bugfix-reproduction-proof.md).

- **The declaration seam is the prior `repro-test` step's structured outcome.** The `coder` is
  deliberately NOT a structured-output kind (it legitimately ends with no final text). Gated on the
  per-task `coder.reproductionProof` tri-state, threaded exactly like `validationChecks`.
- **SYMMETRY is the safety property and the only defence against a false `reproduced`.** Both
  phases run in fresh `git worktree` checkouts with the same setup command and byte-identical
  declared test files, so an environmental defect fails BOTH and red-then-red is `inconclusive`.
  Two load-bearing mechanics: target **`baseSha`** specifically (the coding clone is `--depth 1`, so
  `HEAD~1` isn't in history), and apply the **declared PATHS only** onto the base worktree (a
  whole-tree checkout would drag the fix across and green it). Red-for-the-wrong-reason is a stated
  limitation; both outputs ride the report so a human can see why.
- **Declared test paths are refused for git PATHSPEC MAGIC, not just traversal** (in both the
  engine's `isSafeTestPath` and the harness's copy: keep them in step). `--` stops a path being read
  as a revision but does nothing about `:(glob)**` or `*`, and these strings are model-authored. A
  refused path counts as an omission, never a silent shortening.
- **A GREEN pre-fix tree is only interpretable once you know what that tree IS.** An evicted coder
  container has already checkpoint-pushed, so `baseSha` may carry this step's own partial fix. On a
  green base only, the harness probes `changedFilesSinceBase`; non-test changes there mean the note
  says so and NO repair round is spent. The probe is memoised and degrades to the plain diagnosis
  when it can't answer.
- **Repairable is an explicit OUTPUT of an attempt**, not re-derived. Three shapes are not
  repairable because the agent is not what is wrong: a failed setup, a timed-out tree, and the
  prior-work base.
- **Bounded twice**: `maxAttempts` rounds AND `REPRODUCTION_TOTAL_BUDGET_MS` (45m). The phase's own
  heartbeat suppresses the inactivity watchdog, so the wall-clock budget is what actually bounds it.
  Exceeding it settles `inconclusive`, never a run failure.
- **Both pre-PR phases spawn through ONE seam**, `captured-command.ts`'s `runCapturedCommand`.
- **A failed verification is a REPAIR, not a run failure**, then degrades to `inconclusive` with the
  PR still opening: the opposite disposition from validation, because a red check means the WORK is
  broken while an unproven reproduction means the EVIDENCE is weak.
- **The proof runs BEFORE the validation loop**, so validation stays the last thing to touch the
  tree.
- **Per-job state, absolutely** (a fresh `mkdtemp` worktree root). A shared root would surface as a
  FALSE VERDICT on a pull request, not a crash; `reproduction-proof.concurrency.test.ts` pins it.
- **A CONCEDE is minted by the ENGINE**: a run whose reproduction step declared the bug infeasible
  dispatches no proof, so `concededReproductionReport` records the declaration. That is why "could
  not be reproduced" never reads the same as "nobody tried".

### Pipeline PR descriptions (agent-authored reviewer briefing)

A pipeline-opened PR's description is the AGENT's reviewer briefing, not a restated task record.
A PR-opening coding dispatch gets `PR_DESCRIPTION_GUIDANCE` (`@cat-factory/agents`) appended in
`buildCodingAgentBody` — only when `opensPr`; an in-place fixer amends a PR whose description it
doesn't own — asking the agent to write the briefing (problem, decisions + rejected alternatives,
watch-outs; optional `# <title>` first line) to the `.cat-pr-description.md` sentinel at the
checkout root, one per sibling repo in a multi-repo run (whose agent runs at the WORKSPACE root,
so the primary leg also falls back to a briefing left there). The harness (`pr-description.ts`)
lifts it onto `openPullRequest` — secret-scrubbed, size-capped with a visible truncation note,
the verification-report markers stripped so it can't collide with the managed section, excluded
from git like the effort/follow-ups sentinels. Absent ⇒ the dispatch-time fallback `prBody()`,
which briefs from what the pipeline knows before the run (task, human-chosen fork decision) and
marks itself as agent-less. The filename is triple-kept-in-sync (agents ⇄ harness) like
`EFFORT_REPORT_FILE`; changing the sentinel means an image bump.

Three rules the surface imposes, none of them optional:

- **A PR body is host-parsed, and the briefing is MODEL-authored** — so it crosses a text boundary
  before it is published, exactly as the verification report does. The harness's
  `host-markdown.ts` is a deliberate COPY of kernel's `hostMarkdown` (the image builds from `src/`
  plus typescript, so the harness can depend on no workspace package), pinned byte-for-byte by
  `test/host-markdown.conformity.test.ts` — change one, change the other. It defuses `#123` /
  `@name` / `!123` / closing keywords, and **closes any code fence the briefing leaves open**,
  without which the report's fenced JSON block — appended to the same body afterwards — is
  swallowed. The dispatch-time `prBody()` fallback takes the same boundary through kernel directly:
  its holes carry a human's description and the fork PROPOSER's own titles.
- **The body budget must leave the report room.** `MAX_PR_BODY_CHARS` (15k) plus the report's
  `MAX_SECTION_CHARS` (50k) has to stay under the host's 65,536 limit, or the report — whose
  publisher swallows its own failures — silently stops publishing.
- **A RESUMED run must refresh the PR it already opened.** The re-dispatch pushes onto a branch
  whose PR is open, so the create answers 422 and the briefing would be read, scrubbed, capped and
  then dropped — on precisely the long runs worth briefing. `refreshExisting` PATCHes title + body
  (GitHub) / PUTs them (GitLab), carrying the managed report region across, and is set ONLY when
  the text is the agent's own briefing: refreshing from the generic fallback would clobber a
  human's edit.

### Merge lifecycle (CI gate → CI-fixer → merger → notifications)

Turns an open PR into a merged one, gated on REAL CI and a REAL merge, so a task is `done` only when
its PR actually merged.

- **`ci` (polling gate)**, auto-inserted second-to-last. Reads the PR head's check runs via the
  `CiStatusProvider` port and aggregates with `ci.logic.ts`: green/none finishes and advances with
  nothing spun up; pending sleeps `ciPollInterval`; failure dispatches a `ci-fixer` container job up
  to `ciMaxAttempts` (default 10), else raises `ci_failed` and fails the run. Pass-through with no
  provider wired.
- **`ci-fixer`** clones the PR head, makes CI pass, and pushes back onto the SAME branch.
- **`merger`** (last standard step) clones the PR head, scores the diff (complexity/risk/impact) and
  returns ONLY a JSON assessment, making no commits. `resolveMergerStep` compares it to the task's
  merge threshold preset and either merges for real (`PullRequestMerger` → block `done`) or raises
  `merge_review` leaving the block `pr_ready`. A pipeline with no merger raises `pipeline_complete`
  instead of auto-`done`.
- **Merge threshold presets** — a per-workspace library (`merge_threshold_presets`); a task selects
  one via `Block.mergePresetId`, else the workspace default. Carries the auto-merge ceilings,
  `ciMaxAttempts`, the requirements-review knobs, and the per-class `classRules` map.
- **Merge track record** — every decision persists a row in `merge_track_records`: the deterministic
  change class, the merger's scores, the outcome, and a nullable reviewer-effort tag. This is the
  human evidence the thresholds approximate. The whole feature is a **best-effort side channel**:
  classification and record writes swallow their own failures. Design:
  [`docs/initiatives/merge-track-record.md`](./docs/initiatives/merge-track-record.md).
  - **Classification** is pure backend TS over ONE VCS call (`listChangedFiles` →
    `classifyChangedFiles` in kernel), deliberately not in the harness (no image bump) and
    provider-neutral. Classes rank `docs < test < dependency < config < source < schema` and a mixed
    diff takes the HIGHEST present, which is what makes a per-class rule safe. An unreadable diff
    yields `unknown`, and **`unknown` never matches a rule**, so a VCS outage can't change policy.
  - **Per-class rules** resolve in `MergeResolver` with fixed precedence: `autoMergeEnabled: false`
    > the class rule (`always` bypasses both the score comparison and the empty-rationale backstop;
    > `never` forces review) > the credibility + threshold comparison.
  - **Effort capture** rides existing decision points (`POST /notifications/:id/act` takes an
    optional `reviewEffort`; `POST /merge-track-records/:id/effort` tags out of band). A PR merged
    directly on the provider is detected from the webhook and attributed by `(repoId, prNumber)`.
    Tagging is a nudge, never a gate.
  - **Rollups** are ONE SQL aggregate per workspace behind `rollupByClass`, never rows reduced in JS.
- **Notifications** are a first-class human-actionable surface, not a mid-pipeline gate. The
  canonical row is persisted and pushed in-app behind a `NotificationChannel` port, with
  `CompositeNotificationChannel` as the seam for other channels. `WebhookNotificationChannel` is a
  per-workspace outbound HTTPS endpoint, HMAC-signed with a sealed secret through the SSRF-guarded
  `safeFetch`, best-effort under one deadline; it exists because a headless caller has no in-app
  inbox. An EMPTY type filter means the parking + actionable-tail defaults, not everything. It is an
  EXTERNAL channel, so it composes into that set on both facades. In mothership mode
  `RemoteNotificationChannel` asks the mothership to deliver the row by id
  ([`docs/initiatives/mothership-mode.md`](./docs/initiatives/mothership-mode.md)).

### PR verification report (engine-maintained evidence on the run's PR)

The engine, not the agent, keeps a verification report on every run's PR: captured facts, not the
agent's prose claims. Form:
[`docs/initiatives/pr-verification-report.md`](./docs/initiatives/pr-verification-report.md).

- **A managed section of the PR BODY**, delimited by `<!-- cat-factory:verification-report:start -->`
  / `:end` (`kernel/domain/pr-report.ts`, `spliceManagedSection`). The markers ARE the identity, so
  the write is idempotent with NO persisted state. A maintained COMMENT was rejected: it needs a
  persisted id plus an `updateComment` write neither port has.
- **An engine HOOK on step settlement, not a pipeline step.** One call in
  `RunDispatcher.recordStepResult` → `PrVerificationReportController.publishForRun`. Its POSITION is
  load-bearing: AFTER `applyTerminalStepResolver` (so a merger publishes with its resolved decision)
  and BEFORE `finalizeBlock`. A `pr-report` STEP was rejected: it would need inserting into all 15
  built-in pipelines, would never exist for deployment-authored ones, and a run that fails or parks
  part-way would never reach it.
- **Composed from state already in memory** (`prReport.logic.ts`, pure): the CI gate's recorded
  verdict (never a re-probe, which costs a round trip and can disagree with what the gate acted on),
  the tester's last report, the deployer's env projections, the merger's `step.custom`, per-step kind
  and model. Only reads: one `blockRepository.get` and one batched `taskRepository.listByBlock`. The
  repo and provider come from the publisher's `resolveTarget`, never from `diagnostics.lastDispatch`
  (a PEER repo on a multi-repo task).
- **The ONE exception to "already in memory" is the REQUIREMENT → EVIDENCE section**, which joins the
  service's in-repo `spec/` to the tester's per-requirement verdicts, so it needs a repo read. GATED
  then MEMOISED: nothing is read until a tester has actually reported (before that the answer is
  already determined, so the settlements before the tester stay at zero repo calls), and the
  reassembled tree is cached per execution id. The memo deliberately holds the spec AS THE TESTER SAW
  IT — the promotion post-op rewrites it on this same branch straight after, so re-reading would pair
  fresh state with stale verdicts. Only an ANSWER is memoised (a tree, or a repo with no `spec/`),
  never a FAILURE: caching one flaky read would report "the spec could not be read" for the rest of
  the run. Read through the same `resolveRunRepoContext` seam the repo-ops controller uses, so it is
  facade-symmetric by construction; unwired ⇒ `absent` with a note.
  Verdicts are three-valued (`met`/`not_met`/`not_covered`) because "we didn't check" and "it's
  broken" must never render the same, and a requirement's implementation state travels WITH its
  verdict so `not_covered` on an `aspirational` one reads as expected, not as a coverage gap. Unlike
  every other section this reads EVERY tester step, because promotion does: a pipeline with both
  `tester-api` and `tester-ui` would otherwise report `not checked` against requirements the spec
  already records as `established`.
  **`not_met` on an `established` requirement is a REGRESSION and is counted as one**
  (`requirements.regressions`, a subset of `notMet`, so the tallies still sum to `total`). That is
  the one derived fact the implementation-state axis exists to make computable: every other
  consumer of the axis states the distinction in prose to a MODEL, and left uncomputed the two
  readings of `not_met` — "not built yet" and "you broke it" — reach a REVIEWER as the same cell.
  It is evidence, not policy: the report counts and marks it, and never gates a merge on it.
- **A section whose producing step didn't run says so** (`status: 'absent'` + a note); a silently
  missing section reads exactly like a clean one. Same for a CAPPED list: every cap records what it
  dropped in the report's `truncations` log. The requirement table's cap is the one that is NOT a
  plain prefix: `selectRequirementEntries` selects regressions first and then fills the budget in
  spec order (restoring spec order to render), because a prefix cap drops the row a reviewer must
  not miss purely by where its feature sorts. Its truncation note says so, since a reader who
  assumes a prefix would conclude the tail was never ruled on. Priority is not a GUARANTEE —
  more regressions than the row budget still lose some — so the note reports how many FIT and the
  call-out admits the table holds fewer than it counts; a note overstating what survived is the
  same false reassurance as no note at all.
- **A PR body is NOT an inert string sink**; kernel's `hostMarkdown` is the boundary. The host
  auto-links `#123`/`@name`/`!123`, a **closing keyword before an issue reference CLOSES that issue
  on merge**, a raw newline ends a table row, and an unbalanced fence swallows the JSON block that
  IS the machine-readable contract. Untrusted text goes through `cell`, `inline`, or `prose`, all of
  which neutralise auto-link triggers with numeric entities in ONE pass (chained `.replace()`s
  re-escape each other). Adding a field means picking one of the three.
- **Free text is scrubbed with `redactSecrets`** at COMPOSE time so prose and JSON stay consistent.
  A PR body is strictly more exposed than the telemetry DB.
- **Per-workspace opt-out** (`publishPrVerificationReport`, default on), checked BEFORE anything is
  read. Turning it off stops future writes; an existing region is left alone.
- **Provider-neutral**: the `PrVerificationReportPublisher` port is served by `GitHubPrReportPublisher`
  over whatever `GitHubClient` the facade wired as its ENGINE VCS client. It needs the required
  `getPullRequestBody` on both ports (read-splice-write against the CURRENT remote body, so a
  concurrent human edit is never clobbered).
- **Best-effort, always**: the controller swallows and logs (wire the facade logger, or a revoked
  token leaves no trace) and is a no-op with no publisher. It hashes the rendered section so a
  no-visible-change settlement costs no edit, but does NOT collapse to one write: the report tracks
  the run as it progresses.

### Post-release health (Datadog gate → Agent-On-Call → notify/enrich)

The `post-release-health` gate (LAST standard step, after `merger`) watches monitors/SLOs for a
window and, on a regression, spawns an `on-call` agent to investigate. It never auto-reverts.

`probe()` reads the block's monitors/SLOs since a release marker (`step.gate.watchSince`) and
combines the verdict with the window via `classifyReleaseHealth`. `attemptBudget` is the preset's
`releaseMaxAttempts` (default 1); the window is `releaseWatchWindowMinutes` (default 30).

The kernel `ReleaseHealthProvider` port is vendor-neutral, served by `RegistryReleaseHealthProvider`
(a registry of per-vendor adapters, today only `DatadogObservabilityAdapter`). The composite owns
connection loading, decryption, frame-chain config resolution, and the verdict reduction; an adapter
is just the vendor reads, so a second provider is a new registry entry. Credentials live in
`observability_connections` (sealed), never in containers; per-block mapping in
`release_health_configs`. The SPA splits this: the connection is an Integrations entry, the
monitor/SLO mapping a service-inspector panel.

The gate escalates via `gatherHelperPriorOutputs`. `on-call` returns only a JSON assessment
(culprit confidence + revert/hold/monitor), resolved SPECIALLY (not the generic re-probe) by
`resolveOnCallStep`: raise `release_regression`, best-effort enrich any open incident (the
`IncidentEnrichmentProvider` port annotates, never re-alerts, since those systems page off the same
signals), finish the gate. The human decides revert/acknowledge out of band.

## Custom agents (manifest-driven extension over `RepoFiles`)

A deployment ships its own agent kinds without forking and without rebuilding the harness image.
Governing principle: **zero `switch(agentKind)` in the container**. The harness is a generic
LLM-over-a-checkout runner; all deterministic work is backend TypeScript. Full model:
[`backend/docs/custom-agents.md`](./backend/docs/custom-agents.md); the ROLE-authoring guide
(prompt composition, skill + tool-server authoring):
[`backend/docs/custom-agent-roles.md`](./backend/docs/custom-agent-roles.md).

- **Three stages**, of which the container runs only the middle: `preOps` (backend TS reading and
  committing a targeted subset via the `RepoFiles` port, no checkout) → `agent` (optional:
  `inline` / `container-explore` prose or structured JSON → `result.custom` / `container-coding`) →
  `postOps` (backend TS parsing `result.custom`, rendering artifacts, committing).
- **Registration by reference** on the facade's app-owned registries:
  `agentKindRegistry.register({ kind, systemPrompt, agent, preOps, postOps, presentation })` plus
  `pipelineRegistry.register(...)`. A `container-*` surface implies the container requirement.
- **Live wiring**: `ExecutionService` runs `preOps` before dispatch and `postOps` after
  `recordStepResult`, over a per-run `RepoFiles` bound by the facade-wired `resolveRunRepoContext`
  (composed via `makeResolveRunRepoContext`, wired in ALL THREE facades). Unwired means the hooks
  skip. `runRepoOps` lives in `@cat-factory/agents` so orchestration doesn't import the server layer.
- **`RepoFiles`** (`kernel/ports/repo-files.ts`) is a per-run, checkout-free facade over the Git
  Data + contents API: pure HTTP, so runtime-symmetric.
- **CAPABILITIES — what the kind KNOWS and what it can REACH**
  ([ADR 0029](./backend/docs/adr/0029-agent-kind-capabilities.md)): `skills` (procedural playbooks)
  and `toolServers` (MCP), declared on the kind and resolved per dispatch. Reusable definitions
  register on the SAME `AgentKindRegistry` (`registerSkill` / `registerToolServer`) — they are
  capabilities OF agent kinds, like traits, so they do NOT get their own registries — and
  `assignSkills` / `assignToolServers` attach them to an EXISTING (built-in) kind without
  redefining it, exactly like `assignTraits`.
  - **Skills resolve in the ENGINE** (`resolveRunSkills` → `context.skills`, catalog versions
    pinned onto `step.skillVersions`); **tool servers resolve in the container EXECUTOR**
    (`resolveToolServers`), because what is servable depends on the resolved HARNESS and the
    facade-wired credential resolver, neither of which the runtime-neutral engine knows.
  - **A BUNDLED skill ships in the deployment's own code** — no library, no GitHub, no pin — which
    is what lets a shipped agent package carry its own playbook. A `{ catalogSkillId }` ref is the
    tenant-authored repo-synced kind (ADR 0024) and FAILS the dispatch when it can't resolve unless
    it declares `optional`.
  - **A tool-server credential is declared BY NAME** (`secretKeys`) and resolved through the kernel
    `ToolSecretResolver` port — both facades wire `createEnvToolSecretResolver` (the deployment's
    own env), so a server needs no table and no UI. The VALUE rides the job body's `mcpServers`
    field only; `context.toolServers` is the non-secret projection the prompt AND the telemetry
    snapshot see. The job spec also NAMES which `env`/`headers` keys are credentials, so the
    harness registers exactly those for redaction rather than scrubbing declared config too.
    That default resolver is a TRUST BOUNDARY: a definition names both the key it wants and the
    endpoint it reaches, so a deployment installing third-party agent packages passes
    `{ allowKeys }` (convention: an `MCP_…` prefix).
  - **`allowedTools` is SCOPING, never a security boundary.** Stated in the prompt on every
    harness; additionally sent to claude-code's `--allowedTools`, which must ALWAYS carry the
    CLI's built-in tool names too (an allow-list is whole-session, not MCP-scoped). Whether the
    CLI gates on it is permission-mode dependent, so the harness is written to be correct either
    way. An `http` server must be `https` or loopback — refused at registration AND at the job
    boundary, because its credential rides a request header.
  - **A capability on a NON-container kind is inert and boot says so**
    (`skills_without_container` / `tool_servers_without_container`).
  - **A server that can't be wired is STATED to the agent, never silently dropped** (Pi has no MCP
    client; an ambient Codex run has no per-run config home; a required secret didn't resolve), so
    it plans around the gap instead of discovering it mid-run. A required secret defaults to
    `required: true` — a tool whose first call 401s is worse than one the agent knows it lacks.
  - **The harness MATERIALISES, never decides**: `skills[]` → native
    `CLAUDE_CONFIG_DIR/skills/<name>/` or `.cat-context/skill/<name>/`; `mcpServers[]` → a per-run
    `--mcp-config` + `--strict-mcp-config` (claude-code) or `[mcp_servers.*]` in the per-run
    `CODEX_HOME/config.toml`. Both are PER-JOB paths — never HOME-global, never the checkout.
    Changing either means an image bump.
- **Frontend**: the workspace snapshot carries `customAgentKinds`, merged into the palette via
  `useAgentsStore().registerCustomKinds`; a structured kind's `result.custom` renders through the
  shared `generic-structured` view. No bespoke UI.
- **NOT yet done**: the built-in agents aren't migrated to this model; their rendering still lives
  in the harness. Converting them one at a time (parity-gated, image-bumped) is the remaining
  strangler work.

## Per-workspace agent prompt overrides (edited from the pipeline builder)

A workspace can replace any agent kind's system prompt from the pipeline builder — the surface
where its step is chosen — and switch back through the full history of what it has run.

- **The store is an APPEND-ONLY revision log** (`agent_prompt_revisions`, D1 ⇄ Drizzle, keyed
  `(workspace, agent_kind, revision)`), and the HIGHEST revision is live. There is no update and
  no delete: restoring an older prompt appends a copy of it (tagged `restoredFrom`), and going
  back to what the product ships appends a revision whose `text` is **NULL**. That null is a real
  state, distinct from a kind nobody ever edited — it keeps the workspace tracking the shipped
  prompt as it is bumped instead of pinning a stale copy of today's wording, and it records that
  someone reverted deliberately.
- **The composite key is the concurrency control, not hygiene.** The next revision number comes
  from a read, so a second editor's insert COLLIDES; `AgentPromptService` re-reads the head to tell
  that apart from a store failure (the two runtimes report the violation differently) and raises
  `prompt_revision_conflict`. **Never turn that insert into an upsert** — last-write-wins would
  silently discard one of two people's prompts.
- **An override replaces the SHIPPED TRACK PROMPT, never the whole system prompt.**
  `systemPromptFor(kind, registry, override?)` re-applies the surface directives and trait guidance
  on top, because those are invariants of how the platform runs a kind (a read-only kind must not
  edit; a reasoning kind's answer must land in its visible reply) rather than editorial content. So
  the editor shows — and an override supplies — `baseSystemPromptFor`, not `systemPromptFor`.
- **The engine resolves it ONCE per dispatch** (`AgentContextBuilder`, in the same read wave as the
  rest of the context) onto `AgentRunContext.systemPromptOverride`, so the container, inline and
  consensus paths cannot disagree about which prompt a step ran under. **A new prompt-assembly site
  must honour it** — the same hazard `standardsVerbosityFor` has. Container dispatch rides
  `dispatchSystemPromptFor` (`@cat-factory/server`'s `agents/promptOverrides.ts`); the inline and
  consensus executors pass the override to `systemPromptFor` directly, where it wins over the
  deployment-wide `AGENT_ROUTING` system prompt (the workspace's edit is the more specific of the two).
- **`BESPOKE_CONTAINER_SYSTEM_PROMPTS` exists so the editor and the dispatch agree.** `merger` and
  `on-call` dispatch a bespoke constant instead of their role prompt, so an editor built on
  `systemPromptFor` would show a baseline those kinds never run — and "restore the built-in" would
  restore something that was never running. Adding another such kind means adding it there too.
- **Writes are `settings.manage`, reads pass through.** The builder is member-tier, but an edited
  prompt changes every run in the workspace — the same blast radius as the model mapping.
- **The SPA affordance is an OVERRIDE control**, so it is gated on `showOverrideField`: hidden in
  basic mode while the kind runs the shipped prompt, revealed as soon as the workspace carries one.

## Unified agent runs (failure + retry surface)

Both container-backed flows (task `execution`, repo `bootstrap`) persist to one `agent_runs` table
(kind-scoped), and the board surfaces failure + retry uniformly. `D1AgentRunRepository` reads across
kinds (`getRef` for retry dispatch, `listStale` for the sweeper); `sweepStuckRuns` re-drives stale
`running` runs of BOTH kinds. `POST /workspaces/:ws/agent-runs/:id/retry` resolves the kind then
calls the right service. The frontend merges executions + bootstrap jobs into a per-block summary
rendered by the shared `AgentFailureCard.vue`. A failed execution leaves its block `blocked`.

## Telemetry & agent-context observability

Three sinks live in a dedicated telemetry store, separate from the transactional domain
(append-heavy, high-volume, short-retention): a required `TELEMETRY_DB` D1 database on Cloudflare
and a `telemetry` Postgres schema on Node. All three are pruned to
`LLM_CALL_METRICS_RETENTION_DAYS` (default 3). The known gaps across observability, logging and
error handling — and the phased plan to close them — are tracked in
[`docs/initiatives/observability-logging-gaps.md`](./docs/initiatives/observability-logging-gaps.md).

- **`llm_call_metrics`** — per LLM call (prompt/response delta-stored, tokens, timing), recorded via
  `LlmObservabilityService`. The subscription harnesses (Claude Code / Codex) bypass the proxy, so
  the harness lifts metrics off each CLI's event stream and `pollJob` feeds them through the SAME
  service via `makeHarnessCallRecorder`. Claude Code's `stream-json` carries full bodies; Codex's is
  thinner; neither exposes per-HTTP timing.

  **These STREAM.** The harness hands over whatever accumulated since the previous poll
  (`RunnerJobView.callMetrics`, drain-on-read), and the complete list still rides the terminal
  result. Both carry the same objects stamped with a job-scoped `seq`, so both mint the same
  `<jobId>-hc-<seq>` id and `record` ignores the second write (first write wins, NEVER an upsert,
  which would recompute the delta against a moved chain tip). Both repos target the ID alone
  (`onConflictDoNothing({ target: id })` ⇄ `ON CONFLICT(id) DO NOTHING`, NOT `INSERT OR IGNORE`,
  which would also swallow a constraint violation on one runtime only). Terminal-only recording
  meant a run whose container died reported ZERO calls, which is precisely the run worth inspecting.

  Two invariants the streaming introduces:
  - **A published call must be FINAL.** A producer whose numbers arrive late
    (`attributeCumulativeUsage`) publishes through `createCallMetricPublisher`, which WITHHOLDS an
    un-costed call until the fallback can no longer fire. Otherwise the row lands as zero tokens and
    the correction is dropped.
  - **`latestChainTip` skips `message_count = 0` rows.** A subagent call carries no re-sendable
    chain, and those interleave with the parent's now that telemetry streams; a tip nothing can
    chain onto loses delta compression on exactly the subagent-heavy runs where it matters.

  **The input side is THREE orthogonal classes, never a lump.** `promptTokens` is FRESH input,
  with `cacheReadTokens` + `cacheWriteTokens` beside it, so total input is their sum. They are
  priced ~1x / ~0.1x / 1.25-2x base input respectively — a cache WRITE costs more than fresh —
  so any producer summing them makes a loop that keeps invalidating its prefix read exactly like
  one riding a warm cache. A new producer normalises to fresh at the source through the SINGLE
  `readInputTokenClasses`, never a read-the-classes helper paired by hand with a subtract-them
  one: it subtracts where the vendor reports an INCLUSIVE prompt count (OpenAI/DeepSeek/Codex)
  and leaves the already-exclusive field alone where it reports them apart (Anthropic), and
  **reads the two cache classes INDEPENDENTLY** — an OpenAI-shaped gateway fronting Anthropic
  (`litellm`, OpenRouter) reports a read field AND a write field on one payload, so detecting one
  must never suppress the other. Only Anthropic reports a write class — 0
  elsewhere, never guessed. A count that survives a wire boundary is read LENIENTLY on the way in
  (`coerceCallMetrics`): a runner pool runs whatever harness image its workspace pinned, so
  requiring a field a new image added would drop that pool's telemetry wholesale instead of
  losing the one class the old image never measured. Distinct from the harness's
  `PiRunOutcome.usage`, which is the
  key-rotation WEIGHT and deliberately keeps summing every billed bucket. **On every SPA surface the
  headline `↑` is the TOTAL of the three (`totalInputTokens`), with the classes as the breakdown** —
  the like-for-like of Claude Code's context gauge, which counts the same buckets. Splitting the
  classes makes COST readable; leading with the fresh figure would make VOLUME unreadable, and did
  (a ~31M-token run rendered as 685). Design + the gotchas:
  [`docs/initiatives/token-telemetry-per-class-and-cost.md`](./docs/initiatives/token-telemetry-per-class-and-cost.md).

  **Every row is stamped with the PHASE that spent it and its TURN ordinal**, so a run's burn can
  be attributed to the slice that caused it (the agent's own loop vs a pre-PR validation repair
  round vs a reproduction-proof repair round) instead of piling into one figure per agent kind.
  Design: [`docs/initiatives/token-burn-instrumentation.md`](./docs/initiatives/token-burn-instrumentation.md).
  - **The phase is stamped by whoever OWNS the boundary, never reconstructed downstream.** The
    harness drives those loops, so its job registry stamps `phase` on each streamed call at EMIT
    time (not drain time — a poll lands long after the phase moved on), and the Pi path, whose
    calls are metered server-side, carries it on the proxy URL (`${proxyBaseUrl}/phase/<phase>`,
    rewritten per pass) because Pi makes those requests from a config with no per-request header
    to set. Reconstructing phase from wall-clock timestamps is the brittle inference this avoids.
  - **`''` is a REAL slice, not a gap** — an unphased call (an older image, an inline call, the
    unphased proxy path) is filed as unattributed rather than guessed at from the agent kind. Every
    boundary the free-text label crosses runs it through kernel's `normalizeCallPhase`, since two of
    the three producing paths (a request path, a pool's JSON) arrive over HTTP. The harness carries
    a COPY of that normaliser (`normalizeProxyPhase`) because the image depends on no workspace
    package, pinned by `test/llm-phase.conformity.test.ts` exactly as `host-markdown.ts` is.
  - **The BACKEND declares the phase-tagged route** (`proxyPhasePath` on the job body, the same
    shape as `webSearch`); the harness tags Pi's base URL only when told. Never assume the harness
    image and the backend are a matched set: that holds for the Cloudflare deployment, but a runner
    pool pins its own image and `LOCAL_HARNESS_IMAGE` overrides the recommended pin, and an image
    ahead of its backend would 404 EVERY model call rather than merely lose its telemetry.
  - **`turn_index` is NULLABLE, not 0.** It is the harness's job-scoped `seq` (the same number the
    row id is minted from); the proxy has no job-scoped counter, and a 0 there would sort every
    proxied call to the front of its phase as "the first turn".
  - **The rollup is ONE aggregate at the `(agentKind, phase)` grain**, and every coarser view is a
    pure fold over it (kernel `domain/llm-rollup.ts` → `step.metrics` + `step.metrics.byPhase`, the
    debug overview's `llm.byAgentKind` + `llm.byPhase`, the panel's run-level table). It runs on
    EVERY step settlement, so a second `GROUP BY` per axis both doubles the emit's cost and lets
    two breakdowns of the same rows disagree. **A new consumer folds; it does not add a query.**
  - **The `carryCostTokens` proxy is charged per CONVERSATION** (`partition by agent_kind`, the
    key the prompt delta chain uses) — a later step's turns never re-send an earlier step's
    context. Its window orders by `(created_at, message_count, id)`, never `turn_index`, which is
    NULL for every proxied row. It is the one column summed as 64-bit: a product of two sums
    clears int4 on any real run, so the Postgres aggregate casts `::bigint` where its neighbours
    cast `::int`.

- **`agent_context_snapshots`** — the complete context an agent was PROVIDED per dispatch: composed
  system + user prompts, fragment bodies, and the full content of injected `.cat-context/*` files
  (which the agent reads via tools, so they never reach proxy telemetry). A redacted allow-list
  projection, never a token or credential-bearing URL. As defence in depth, `record` also runs every
  stored body through `redactSecrets` before the size budget, deep-scrubs `extras` (free-text prose
  can embed a token), and drops the body of a context file whose name marks it a credential store
  (`isSecretShapedFilename`). `redactSecrets` catches PEM-armored keys by header regardless of
  filename.

- **`agent_search_queries`** — one row per web search a container agent PERFORMED (query, provider,
  result count). The sibling of the snapshot: that keeps what the agent was given, this what it went
  and looked up (the search rides the web-search proxy, not the LLM proxy). The stored query is
  clamped to `MAX_SEARCH_QUERY_CHARS` so a pathological query can't fail the row.

- **Gating**: the snapshot and the search queries require BOTH `LLM_RECORD_PROMPTS` AND the
  per-workspace `storeAgentContext` (the operator opt-out wins). Each service wires only when its
  repository is present. **That double gate governs every path that captures a model BODY, not
  just the ones that persist it** — the EXTERNAL trace fan-out answers to it too, on the proxied
  path AND the inline one. It is ONE shared helper, kernel's `createStoreAgentContextGate`,
  precisely because the two paths diverged: the inline feeder consulted only the deployment
  switch, so an opted-out workspace still shipped its judge/consensus/requirements-writer prompts
  and replies to Langfuse/OTel. A new body-capturing path builds its gate from that factory rather
  than re-deriving the rule; a read that THROWS fails closed at the caller, because an unreadable
  settings row is not consent.
- **Surfacing**: `GET /workspaces/:ws/executions/:executionId/{agent-context,search-queries}` →
  `stores/observability.ts` → `ObservabilityPanel.vue`. A run-scoped endpoint returns an EMPTY list
  rather than erroring when its sink isn't wired.
- **Parity** asserted by `defineAgentContextSuite`. Cloudflare fails fast at build if `TELEMETRY_DB`
  is unbound.

### Remote debugging reads (`/api/v1/debug/*`)

The same three sinks plus the provisioning event log, exposed to an EXTERNAL caller — in practice
an LLM asked to diagnose a run. Full model: [`backend/docs/debug-api.md`](./backend/docs/debug-api.md).

The whole surface is shaped by one rule, and a new endpoint on it must obey the same one: **a
response's size has to be computable BEFORE the request.** The SPA drill-down loads a run's whole
telemetry into a browser, which is fine for a human with a scrollbar and useless for a caller with
a context budget.

- **Fan-out lists NEVER carry bodies; bodies are always a point read.** A snapshot row is
  routinely megabytes (it holds every injected context file's full content), so the list
  projection is identity + SQL `length()`. The one opt-in exception is `?bodyChars=` on the
  LLM-call list, where a size alone can't tell an empty reply from an un-previewed one.
- **Slice, filter AND SEARCH in SQL** (`substr`/`length`/`instr`, the outcome predicate, the
  agent-kind narrowing, the `?contains=` body search). A zero budget selects a literal `''`, so a
  sweep reads no body bytes out of the store at all — doing it in TypeScript would transfer
  everything and then throw it away. Same logic for finding: locating a marker (a tool-validation
  error, a repeated apology) is ONE `LIKE`-filtered request, never a paged sweep of bodies grepped
  in the caller's context. A searched row reports per-body `matchOffset`s (code points, so they
  feed `substr` directly); keep the LIKE-escaping on kernel's shared `escapeLikePattern` and the
  case folding ASCII-parity-tested (SQLite `LIKE` ⇄ Postgres `ILIKE`).
- **Every body is a `debugText`** (`{ text, chars, offset, totalChars, truncated }`). A bare
  truncated string reads exactly like a short one, so a model would report "the agent said
  nothing" from a payload that merely hit its budget. Point reads take `?bodyOffset=`, so the
  MIDDLE and TAIL of a large body are reachable (the last tool result, the end of a build log —
  where causes actually sit); the ceiling on the offset sits above the store's per-body cap so no
  stored byte is unreachable.
- **The prompt delta has TWO presentations, one storage shape.** `?view=messages` on the call
  point read parses the stored delta into per-message rows budgeted INDEPENDENTLY (one huge tool
  result can't hide the messages after it); the parse is lenient across both producers' content
  shapes and DEGRADES to the raw window with `promptMessages: null` — never a guess, never less
  than the raw read (`promptMessages.ts`).
- **A failed run with clean calls gets a POINTER, not silence** (`failure_outside_model_calls`):
  tool-execution errors happen inside the container and exist only as prompt-delta text, so
  every call reads `ok` while the run is dead. The signal names the shape and routes the caller
  to the search. A first-class per-call tool-error count needs harness capture (an image-bumping
  change) — do NOT fake one by pattern-matching bodies at record time.
- **Keyset cursors ride the `(createdAt, id)` COMPOSITE**, never a bare timestamp: telemetry is
  appended in same-millisecond bursts and a timestamp-only cursor silently drops the ties.
- **`available: false` ≠ `count: 0`.** The overview's per-sink block distinguishes "this deployment
  retains none of this" from "nothing happened", because they need different follow-up.
- **`read` scope, deliberately not `admin`** — `admin` also merges PRs and deletes tasks, so gating
  a read-only diagnostic surface behind it would hand a debugging agent a destructive key. What
  text is retained at all stays governed at CAPTURE time (`LLM_RECORD_PROMPTS` + `storeAgentContext`).
- **Run scope is the WORKSPACE**, wider than the task surface's `loadScopedRun` on purpose: a
  frame's blueprint run and a recurring bug-intake fire are exactly what someone asks about.
- **Telemetry reads stay OFF the mothership RPC** (`telemetry` bucket — local-first by design);
  only `ExecutionRepository.listRecent`/`exists`, which read org/durable run state, are
  allow-listed.

### External trace destinations (the `LlmTraceSink` seam)

Exporting the same activity to an operator's backend goes through ONE kernel port and never a second
recording path. Two packages implement it (`observability-langfuse`, `observability-otel`), and
`composeTraceSinks([…])` collapses them into `CoreDependencies.llmTraceSink`. **Adding a destination
is a new implementation composed into that array, never a new call site.**

Each facade builds the slot in one place (`buildTraceSink(config)`); every sink is opt-in on a FULL
config, and half-configured means not built. The OTel package is the one place the runtimes
deliberately differ in TRANSPORT, not behaviour: workerd can't run the official SDK, so the Worker
gets the `fetch` OTLP exporter and Node the SDK one. They share `src/mapping.ts` and are pinned
equal by `conformity.test.ts`, so a change to span names, attributes, trace-id grouping, or metric
names goes in the mapping layer. **A sink never throws into the caller** and honours
`LLM_RECORD_PROMPTS` (usage and timing still export; bodies don't): observability must never break
agent work.

**Deployment-level metrics** are the dual: `sweepPlatformMetrics` enumerates accounts and pushes
each account's `PlatformObservabilityService.summarize` projection as OTLP gauges, runtime-symmetric
(Worker cron ⇄ Node interval sweeper) and opt-in on top of the base exporter
(`OTEL_PLATFORM_METRICS`). Best-effort per account. The in-app half is
`GET /accounts/:accountId/observability/platform` → `OperatorDashboardPanel.vue`, plus the
`platform_health` threshold alert (state-change deduplicated). Detail:
[`docs/initiatives/platform-operator-observability.md`](./docs/initiatives/platform-operator-observability.md).

## Reports (cross-cutting usage analytics)

The dual of the platform-health rollups above: those answer "is the deployment HEALTHY",
`ReportsService` answers "where are the money and the work GOING". One admin read,
`GET /accounts/:accountId/reports` (`ReportsController`, `requireAdmin` like the operator
dashboard), returns spend by model / agent kind / workspace / service / task type, run activity by
workspace / service / task type, and a spend trend. Design:
[`backend/docs/reports.md`](./backend/docs/reports.md).

- **No new table, no migration.** Every number is a `GROUP BY` over `token_usage` and `agent_runs`,
  joined to `blocks`/`services`/`workspaces` for the board shape and the display labels — all MAIN
  store on both runtimes, so the telemetry database is never joined. `token_usage` carries no
  service or task type (a metered call records the RUN, not the board), so those two spend
  dimensions reach the run through `execution_id`.
- **Metered and subscription cost are TWO columns and must never be summed.** Only `meteredCost` is
  real money; `subscriptionCost` is the illustrative equivalent-API cost of flat-rate quota usage,
  which the spend gate excludes. The split is a conditional `SUM` in the same pass, and anything not
  literally `'subscription'` is priced as metered.
- **The `''` key is a REAL slice** (a call whose run/service/task type couldn't be resolved). An
  inner join would drop it and under-report the window while looking complete.
- **No row cap**: every dimension has naturally bounded cardinality, so a cap would either drop
  slices silently or make the folded totals disagree with the rows. A new dimension with unbounded
  cardinality must revisit that, not inherit it.
- **Activity has a NARROWER axis than spend** (`workspace | service | taskType`, no `model` /
  `agentKind`): a run carries no single agent kind or model — those are per-step facts. The contract
  encodes the difference rather than returning empty arrays.
- **Totals are FOLDED from one breakdown**, never a sixth query: every spend breakdown partitions the
  same ledger rows, so they total identically.
- Costs are the DEPLOYMENT's base currency, not a workspace override — an account-wide report spans
  boards that may each override it.

## Board / service / repo-linkage model

- A "service" is a `Block` with `level: 'frame'`, `parentId: null`. Modules are sub-frames; tasks are
  leaves.
- **A Block carries no repo fields.** Repo↔block linkage lives in the `github_repos` projection via
  its `block_id` column.
- **Execution resolves the repo at runtime** via `resolveRepoTarget(workspaceId, blockId)`: the
  `github_repos` row whose `block_id` matches, else `repos[0]`. So a bootstrapped repo becomes a
  board service only once its projection row is linked to the frame's block id.
- A workspace has exactly ONE VCS installation but may have MANY repos.
- **A service frame's board POSITION (and any size override) lives on its `WorkspaceMount`, not on
  the Block.** One shared service sits at a different spot on every board that mounts it, so
  `moveBlock` writes the mount and the frame block row's own `position` is frozen at creation —
  permanently stale for any mounted frame. **Every frame-returning read therefore projects through
  kernel's `applyMountLayout`**: the snapshot (`WorkspaceService.composeBoard`) and each
  single-block `BoardService` mutation response alike. Skipping it is silent — nothing fails, the
  SPA just upserts the authoritative block a mutation returned and the frame JUMPS to coordinates
  no board shows it at (the resize path is where users hit this, because a `size`-only edit is the
  one frame patch with no other visible effect). A non-frame block costs no extra query.
- Drag-drop: `useBlockDrag.ts` → `POST /blocks/:id/reparent` → `BoardService.reparent()`. Tasks move
  into frames or modules, modules into frames; frames cannot nest (`canReparent` in `board.logic.ts`).

## Individual-usage subscriptions (per-user, not pooled)

Vendors flagged `individualOnly` in `SUBSCRIPTION_VENDORS` (`claude`, `codex`, `glm`) are licensed
for individual use, so `ProviderSubscriptionService` refuses them from the workspace pool (409).
Full model:
[`backend/docs/individual-subscription-usage.md`](./backend/docs/individual-subscription-usage.md).

- **Double-encrypted at rest** (`personal_subscriptions`): `system.encrypt(personal.seal(token,
password))`. The inner layer is keyed by the user's password, which is never stored, so recovery
  needs BOTH.
- **Per-run activation** (`subscription_activations`): at start/retry the user supplies their
  password, and `activateForRun` re-encrypts with the SYSTEM key scoped to the run so async steps
  lease it without the user present. Cleared at terminal and swept on TTL (Worker cron ⇄ Node timer).
- **Gating**: `personalGateForBlock`/`personalGateForRun` resolve the vendor via
  `individualVendorForModelId`; a missing credential returns `428 credential_required`, which the SPA
  turns into a password modal. `ContainerAgentExecutor` leases the initiator's activation.
- **No recurring**: `RecurringPipelineService.fire` refuses a block on an individual-usage model.

## Multi-runtime facades & cross-runtime conformance

Both facades serve the same `@cat-factory/server` Hono app; each supplies only its differentiators
behind the shared kernel ports and the `container.gateways` seam.

- **Cloudflare Worker**: D1, Workflows for durable execution, Durable Objects for real-time and
  per-run Containers, queues/cron, the `workers-ai` binding.
- **Node service**: Postgres via Drizzle, **pg-boss** for durable execution (`PgBossWorkRunner`
  enqueues `execution.advance`; `driveExecution` runs the same advance/poll loop with plain sleeps;
  `signalDecision` re-enqueues a parked run). Async GitHub ingest is pg-boss-backed (the analogue of
  the Worker's sync queue + backfill workflow), draining onto the same `GitHubSyncService` /
  `WebhookService`. **Real-time**: a per-workspace `NodeRealtimeHub` plus `attachRealtime`, which
  serves the SAME raw-WebSocket + `?ticket=` protocol via a `ws` server on the HTTP `upgrade` event
  (`@hono/node-server` can't upgrade from a Hono `Response`, and the SPA speaks raw WebSocket), with
  the ticket mint/verify shared from `@cat-factory/server`. **Multi-node** rides a layered propagator
  writing through a narrow `LocalEventSink` seam: Redis pub/sub today (`ioredis` dynamically imported
  only when `REDIS_URL` is set), a future Postgres LISTEN/NOTIFY or NATS adapter on the same port.
  With no bus the layer is exactly the bare hub. The Worker needs none of this: its
  `WorkspaceEventsHub` DO is globally addressed, so propagation is inherent (a genuine Node-only
  concern, not a parity gap). **Container agent steps** run via the SAME `CompositeAgentExecutor` +
  `ContainerAgentExecutor`, dispatching to a workspace's self-hosted runner pool
  (`RunnerPoolTransport`) instead of a Cloudflare Container. A pool runs the same harness image, so
  it serves EVERY dispatch kind: no opt-in allow-list, and a new harness kind reaches it
  automatically. When unconfigured the composite serves inline kinds but fails container kinds
  loudly.
- **Local mode**: the Node facade with the runner backend swapped for a per-run local container and
  GitHub reached via a PAT, both the push token and a PAT-backed `FetchGitHubClient` wiring the CI
  gate + merge providers, so a local pipeline gates on real Actions CI and merges for real. Container
  kinds need the target repo's projection rows seeded (the `linkRepo` helper does this from PAT-read
  metadata).
- **Model provisioning** is composed per facade from `CompositeModelProvider`. Unconfigured
  providers aren't registered, so `resolve` throws a clear error instead of failing deep in the SDK.
- **Locally-run models (per-user)** — Ollama / LM Studio / llama.cpp / vLLM / custom
  OpenAI-compatible. Stored in `local_model_endpoints` (D1 ⇄ Drizzle), validated via
  `testConnection`. Enabled models are appended to `GET /models` as `direct` gated by the
  `localModels` capability (model-granular, not per-runner), with NO API key. At run time the proxy
  and inline provider resolve the run INITIATOR's endpoint and skip the key lease. The base URL is
  forwarded server-side, so it's constrained to a loopback/LAN allow-list (`localRunnerUrlError`) at
  the write boundary and the test probe (public hosts and the link-local metadata endpoint rejected).

**Cross-runtime conformance**: `@cat-factory/conformance` exposes `defineConformanceSuite(harness)`,
the key backend behaviour as runtime-neutral assertions parameterised by a `ConformanceHarness`. The
Worker runs it inside workerd against real D1; Node and local against real Postgres (local building
through `buildLocalContainer` so its wiring can't drift). Same assertions, so a repository that maps
a column differently, or an engine path only one facade wires, fails a test instead of shipping.
`runtimes/node/test/durable-execution.spec.ts` additionally drives a run through real pg-boss.

## End-to-end (assembled-product) coverage

Where conformance asserts backend behaviour port-by-port, the Playwright suite
(`backend/internal/e2e`) covers the assembled product: real Chromium → real SPA → real Node backend
(real Postgres, real pg-boss, real WebSocket push). Only EXTERNAL deps are faked, so it needs no
secrets/Docker/network: LLMs and containers → the canonical `FakeAgentExecutor`, bootstrap →
`FakeRepoBootstrapper`, GitHub App / email / Slack / Datadog left off. Wiring is `src/testServer.ts`;
full picture in [`backend/internal/e2e/README.md`](./backend/internal/e2e/README.md).

- **What e2e is FOR**: what only the assembled product shows, above all the live WebSocket-pushed UI
  round-trip. A pure backend side-effect belongs in conformance. Anything needing a real outbound
  call must be mocked at the backend's OUTBOUND boundary, never in the browser.
- **Spec shape (mandatory)**: seed/trigger over REST, then assert only on LIVE pushed UI updates. No
  reloads, no fixed sleeps, no canvas drag/zoom; only web-first assertions on the named timeouts in
  `tests/helpers.ts`. Shared setup is the `seededBoard` fixture plus the auto `pageErrors` fixture.
  Each spec seeds its own workspace (`workers: 1`, serial).
- **Selectors are `data-testid`, always.** Covering a flow whose affordance has none means ADDING
  the test id first (a behaviour-neutral frontend change) plus a patch changeset.
- **Adding a spec**: `*.spec.ts` under `tests/`, importing `test`/`expect` from `./fixtures` (not
  `@playwright/test`), reusing `helpers.ts`, plus a row in the README's Specs table. Deterministic
  variations are env knobs on `testServer.ts`; a spec needing a different backend env wants its own
  `webServer` in `playwright.config.ts`.
- **CI** runs it in a non-blocking `Test e2e` job, outside the aggregated `Test` gate.

### A flaky e2e test is a BLOCKING bug: investigate and deflake, NEVER retry

**A flaky spec must always be root-caused. A green-on-retry run is NOT a pass.** Playwright enforces
this (`failOnFlakyTests: true`): first-attempt-fail then retry-pass reports the shard RED on purpose.
The retry exists ONLY to capture the trace.

- **Do NOT re-run CI hoping for green, bump `retries`, skip the spec, or dismiss it as a boot flake.**
  The non-blocking job is a safety net for infra hiccups, not permission to ignore a flake.
- **Reproduce, then root-cause.** A flake almost always exposes a REAL race: a live event applied
  between a snapshot's fetch and its store-commit, a subscribe-after-broadcast gap, a status
  rendering from a clobbered store. Fix the SOURCE (usually a frontend store reconcile or a
  `helpers.ts` readiness gate) and add a unit test pinning the race.
- **Never paper over it in the spec**: no sleep, no bumped timeout, no reload (which hides exactly
  the live-push bug the suite exists to catch).
- **The bar for "fixed" is deterministic, not lucky**: a high-count `--repeat-each` pass locally AND
  the root-cause fix with its regression test in the same change.

### Real-time store coherence: avoid the full-refresh CLOBBER

Most of those flakes are one recurring product bug: a stale full-snapshot refresh clobbering newer
live state. The SPA has two delivery shapes and mixing them wrong drops live-added state with NO
event left to restore it.

- **Know how your entity is delivered.** A `board` event is COARSE: no payload, only a debounced full
  `workspace.refresh()`, and `hydrate` REPLACES whole lists. A spawned task/module block reaches the
  browser ONLY this way. Targeted events (`execution`/`bootstrap`/`initiative`) carry the entity and
  `upsert` it, so they don't clobber. Prefer a targeted upsert for anything that must appear reliably.
- **Full refreshes MUST be monotonic.** Two `refresh()` calls can be in flight; a staler one
  resolving later overwrites the newer. `workspace.refresh()` guards this with a sequence. Do not
  reintroduce an unguarded `hydrate(await fetch())`, and apply the guard to any new coalesced
  refresh path.
- **Never gate readiness on a snapshot a later resync can undo.** The on-connect resync flips
  `connected` only after it settles (which is why e2e gates on `data-connected`).
- **A REPLACE-style `hydrate` must never silently drop live-only state.** Either fold that state into
  the snapshot or reconcile rather than replace.
- **Pin it with a store-level unit test** (`stores/workspace.spec.ts`): drive two out-of-order
  refreshes and assert the fresher one wins.

## Basic vs advanced interface mode (frontend)

The SPA renders at one of two tiers: `basic` (the shipped default — the everyday surface) and
`advanced` (everything). Resolution is `NUXT_PUBLIC_UI_MODE` → the user's persisted choice →
`basic`, first match wins, in `stores/uiMode.ts` (which also owns the sidebar's collapsed rail:
basic mode always STARTS railed). Full model:
[`frontend/app/README.md`](./frontend/app/README.md#interface-modes-basic--advanced).

**A new user-facing surface must decide its tier, and the answer is never "ignore this".**

- **A nav destination declares `advanced: true`** in `modular/nav-contributions.ts`; the shared
  `navSlotFilter` drops it in basic mode across all three shells. It is a SEPARATE axis from the
  RBAC `gate` and both must pass — never fold the tier into a `gate` predicate, or the two become
  un-disentangleable in the specs (and a consumer item loses the declarative flag). **The bar is
  whether the EVERYDAY DELIVERY LOOP needs it** — plan work on a board, run it, review and merge
  it — not how advanced the surface feels. Marking an item does one of two things and the
  difference must be stated, because only one of them is free:
  - **reached-another-way** — a shortcut into a surface a basic destination also opens, so
    nothing is lost (the Merge / Service-best-practices palette entries, the local-models knob).
  - **out-of-tier** — the SOLE route, hidden deliberately, so the capability is ABSENT from basic
    mode and the tier switch is the way to it (sandbox, Kaizen, `bootstrap-repo`, and the
    deployment-wide `operator-dashboard` / `reports` rollups, which answer an operator's question
    rather than a delivery one).

  A sole route stays in basic when the loop runs on it: the pipeline builder, `add-from-repo`,
  the fragment library, the infrastructure/PREnv windows, and the workspace/model configuration a
  run actually reads. `nav-contributions.spec.ts` pins the advanced set against a table naming
  each item's kind AND reason, so a promotion has to write that claim down rather than assume it.

- **A less-used option inside a surface** reads `useUiModeStore().isAdvanced`. **HIDE, never
  disable, and only ever hide an OVERRIDE**: what remains must be exactly the default the hidden
  field would have shown (a workspace merge preset, the service-seeded fragments, an engine-inferred
  flag), so a basic-mode user gets fewer choices, never different behaviour. Anything carrying an
  input NOTHING else supplies stays in BOTH tiers however advanced it feels — the e2e suite caught
  exactly this on the apriori-branch picker, which has no default to fall back to.
- **A whole AUTHORING affordance may be tier-scoped**, but only when the tier hides the ability to
  CREATE and never the ability to SEE. The frame header's recurring-schedule and initiative
  buttons are advanced-only; both are safe because existing state stays legible in basic mode
  through its normal surfaces (a live schedule badges its task card and opens `recurring-schedule`
  in the inspector; an initiative is a block on the board with its own inspector). Hide a create
  button whose product is only visible behind that same button and a basic-mode user is acted on
  by state they cannot find — which is the override rule's failure mode wearing different clothes.
- **Gate an override control on `showOverrideField(isAdvanced, ...values)`, NOT on `isAdvanced`
  alone** (`utils/uiMode.ts`). The rule above holds only while the override is UNSET, which is
  guaranteed at CREATION time (a fresh form starts from the defaults) but never for an EXISTING
  entity: a block can already carry an override written by a teammate on the advanced tier, by the
  API, or by this user before switching down. Hiding it then would leave a basic-mode user on
  settings they can neither see nor clear — the exact divergence the rule forbids. The helper keeps
  the control whenever any value it edits is set (`false` counts — a tri-state `false` is a choice,
  not absence), so basic stays clean for the common case without ever concealing a deviation.
  **It gates SECTIONS as readily as fields**, and post-release health is the reference case: the
  Integrations-hub row and the service inspector's monitor/SLO panel are both advanced-tier (that
  gate acts AFTER delivery, outside the loop basic serves), but each reveals itself once the
  workspace has a connection / the frame has a mapping — otherwise basic mode would hide a live
  Datadog watch, and an on-call agent that can spawn from it, behind a tier the user never chose.
- **The env pin makes the switcher READ-ONLY** (`envPinned`), and `setMode` refuses to write. A
  persisted preference the resolver would then ignore is a lie to the user, not a fallback. That
  refusal is hygiene, not the invariant — a persisted setup store must return its state to persist
  it, so a direct write to `storedMode` is always possible; the tier is safe because `resolveUiMode`
  consults the env FIRST, so such a write can only leave a stale value, never change the mode.
- **The rail state is a PER-TIER preference** (`railCollapsed`, keyed by `UiMode`), not one shared
  boolean. Each tier has its own default (`DEFAULT_RAIL_COLLAPSED`: basic railed, advanced expanded)
  AND its own memory, so a choice in either tier survives a reload and a round trip through the
  other. Don't reintroduce a single flag with a reset watcher — it can only honour one tier's
  default, and it does so by discarding the other tier's explicit choice.
- **Never mark the way BACK as `advanced`.** Basic is the shipped default, so anything that is the
  only route to the advanced half (the `ui-mode` palette entry, the sidebar switcher) has to stay
  visible in basic mode, or the tier is a one-way door for a user who never finds the switcher.
- **An e2e spec whose subject is not the tier pins it** with `useAdvancedInterfaceMode(page)`
  before `openBoard`; `ui-mode.spec.ts` owns the default, the switch, the rail, and the palette
  route back.

## Internationalization (i18n)

All user-facing SPA copy goes through `@nuxtjs/i18n`; never hard-code a display string. The
`@cat-factory/app` layer ships the base `en` locale, and a downstream deployment overrides by
dropping its own files (the per-layer deep-merge is the override seam, consumer wins key by key).

- `frontend/app/i18n/locales/<locale>.json` — the catalogs (the v9+ `i18n/` convention, NOT
  `app/locales/`).
- `frontend/app/i18n/i18n.config.ts` — runtime vue-i18n behaviour only (fallback locale, the named
  `numberFormats`/`datetimeFormats`). Messages are deliberately NOT here so the module can deep-merge
  across the `extends` chain. Referenced as the BARE filename `vueI18n: 'i18n.config.ts'`, never
  `layerDir`-anchored.
- `package.json` `files` MUST include `"i18n"`. Release-blocking.

**Adding a string**: add the key to `en.json` under the feature namespace, resolve with
`t('feature.area.key')`, and format numbers/dates through `$n`/`$d` (the named formats), never raw
`Intl`. `currency` needs a per-call `currency` override.

**Key conventions**: one namespace per feature; **leaf keys mirror the enum/code value verbatim** so
a dynamic lookup is total; **no cross-key concatenation** (a full sentence is ONE key with `{named}`
placeholders, plurals use the pipe form).

**Component mechanics that bite:**

- `useI18n` is auto-imported; destructure in `<script setup>` and use those fns in the template so
  the typed-key check sees literal keys. Never `import` it.
- Plural + interpolation: `t(key, { vendor, count }, count)`, where the THIRD arg is the choice.
- **Code/format-example placeholders stay INLINE**, not in the catalog. Required when they contain
  `{`/`}` (vue-i18n metacharacters). Only prose placeholders get a key. Same for brand names.
- **No HTML in message bodies**: drop mid-sentence `<strong>`, or use `<i18n-t>` with slots.
- For a vendor/enum-keyed set, build an array of STATIC literal `t()` keys, one per member. Reserve
  the runtime-assembled key + exhaustive `Record` guard for lookups genuinely unknown until runtime.
- Straight quotes, no em-dashes in new entries.

**Translator descriptions (`@<key>` siblings): default to NONE.** They live only in `en.json` and are
notes to a translator, never runtime data. Most keys are unambiguous from their value plus their
path, and a description on them is noise. Add one ONLY when a competent translator seeing the English
and the key path could plausibly get it wrong: homograph / part-of-speech ambiguity (`@close`),
proper nouns that must NOT be translated (`@kaizen`, contrasted with `@sandbox` whose note says the
opposite), umbrella strings hiding cases the text doesn't show, placeholder/format constraints, or
plural-form requirements beyond English's two.

**Backend strings**: the backend does not localize prose. A localizable condition emits a
machine-readable `error.details.reason`/`code` that the SPA maps to a frontend key (the
`usePipelineErrorToast.ts` pattern); the raw `message` is an untranslated last resort. The wire
vocabulary lives in `@cat-factory/contracts`, so the SPA imports the SAME source of truth.

**Drift guards** (oxlint has no `no-raw-text` rule, so these replace it):

1. **Typed message keys** make a statically written unknown `t('literal.key')` a typecheck failure.
   This does NOT cover a runtime-assembled key.
2. For enum→key lookups, guard with an **exhaustive `Record<TheEnum, string>`** keyed off the
   contracts union (e.g. `CONFLICT_TITLE_KEYS`), plus a runtime `te()` fallback. Never rely on tier 1
   alone for a reason/status-keyed lookup.
3. `pnpm --filter @cat-factory/app run i18n:check` hard-fails on MISSING keys and reports unused ones
   as non-blocking warnings (the catalog legitimately seeds keys ahead of use).
4. **Locale parity**: `i18n-locale-parity.mjs --since origin/<base>` requires a PR that adds, changes,
   or removes an `en.json` key to make the SAME change in every other locale. It is change-coupling
   against the merge-base, NOT full key parity, so pre-existing lag on untouched keys is left alone.

**Translate for real: NEVER ship an English string as a non-`en` value.** The parity gate checks only
that the key exists, so it will pass a verbatim English copy. That copy is a bug. The only values
that may legitimately match `en` are proper nouns identical across languages (`DeepSeek`, `AWS
Bedrock`). If you genuinely cannot produce a translation, say so in the PR rather than committing a
placeholder that reads as done.

Migration is incremental: when you touch a component, lift its visible copy into the catalog.

## Workspace RBAC enforcement

Per-workspace authorization (ADR
[`0025-workspace-rbac`](./backend/docs/adr/0025-workspace-rbac.md)) is enforced in exactly three
shared places, never re-derived per controller:

1. **Resolution + the 404 hide** — `mountAuthGate` calls the single `loadWorkspaceAccess` (through
   the `workspaceAccess` cache slice) on every `/workspaces/:ws/*` request, publishes
   `{ role, permissions }` on the context, and returns the SAME 404 for a denied or absent board.
   Roles (`admin | member | viewer`) map onto seven permissions via a fixed kernel table.
2. **The viewer write floor** — also in the gate: any non-GET/HEAD requires `≥ member`, covering the
   whole member tier with zero per-controller code. Its sole exemption is the read-only WS ticket
   mint.
3. **The admin-tier permission gate** — `requireWorkspacePermission(perm)`, a Hono middleware mounted
   ONCE at the top of each admin controller. It gates every write the controller serves (now and
   future) while letting reads through, and runs BEFORE the handler's 503/lookup so an unauthorized
   member gets a clean 403 without learning whether the integration is wired. Co-located with the
   mount, not a central path→permission table, so new routes inherit the right gate. Each admin
   controller maps to exactly ONE permission. `WorkspaceController` and `WorkspaceMemberController`
   mix gated and ungated writes, so they use the imperative `requirePermission(c, perm)` per handler.

Adding a route to an admin controller needs no authz code. Adding a NEW admin controller: mount the
middleware and add a `member 403` case to `defineWorkspaceRbacSuite`. A member-tier controller needs
nothing. Dev-open resolves no access object and allows everything, so conformance MUST run
auth-enabled or it passes vacuously.

## Conventions

- **Hexagonal layering**: controllers (`@cat-factory/server`) → services
  (orchestration/integrations) → ports (kernel). Infra adapters live in each facade and implement
  the ports + the `gateways` seam, wired via constructor injection of one `dependencies` object.
  Opt-in integrations wire only when configured.
- **Folded best-practice standards are two-tier, and the brief travels WITH its body.** An
  implementer kind (`coder`/`fixer`/`ci-fixer`/`conflict-resolver` — the `brief-standards` trait)
  re-sends its whole system prompt on every turn of a long loop, so it folds a fragment's condensed
  `brief` instead of the full `body`; reviewer/planner kinds keep the full text. Two rules:
  **`brief` is resolved alongside the body it condenses and NEVER re-looked-up by id** (a
  workspace/account row may override a built-in id, and re-resolving would fold the built-in's
  condensed text over the tenant's standard), and **every `composeBlockSystemPrompt` call site
  threads `standardsVerbosityFor(kind, registry)`** — today the dispatch chokepoint
  (`buildKindBody`), the inline `AiAgentExecutor`, and `ConsensusAgentExecutor`. A new compose site
  that forgets it silently restores the full bodies. Authoring guidance:
  [`backend/packages/prompt-fragments/README.md`](./backend/packages/prompt-fragments/README.md).
- **A dispatch records what the poll site cannot re-derive** (`recordDispatchAttribution`). An async
  container job settles on the durable poll path, which rebuilds the job handle from the STEP alone
  — so the resolved `model`, the leased `subscriptionTokenId` and the run's `initiatedByUserId` are
  persisted on the step at dispatch and re-supplied when polling. Anything a new executor resolves
  at dispatch and reads back off the handle must join them, or it is silently absent on the path
  that actually runs in production (the symptom is attribution quietly landing as "unknown"/nobody,
  never an error).
- **Final answer must land in the reply, not the reasoning channel.** Any agent whose deliverable IS
  its final reply (spec-writer, blueprinter, merger, on-call, task-estimator, the tester report, the
  reviewers/companions, the requirements reviewer) MUST append the shared `FINAL_ANSWER_IN_REPLY`
  fragment (`@cat-factory/agents`). Some reasoning models emit the whole answer into their private
  channel and return an empty visible reply, which the harness reads as unusable and fails the run.
  Applied centrally for `systemPromptFor` kinds and inline on the container constants in
  `ContainerAgentExecutor.ts`. Do NOT append it to side-effect agents whose product is a pushed
  commit (coder, ci-fixer, conflict-resolver, mocker, playwright, business-documenter): they
  legitimately end with no final text. Editing a versioned prompt means bumping its number.
- **Dedicated result-view seam (frontend)**: an agent step opens the generic prose panel UNLESS its
  archetype declares a `resultView` id (`app/utils/catalog.ts`). The `ui` store's `dispatchStepView`
  routes such a step to `ui.resultView`, and `StepResultViewHost.vue` mounts the component
  registered for that id in the modular `resultViews` slot. A built-in window declares `resultView`
  and contributes an entry; a CONSUMER contributes to the SAME slot via `registerAppModule` with a
  namespaced `<ns>:<name>` id. Custom agent kinds flow through the modular `agentKinds` slot plus a
  per-workspace `RemoteModuleManifest`; the built-in `AGENT_BY_KIND` const is frozen.
  **Anything EVERY window must show goes in `ResultWindowShell.vue`, never in the windows.** The
  shell owns the chrome and the shared trailing section (today `step.effortReport`), resolving the
  step itself rather than via a per-window prop, so a window can't opt out or forget it.
- **Inspector panel seam (frontend)**: the inspector body is a subject-keyed panel group, not a
  `v-if` monolith. Each sub-panel is a `PanelEntry<Block>` (`{ id, component, when(block), order }`)
  contributed to the `inspectorPanels` slot and rendered by `<PanelsOutlet>`. A consumer contributes
  its own with no `InspectorPanel.vue` edits. The shell (identity, run banners, actions row) is not
  part of the group.
- **Consumer overlay seam (frontend)**: a deployment contributes top-level overlays through the
  `appOverlays` slot and opens one via `useAppOverlays().open(id, subject?)`. A single
  `<AppOverlayHost>` resolves the merged slot and mounts the entry matching `ui.activeOverlay`.
  First-party modals stay hand-mounted (strangler); duplicate ids fail fast at boot, a dangling open
  degrades to nothing.
- **Frontend module registry seam** (`registerAppModule`): the frontend analogue of the backend
  registries. First-party feature modules and a consumer's own modules register through one seam
  (`app/modular/registry.ts`), so a deployment extends the layer without forking. The layer's install
  plugin is `enforce: 'post'` so consumer registration runs first. Adoption is phased:
  [`docs/initiatives/modular-vue-adoption.md`](./docs/initiatives/modular-vue-adoption.md).
- **Tests**: Worker integration tests use real `workerd` + real local D1; Node tests use real
  Postgres (`DATABASE_URL`). Only the LLM is faked. Run the full suite with `pnpm test:run` from the
  root.
- **Always run `typecheck`/`test:run`/`build` through Turbo from the repo root**, never a package's
  raw script from inside its directory. Turbo's `^build` edge only fires through Turbo; bypassing it
  surfaces as spurious `TS2307 Cannot find module '@cat-factory/contracts'`. To scope, filter
  instead of `cd`: `pnpm exec turbo run typecheck --filter=@cat-factory/app`. (The exception is a
  task with no build deps, e.g. the i18n check.)
