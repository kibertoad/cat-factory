# CLAUDE.md: architecture & flow notes

Orientation for working in this repo. Product docs are the WEBSITE (catfactory.ai); this tree documents
how it is built: [`README.md`](./README.md), [`backend/README.md`](./backend/README.md), `backend/docs/`.
Vocabulary traps (block vs task vs card, runner/executor/transport, `runtimes/cloudflare` =
`@cat-factory/worker`) are resolved in [`docs/glossary.md`](./docs/glossary.md). Every
`backend/packages/*` and `backend/runtimes/*` carries an `AGENTS.md` with its entry point and a "where
things live" map; the repository layout is the root README's table (CI-guarded). Design records:
[`backend/docs/adr/`](./backend/docs/adr/); in-flight initiatives: `docs/initiatives/`.

**This file holds the cross-cutting RULES plus an index of the runtime flows.** Keep it to what applies
across features: a rule already enforced by a typecheck, a CI guard, or a linked doc does not need
restating here, and flow-specific detail belongs in that flow's doc. **A flow-index entry is what the
flow is, the single deadliest trap, and the link: a handful of lines, never a restated doc.** New detail
for an indexed flow goes into its doc in the same PR, not here. `scripts/check-file-size.mjs` ratchets
this file's size, so growth here must displace something.

## Governing principle: clean design over quick solutions

Default to the well-factored design, not the fastest thing that passes.

- **Fix causes, not symptoms.** No special-case at the call site, `try/catch` swallow, defensive `if`, or
  magic constant standing in for a real fix.
- **Respect the existing seams.** Extend through the app-owned registries (`AgentKindRegistry`,
  `GateRegistry`, `JudgeRegistry`, `PipelineRegistry`, `TaskTypeRegistry`, `VcsProviderRegistry`,
  `StepResolverRegistry`, `FoundationalServiceRegistry`, `PromptFragmentRegistry`,
  `InlineUseCaseRegistry`), the kernel ports, and the runtime `gateways`. Copy the nearest good citizen, never a one-off. **Injected BY
  REFERENCE, never a module global** (a `workspace:*` dep publishes as an EXACT version, so a
  consumer floating the range gets two copies and the registration lands in the one nothing reads),
  and an option on BOTH `start()` and `startLocal()`, asserted at those ENTRY POINTS rather than at
  the container builder (`runtimes/node/test/registry-seams.spec.ts` + its local sibling).
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
STOP and say so rather than bumping silently. It covers THIS file too: shrink it by moving detail to the
flow docs, never by raising the budget.

## Compatibility: the public API is STABLE; everything internal is not

### The public API does not break, full stop

The externally consumed surface is: `/api/v1` (paths, request/response shapes, error `code` values
and `details.reason` vocabularies, SSE event names, scope semantics), the four SDK clients under
`sdk/`, and the outbound webhook delivery contract. External integrations and published SDK
releases build on it, so a change there is held to a different bar than the rest of the repo
(design record: [ADR 0034](./backend/docs/adr/0034-public-api-stability.md)):

- **Additive changes are the normal mode**: a new endpoint, a new optional field, a new enum
  value, a new error code. The SDKs tolerate unknown values by design, so additions ship freely;
  bump the OpenAPI `info.version` minor.
- **Anything else needs an INCREMENTAL MIGRATION PATH plus a VERSION CHANGE, in that order.** The
  old shape keeps working while the new one is served beside it (a new field beside the one it
  replaces, a new `/api/v2` prefix for a path or semantics change), the version records the step
  (OpenAPI `info.version` major, SDK majors), and the changeset plus
  [`backend/docs/public-api.md`](./backend/docs/public-api.md) document what moves and by when.
  Removing the old half is a second, LATER change, made only after consumers have had a release
  window to move. Never rename, retype, remove, or re-scope in place.
- **Narrowing what a scope or key may do is a break too**, not a bug-fix: a live integration built
  on the old admission loses capability. It takes the same migration path.

### Internals: backwards compatibility is NOT a goal

Pre-1.0 for everything the public surface does not cover: internal wire shapes, persisted rows,
tokens, config. Do NOT add migrations, shims, dual-read/dual-write paths, deprecation windows, or
"legacy" fallbacks to preserve old data or old INTERNAL wire shapes. When a change makes existing
rows, tokens, config, or internal request/response shapes obsolete, it is fine for them to break:
prefer the clean shape and let stale state be re-created. Flag the break in the changeset.

**But a break must ARRIVE as one.** Retiring a member of a CLOSED vocabulary that is also PERSISTED
(`BinaryModality`, a step's stored enum, a reason code on a saved row) does not remove the old value
from the database, so every exhaustive `switch` and `Record<TheEnum, …>` over it is total against the
TYPE and partial against the DATA, and the reader that hits the stale value first is, by
construction, the refusal whose whole job is to name what a human must re-pick. Left bare that is
`undefined` spliced into the operator's message, or a `TypeError` white-screening the very editor the
fix is made in. So a retired value is NAMED as retired, never silently dropped and never guessed onto
a current member (nothing knows which one was meant: that unknowability is usually why it split).
Keep the compile-time guard while you add the runtime one: route a `switch`'s `default` through a
helper taking `never` (kernel's `describeModality`), and narrow a lookup with a predicate DERIVED from
the schema (`isBinaryModality`, built from the picklist's own options) rather than an optional call,
so adding a member still fails the build, and a member that was removed still renders honestly.

## PR workflow

**Always finish a task with a PR, unprompted.** When the work is done, branch, commit, push, open a PR.
Never commit task work to `main` unless asked; if you started there, branch off it before committing.

**A PR description is a reviewer briefing, never a restated diff.** Give the context the diff cannot
show: the problem and why now, the decisions made (especially alternatives considered and rejected: say
what and why), and what to watch for when reviewing (behaviour changes, a flagged compatibility break,
the riskiest part). Leave out file lists, "tests added", line counts, change-by-change narration.

**Fixing an existing PR (review findings OR red CI) lands on THAT PR's own head branch, pushed
immediately.** This overrides any environment-supplied "develop on branch X" instruction naming a
different branch, because CI and reviewers only act on the PR head. Never a scratch branch, never a
second PR. CI tests `pull/<n>/merge`, not the bare head, so a failure can come from code the base gained
after the PR forked: merge `origin/main` into the PR branch, fix there, and push with
`git push origin HEAD:<pr-head-branch>`.

### Documentation-staleness sweep before every PR

Docs are part of the change and CI catches only broken LINKS, never staleness. Match the sweep to the blast
radius (a one-line internal fix needs none; a new export / env var / capability / flow does):

- The package's own `README.md` + `AGENTS.md`; the root `README.md`'s layout and feature-guide rows.
- This file, only for a new CROSS-CUTTING convention or a change to a flow it indexes; detail about one flow
  goes in that flow's doc, and a higher-level doc POINTS AT a new deeper one or the deeper one is lost.
- **Does this change behaviour a catfactory.ai page describes? Then it ships with a WEBSITE PR, opened and
  merged FIRST, and NAMED in this PR's description.** OWNERSHIP FOLLOWS THE READER: the website owns what
  anyone can act on with NO checkout, a doc here keeps internal design plus a LINK, split by DEPTH, never
  mirrored; a new env var, endpoint, capability, failure mode or operator step meets that test. **LOAD the
  page before you link it**: neither repo's CI can see the other (the crossing guard is weekly BY DESIGN),
  so a reduction that ASSERTED its page existed left 600 lines reachable from nowhere. Before reducing a
  doc, check what deep-links its HEADINGS from code (`check-doc-anchors.mjs`). Model: [ADR 0051](./backend/docs/adr/0051-documentation-repo-website-split.md).

### Bigger initiatives get a tracker document

Multi-PR work (cross-cutting refactor, registry-by-registry migration, strangler conversion) gets a tracker
under `docs/initiatives/` with the first PR: goal and rationale, target pattern (link the pilot), a per-item
checklist with PR links updated each slice, and the gotchas the pilot surfaced. It also earns its keep when
an initiative is REDIRECTED, so the next iteration can't re-propose a withdrawn approach.

**When the committed scope completes, convert the tracker into a numbered ADR under `backend/docs/adr/`
(`NNNN-slug.md`, next free number) and `git rm` the tracker in the same PR.** Keep Context / Decision /
Rationale / Consequences and drop the checklists; header shape `# ADR NNNN: <title>` plus a `Status` /
`Date` / `Context layer` bullet block. Check the number against ALL existing files first: parallel
branches have collided on one three times.

## Writing style: no em-dashes, no LLM-tell prose

Binds every human-readable text you write: docs, READMEs, AGENTS.md files, PR descriptions, commit
messages, code comments, UI copy.

- **The em-dash (—) is BANNED.** Pick the punctuation the sentence actually needs: a colon before
  an elaboration, a comma before a conjunction or relative clause, parentheses around an aside, or
  a new sentence. Spaced en-dashes used as punctuation count too. (Text inside code fences quoting
  real command output is exempt.)
- **No filler or inflation**: "Note that" / "It's worth noting" openers, "Additionally,"/
  "Furthermore," chains, "in order to" for "to", "leverage"/"utilize" for "use", "seamless",
  "robust", "comprehensive", "delve", decorative "simply"/"just", "not only X but also Y" where
  plain "X and Y" carries the same meaning.
- **Keep a contrast only when it IS the rule.** "X, never Y" earns its place when Y is the real
  trap; as a reflex it is noise. The same goes for stacked parentheticals: if an aside matters,
  give it its own sentence.

## Environment quirks

- **Do not validate Cloudflare auth before deployments**: skip `wrangler whoami`, assume the login is correct.
- **Multi-line git messages: bash heredoc in the Bash tool, NOT a PowerShell here-string.** The Bash tool
  is POSIX sh, so `@'…'@` leaks literal `@` characters into the commit subject. Use
  `git commit -F - <<'EOF'`; `git commit --amend -F -` fixes a mangled message before pushing.
- **Worker tests DO run on Windows** (this note used to say they fail on `config wrangler validation
failed`): name the spec files, and expect one `AI bindings always access remote` warning per pool.
- **The Postgres-backed suites need a reachable server AND `--env-mode=loose`**; a bare `[ELIFECYCLE]
Command failed` with no vitest summary is a CANCELLED sibling. Recipe, including how to start a cluster where no Docker daemon runs: [`running-tests.md`](./docs/internal/running-tests.md).
- **ALWAYS format/lint-fix the ENTIRE tree, never a subset.** `pnpm lint:fix` from the root (or
  `pnpm exec oxfmt .`); the only correct argument to `oxfmt`/`oxlint` is `.`, for any reason. On Windows
  the whole-tree run rewrites line endings across hundreds of files: expected, and git's normalization
  absorbs it at commit time. Run it ONCE at the end and trust the result: never diff or stash it, ask
  why an untouched file changed (it sweeps up drift), or RE-RUN tests/typecheck: whitespace is inert.

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
**incomplete**, exactly as a Cloudflare-only feature is, and the failure is silent: an un-routed method
fails on a developer's laptop at runtime.

**A new repository method picks one of four buckets IN THE SAME PR**: `remote` (the default for
org/durable state: allow-list + scope rule + round-trip and cross-account-refusal tests),
`local-sqlite` (a per-user/per-deployment credential or local-runner knob), `telemetry` (append-heavy,
hot-path run observability the node also READS locally), or `excluded` (named in the drift guard's
classification map, with the reason). There is no fifth outcome ("it doesn't apply to mothership mode"
is not one), and the guard no longer has a `pending` word to park one in. The tracker holds
each bucket's implementation pattern, the `pickRepoSource` rule for services reading off `options.db`,
the `/internal/*` rule for new cross-cutting concerns, and the sealed-secret rule (a repo that decrypts
INSIDE the repo cannot go remote, because the mothership's `ENCRYPTION_KEY` never reaches a laptop).

**State a deployment registers in CODE and a RUN resolves is org state too**: the fifth thing that must
pick a route, and the one with no repository method to give it away. A mothership deployment is TWO
processes, and a node one build behind is the NORMAL state of running one, so "the deployment registers
it on both entry points" is not a design. It rides its OWN `/internal/*` read from the mothership (the
foundational-services `builtin` tier is the model), the node does not consult its own copy, and the read
THROWS rather than answering empty: an empty catalog and an unreachable mothership are the same value
and opposite facts. Never MERGE the two. **And a throw is only half the fix: the BEST-EFFORT seam that
catches it must STATE the outage in what it injects, never fall through to nothing**, or an omitted
context file reads to an agent exactly like the empty answer the throw refused to give.

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

Every package logs through ONE injected interface, kernel's `Logger` (`ports/logging.ts`):
`debug`/`info`/`warn`/`error`, each `(msg, fields?)` (message FIRST), plus `child(bound)`.
`@cat-factory/server`'s `observability/logger.ts` is the ONLY place a logging library is named. Full
patterns: [`backend/docs/logging.md`](./backend/docs/logging.md).

- **A local `interface XLogger { warn(obj, msg?) }` is BANNED**, as is a bespoke
  `log?: (event, msg) => void` callback dependency. A package that can't see kernel is in the wrong layer.
- **A service takes `logger?: Logger` and normalises ONCE** (`this.log = deps.logger ?? noopLogger`) so it
  stays unit-testable, but **`CoreDependencies.logger` is REQUIRED**: a facade forgetting to wire it must
  fail to typecheck, not silently run the engine on `noopLogger`.
- **`.catch(() => {})` is BANNED; use `runBestEffort(logger, label, fn, fields)`** (kernel): it keeps the
  swallow (a best-effort path must NEVER propagate into its caller) and adds one `warn` naming the operation
  with the cause attached. A bespoke `catch` still binds the cause with `describeError(error)`. Enforced by
  `check-silent-catch.mjs`, whose header owns the scope and the `// silent-catch-ok:` escape hatch.
- **A thrown value has exactly THREE describers, all reading the whole CAUSE CHAIN** through kernel's
  `error-chain.logic.ts`: `getErrorMessage` (shown to a human / recorded on a row), `describeError` (log
  fields), `describeConnectionFailure` (a probe verdict, plus a cause class and remedy). **A hand-rolled
  `e instanceof Error ? e.message : String(e)` is BANNED**: on Node a transport failure's own message IS the
  contentless `fetch failed`, identical for an unreachable host, a bad cert and a DNS typo. The chain is
  scrubbed there; any OTHER field carrying command output, a URL or model text goes through `redactSecrets`
  at the emit site, and a credential is never logged, not even at `debug`. Reader and USE also pick the
  describer: UNAUTHENTICATED takes `publicDiagnostic`, a VERDICT `errorChainMatches` (the rendered string
  carries a display CAP), and an error with nothing to say answers EMPTY so a `|| '<fallback>'` guard works.
- **Correlate with `child`, not per-call spreads**: bind `{ workspaceId, executionId }` once at the top of
  the scope. Three seams do it for you: `mountRequestLogging` (mounted FIRST, it mints or adopts
  `X-Request-Id` and puts it in every error envelope, which is what a user quotes off a failed request),
  `containerJobLog` (the same ids ride the job body), and the durable drivers. A request line logs the
  PATHNAME only, because a query string carries the WS `?ticket=` and OAuth `?code=`.
- **`LOG_LEVEL`** is applied FIRST in each boot path and gated in the ADAPTER (a pino child snapshots its
  parent's level at creation). **Assert the evidence in tests** with kernel's `createRecordingLogger()`.
- **A SECOND destination is a kernel `LogSink` installed with `setLogSink`**, never a second logger; it
  sits behind the same level gate. `record` may not throw or block, `flush` may not reject, and the facade
  DRAINS wherever the buffer's HOLDER can vanish: Node timer + shutdown flush ⇄ Worker per-invocation
  `waitUntil` ⇄ each isolate-ending wait in a workflow wake, a failed `step.do` too.

## Operational EVENTS are counted, not just logged

A log line answers "what happened to THIS run"; only a counter answers "is this happening more
than it was". The seam is the kernel `OperationalMetrics` port (`ports/operational-metrics.ts`),
required on `CoreDependencies` and exposed as `container.operationalMetrics`; the process-wide
(Node) / per-isolate (Worker) collector is `@cat-factory/server`'s `operationalMetrics`, the
sibling of `logger`.

- **The counter and gauge unions are CLOSED**, and the OTel mapping names each member through an
  exhaustive `Record`, so adding a signal fails to compile until it has a metric name and a unit.
- **Counters export as DELTAS.** A collector is per process on Node and per ISOLATE on the Worker,
  and each flushes independently; only a delta sums correctly across the flushers. That is also
  why the Worker flushes at the end of every invocation rather than on its cron, which runs in an
  isolate that saw none of the request path's events.
- **Dimensions must be BOUNDED, and named at the CALL SITE**: a queue name, a cache name, an
  eviction kind. Every distinct value is its own time series, so a run/workspace/job id is a
  cardinality explosion. The ids stay on the log line, which is why every increment site also
  logs. Never pick the dimension back out of the log fields (`fields.kind ?? fields.evicted`): it
  reads as correct until someone logs one more field and the series silently re-points.
- **A COUNTER counts EVENTS; a standing level is a GAUGE.** The test is whether the producer can
  see what arrived since the last look. A periodic `SELECT` returning a total cannot: feeding
  that to a delta counter re-reports the same rows every pass (an hourly sweep turned five
  dead-lettered jobs into ~120/day), and diffing it in memory tells the same lie after a restart.
- **An un-wired counter reads as a ZERO**, which is why `CoreDependencies.operationalMetrics` is
  required rather than optional. A caller with nothing to export passes `noopOperationalMetrics`,
  which says so in code.
- **An empty flush sends nothing.** An unflushed zero and a genuine zero are different facts, and
  only the ABSENCE of a data point states the first one honestly. Same rule as "absent ≠ zero"
  above: where a runtime genuinely cannot read a gauge (Cloudflare Queues expose no backlog to
  their consumer), it emits no series rather than a 0.
- **A background sweep reports its pass through ONE call** on both facades (Node's `startSweeper`
  takes `SweeperOptions.health`; the Worker's crons go through `SweepTick.run`), landing on
  `SweepHealthTracker.recordFailure`, which emits the `sweep.failed` RATE and the `sweep_degraded`
  STREAK together; as two calls per site the facades drifted into tracking disjoint sweeper sets.
  A bare `metrics.increment('sweep.failed', …)` is half a report. On the Worker, `SweepTick` also
  orders the tick's metrics flush AFTER its passes settle, because the collector is per isolate
  and a cron's counters are otherwise exported by nobody.

## A controller REFUSES by throwing a `DomainError`, never by building an envelope

`handleError` (`@cat-factory/server`'s `http/errorHandler.ts`) is mounted as `app.onError` on every
facade and is the ONE producer of the `{ error: { code, message, details } }` wire envelope. A hand-built
`c.json({ error: { code: 'unavailable' } }, 503)` is BANNED: an envelope literal structurally cannot
carry `details.reason`, the machine-readable code the SPA maps to translated copy and remedy actions.

- **The vocabulary is kernel's `domain/errors.ts`**, and every member takes `details`: `NotFoundError`
  404, `UnauthorizedError` 401, `ForbiddenError` 403, `ConflictError` 409, `ValidationError` 422,
  `CredentialRequiredError` 428, `RateLimitedError` 429, `UnavailableError` 503. Adding a status means
  adding a class plus its row in `STATUS_BY_CODE` and in the persistence-RPC `ERROR_STATUS` map; both are
  `Record<Code, …>`, so both fail to compile until mapped.
- **`code` is the STATUS CLASS; the machine-readable cause is `details.reason`.** Never invent a new
  `code` value to express a reason.
- **Guard with the total accessors**, not a nullable read plus an `if` at every route:
  `requireCapability(c.get('container').x, 'X is not configured')` and `requireUser(c, 'Sign in to …')`
  (`http/guards.ts`). A per-controller `requireX(c): X` that throws is the shape; a `requireX(c): X | null`
  paired with a local `unavailable()` thrower is what it replaced. The exception is a boolean FLAG
  (`cfg.passwordEnabled`): with no value to narrow, it throws directly. **A capability behind a capability
  gets its OWN accessor** (a library module's `sourceService`, wired only when GitHub is), never a message
  borrowed from its parent, which would name a module the operator has already wired.
- **A guard whose value the route ignores uses the `assert*` twin**, never a discarded `require*`:
  `assertCapability` / `assertUser` return `void`, so the line reads as the refusal it is, where a bare
  `requireClarity(c)` statement reads as a no-op the next cleanup deletes with no test failing.
- **Rethrow, don't re-map.** Catching a `ConflictError` to re-emit it as `c.json({code:'conflict'})` drops
  its `reason`. The one deliberate exception is a handler that flattens distinct causes ON PURPOSE because
  the distinction is an ORACLE (password reset: "no such token" / "expired" / "used").
- **Four surfaces answer in their OWN shape, each documented at the site**: the LLM/web-search proxy pair
  (each failure is RECORDED on the call metric before responding, and they answer 402/413/502),
  `publicApiAuth`/`PublicDecisionController` (failures are DATA, so contract handlers stay typed against
  their declared response schemas), the `/internal` relay controllers (a `{ ok: false }` their machine
  clients parse), and the MCP authorization endpoints (RFC 6749's error body, which a client branches on).
- **A test driving a controller through a bare `new Hono()` must mount `app.onError(handleError)`**, or
  every refusal reads as a 500.
- **A user-reachable 503 `reason` owes TRANSLATED copy** (`UNAVAILABLE_REASONS`, an exhaustive `Record`
  in `usePipelineErrorToast`, the `CONFLICT_REASONS` pattern): the status class's generic wording commits
  to "this deployment has not configured the capability", which is right for an unwired module and is the
  misattribution itself for an outage.

## Caching goes through the app cache seam, never a homebrew Map

A per-service `Map` with a manual TTL, a module-global memo, or an ad-hoc `{ value, expiresAt }` store is
BANNED: it can't be invalidated across a scaled Node deployment. The seam is the kernel `AppCaches` port
(`kernel/src/ports/caching.ts`), implemented by `@cat-factory/caching` and exposed as `container.caches`.
Register a new entry on the interface, in `AppCachesProfile` plus both profiles, and build it in
`createAppCaches`; copy `repoProjection` or `fragmentDocumentBody`. Slice pattern:
[`caching-layer.md`](./docs/initiatives/caching-layer.md).

- **Invalidate on EVERY write** right after it commits. Invalidation, not the TTL, is the coherence story;
  a cached read with no invalidation on its write path is a bug.
- **On the Worker, our mutable state is pass-through or GENERATION-PROBED** (`coherencyWindowMsecs`
  and the `CACHE_GENERATIONS` DO directory), never a bare TTL. The bag is per ISOLATE, so no in-flight
  promise may cross invocations (workerd kills the joiner UNCATCHABLY): `currentInvocation`.
- **Wrap a nullable value** (`{ value: T | null }`): layered-loader treats bare `null` as unresolved.

## Concurrency, idempotency, replay

The durable drivers REPLAY, and two writers routinely race. Each of these was learned from a real
data-loss bug; they bind any new write path.

- **A row that is ONE JSON blob is rev-guarded, never blind-upserted.** The iterative-review stores carry
  a `rev` and a `compareAndSwap`; `IterativeReviewService.mutateReview` loads, applies, CASes, and on a
  lost race RELOADS and RE-APPLIES on the winner's snapshot. So a mutation handed to it must be IDEMPOTENT,
  and notifications/dispatches go AFTER it resolves, on the returned value. Exhausting the bounded retries
  throws `ReviewContendedError`: a 409 to an HTTP caller AND the durable driver's re-drive signal.
- **"One live row per X" is a UNIQUE INDEX, never a transaction around delete-then-insert.** At Postgres'
  default READ COMMITTED a DELETE takes no predicate lock, so two publishers both delete nothing and both
  insert; SQLite serializes writers, so the same code is accidentally safe on D1. That is the trap: a
  sequential conformance test passes on both. Publish through one conflict-targeted upsert, assert the
  invariant with CONCURRENT writers, and heal pre-existing duplicates in the constraint-adding migration.
- **An external side effect in a replaying driver is guarded by an ATOMIC CLAIM taken BEFORE the effect**,
  never a marker written after. Such a design must answer "what if the claimer dies": `failed` is
  re-claimable, the terminal state is not, and `pending` becomes re-claimable past a TTL. **Commit the
  local state FIRST and run the outbound call behind it**, so an upstream outage costs the notification and
  never the data. **A claim that ERRORS must propagate, never degrade to "already done"**: the apply is
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
surfaces, not inert string sinks. The end-to-end trust-boundary model (what stands between an
injected/hallucinating agent and a malicious commit landing, layer by layer with its residual gaps)
is [`backend/docs/security-model.md`](./backend/docs/security-model.md); a change to the write path
(token minting or credential PRECEDENCE, the push, the merge decision, a rendered surface, the
native-child env allow-list) updates that doc in the same PR.

- **Kernel's `hostMarkdown` is the boundary.** The host auto-links `#123` / `@name` / `!123`, a **closing
  keyword before an issue reference CLOSES that issue on merge**, a raw newline ends a table row, and an
  unbalanced fence swallows whatever follows, including the machine-readable JSON block of the
  verification report. Every hole goes through `cell`, `inline` or `prose`, which neutralise the auto-link
  triggers with numeric entities in ONE pass (chained `.replace()`s re-escape each other); a hole that is a
  link TARGET goes through `link`/`cellLink`, which emit an unusable URL as plain text rather than a link.
- **The harness carries byte-for-byte COPIES of a few kernel helpers** (`host-markdown.ts`,
  `normalizeProxyPhase`, `isSafeTestPath`) because the image builds from `src/` plus typescript and can
  depend on no workspace package. Each is pinned by a conformity test: change one, change the other.
- **Scrub with `redactSecrets` at COMPOSE time**, before any truncation, so prose and JSON stay
  consistent. A PR body is strictly more exposed than the telemetry DB.
- **Model-authored strings that become shell or git arguments are validated for MAGIC, not just
  traversal**: `--` stops a path being read as a revision but does nothing about `:(glob)**` or `*`. A
  refused input counts as an omission that is REPORTED, never a silent shortening.
- **Captured command output reaching a model is fenced through `fencedOutput`** (`captured-command.ts`),
  sized one tick longer than the longest backtick run in the body: a fixed ``` fence closes mid-tail and
  spills the rest, plus the instructions after it, into what the model reads as prose.

## Degrade loudly: state what is missing, derive what is computable

- **"Absent" and "zero" must never render the same.** A report section whose producing step didn't run
  says `status: 'absent'` with a note; a sink the deployment doesn't retain says `available: false`, not
  `count: 0`. A silently missing section reads exactly like a clean one.
- **Distinguish the causes that need different fixes.** "No model configured" / "wired but broken" / "over
  budget" are three status values, not one; "no repo" / "read failed" / "recognised nothing" likewise.
  Never infer a cause from the mere presence of an error.
- **Every cap records what it dropped**, and a cap that is NOT a plain prefix says so, because a reader
  who assumes a prefix would conclude the tail was never considered.
- **The model JUDGES; the platform COMPUTES.** A ranking, a score ratio, a regression count is derived in
  code from the model's stated judgements, never read off the reply, or a list is ordered by something its
  own rationale doesn't explain.
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
  returning GitLab projects via the adapter; do not add a second store.
- **Per-workspace PAT connect reuses `github_installations`**, writing a `provider: 'gitlab'` row with the
  PAT sealed by the deployment `SecretCipher`. When a facade has BOTH a GitHub App and GitLab connect, the
  `github` module reads through **`providerRoutingGitHubClient`**, which dispatches per installation by
  stored provider (memoised, so no N+1). Don't hand-roll a second per-provider client or fork the module;
  keep facades symmetric (`selectVcsConnectDeps` ⇄ `selectWorkerVcsConnectDeps`).
- **What the SPA may connect comes from `GET /workspaces/:ws/vcs/connect-options`**; WHERE it links, from
  that option's / the connection's `webUrl` (derived from the API base; null ⇒ WITHHOLD the affordance,
  never fall back to the public instance). Both switch in ONE place: `app/utils/vcs.ts`
  `Record<VcsProvider, …>` constants + `vcs.*` i18n keys, extended per provider (typecheck fails), never forked.
- The migration is incremental: kernel ports are neutralized, but entity types (`GitHubRepo`, the
  `github_repos`/`github_installations` tables) are still GitHub-named and reused as-is. Copy the NEUTRAL
  shape for new surfaces; an un-migrated neighbour is not license to name a field `githubId`.

## Public-API SDK clients: generated from the spec, never hand-edited

Four official clients for `/api/v1` live under `sdk/` (TypeScript, Python, Go, and Java, which also
serves Kotlin), plus two projections: `sdk/mcp` (the operations as MCP tools) and `sdk/gatekeeper`
(per-operation scope floors, from the contracts' `minScope`). THOSE SIX are the chain
**contracts → `docs/openapi.json` → `sdk/*`** with no hand-editing at any link: `pnpm gen:sdk` renders
the spec and `pnpm check:sdk` fails CI on drift and version skew. `sdk/gatekeeper-worker` is the ONE
member outside it, hand-written: a published library CONSUMING that table. Generation, the smoketest
and that exception: [`sdk/README.md`](./sdk/README.md). Two rules bite from outside:

- **Never edit a file whose header says GENERATED**; change the contracts or the emitter. Only models
  and operations are generated; each transport is hand-written beside them.
- **Adding a `/api/v1` endpoint means adding an entry to `scripts/sdk/surface.mjs`** naming its resource
  group and method. Generation FAILS without one, so a new endpoint cannot ship as an un-callable hole in
  four clients, and the same entry becomes an MCP tool with no second decision, except a STREAMING one,
  named in `MCP_OMITTED_OPERATIONS` with its reason. A scenario step added to one `sdk-smoketest` client
  must be added to all four.

## Migrations

Node boots by running `migrate()` BEFORE `boss.start()` (sequential, so a migration failure is the clean
top-level rejection). Resolving CONFLICTING Drizzle migrations after a merge has its own non-obvious
recipe (`rebase-migration-snapshot.mjs`, never a `db:generate` rerun):
[`backend/runtimes/node/AGENTS.md`](./backend/runtimes/node/AGENTS.md).

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
`container.gateways` seam. Each facade's internals (real-time transport, durable execution, container
adapters) live in its own `AGENTS.md`.

- **Cloudflare Worker** (`runtimes/cloudflare` = `@cat-factory/worker`): D1, Workflows for durable
  execution, Durable Objects for real-time and per-run Containers, queues/cron, the `workers-ai` binding.
- **Node** (`runtimes/node`): Postgres via Drizzle, pg-boss for durable execution, a per-workspace
  `NodeRealtimeHub` serving the same raw-WebSocket + `?ticket=` protocol, multi-node propagation behind
  the `LocalEventSink` seam, and container dispatch to a workspace's self-hosted runner pool. Details:
  [`backend/runtimes/node/AGENTS.md`](./backend/runtimes/node/AGENTS.md).
- **Local** (`runtimes/local`): the Node facade with per-run local containers
  (`LocalContainerRunnerTransport` over a `ContainerRuntimeAdapter` selected by
  `LOCAL_CONTAINER_RUNTIME`) and GitHub reached via a PAT, so a local pipeline gates on real Actions CI
  and merges for real. The adapter contracts that bite (`endpoint()` on an exited container, the
  post-mortem, `localDind`): [`backend/runtimes/local/AGENTS.md`](./backend/runtimes/local/AGENTS.md).
- **Model provisioning** is composed per facade from `CompositeModelProvider`; unconfigured providers
  aren't registered, so `resolve` throws a clear error instead of failing deep in the SDK. Locally-run
  models are per-user endpoints with NO API key forwarded SERVER-side, so the base URL is constrained to
  a loopback-only allow-list (`localRunnerUrlError`) at the write boundary, the test probe and every
  redirect hop; `LOCAL_MODELS_ALLOW_LAN=true` is the operator opt-in. Doc: [`backend/docs/model-support.md`](./backend/docs/model-support.md).
- **`deploy/preview`** carries the per-PR TEST environments for THIS repo. Board wiring AND the three
  editing constraints (no `include:`/bind mounts/`env_file`, the empty `apiBase`, the per-PR name
  templates): [`docs/internal/dogfooding.md`](./docs/internal/dogfooding.md).

## Dependencies, releases, new packages

### The `minimumReleaseAge` supply-chain gate

Installs reject any registry package published inside the 24h cutoff. **The gate is OFF unless
`minimumReleaseAge: 1440` is set in `pnpm-workspace.yaml`**: pnpm has no default, so an unset value is
not a shorter window but NO window, and `minimumReleaseAgeExclude` beside it then governs nothing.

- **Only wildcard namespaces WE OWN** belong on that allow-list (`@cat-factory/*`, `@toad-contracts/*`).
- **Never add a per-version third-party exception**, and delete any that accrue.
- **When upgrading, pick the latest version that already satisfies the rule**
  (`npm view <pkg> time --json`), staying within the compatible major.
- **Do not touch the executor-harness** during a dependency sweep: its deps feed the published image, so
  bumping them is a separate image-bumping change.
- **The Vercel AI SDK family is held to the major that pairs with `workers-ai-provider`**: today `ai@^7` +
  `@ai-sdk/*@^4` (`openai-compatible@^3`, `amazon-bedrock@^5`).

### Releases & changesets

Versioning is changesets (root `pnpm changeset` / `ci:publish`). **Always add a changeset for a change to
a versioned package**; empty changeset for docs/CI/test-only. CI enforces this.

**Any change to what goes into the runner image bumps `@cat-factory/executor-harness` AND the pinned
tag everywhere it appears.** This repo publishes the images but operates no deployment: the pins
DECLARE the supported tag, which a deployment mirrors into its own registry as a FRESH immutable tag
(reusing one does NOT roll out there; the symptom is `Container dispatch failed (HTTP 404)`). Rollout
recipe, release-PR re-sync, new-published-package checklist: [`docs/internal/releases.md`](./docs/internal/releases.md).

### Run the CI guard scripts locally before committing

> **Do NOT run locally: the whole-tree `pnpm test:run` NOR a `--filter`ed package lane** (CI's test
> lanes own both; see Conventions), **`pnpm lint:knip`, `node scripts/check-package-catalog.mjs`**
> (slow; CI's `Build & typecheck` is authoritative) **or `turbo run test:mutation`** (nightly: [`mutation-testing.md`](./docs/internal/mutation-testing.md)).

- `node scripts/check-file-size.mjs`: the file-size ratchet (split, don't raise).
- `node scripts/check-silent-catch.mjs`: bans `.catch(() => {})` in backend non-test source.
- `node scripts/check-component-imports.mjs`: every layer component used in a Vue template is
  imported by path ([`frontend/app/README.md`](./frontend/app/README.md#always-import-a-layer-component-explicitly)).
- `node scripts/check-reserved-env-keys.mjs`: every variable in `docs/environment-variables.md` is RESERVED, so it can never be named as a capability credential.
- `node scripts/check-gate-approval-raise.mjs`: every human-gate raise goes through `buildStepApproval`.
- `node scripts/check-external-api-inventory.mjs`: every outbound call, and every vendor endpoint declared for something ELSE to send, is a surface the external-API sweep verifies, one of ours, or an SDK's.
- `node scripts/check-doc-links.mjs`, `check-doc-anchors.mjs`, `check-shipped-doc-links.mjs`: an ordinary markdown link, a doc URL built in CODE, and a shipped tarball's links each resolve to a file AND a heading.
- `node scripts/check-{test-lane,conformance-group}-parity.mjs`: `pnpm test:quick` excludes what CI's no-DB lane does; every conformance group runs on every facade.
- `node scripts/check-deploy-placeholders.mjs`: the `deploy/*` templates hold placeholders, never real ids.
- `node --test 'scripts/*.test.mjs'` runs each guard's own fixtures (CI runs them all).
- `pnpm exec changeset status --since=origin/main`: after committing locally.
- `pnpm lint:monorepo` (sherif): cross-package dependency-version consistency.
- `pnpm check:publish` (after `pnpm build`): publish-artifact integrity.
- `node scripts/check-runner-image-{tag.mjs --since origin/main,paths.mjs}`: whenever anything image-affecting changed.
- `pnpm exec turbo run typecheck --filter=<touched package>` (it covers tests, which build excludes).

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
join them, or it is silently absent in production; the symptom is attribution landing as
"unknown"/nobody, never an error.

## Harness rules

**Per-job state: NEVER a process- or HOME-global.** Anything the executor-harness stages for ONE job is
scoped to that job: explicit child env, or a per-job directory. Never `process.env`, never a dotfile
under `HOME`. This is a correctness rule: a global LOOKS per-job in a container, where one job owns the
process and `HOME`, but the local native transport (`LOCAL_NATIVE_AGENTS`, `LocalProcessRunnerTransport`)
serves EVERY concurrent `ambientAuth` job from ONE long-lived host process whose `HOME` is the developer's
own. Container tests keep passing while one job leaks into a sibling and files the developer owns are
destroyed.

- **`RunOptions.agentEnv`** → `SubscriptionRunOptions.extraEnv`, merged over the inherited env when the
  agent CLI is spawned; layer onto it with `withAgentEnv`. **Anything the HARNESS spawns itself must be
  passed `agentEnv` explicitly**, since a child of the harness inherits nothing.
- **A per-job directory** created in `handleAgent` for an `ambientAuth` job and removed with it; the
  private-registry npmrc goes there via `npm_config_userconfig`, because writing or clearing the real
  `~/.npmrc` corrupts the developer's own config.
- **State with no per-job form is NOT WRITTEN AT ALL** rather than written globally: a repo-sourced Claude
  Skill installs natively only into an isolated `CLAUDE_CONFIG_DIR`, and an ambient run reads it from the
  checkout's `.cat-context/skill/`. When you move state to the checkout, move the PROMPT with it. `~/.pi/*`
  is HOME-global only because the Pi harness never runs natively; do not extend that assumption.
- **Add a test that two concurrent jobs keep new per-job state separate**: the container path alone will
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

- **Agents**: a container or inline LLM does the work (`coder`, `architect`, `spec-writer`, `tester`,
  `merger`, the companions). Dispatched via `CompositeAgentExecutor`; container kinds park on
  `awaiting_job`.
- **Polling gates**: `ci`, `conflicts`, `post-release-health`. A gate runs a **programmatic precheck**
  against a provider and only escalates to a helper container agent (`ci-fixer` / `conflict-resolver` /
  `on-call`) on a negative verdict; skip-unless-needed is the whole point. ONE generic machine drives every
  gate (`evaluateGate` / `dispatchGateHelper` / `pollGate`, parking on `awaiting_gate`); a
  `GateDefinition` supplies only `wired()`, `probe()`, `helperKind` and `onExhausted`, and live state is
  `step.gate`. **Adding a gate is a new registry entry, never another `evaluateX`/`pollX`/`awaiting_x`
  triple**; ergonomics:
  [`custom-agent-gate-ergonomics.md`](./backend/docs/custom-agent-gate-ergonomics.md). Pure gate logic
  lives in kernel (`domain/gate-logic.ts`); `defaultGateRegistry()` is EMPTY and the built-ins
  (`@cat-factory/gates`) install themselves through the same public seam a deployment uses.
  **`resolveHelperCompletion`** is the seam for an INVESTIGATE-don't-fix helper (`on-call` never
  reverts), settling the gate without re-probing.
- **One-shot engine steps**: `tracker`, `deployer`, `requirements-review`. Bespoke handling; not gates
  because they don't poll-or-escalate.
- **Judges**: an inline LLM scores work against a rubric, disposing: advance / park / bounce the
  producing step with findings as `rework` / fail. **Adding a judge is a new registry entry**
  (`JudgeDefinition`). Model, and why it is neither a gate nor a `StepCompletionResolver`:
  [`judge-registry.md`](./docs/initiatives/judge-registry.md).
- **Companions**: a REWORK PAIR looping the preceding producer back on a bounded budget before a
  human is asked; **added with `AgentKindRegistry.registerCompanion`**. Trap: the pairing is stored
  SEPARATELY from the kind and the lookups take the registry OPTIONALLY, so a read off a kind's own
  definition sees built-in pairs only. Doc: [`custom-agent-gate-ergonomics.md`](./backend/docs/custom-agent-gate-ergonomics.md).
- **The `merger` resolver is a privileged built-in, deliberately NOT externalized.** It owns terminal block
  status (`ownsTerminalStatus`) and executes a policy-gated real merge, so it keeps engine-internal access
  rather than the minimal public `ResolverContext`.

**A step's presence may be conditional on the task estimate; a HUMAN GATE never is.** Estimate gating
(`StepGating` → `shouldRunGatedStep` → `RunDispatcher.skipGatedStep`) skips a step when an earlier
estimate PRODUCER's scores fall below its thresholds; that is what lets ONE pipeline cover a range that
would otherwise need several near-identical presets. The three binding rules (gatability is a declared
per-kind capability, OFF by default, and structural kinds like `merger` stay unlisted; a skipped
producer CASCADES onto its companion via the persisted `step.skipped`; a step may not carry both
`gates[i]` and enabled `gating`, because an estimate may ADD a human checkpoint but never cancel one):
[`pipeline-catalog-collapse.md`](./docs/initiatives/pipeline-catalog-collapse.md). The same
precheck-first idea applies inline: `hasNotesToIncorporate` short-circuits `runIncorporationCycle` so
the rework + re-review LLM calls are skipped when the human left nothing to fold in.

## Pipeline flows

An INDEX: what each flow is, plus the trap a change would hit. The linked doc is the authority; new flow
detail belongs there, not here, and an entry stays a handful of lines. The cross-cutting rules these
flows established are stated once above (concurrency/idempotency, untrusted text, degrade loudly,
harness rules).

**Built-in catalog lifecycle**: built-ins are COPIED into each workspace at creation and reconciled
against the CATALOG, never the stored row; a run ADOPTS an entry the board was never seeded with, so a
PINNED pipeline is never stuck behind an advisory. Traps: retiring one is TWO edits (definition AND
`buildRetiredPipelines()`), the first alone a silent no-op; a bare `pipelineRepository.get` on a
run-adjacent path is the smell, since every start gate resolves the pipeline and CONCLUDES from it; and
an AUTHORING rule (`validatePipelineAuthoring`) binds create/update, the run door refusing only the
subset that dead-ends ANY run, or every stored pipeline predating it stops running. Doc: [`pipeline-catalog-lifecycle.md`](./backend/docs/pipeline-catalog-lifecycle.md).

**Repo bootstrap** mirrors the execution pattern: `BootstrapService` → `bootstrap_jobs` →
`BootstrapWorkflow` polling the idempotent `pollBootstrapJob()`, then links the repo to the block and
flips the frame to `ready`. Pre-flights that the target repo is empty; the prompt goes to Pi's global
`~/.pi/agent/AGENTS.md`, outside the checkout, so it never lands in the bootstrapped repo.

**Service blueprints**: a Blueprinter agent decomposes a repo into service → modules and persists it IN
THE REPO under `blueprints/`: no table, because the files are the truth and the board is the projection.
The map stops at modules and tasks are authored by people, so `reconcileBlueprint` matches by name, adds
missing, refreshes descriptions, and **NEVER deletes or touches authored tasks**.

**In-repo spec implementation state**: `requirementItem.state` (`aspirational` ⇄ `established`) keeps an
agreed-but-unbuilt requirement out of build prompts. Trap: `specPromotionPostOp` is the ONE author and
it NEVER demotes; `coerceRequirement` defaults a garbled state to `aspirational`, so a model cannot promote
by assertion. Doc: [`service-acceptance-criteria.md`](./docs/initiatives/service-acceptance-criteria.md).

**Pre-dispatch input gate**: a deterministic reduction over a task's OWN authored fields, run at step 0
before the first dispatch, parking the run for FREE when there is structurally nothing to act on.
Trap: it is not a cheap reviewer, so it never scores prose or infers intent and every BLOCKING finding
names an input no model could have acted on either. Doc:
[`pre-dispatch-input-gate.md`](./docs/initiatives/pre-dispatch-input-gate.md).

**Requirements review**: an inline iterative loop (review → answer → incorporate → re-review) settling the
PRODUCT layer only, its findings sorted into the two groups that decide WHO answers. Traps: a parked run
waits indefinitely by design (never a timeout); the reviewer must be TOLD what system the work is about, and
a derived subject never displaces it. Doc: [`requirements-review.md`](./backend/docs/requirements-review.md).

**Inbound tracker webhooks**: HMAC over the RAW body before any parse, ack 202, hand off through
`gateways.trackerWebhook`; unconfigured FAILS CLOSED. Traps: push never replaces the `bug-intake`
reconciliation sweep; ticket-comment replies route through the SAME service methods the SPA calls; the
per-ticket match is a VERDICT (`unconfirmed` fires `queue` and withholds `per-ticket`), never a boolean.
Doc: [ADR 0032](./backend/docs/adr/0032-tracker-webhook-intake.md).

**Bug hunt**: scan a tracker board's open unassigned bugs, rate impact against complexity, adopt one onto
`pl_bugfix`; persists NOTHING. Traps: one vendor call per scan is a hard requirement, and the rating
takes `isOverBudget`, being the platform's first billable call no run start gates; any future
un-run-scoped LLM call owes the same guard. Doc: [`bug-hunt.md`](./backend/docs/bug-hunt.md).

**Implementation-fork decision**: an optional two-phase `coder` step that proposes materially different
implementations and parks for a human BETWEEN two dispatches on the same step (a container job can't
pause mid-run). Rides `step.forkDecision`; primary repo only. Doc:
[ADR 0022](./backend/docs/adr/0022-coder-fork-decision.md).

**Dependency prepopulation**: one declared install command run before the agent's first turn. Trap:
NEVER a gate; an install is SETUP, so every failure becomes a prompt NOTE and the run continues. Doc:
[`agent-dependency-prepopulation.md`](./docs/initiatives/agent-dependency-prepopulation.md).

**Foundational services**: a tiered (builtin ⊕ account ⊕ workspace) catalog of the shared capabilities
an org already runs, injected as `.cat-context/` files. Traps: the catalog and the CONTRACTS are two
separate reads and that split IS the feature; the code-registered `builtin` tier holds no rows; "no
declaration", "empty declaration" and "unknown id" are three states needing different reactions, with
`operationsAreIndexable` the one place the fourth (an unparseable format) lives. Doc:
[ADR 0031](./backend/docs/adr/0031-foundational-services.md).

**Binary-output steps**: a `binary-output`-trait kind generates artifacts, stored through a foundational
service its step SELECTS; what MAKES them is `BinaryGeneratorRegistry`, read only via `BinaryGeneratorSource`
(unreachable ⇒ 503, mothership rule), whose `capabilities` + `accepts` gate the options and, past two producers,
a human CANDIDATE park. `pl_media` runs the shipped kind against `platform-assets` + `nano-banana`, the one
service and integration shipped (INJECTING a registry drops it, refusing that preset). Deadliest trap: content
type is CLOSED and stops deciding at the SECOND producer, so overlaps are STATED, never ranked. Doc: [`binary-output-foundational-storage.md`](./docs/initiatives/binary-output-foundational-storage.md).

**Compose layers**: `StackRecipe` / `SharedStack` name an ORDERED list of `ComposeFileRef` layers
(in-repo path, `inline`, or `repo`), letting a deployment declare infra dependencies in code. Traps: the
project directory anchors on the first `path` layer, NEVER the first layer. Doc:
[`stack-recipes-and-shared-stacks.md`](./docs/initiatives/stack-recipes-and-shared-stacks.md).

**Pre-PR validation**: per-frame install/lint/test/build commands after the agent settles; only a green
checkout opens a PR. Traps: autodetection SUGGESTS, it never writes; unconfigured is byte-for-byte the
old behaviour. Doc: [`pre-pr-validation.md`](./docs/initiatives/pre-pr-validation.md).

**Bugfix reproduction proof**: the declared reproduction command against the pre-fix tree and the PR
tree; only red-then-green is proof. Traps: SYMMETRY between the two trees is the safety property; target
`baseSha` and apply the declared PATHS only; a failure degrades to `inconclusive` with the PR still
opening (the opposite disposition from validation); the producer's `note` is rendered VERBATIM. Doc:
[ADR 0033](./backend/docs/adr/0033-bugfix-reproduction-proof.md).

**Pipeline PR descriptions**: the agent writes its reviewer briefing to `.cat-pr-description.md` and the
harness lifts it onto `openPullRequest`; when the target repo ships a PR template, the briefing IS that
template, filled in. Traps: the guidance rides EVERY agent pass; the sentinel is read with
`titleFromHeading: false`; the coverage test classifies every agent-running mode as PR-opening or not.
Doc: [`pipeline-pr-descriptions.md`](./backend/docs/pipeline-pr-descriptions.md).

**Consensus panels**: an eligible step runs as a multi-model panel (`@cat-factory/consensus`). Traps: a
panel participant has NO checkout and `dispatchDeliversCheckout` is the one definition every layer asks;
the tier is chosen by the ENGINE at dispatch, deterministically. Doc:
[`consensus-panels.md`](./backend/docs/consensus-panels.md).

**Merge lifecycle** turns an open PR into a merged one, gated on REAL CI and a REAL merge, so a task is
`done` only when its PR actually merged.

- **`ci` (polling gate)**, auto-inserted second-to-last: green/none advances with nothing spun up,
  pending sleeps, failure dispatches `ci-fixer` (which pushes back onto the SAME branch) up to
  `ciMaxAttempts` then raises `ci_failed`.
- **`merger`** (last standard step) returns ONLY a JSON assessment; `resolveMergerStep` scores it against
  the task's risk policy (an account ⊕ workspace library of ceilings, budgets and per-class `classRules`,
  read by editor/picker/engine alike through the ONE merged `WorkspaceRiskPolicyReader`: [ADR 0055](./backend/docs/adr/0055-account-scoped-risk-policies.md))
  and either merges for real or raises `merge_review`. No merger ⇒ `pipeline_complete`, never auto-`done`.
- **Who started the run is part of the merge policy**, and a bar on LANDING is refused at BOTH exits
  (auto-merge AND `mergePr`). Deadliest trap: the role and mode PIN at admission and count only if the pin
  PERSISTS through `executionToDetail` / `rowToExecution` / `buildResumedInstance`, so a dropped pin reads
  as a run with no policy rather than as an error.
  [ADR 0037](./backend/docs/adr/0037-role-scoped-merge-policy.md),
  [ADR 0039](./backend/docs/adr/0039-role-scoped-submission-allowlists.md).
- **Merge track record** persists each decision best-effort. Trap: an unreadable diff yields `unknown`,
  which never matches a rule, so a VCS outage cannot change policy.
  [ADR 0046](./backend/docs/adr/0046-merge-track-record.md).
- **Whether a run WAITS is policy too**: `autonomy` answers the parks the engine's loops raise WHEN THEY
  GIVE UP, on the record; a workspace holds TWO defaults for it AND for its pipeline, scoped by
  `runDefaultScopeFor(intakeOrigin)`. Traps: never a park the PIPELINE asked for; a new give-up park picks
  a side; a review's QUESTIONS settle only where a SECOND, independent judgement agrees.
  [ADR 0053](./backend/docs/adr/0053-unattended-run-autonomy.md), [ADR 0054](./backend/docs/adr/0054-per-scope-pipeline-defaults.md).
- **Notifications** (`NotificationChannel`) and run-lifecycle events (`RunLifecycleSink`) are built together
  by `buildNotificationWebhookSupport` onto ONE registered endpoint and the ONE `signedDelivery.ts`
  retry/SSRF/signature core. Traps: the started edge is exactly-once via `handOffLiveRun` (announced LAST,
  after the claim and the local write); the terminal edges are at-least-once with a `<runId>:<event>` dedupe
  id a receiver dedupes on, never on the body. [ADR 0030](./backend/docs/adr/0030-public-api-surface.md).

**Run evidence reductions**: the ENGINE keeps a verification report of captured facts on EVERY pull request
a run opened (marker-delimited body section, idempotent, no persisted state) and reduces the same evidence
into the OUTCOME summary the SPA card renders and `/api/v1/runs/:runId/outcome` serves. Traps: composing is
a settlement HOOK reading in-memory state, never a re-probe; a peer's copy WITHHOLDS the own-service-only
sections, so the write-avoidance cache keys per TARGET; a rule BOTH reductions state (which testers count,
regressions, coverage) lives in contracts' `run-evidence.ts`. Doc: [`pr-verification-report.md`](./docs/initiatives/pr-verification-report.md).

**Environment disposal**: the `disposer` step reclaims what the run provisioned where its author placed
it, every teardown path re-probes afterwards, and a SAVE refuses a chain that neither reclaims nor says
the environment outlives it. Deadliest trap: a no-op `teardown:` reports `torn_down`, so only a
`confirmed` probe is a reclaim and a missing verify row is never a pass. Doc: [`environment-disposal-and-teardown-proof.md`](./docs/initiatives/environment-disposal-and-teardown-proof.md).

**Post-release health**, the LAST standard step: watch monitors/SLOs for a window and, on a regression,
spawn an `on-call` agent to investigate. **It never auto-reverts.** The kernel `ReleaseHealthProvider`
port is vendor-neutral (per-vendor adapters, today only Datadog); credentials live sealed in
`observability_connections`, never in containers. `on-call` is resolved by `resolveOnCallStep`: raise
`release_regression`, best-effort enrich any open incident (the `IncidentEnrichmentProvider` port
annotates, never re-alerts), finish the gate.

## Custom agents (manifest-driven extension over `RepoFiles`)

A deployment ships its own agent kinds without forking and without rebuilding the harness image.
Governing principle: **zero `switch(agentKind)` in the container**. The harness is a generic
LLM-over-a-checkout runner and all deterministic work is backend TypeScript. Full model:
[`custom-agents.md`](./backend/docs/custom-agents.md); role authoring:
[`custom-agent-roles.md`](./backend/docs/custom-agent-roles.md); tool servers (MCP):
[`mcp-tool-servers.md`](./backend/docs/mcp-tool-servers.md); design record:
[ADR 0029](./backend/docs/adr/0029-agent-kind-capabilities.md).

- **Three stages**, of which the container runs only the middle: `preOps` (backend TS committing a
  targeted subset via the `RepoFiles` port, a per-run checkout-free HTTP facade) → `agent` →
  `postOps` (backend TS parsing `result.custom`, rendering artifacts, committing). Unwired means
  the hooks skip.
- **Capabilities are `skills` and `toolServers`**, registered on the SAME `AgentKindRegistry` and
  attachable to a built-in kind via `assignSkills` / `assignToolServers`. **Skills resolve in the
  ENGINE**; **tool servers resolve in the container EXECUTOR**, because what is servable depends on the
  resolved harness and the facade-wired credential resolver.
- **A capability credential is declared BY NAME** and resolved through the kernel `ToolSecretResolver`
  port; the VALUE rides the job body only. Deadliest trap: **a credential has TWO names and only one
  of them is a boundary** (the LOOKUP key may never be a variable the platform reads; `envName`
  carries only the narrower toolchain rule, because vendors' SDKs fix what they look for). Full
  model: [ADR 0041](./backend/docs/adr/0041-capability-credential-store.md).
- **`allowedTools` is SCOPING, never a security boundary**, and claude-code's `--allowedTools` must
  ALWAYS carry the CLI's built-in tool names too (it is whole-session, not MCP-scoped). An `http`
  server must be `https` or loopback, refused at registration AND at the job boundary.
- **A capability that can't be honoured is STATED to the agent, never silently dropped.**
- **The harness MATERIALISES, never decides**, into PER-JOB paths: never HOME-global, never the
  checkout. Changing what it writes means an image bump.
- **A deployment's own TASK TYPES ride the same kind of seam**; one bundling a per-case form, its
  standing context and its own canned pipeline is a REUSABLE OPERATION: [`reusable-operations.md`](./backend/docs/reusable-operations.md).
- **The BUILT-INS ride the same seam**: every container kind is a `registerAgentKind` entry
  declaring an `AgentStepSpec`; a hard-coded set beside the registry is the anti-pattern replaced.
  Trap: it declares NO `systemPrompt` (the TRACK owns it) and NO `presentation` (palette duplicate).

## Per-workspace agent prompt overrides

A workspace can replace any agent kind's system prompt from the pipeline builder; the store is an
append-only revision log and the engine resolves the override ONCE per dispatch onto
`AgentRunContext.systemPromptOverride`, which every prompt-assembly site must honour. Traps: an override
replaces the shipped TRACK prompt, never the whole system prompt; engine-enforced fragments survive only
through `OVERRIDE_PRESERVED_FRAGMENTS`; `merger`/`on-call` bespoke prompts and the inline engine kinds
are SPLIT `{ role, directives }` and a new one added un-split fails only after a workspace edits it. The
full model (revision log, generation-setting sibling store, variant composition, the sandbox):
[`agent-prompt-overrides.md`](./backend/docs/agent-prompt-overrides.md).

## Telemetry & agent-context observability

Four sinks (`llm_call_metrics`, `agent_context_snapshots`, `agent_search_queries`, `agent_tool_calls`) live in a
dedicated telemetry store, not the transactional one: a required `TELEMETRY_DB` D1 database on Cloudflare and a
`telemetry` Postgres schema on Node, pruned to `LLM_CALL_METRICS_RETENTION_DAYS`. The authority for anything
recording an LLM call: [`llm-telemetry.md`](./backend/docs/llm-telemetry.md). The rules that most often bite:

- **Three producers converge on the ONE `LlmObservabilityService` and a new one must too**: the proxy,
  the subscription harnesses, and inline calls through the kernel `InlineLlmCallRecorder` port. A model
  served by a harness CLI files its OWN calls and the middleware around it STANDS DOWN
  (`reportsOwnLlmCalls`); two producers for one call would double every token in the rollup.
- **A new inline caller on the run path must build its scope with the run in it**, or its rows are IN
  the store and absent from every run-scoped read, which reads as a step that spent nothing.
- **State what a producer does NOT know rather than filling a field with a guess**; the input side is
  THREE token classes, never a lump (`readInputTokenClasses`); every row is stamped with the PHASE that
  spent it by whoever OWNS the boundary.
- **A rollup is ONE aggregate** (`(agentKind, phase)` for spend, `(agentKind, tool)` for tool calls,
  whose failures are invisible in the first); a new consumer folds, it does not add a query.
- **The tool-call TRAJECTORY is one sink per invocation, ordered SERVER-SIDE by `(startedAt, seq)`**
  and never by the drain stamp several calls share nor by the job id, a string that sorts dispatches
  by agent-kind spelling; a harness image that numbers nothing has its trajectory skipped rather
  than collapsed onto colliding ids, and `bodies` marks a withheld arg list so it never reads as a
  tool that took none.
- **Bodies are double-gated** (`LLM_RECORD_PROMPTS` AND the per-workspace `storeAgentContext`, via
  kernel's `createStoreAgentContextGate`), on every path that captures a model body, external trace
  fan-out included; a read that throws fails closed.
- **External trace destinations go through the ONE `LlmTraceSink` port** composed by
  `composeTraceSinks`, never a second recording path; a run's spans are a hierarchy built from DERIVED
  ids with extents folded from recorded stamps, and a span name is a bounded class.

The deployment-level projections (`gate_outcomes`, `platform_run_days`, plus `spend_days`, the ONE with
no retention: a TCO table that expires is a slower ledger) live in the MAIN store; their rewrite,
watermark and derived-id rules: [ADR 0048](./backend/docs/adr/0048-platform-operator-observability.md)
and [`storage-and-retention.md`](./backend/docs/storage-and-retention.md). Remote debugging reads
(`/api/v1/debug/*`) obey one rule: size is computable BEFORE the request: [`debug-api.md`](./backend/docs/debug-api.md).

## Board / service / repo-linkage model

- **A Block carries no repo fields.** Repo↔block linkage lives in the `github_repos` projection via its
  `block_id` column, and **execution resolves the repo at runtime** via
  `resolveRepoTarget(workspaceId, blockId)`, which walks the block's ancestry to the enclosing service
  frame and reads that frame's `Service.repoGithubId`: the SOLE linkage, and the only one carrying a
  monorepo `directory`. **There is deliberately NO "first repo" fallback**: an unlinked chain THROWS a
  `ValidationError`, because guessing once pushed a simple-service task into someone else's repo. So a
  bootstrapped repo becomes a board service only once its projection row is linked to the frame's block
  id. A workspace has exactly ONE VCS installation but may have MANY repos.
- **A step's prompt names the service the work belongs to**: `AgentRunContext.ownService`, derived by
  the engine from that same ancestry walk (kernel's `describeOwnService`). It is a DISCRIMINATED result,
  not a nullable one, and "not under a service" is RENDERED rather than omitted: a bare task title names
  no software, so a silent omission reads like a task whose product is obvious and the model supplies one
  (see the requirements-review flow entry). Inline reviewers use `IterativeReviewService.resolveOwnService`.
- **A service frame's board POSITION (and any size override) lives on its `WorkspaceMount`, not on the
  Block**, because one shared service sits at a different spot on every board that mounts it: `moveBlock`
  writes the mount and the frame block row's own `position` is frozen at creation. **Every frame-returning
  read therefore projects through kernel's `applyMountLayout`**: the snapshot and each single-block
  `BoardService` mutation response alike. Skipping it is silent: nothing fails, the SPA just upserts the
  authoritative block a mutation returned and the frame JUMPS to coordinates no board shows it at.
- **A TASK carries no position at all: it is laid out in a status SWIMLANE** derived from its status plus
  its run's park/failure state, so a drag only REPARENTS (`useBlockDrag.ts` `positioned: false` →
  `BoardService.reparent()`; tasks into frames or modules, modules into frames, frames never nest per
  `canReparent`), and a module renders no box (its tasks group by module name in the lanes). Trap: a lane
  is a CLAIM, so a status the TYPE forbids but the DATABASE still holds must land in a NAMED lane, never
  `undefined`, or the card leaves the board with nothing left to say it existed.
  [Doc](./frontend/app/README.md#task-swimlanes).

## End-to-end (assembled-product) coverage

Where conformance asserts backend behaviour port-by-port, the Playwright suite (`backend/internal/e2e`)
covers the assembled product: real Chromium → real SPA → real Node backend, with only EXTERNAL deps
faked. Spec-writing mechanics and the Specs table:
[`backend/internal/e2e/README.md`](./backend/internal/e2e/README.md).

- **What e2e is FOR**: what only the assembled product shows, above all the live WebSocket-pushed UI
  round-trip. A pure backend side-effect belongs in conformance. Anything needing a real outbound call
  must be mocked at the backend's OUTBOUND boundary, never in the browser.
- **Spec shape (mandatory)**: seed/trigger over REST, then assert only on LIVE pushed UI updates: no
  reloads, no sleeps, no canvas drag/zoom, `data-testid` selectors, `helpers.ts` timeouts. A spec
  about IDENTITY (the login screen, a policy naming PEOPLE) needs the AUTH-ENABLED stack.
- **A flaky e2e test is a BLOCKING bug: investigate and deflake, NEVER retry.** Playwright enforces this
  (`failOnFlakyTests: true`); the retry exists ONLY to capture the trace. A flake almost always exposes a
  REAL race, usually a frontend store reconcile or a `helpers.ts` readiness gate; fix the SOURCE and pin
  it with a unit test. Never paper over it in the spec (no sleep, no bumped timeout, no reload), and the
  bar for "fixed" is a high-count `--repeat-each` pass plus the root-cause fix in the same change.
- **A flake is either a SPEC asserting state the product only passes THROUGH (the e2e README names
  the untestable transients) or the recurring product bug: a stale full-snapshot refresh clobbering
  newer live state.** The delivery-shape rules (coarse `board` events vs targeted upserts, monotonic
  refreshes, the optimistic-echo trap and `execution.echoAfter`) plus the store-level unit tests that
  pin them live in [`frontend/app/README.md`](./frontend/app/README.md#real-time-store-coherence-avoid-the-full-refresh-clobber).

## Role, then interface mode: how much of the SPA is shown (frontend)

Two narrowings, both applied in `navSlotFilter`. The ROLE is the job the person picked at first launch
(`stores/uiRole.ts`): `engineer` / `product-manager` see everything, `designer` gets the `intake` surface (the
board's services, the work in flight, the three ways to bring work IN) and is CAPPED at the basic tier. The TIER
is `basic` (the shipped default) vs `advanced` (`stores/uiMode.ts`); both axes and their seams: [`frontend/app/README.md`](./frontend/app/README.md#roles-engineer--product-manager--designer).

- **A new user-facing surface must decide BOTH, and neither answer is "ignore this"**: the tier bar is whether
  the EVERYDAY DELIVERY LOOP needs it, the role bar whether an `intake` persona (which never configures the
  platform) does. `intake` is opt-IN, so silence there narrows nothing by accident.
- **HIDE, never disable, and only ever hide an OVERRIDE**: what remains must be exactly the default the
  hidden field would have shown. Gate override controls on `showOverrideField(isAdvanced, ...values)`,
  NOT on `isAdvanced` alone, because an EXISTING entity can already carry an override.
- **Never mark the way BACK as `advanced`, nor hide it from a narrowed role.** Neither axis is AUTHORIZATION
  (workspace RBAC is, server-side), so both hide destinations the caller is allowed to open.
- **Agent tiers are a SEPARATE axis** (`presentation.tier`, cumulative, vocabulary in `@cat-factory/contracts`):
  those two decide which SURFACES exist, this how much of one surface's catalog is LISTED; a new BUILT-IN kind declares its tier in `utils/catalog.ts` (`catalog.spec.ts` fails otherwise).

## Internationalization (i18n)

All user-facing SPA copy goes through `@nuxtjs/i18n`; never hard-code a display string. The full
authoring how-to (catalog layout, key conventions, component mechanics, translator descriptions, the
drift guards) is
[`frontend/app/README.md`](./frontend/app/README.md#internationalization-i18n-authoring); migration
status: [`docs/internal/localization.md`](./docs/internal/localization.md). What binds beyond the SPA:

- **The backend does not localize prose.** A localizable condition emits a machine-readable
  `error.details.reason`/`code` that the SPA maps to a frontend key. The wire vocabulary lives in
  `@cat-factory/contracts`, so the SPA imports the SAME source of truth. **Every failure toast goes through
  the ONE funnel** (`usePipelineErrorToast().present(error, titleKey)`), never a hand-built
  `toast.add({ description: err.message })`: raw prose is DETAIL behind a disclosure, and the funnel is what
  makes a failure translated, non-auto-dismissing, and copyable WITH the `requestId` joining it to the log.
- **Locale parity is CI-gated per change** (`i18n-locale-parity.mjs`), and **never ship an English
  string as a non-`en` value**: the parity gate checks only that the key exists, so a verbatim English
  copy passes and is a bug. If you genuinely cannot produce a translation, say so in the PR.
- Migration is incremental: when you touch a component, lift its visible copy into the catalog.

## Workspace RBAC enforcement

Per-workspace authorization (ADR [`0025-workspace-rbac`](./backend/docs/adr/0025-workspace-rbac.md)) is
enforced in exactly three shared places, never re-derived per controller:

1. **Resolution + the 404 hide**: `mountAuthGate` calls the single `loadWorkspaceAccess` on every
   `/workspaces/:ws/*` request, publishes `{ role, permissions }`, and 404s a denied or absent board alike.
2. **The viewer write floor**, also in the gate: any non-GET/HEAD requires `≥ member` (sole exemption: the
   read-only WS ticket mint). It covers the member tier with zero per-controller code, so a member-tier
   write relies on it and mounts NO gate of its own.
3. **The admin-tier permission gate**: `mountWorkspacePermission(app, perm, prefixes)`, on each admin
   controller's OWN top-level paths. It gates every write served under them (now and future), lets reads
   through, and runs ahead of body validation and the handler's 503, so a refusal never reveals wiring. One
   permission per controller, except three that MIX tiers: `WorkspaceController`/`WorkspaceMemberController`
   go imperative per handler with `requirePermission(c, perm)`, and `DocumentSourceController` by PREFIX.

**It takes PREFIXES, never `'*'`; no gate factory is exported, so the wildcard is unrepresentable.**
`app.route(prefix, sub)` re-registers a sub-app's `use('*')` as `ALL <prefix>/*`, which Hono runs for every
route registered AFTER it, so each admin gate silently refused the siblings mounted later in `app.ts`. A NEW
admin controller joins `WORKSPACE_CONTROLLERS`, gates its own prefixes, and gains a `member 403` case in
`defineWorkspaceRbacSuite`. Prefixes can UNDER-reach where `'*'` over-reached, and one assertion cannot see
both: `permissionMounts.test.ts` pins that a member is refused exactly the writes their OWN controller gates
AND that a gated controller leaves no route of its own uncovered.

## Conventions

- **Hexagonal layering**: controllers (`@cat-factory/server`) → services (orchestration/integrations) →
  ports (kernel). Infra adapters live in each facade and implement the ports + the `gateways` seam, wired
  via constructor injection of one `dependencies` object. Opt-in integrations wire only when configured.
- **A pure rule BOTH the backend and the SPA must agree about lives in `@cat-factory/contracts`**, never
  restated on each side. The SPA cannot see kernel, so a rule that stays there becomes a hand-written copy
  the moment a surface has to state the same judgement to a human, and the two then drift
  (`binaryFormatCoverage` and `binaryModalityOverlaps` are the worked example). What decides is who has
  to AGREE about the answer, not which package the rule feels like it belongs to. A rule needing kernel's
  own types stays in kernel; so does the DISPOSITION of its outcomes (which refuses a run, which only
  warns), being a fact about admission rather than about the thing judged.
- **Folded best-practice standards are two-tier, and the brief travels WITH its body.** An implementer
  kind folds a fragment's condensed `brief` instead of the full `body`; reviewer/planner kinds keep the
  full text. Traps: `brief` is resolved alongside the body it condenses and NEVER re-looked-up by id;
  every `composeBlockSystemPrompt` call site threads `standardsVerbosityFor(kind, registry)`; every
  failure folds the FULL BODY, and an over-long generation is REFUSED rather than truncated. Authoring:
  [`prompt-fragments/README.md`](./backend/packages/prompt-fragments/README.md); design:
  [`auto-generated-fragment-briefs.md`](./docs/initiatives/auto-generated-fragment-briefs.md).
- **Final answer must land in the reply, not the reasoning channel.** Any agent whose deliverable IS its
  final reply (spec-writer, blueprinter, merger, on-call, task-estimator, the tester report, the
  reviewers/companions, the requirements reviewer) MUST append the shared `FINAL_ANSWER_IN_REPLY` fragment:
  some reasoning models emit the whole answer into their private channel and return an empty visible reply,
  which the harness reads as unusable and fails the run. Do NOT append it to side-effect agents whose
  product is a pushed commit (coder, ci-fixer, conflict-resolver, mocker, playwright, business-documenter):
  they legitimately end with no final text. Editing a versioned prompt means bumping its number.
- **Frontend extension seams** are all contributed through the one `registerAppModule` registry
  (`app/modular/registry.ts`), the frontend analogue of the backend registries: result views, inspector
  panels (`PanelEntry<Block>` in the `inspectorPanels` slot), overlays (`appOverlays` +
  `useAppOverlays().open`). The placement rule for step-attached state (declared result view vs
  `ResultWindowShell` section, decided by the RECORD's scope) and the `useResultViewRunMeta` rule live in
  [`frontend-extension-mechanism.md`](./docs/initiatives/frontend-extension-mechanism.md); adoption:
  [ADR 0049](./backend/docs/adr/0049-modular-vue-adoption.md).
- **Tests**: Worker integration tests use real `workerd` + real local D1; Node tests use real Postgres
  (`DATABASE_URL`); only the LLM is faked. **Run the FILES your change touched, NAMED on the command line**
  (`pnpm exec vitest run <file>`). A `--filter`ed package, `test:changed`, `test:quick` and the tree are LANES:
  CI's to run, and reaching for one is the banned habit, not thoroughness. An edit with no runnable file of
  its OWN (a conformance suite, a catalog change) is NOT the exception: [`conformance/README`](./backend/internal/conformance/README.md) names the spec.
  A green run printing the app's OWN log lines is a SUITE bug: silence the gate, or inject a silent logger.
- **Count what the test OWNS; assert a RELATION over what it does not.** Seed two rows and assert two:
  the test made that population, so the count is a local fact. A total over a population it does NOT
  control (a generated table, a registry, a catalog, the spec) is the opposite: `toBe(42)` fails on
  every ordinary addition, names nothing about what broke, and trains the next person to re-pin it
  unread. Derive that expectation from the same source the code reads and assert the structural
  property (every operation accounted for EXACTLY ONCE across exposed and omitted; a facade listing
  EXACTLY its table). Check what already refuses the case first: the assertion worth writing is the one
  existing guards structurally CANNOT make, e.g. a regenerate-and-diff check passes an emitter whose
  bug is consistent in both halves.
- **Always run `typecheck`/`test`/`build` through Turbo from the repo root**, never a package's raw script from inside
  its directory (exception: a task with no build deps), and scope with `--filter` rather than a `cd`. Turbo's `^build`
  edge only fires through Turbo; bypassing it surfaces as spurious `TS2307 Cannot find module '@cat-factory/contracts'`.
