# CLAUDE.md: cross-cutting rules

**This file holds the RULES that bind more than one feature.** A rule already enforced by a
typecheck, a CI guard, or a linked doc does not need restating here, and how one subsystem WORKS
belongs in that subsystem's doc, never here. `scripts/check-file-size.mjs` ratchets this file, so
growth must displace something.

Where everything else lives:

- **Orientation**: [`README.md`](./README.md) (the CI-guarded layout table),
  [`backend/README.md`](./backend/README.md), and an `AGENTS.md` in every `backend/packages/*` and
  `backend/runtimes/*` with its entry point and a "where things live" map.
- **Vocabulary** (block vs task vs card, runner/executor/transport, `runtimes/cloudflare` =
  `@cat-factory/worker`): [`docs/glossary.md`](./docs/glossary.md).
- **The runtime flows**, one entry each with its deadliest trap:
  [`docs/flow-index.md`](./docs/flow-index.md). The step vocabulary they assume:
  [`step-taxonomy.md`](./backend/docs/step-taxonomy.md).
- **Design records**: [`backend/docs/adr/`](./backend/docs/adr/). **In-flight initiatives**:
  `docs/initiatives/`. **Product docs are the WEBSITE** (catfactory.ai); this tree documents how
  the product is built.

## Governing principle: clean design over quick solutions

Default to the well-factored design, not the fastest thing that passes.

- **Fix causes, not symptoms.** No special-case at the call site, `try/catch` swallow, defensive
  `if`, or magic constant standing in for a real fix.
- **Respect the existing seams.** Extend through the app-owned registries (`AgentKindRegistry`,
  `GateRegistry`, `JudgeRegistry`, `PipelineRegistry`, `TaskTypeRegistry`, `VcsProviderRegistry`,
  `StepResolverRegistry`, `FoundationalServiceRegistry`, `PromptFragmentRegistry`,
  `InlineUseCaseRegistry`), the kernel ports, and the runtime `gateways`. Copy the nearest good
  citizen, never a one-off, and never add a second `evaluateX` / `pollX` / `awaiting_x` triple
  beside a generic machine. A registration is injected BY REFERENCE, never through a module global
  (a `workspace:*` dep publishes as an EXACT version, so a consumer floating the range gets two
  copies and the registration lands in the one nothing reads), and takes an option on BOTH `start()`
  and `startLocal()`, asserted at those ENTRY POINTS rather than at the container builder
  (`runtimes/node/test/registry-seams.spec.ts` + its local sibling).
- **No shortcuts that create debt.** Don't hard-code what should be configured, widen a type to
  `any` to dodge a modelling problem, or leave a half-wired feature behind a TODO. If the clean
  solution needs a new port/method/table, add it (mirrored across runtimes).
- **Prefer deleting to accreting.** Remove the obsolete path rather than keeping it beside the new.

### Size budgets are a split trigger, NEVER a number to raise

`scripts/check-file-size.mjs` and oxlint's `max-lines-per-function` are ratchets: they may only go
DOWN. When your change pushes a file or function over budget, extract the concern your change
touches into a cohesive collaborator taking a small deps object of bound callbacks, leaving a thin
delegate behind (the model: the `RunDispatcher` controller extractions, `FetchGitHubClient` →
`reviewPosting.ts`). A budget number may only change in your PR when a split made it smaller. If
you believe a split is impossible, STOP and say so rather than bumping silently. It covers THIS
file too: shrink it by moving detail to the docs above, never by raising the budget.

## Compatibility: the public API is STABLE; everything internal is not

The externally consumed surface is `/api/v1` (paths, request/response shapes, error `code` values
and `details.reason` vocabularies, SSE event names, scope semantics), the four SDK clients under
`sdk/`, and the outbound webhook delivery contract. Design record:
[ADR 0034](./backend/docs/adr/0034-public-api-stability.md).

- **Additive changes are the normal mode**: a new endpoint, optional field, enum value or error
  code. The SDKs tolerate unknown values by design, so additions ship freely; bump the OpenAPI
  `info.version` minor.
- **Anything else needs an INCREMENTAL MIGRATION PATH plus a VERSION CHANGE, in that order.** The
  old shape keeps working while the new one is served beside it (a new field beside the one it
  replaces, a new `/api/v2` prefix for a path or semantics change), the version records the step
  (OpenAPI major, SDK majors), and the changeset plus
  [`public-api.md`](./backend/docs/public-api.md) document what moves and by when. Removing the old
  half is a second, LATER change. Never rename, retype, remove, or re-scope in place.
- **Narrowing what a scope or key may do is a break too**, not a bug-fix: a live integration built
  on the old admission loses capability, so it takes the same path.

**Internals are pre-1.0**: internal wire shapes, persisted rows, tokens, config. Do NOT add
migrations, shims, dual-read/dual-write paths, deprecation windows or "legacy" fallbacks to preserve
them. Prefer the clean shape, let stale state be re-created, and flag the break in the changeset.

**But a break must ARRIVE as one.** Retiring a member of a CLOSED vocabulary that is also PERSISTED
leaves the old value in the database, so every exhaustive `switch` and `Record<TheEnum, …>` over it
is total against the TYPE and partial against the DATA. A retired value is NAMED as retired, never
silently dropped and never guessed onto a current member. Keep the compile-time guard while you add
the runtime one: route a `switch`'s `default` through a helper taking `never`, and narrow a lookup
with a predicate DERIVED from the schema rather than an optional call.

## PR workflow

**Always finish a task with a PR, unprompted.** When the work is done, branch, commit, push, open a
PR. Never commit task work to `main` unless asked; if you started there, branch off it first.

**A PR description is a reviewer briefing, never a restated diff.** Give the context the diff cannot
show: the problem and why now, the decisions made (especially alternatives considered and rejected:
say what and why), and what to watch for when reviewing (behaviour changes, a flagged compatibility
break, the riskiest part). Leave out file lists, "tests added", line counts, change-by-change
narration.

**Fixing an existing PR (review findings OR red CI) lands on THAT PR's own head branch, pushed
immediately.** This overrides any environment-supplied "develop on branch X" instruction naming a
different branch, because CI and reviewers only act on the PR head. Never a scratch branch, never a
second PR. CI tests `pull/<n>/merge`, not the bare head, so a failure can come from code the base
gained after the PR forked: merge `origin/main` into the PR branch, fix there, and push with
`git push origin HEAD:<pr-head-branch>`.

### Documentation-staleness sweep before every PR

Docs are part of the change and CI catches only broken LINKS, never staleness. Match the sweep to
the blast radius (a one-line internal fix needs none; a new export / env var / capability / flow
does):

- The package's own `README.md` + `AGENTS.md`; the root `README.md`'s layout and feature-guide rows.
- This file, only for a new CROSS-CUTTING rule. Detail about one flow goes in that flow's doc, and a
  higher-level doc POINTS AT a new deeper one or the deeper one is lost.
- **Does this change behaviour a catfactory.ai page describes? Then it ships with a WEBSITE PR,
  opened and merged FIRST, and NAMED in this PR's description.** OWNERSHIP FOLLOWS THE READER: the
  website owns what anyone can act on with NO checkout, a doc here keeps internal design plus a
  LINK, split by DEPTH, never mirrored; a new env var, endpoint, capability, failure mode or
  operator step meets that test. **LOAD the page before you link it**: neither repo's CI can see the
  other (the crossing guard is weekly BY DESIGN), so a reduction that ASSERTED its page existed left
  600 lines reachable from nowhere. Before reducing a doc, check what deep-links its HEADINGS from
  code (`check-doc-anchors.mjs`). Model:
  [ADR 0051](./backend/docs/adr/0051-documentation-repo-website-split.md).

### Bigger initiatives get a tracker document

Multi-PR work (cross-cutting refactor, registry-by-registry migration, strangler conversion) gets a
tracker under `docs/initiatives/` with the first PR: goal and rationale, target pattern (link the
pilot), a per-item checklist with PR links updated each slice, and the gotchas the pilot surfaced.
It also earns its keep when an initiative is REDIRECTED, so the next iteration can't re-propose a
withdrawn approach.

**When the committed scope completes, convert the tracker into a numbered ADR under
`backend/docs/adr/` (`NNNN-slug.md`, next free number) and `git rm` the tracker in the same PR.**
Keep Context / Decision / Rationale / Consequences and drop the checklists; header shape
`# ADR NNNN: <title>` plus a `Status` / `Date` / `Context layer` bullet block. Check the number
against ALL existing files first: parallel branches have collided on one three times.

## Writing style: no em-dashes, no LLM-tell prose

Binds every human-readable text you write: docs, READMEs, AGENTS.md files, PR descriptions, commit
messages, code comments, UI copy.

- **The em-dash is BANNED.** Pick the punctuation the sentence actually needs: a colon before an
  elaboration, a comma before a conjunction or relative clause, parentheses around an aside, or a
  new sentence. Spaced en-dashes used as punctuation count too. (Text inside code fences quoting
  real command output is exempt.)
- **No filler or inflation**: "Note that" / "It's worth noting" openers, "Additionally," /
  "Furthermore," chains, "in order to" for "to", "leverage"/"utilize" for "use", "seamless",
  "robust", "comprehensive", "delve", decorative "simply"/"just", "not only X but also Y" where
  plain "X and Y" carries the same meaning.
- **Keep a contrast only when it IS the rule.** "X, never Y" earns its place when Y is the real
  trap; as a reflex it is noise. The same goes for stacked parentheticals: if an aside matters, give
  it its own sentence.

## Environment quirks

- **Skip `wrangler whoami` before a deployment**: assume the Cloudflare login is correct.
- **Multi-line git messages: bash heredoc in the Bash tool, NOT a PowerShell here-string.** The Bash
  tool is POSIX sh, so `@'…'@` leaks literal `@` characters into the commit subject. Use
  `git commit -F - <<'EOF'`; `git commit --amend -F -` fixes a mangled message before pushing.
- **Worker tests DO run on Windows**: name the spec files, and expect one `AI bindings always access
remote` warning per pool.
- **The Postgres-backed suites need a reachable server AND `--env-mode=loose`**; a bare `[ELIFECYCLE]
Command failed` with no vitest summary is a CANCELLED sibling. Recipe, including how to start a
  cluster where no Docker daemon runs: [`running-tests.md`](./docs/internal/running-tests.md).
- **ALWAYS format/lint-fix the ENTIRE tree, never a subset.** `pnpm lint:fix` from the root (or
  `pnpm exec oxfmt .`); the only correct argument to `oxfmt`/`oxlint` is `.`, for any reason. On
  Windows the whole-tree run rewrites line endings across hundreds of files: expected, and git's
  normalization absorbs it at commit time. Run it ONCE at the end and trust the result: never diff
  or stash it, ask why an untouched file changed (it sweeps up drift), or RE-RUN tests/typecheck.

## Conventions

- **Hexagonal layering**: controllers (`@cat-factory/server`) → services
  (orchestration/integrations) → ports (kernel). Infra adapters live in each facade and implement
  the ports + the `gateways` seam, wired via constructor injection of one `dependencies` object.
  Opt-in integrations wire only when configured.
- **A pure rule BOTH the backend and the SPA must agree about lives in `@cat-factory/contracts`**,
  never restated on each side. The SPA cannot see kernel, so a rule that stays there becomes a
  hand-written copy the moment a surface has to state the same judgement to a human, and the two
  then drift (`binaryFormatCoverage` and `binaryModalityOverlaps` are the worked example). What
  decides is who has to AGREE about the answer, not which package the rule feels like it belongs to.
  A rule needing kernel's own types stays in kernel; so does the DISPOSITION of its outcomes (which
  refuses a run, which only warns), being a fact about admission rather than about the thing judged.
- **Final answer must land in the reply, not the reasoning channel.** Any agent whose deliverable IS
  its final reply (spec-writer, blueprinter, merger, on-call, task-estimator, the tester report, the
  reviewers/companions, the requirements reviewer) MUST append the shared `FINAL_ANSWER_IN_REPLY`
  fragment: some reasoning models emit the whole answer into their private channel and return an
  empty visible reply, which the harness reads as unusable and fails the run. Do NOT append it to
  side-effect agents whose product is a pushed commit (coder, ci-fixer, conflict-resolver, mocker,
  playwright, business-documenter): they legitimately end with no final text. Editing a versioned
  prompt means bumping its number.
- **Folded best-practice standards are two-tier, and the brief travels WITH its body.** An
  implementer kind folds a fragment's condensed `brief`; reviewer/planner kinds keep the full text.
  Authoring: [`prompt-fragments/README.md`](./backend/packages/prompt-fragments/README.md); design:
  [`auto-generated-fragment-briefs.md`](./docs/initiatives/auto-generated-fragment-briefs.md).

## Tests

- **Run the FILES your change touched, NAMED on the command line** (`pnpm exec vitest run <file>`).
  A `--filter`ed package, `test:changed`, `test:quick` and the tree are LANES: CI's to run, and
  reaching for one is the banned habit, not thoroughness. An edit with no runnable file of its OWN
  (a conformance suite, a catalog change) is NOT the exception:
  [`conformance/README`](./backend/internal/conformance/README.md) names the spec.
- **Always run `typecheck`/`test`/`build` through Turbo from the repo root**, never a package's raw
  script from inside its directory (exception: a task with no build deps), and scope with `--filter`
  rather than a `cd`. Turbo's `^build` edge only fires through Turbo; bypassing it surfaces as
  spurious `TS2307 Cannot find module '@cat-factory/contracts'`.
- Worker integration tests use real `workerd` + real local D1; Node tests use real Postgres
  (`DATABASE_URL`); only the LLM is faked. A green run printing the app's OWN log lines is a SUITE
  bug: silence the gate, or inject a silent logger.
- **Count what the test OWNS; assert a RELATION over what it does not.** Seed two rows and assert
  two: the test made that population. A total over a population it does NOT control (a generated
  table, a registry, a catalog, the spec) is the opposite: `toBe(42)` fails on every ordinary
  addition, names nothing about what broke, and trains the next person to re-pin it unread. Derive
  that expectation from the same source the code reads and assert the structural property instead
  (every operation accounted for EXACTLY ONCE across exposed and omitted). Check what already
  refuses the case first: the assertion worth writing is the one existing guards structurally CANNOT
  make, e.g. a regenerate-and-diff check passes an emitter whose bug is consistent in both halves.
- **A flaky e2e test is a BLOCKING bug: investigate and deflake, NEVER retry.** Playwright enforces
  this (`failOnFlakyTests: true`); the retry exists ONLY to capture the trace. A flake almost always
  exposes a REAL race, usually a frontend store reconcile or a readiness gate; fix the SOURCE and
  pin it with a unit test. Never paper over it (no sleep, no bumped timeout, no reload), and the bar
  for "fixed" is a high-count `--repeat-each` pass plus the root-cause fix in the same change. What
  e2e is for and the mandatory spec shape:
  [`backend/internal/e2e/README.md`](./backend/internal/e2e/README.md); the store-delivery rules a
  flake usually indicts:
  [`frontend/app/README.md`](./frontend/app/README.md#real-time-store-coherence-avoid-the-full-refresh-clobber).

### Run the CI guard scripts locally before committing

> **Do NOT run locally: the whole-tree `pnpm test:run` NOR a `--filter`ed package lane** (CI's test
> lanes own both), **`pnpm lint:knip`, `node scripts/check-package-catalog.mjs`** (slow; CI's
> `Build & typecheck` is authoritative) **or `turbo run test:mutation`** (nightly:
> [`mutation-testing.md`](./docs/internal/mutation-testing.md)).

- `node scripts/check-file-size.mjs`: the file-size ratchet (split, don't raise).
- `node scripts/check-silent-catch.mjs`: bans `.catch(() => {})` in backend non-test source.
- `node scripts/check-inline-model-scope.mjs`: every inline LLM caller builds its credential scope through kernel's `resolveInlineScope`, NAMING what it holds, so a dropped run or asker cannot pass as a decision.
- `node scripts/check-component-imports.mjs`: every layer component used in a Vue template is imported by path ([`frontend/app/README.md`](./frontend/app/README.md#always-import-a-layer-component-explicitly)).
- `node scripts/check-reserved-env-keys.mjs`: every variable in `docs/environment-variables.md` is RESERVED, so it can never be named as a capability credential.
- `node scripts/check-gate-approval-raise.mjs`: every human-gate raise goes through `buildStepApproval`.
- `node scripts/check-external-api-inventory.mjs`: every outbound call, and every vendor endpoint declared for something ELSE to send, is a surface the external-API sweep verifies.
- `node scripts/check-doc-links.mjs`, `check-doc-anchors.mjs`, `check-shipped-doc-links.mjs`: an ordinary markdown link, a doc URL built in CODE, and a shipped tarball's links each resolve to a file AND a heading.
- `node scripts/check-{test-lane,conformance-group}-parity.mjs`: `pnpm test:quick` excludes what CI's no-DB lane does; every conformance group runs on every facade.
- `node scripts/check-deploy-placeholders.mjs`: the `deploy/*` templates hold placeholders, never real ids.
- `node scripts/check-workspace-bin-scripts.mjs`: no package script spawns a workspace CLI by its bin NAME (that shim cannot link on a fresh checkout); the by-path spawn addresses the path the owning package DECLARES.
- `node --test 'scripts/*.test.mjs'` runs each guard's own fixtures (CI runs them all).
- `pnpm exec changeset status --since=origin/main`: after committing locally.
- `pnpm lint:monorepo` (sherif): cross-package dependency-version consistency; `pnpm check:publish` (after `pnpm build`): publish-artifact integrity.
- `node scripts/check-runner-image-{tag.mjs --since origin/main,paths.mjs}`: whenever anything image-affecting changed.
- `pnpm exec turbo run typecheck --filter=<touched package>` (it covers tests, which build excludes).

## Dependencies, releases, new packages

### The `minimumReleaseAge` supply-chain gate

Installs reject any registry package published inside the 24h cutoff. **The gate is OFF unless
`minimumReleaseAge: 1440` is set in `pnpm-workspace.yaml`**: pnpm has no default, so an unset value
is not a shorter window but NO window, and `minimumReleaseAgeExclude` beside it then governs
nothing.

- **Only wildcard namespaces WE OWN** belong on that allow-list (`@cat-factory/*`,
  `@toad-contracts/*`).
- **Never add a per-version third-party exception**, and delete any that accrue.
- **When upgrading, pick the latest version that already satisfies the rule**
  (`npm view <pkg> time --json`), staying within the compatible major.
- **Do not touch the executor-harness** during a dependency sweep: its deps feed the published
  image, so bumping them is a separate image-bumping change.
- **The Vercel AI SDK family is held to the major that pairs with `workers-ai-provider`**: today
  `ai@^7` + `@ai-sdk/*@^4` (`openai-compatible@^3`, `amazon-bedrock@^5`).

### Releases & changesets

Versioning is changesets (root `pnpm changeset` / `ci:publish`). **Always add a changeset for a
change to a versioned package**; empty changeset for docs/CI/test-only. CI enforces this.

**Any change to what goes into the runner image bumps `@cat-factory/executor-harness` AND the pinned
tag everywhere it appears.** This repo publishes the images but operates no deployment: the pins
DECLARE the supported tag, which a deployment mirrors into its own registry as a FRESH immutable tag
(reusing one does NOT roll out there; the symptom is `Container dispatch failed (HTTP 404)`).
Rollout recipe, release-PR re-sync, new-published-package checklist:
[`docs/internal/releases.md`](./docs/internal/releases.md).

## Keep the runtimes symmetric

**Any change to one runtime facade must land the symmetric change in every other.** Every facade
serves the same `@cat-factory/server` app behind the same kernel ports, so a new repository, port
implementation, table, migration, cron task, gateway or wiring added to one has to land in the other
(D1 migration ⇄ Drizzle schema + `pnpm db:generate`; a Cloudflare `scheduled` cron ⇄ a Node
`setInterval` sweeper; a D1 repo ⇄ a Drizzle repo). What each facade supplies is the root README's
layout table; the internals that bite are each one's `AGENTS.md`
([cloudflare](./backend/runtimes/cloudflare/AGENTS.md), [node](./backend/runtimes/node/AGENTS.md),
[local](./backend/runtimes/local/AGENTS.md)).

**A facade-parity gap is a showstopper, not a follow-up**, even when the second runtime "degrades
gracefully". Land both runtimes AND a conformance assertion in the same change, or don't land it.
"Node has no X yet" is acceptable only for behaviour that genuinely cannot exist on a runtime (a
Cloudflare-Container-only execution path), never for runtime-neutral domain behaviour that merely
needs a repository wired.

**Conformance is the enforcement**: `@cat-factory/conformance` exposes `defineConformanceSuite`, the
key backend behaviour as runtime-neutral assertions parameterised by a `ConformanceHarness`, run by
the Worker inside workerd against real D1 and by Node and local against real Postgres. So a
repository that maps a column differently, or an engine path only one facade wires, fails a test
instead of shipping.

**Every feature ships MOTHERSHIP-READY from its first implementation.** In mothership mode
([`mothership-mode.md`](./docs/initiatives/mothership-mode.md)) the local node runs the engine with
no main database, reaching every org/durable repository over the `/internal/persistence` machine
RPC, so a feature that works only against a direct `db` handle is incomplete and fails silently on a
developer's laptop at runtime.

- **A new repository method picks one of four buckets IN THE SAME PR**: `remote` (the default for
  org/durable state), `local-sqlite` (a per-user or per-deployment credential or local-runner knob),
  `telemetry` (append-heavy run observability the node also READS locally), or `excluded` (named in
  the drift guard's classification map, with the reason). There is no fifth outcome. The tracker
  holds each bucket's pattern, the `pickRepoSource` rule and the sealed-secret rule.
- **State a deployment registers in CODE and a RUN resolves is org state too.** A mothership
  deployment is TWO processes and a node one build behind is NORMAL, so "the deployment registers it
  on both entry points" is not a design: it rides its OWN `/internal/*` read, the node does not
  consult its own copy, and the read THROWS rather than answering empty (an empty catalog and an
  unreachable mothership are the same value and opposite facts). **A throw is only half the fix: the
  BEST-EFFORT seam that catches it must STATE the outage in what it injects**, never fall through to
  nothing.

## No N+1 repository access

**Calling a single-row repository method inside a loop (`for`, `.map`, `Promise.all`) over a list is
BANNED**, in the service layer, the facade repos, and the HTTP layer alike. Instead:

- **Batch with one chunked `IN` query** via a `listByIds` / `listByFrameBlocks`-shaped port method,
  indexed into a `Map`. If no batch method exists, ADD one (mirrored D1 ⇄ Drizzle, with a
  conformance assertion). A read method needs no migration.
- **Reuse an already-fetched list** by indexing it into a `Map` rather than re-querying.
- **Hoist invariant reads out of the loop.**
- **Push counts/aggregates into SQL** (`COUNT`/`SUM`/`GROUP BY`), never reduce rows in JS.

Good citizens: `WorkspaceMountRepository.countByServiceIds`, `ServiceRepository.listByIds`,
`TaskRepository.listByRefs`, `BoardService.removeBlock`.

## Logging goes through the kernel `Logger` port, never a local logger interface

Every package logs through ONE injected interface, kernel's `Logger` (`ports/logging.ts`):
`debug`/`info`/`warn`/`error`, each `(msg, fields?)` (message FIRST), plus `child(bound)`.
`@cat-factory/server`'s `observability/logger.ts` is the ONLY place a logging library is named. Full
patterns, including the metrics half below:
[`backend/docs/logging.md`](./backend/docs/logging.md).

- **A local `interface XLogger { warn(obj, msg?) }` is BANNED**, as is a bespoke
  `log?: (event, msg) => void` callback dependency. A package that can't see kernel is in the wrong
  layer.
- **A service takes `logger?: Logger` and normalises ONCE** (`deps.logger ?? noopLogger`) so it
  stays unit-testable, but **`CoreDependencies.logger` is REQUIRED**: a facade forgetting to wire it
  must fail to typecheck, not silently run the engine on `noopLogger`.
- **`.catch(() => {})` is BANNED; use `runBestEffort(logger, label, fn, fields)`** (kernel): it
  keeps the swallow (a best-effort path must NEVER propagate into its caller) and adds one `warn`
  naming the operation with the cause attached. A bespoke `catch` still binds the cause with
  `describeError(error)`. Enforced by `check-silent-catch.mjs`, whose header owns the scope and the
  `// silent-catch-ok:` escape hatch.
- **A thrown value has exactly THREE describers, all reading the whole CAUSE CHAIN**:
  `getErrorMessage` (shown to a human or recorded on a row), `describeError` (log fields),
  `describeConnectionFailure` (a probe verdict). **A hand-rolled
  `e instanceof Error ? e.message : String(e)` is BANNED**: on Node a transport failure's own message
  IS the contentless `fetch failed`, identical for an unreachable host, a bad cert and a DNS typo.
  Any OTHER field carrying command output, a URL or model text goes through `redactSecrets` at the
  emit site, and a credential is never logged, not even at `debug`.
- **Correlate with `child`, not per-call spreads**: bind `{ workspaceId, executionId }` once at the
  top of the scope. A request line logs the PATHNAME only, because a query string carries the WS
  `?ticket=` and OAuth `?code=`.
- **Assert the evidence in tests** with kernel's `createRecordingLogger()`.

**Operational EVENTS are counted, not just logged.** A log line answers "what happened to THIS
run"; only a counter answers "is this happening more than it was". The seam is the kernel
`OperationalMetrics` port, required on `CoreDependencies` beside `logger`. Every increment site also
logs, because a counter's dimensions must be BOUNDED (a run or job id is a cardinality explosion)
while a line's fields need not be, and a COUNTER counts EVENTS where a standing level is a GAUGE.

## A controller REFUSES by throwing a `DomainError`, never by building an envelope

`handleError` (`@cat-factory/server`'s `http/errorHandler.ts`) is mounted as `app.onError` on every
facade and is the ONE producer of the `{ error: { code, message, details } }` wire envelope. A
hand-built `c.json({ error: { code: 'unavailable' } }, 503)` is BANNED: an envelope literal
structurally cannot carry `details.reason`, the machine-readable code the SPA maps to translated
copy and remedy actions.

- **The vocabulary is kernel's `domain/errors.ts`** (404 through 503, `CredentialRequiredError`
  428 included), and every member takes `details`. Adding a status means adding a class plus its row
  in `STATUS_BY_CODE` and in the persistence-RPC `ERROR_STATUS` map; both are `Record<Code, …>`, so
  both fail to compile until mapped.
- **`code` is the STATUS CLASS; the machine-readable cause is `details.reason`.** Never invent a new
  `code` value to express a reason.
- **Guard with the total accessors** (`http/guards.ts`), not a nullable read plus an `if` at every
  route: `requireCapability(c.get('container').x, 'X is not configured')`, `requireUser(c, …)`. **A
  capability behind a capability gets its OWN accessor**, never a message borrowed from its parent,
  which would name a module the operator has already wired.
- **A guard whose value the route ignores uses the `assert*` twin**, never a discarded `require*`:
  `assertCapability` / `assertUser` return `void`, so the line reads as the refusal it is, where a
  bare `requireClarity(c)` statement reads as a no-op the next cleanup deletes with no test failing.
- **Rethrow, don't re-map.** Catching a `ConflictError` to re-emit it as
  `c.json({code:'conflict'})` drops its `reason`. The deliberate exception is a handler that
  flattens distinct causes ON PURPOSE because the distinction is an ORACLE (password reset).
- **Four surfaces answer in their OWN shape, each documented at the site**: the LLM/web-search proxy
  pair, `publicApiAuth`/`PublicDecisionController`, the `/internal` relay controllers and the MCP
  authorization endpoints.
- **A test driving a controller through a bare `new Hono()` must mount `app.onError(handleError)`**,
  or every refusal reads as a 500.
- **A user-reachable 503 `reason` owes TRANSLATED copy** (`UNAVAILABLE_REASONS`, an exhaustive
  `Record` in `usePipelineErrorToast`): the status class's generic wording commits to "this
  deployment has not configured the capability", which is right for an unwired module and is the
  misattribution itself for an outage.

## Caching goes through the app cache seam, never a homebrew Map

A per-service `Map` with a manual TTL, a module-global memo, or an ad-hoc `{ value, expiresAt }`
store is BANNED: it can't be invalidated across a scaled Node deployment. The seam is the kernel
`AppCaches` port, implemented by `@cat-factory/caching` and exposed as `container.caches`. Register
a new entry on the interface, in `AppCachesProfile` plus both profiles, and build it in
`createAppCaches`; copy `repoProjection` or `fragmentDocumentBody`. Slice pattern:
[`caching-layer.md`](./docs/initiatives/caching-layer.md).

- **Invalidate on EVERY write** right after it commits. Invalidation, not the TTL, is the coherence
  story; a cached read with no invalidation on its write path is a bug.
- **On the Worker, our mutable state is pass-through or GENERATION-PROBED**, never a bare TTL. The
  bag is per ISOLATE, so no in-flight promise may cross invocations (workerd kills the joiner
  UNCATCHABLY): `currentInvocation`.
- **Wrap a nullable value** (`{ value: T | null }`): layered-loader treats bare `null` as unresolved.

## Concurrency, idempotency, replay

The durable drivers REPLAY, and two writers routinely race. Each of these was learned from a real
data-loss bug; they bind any new write path.

- **A row that is ONE JSON blob is rev-guarded, never blind-upserted.** Load, apply,
  compare-and-swap, and on a lost race RELOAD and RE-APPLY on the winner's snapshot
  (`IterativeReviewService.mutateReview` is the model). So a mutation handed to such a helper must be
  IDEMPOTENT, and notifications go AFTER it resolves, on the returned value.
- **"One live row per X" is a UNIQUE INDEX, never a transaction around delete-then-insert.** At
  Postgres' default READ COMMITTED a DELETE takes no predicate lock, so two publishers both delete
  nothing and both insert; SQLite serializes writers, so the same code is accidentally safe on D1.
  That is the trap: a sequential conformance test passes on both. Publish through one
  conflict-targeted upsert, assert the invariant with CONCURRENT writers, and heal pre-existing
  duplicates in the constraint-adding migration.
- **An external side effect in a replaying driver is guarded by an ATOMIC CLAIM taken BEFORE the
  effect**, never a marker written after. Such a design must answer "what if the claimer dies":
  `failed` is re-claimable, the terminal state is not, and `pending` becomes re-claimable past a TTL.
  **Commit the local state FIRST and run the outbound call behind it**, so an upstream outage costs
  the notification and never the data. **A claim that ERRORS must propagate, never degrade to
  "already done"**: the apply is idempotent precisely so the queue can retry.
- **First write wins where the row's value derives from a chain**; never an upsert, which would
  recompute against a moved tip. Streamed telemetry arrives twice with the same minted id, so both
  repos target the ID alone (`onConflictDoNothing({ target: id })` ⇄ `ON CONFLICT(id) DO NOTHING`,
  NOT `INSERT OR IGNORE`, which also swallows a constraint violation on one runtime only).
- **A published value must be FINAL.** A producer whose numbers can arrive late publishes through a
  gate that WITHHOLDS the row until the correction can no longer fire, rather than landing a zero
  and dropping the fix.
- **Idempotency by CONTENT beats a marker row** where the work is a file rewrite: re-read,
  recompute, byte-compare.

## Degrade loudly: state what is missing, derive what is computable

- **"Absent" and "zero" must never render the same.** A report section whose producing step didn't
  run says `status: 'absent'` with a note; a sink the deployment doesn't retain says
  `available: false`, not `count: 0`. A silently missing section reads exactly like a clean one.
- **Distinguish the causes that need different fixes.** "No model configured" / "wired but broken" /
  "over budget" are three status values, not one. Never infer a cause from the mere presence of an
  error.
- **Every cap records what it dropped**, and a cap that is NOT a plain prefix says so, because a
  reader who assumes a prefix would conclude the tail was never considered.
- **The model JUDGES; the platform COMPUTES.** A ranking, a score ratio, a regression count is
  derived in code from the model's stated judgements, never read off the reply.
- **A pass-through is the correct disposition for an unwired capability**, and it must be invisible
  to the domain: a gate with no provider, a judge with no assessor, an unset validation config are
  all byte-for-byte the prior behaviour.

## Untrusted text crossing a rendered surface

Model- and user-authored text reaches PR bodies, tracker comments and telemetry, and those are
parsed surfaces, not inert string sinks. The end-to-end trust-boundary model is
[`security-model.md`](./backend/docs/security-model.md); a change to the write path (token minting
or credential PRECEDENCE, the push, the merge decision, a rendered surface, the native-child env
allow-list) updates that doc in the same PR.

- **Kernel's `hostMarkdown` is the boundary.** The host auto-links `#123` / `@name` / `!123`, a
  **closing keyword before an issue reference CLOSES that issue on merge**, a raw newline ends a
  table row, and an unbalanced fence swallows whatever follows. Every hole goes through `cell`,
  `inline` or `prose`; a hole that is a link TARGET goes through `link`/`cellLink`.
- **Scrub with `redactSecrets` at COMPOSE time**, before any truncation, so prose and JSON stay
  consistent. A PR body is strictly more exposed than the telemetry DB.
- **Model-authored strings that become shell or git arguments are validated for MAGIC, not just
  traversal**: `--` stops a path being read as a revision but does nothing about `:(glob)**` or `*`.
  A refused input counts as an omission that is REPORTED, never a silent shortening.
- **Captured command output reaching a model is fenced through `fencedOutput`**, sized one tick
  longer than the longest backtick run in the body.
- **The harness carries byte-for-byte COPIES of a few kernel helpers** (`host-markdown.ts`,
  `normalizeProxyPhase`, `isSafeTestPath`) because the image can depend on no workspace package.
  Each is pinned by a conformity test: change one, change the other.

## Migrations

Node boots by running `migrate()` BEFORE `boss.start()`, so a migration failure is the clean
top-level rejection. Resolving CONFLICTING Drizzle migrations after a merge has its own non-obvious
recipe (`rebase-migration-snapshot.mjs`, never a `db:generate` rerun):
[`backend/runtimes/node/AGENTS.md`](./backend/runtimes/node/AGENTS.md).

- **Never hand-drop `public` alone.** The drizzle ledger lives in its own `drizzle` schema, so a
  hand `DROP SCHEMA public CASCADE` wipes the data while the ledger still claims everything is
  applied. Recovery is deliberate and destructive:
  `pnpm --filter @cat-factory/node-server db:reset` drops ALL app-owned schemas together so the
  ledger can never outlive the data.
- **Self-healing FK migrations (both runtimes).** A migration adding an `ON DELETE RESTRICT` FK must
  first delete or NULL pre-existing orphans, or it hard-fails with `23503`. Heal then constrain,
  mirrored in the Postgres `migration.sql` AND the D1 rebuild. Deleting orphaned experimental data
  is acceptable; swallowing the error is not.
- Test harnesses never touch the base `DATABASE_URL` DB: they require a per-vitest-worker database
  and use the `postgres` maintenance DB for the admin connection.

## Git-provider-agnostic (VCS) naming: never re-hardcode GitHub

The platform talks to multiple VCS providers (`github` + `gitlab`, extensible). Reintroducing
GitHub-specific names or a hard-coded `github.com` / `provider: 'github'` in a shared path silently
breaks GitLab deployments. Which layer owns what, and the accepted gaps:
[`vcs-providers.md`](./backend/docs/vcs-providers.md),
[`gitlab-parity.md`](./backend/docs/gitlab-parity.md).

- **Neutral identity vocabulary** (`kernel/src/domain/vcs-types.ts`): `VcsProvider`, `VcsRepoRef`,
  `VcsConnectionRef`. Persisted and wire types name fields `repoId` / `connectionId` / `provider`,
  NEVER `githubId` / `installationId`; GitHub maps on via `githubConnectionRef` /
  `githubInstallationId`, the only place the GitHub shape of those ids is known.
- **Never build a `https://github.com/...` URL yourself.** Provider is a deployment-level fact
  resolved through `ResolveRepoOrigin`: ride `this.deps.resolveRepoOrigin ?? githubRepoOrigin` and
  pass `origin.provider` to the harness `RepoSpec`; a new repo leg copies the primary's resolution.
- **GitLab is ADAPTED INTO the canonical client**, not bolted on beside it, so the GitHub-shaped
  service layer works unchanged. Don't hand-roll a second per-provider client, don't fork the
  `github` module, and don't add a second frontend repo store.
- **Where the SPA links is `webUrl`**, null meaning WITHHOLD the affordance, never a fallback to the
  public instance. Per-provider constants switch in ONE place (`app/utils/vcs.ts` plus the `vcs.*`
  i18n keys), extended per provider so a typecheck fails, never forked.
- The migration is incremental: kernel ports are neutralized, but entity types (`GitHubRepo`, the
  `github_repos`/`github_installations` tables) are still GitHub-named and reused as-is. Copy the
  NEUTRAL shape for new surfaces; an un-migrated neighbour is not license to name a field `githubId`.

## Public-API SDK clients: generated from the spec, never hand-edited

Six members under `sdk/` are the chain **contracts → `docs/openapi.json` → `sdk/*`** with no
hand-editing at any link: four clients (TypeScript, Python, Go, Java) and two projections,
`sdk/mcp` and `sdk/gatekeeper`. `pnpm check:sdk` fails CI on drift and version skew.
`sdk/gatekeeper-worker` is the ONE hand-written member, a library CONSUMING that table. Generation,
the smoketest and that exception: [`sdk/README.md`](./sdk/README.md).

- **Never edit a file whose header says GENERATED**; change the contracts or the emitter. Only
  models and operations are generated; each transport is hand-written beside them.
- **Adding a `/api/v1` endpoint means adding an entry to `scripts/sdk/surface.mjs`** naming its
  resource group and method. Generation FAILS without one, so a new endpoint cannot ship as an
  un-callable hole in four clients, and the same entry becomes an MCP tool with no second decision,
  except a STREAMING one, named in `MCP_OMITTED_OPERATIONS` with its reason. A scenario step added
  to one `sdk-smoketest` client must be added to all four.

## Harness rules

**Per-job state: NEVER a process- or HOME-global.** Anything the executor-harness stages for ONE job
is scoped to that job: explicit child env (`RunOptions.agentEnv`, which anything the harness spawns
itself must be passed explicitly) or a per-job directory. This is a correctness rule, not hygiene: a
global LOOKS per-job in a container, but the local native transport serves EVERY concurrent
`ambientAuth` job from ONE long-lived host process whose `HOME` is the developer's own, so container
tests keep passing while one job leaks into a sibling and files the developer owns are destroyed.
State with no per-job form is NOT WRITTEN AT ALL rather than written globally, and a new piece of it
earns a test that two concurrent jobs keep it separate. The table of what goes where:
[`executor-harness/README.md`](./backend/internal/executor-harness/README.md).

- **Any harness-spawned, activity-SILENT phase MUST feed the inactivity watchdog** on a 30s
  heartbeat: `JOB_INACTIVITY_MS` is tighter than a command's own watchdog, so without it a slow
  build or cold install aborts the run as "inactivity". A phase's own watchdog is DERIVED from the
  configured `JOB_MAX_DURATION_MS`, never a constant sized against today's default.
- **A source change here bumps the runner image**, which is why the harness is out of scope for the
  silent-catch guard and why anything duplicated from kernel is pinned by a conformity test.

## Custom agents (manifest-driven extension over `RepoFiles`)

A deployment ships its own agent kinds without forking and without rebuilding the harness image.
Governing principle: **zero `switch(agentKind)` in the container.** The harness is a generic
LLM-over-a-checkout runner and all deterministic work is backend TypeScript, staged as `preOps` →
`agent` → `postOps`. The BUILT-INS ride the same seam, every container kind being a
`registerAgentKind` entry declaring an `AgentStepSpec`, so add a kind the way a deployment would.
Full model: [`custom-agents.md`](./backend/docs/custom-agents.md); role
authoring: [`custom-agent-roles.md`](./backend/docs/custom-agent-roles.md); tool servers:
[`mcp-tool-servers.md`](./backend/docs/mcp-tool-servers.md); design record:
[ADR 0029](./backend/docs/adr/0029-agent-kind-capabilities.md).

- **A capability credential is declared BY NAME** and resolved through the kernel
  `ToolSecretResolver` port; the VALUE rides the job body only. Deadliest trap: **a credential has
  TWO names and only one of them is a boundary** (the LOOKUP key may never be a variable the
  platform reads; `envName` carries only the narrower toolchain rule). Full model:
  [ADR 0041](./backend/docs/adr/0041-capability-credential-store.md).
- **`allowedTools` is SCOPING, never a security boundary**, and claude-code's `--allowedTools` must
  ALWAYS carry the CLI's built-in tool names too (it is whole-session, not MCP-scoped). An `http`
  tool server must be `https` or loopback, refused at registration AND at the job boundary.
- **A capability that can't be honoured is STATED to the agent, never silently dropped.**
- **A per-workspace prompt override replaces the shipped TRACK prompt, never the whole system
  prompt**, and every prompt-assembly site must honour `AgentRunContext.systemPromptOverride`.
  Engine-enforced fragments survive only through `OVERRIDE_PRESERVED_FRAGMENTS`. Full model:
  [`agent-prompt-overrides.md`](./backend/docs/agent-prompt-overrides.md).

## Telemetry & agent-context observability

The four run-observability sinks live in a dedicated telemetry store, never the transactional one.
Authority for anything recording an LLM call:
[`llm-telemetry.md`](./backend/docs/llm-telemetry.md); the deployment-level projections and their
retention: [ADR 0048](./backend/docs/adr/0048-platform-operator-observability.md) and
[`storage-and-retention.md`](./backend/docs/storage-and-retention.md).

- **Three producers converge on the ONE `LlmObservabilityService` and a new one must too**: the
  proxy, the subscription harnesses, and inline calls through the kernel `InlineLlmCallRecorder`
  port. A model served by a harness CLI files its OWN calls and the middleware around it STANDS
  DOWN; two producers for one call would double every token in the rollup.
- **A new inline caller on the run path must build its scope with the run in it**, or its rows are
  IN the store and absent from every run-scoped read, which reads as a step that spent nothing.
- **State what a producer does NOT know rather than filling a field with a guess**, and fold over
  the ONE rollup rather than adding a query.
- **Bodies are double-gated** (`LLM_RECORD_PROMPTS` AND the per-workspace `storeAgentContext`) on
  every path that captures a model body, external trace fan-out included; a read that throws fails
  closed.

## Board / service / repo linkage

- **A Block carries no repo fields**, and **there is deliberately NO "first repo" fallback.**
  Repo-to-block linkage lives in the `github_repos` projection via its `block_id` column, and
  execution resolves the repo at runtime through `resolveRepoTarget(workspaceId, blockId)`, which
  walks the block's ancestry to the enclosing service frame and reads that frame's
  `Service.repoGithubId`: the SOLE linkage, and the only one carrying a monorepo `directory`. An
  unlinked chain THROWS a `ValidationError`, because guessing once pushed a simple-service task into
  someone else's repo. A workspace has exactly ONE VCS installation but may have MANY repos.
- **A step's prompt names the service the work belongs to**: `AgentRunContext.ownService`, derived
  from that same ancestry walk (kernel's `describeOwnService`). It is a DISCRIMINATED result, not a
  nullable one, and "not under a service" is RENDERED rather than omitted: a bare task title names no
  software, so a silent omission reads like a task whose product is obvious and the model supplies
  one.
- **Layout is not a Block field either.** A service frame's POSITION lives on its `WorkspaceMount`
  (one shared service sits at a different spot on every board that mounts it), so **every
  frame-returning read projects through kernel's `applyMountLayout`**, snapshot and single-block
  mutation response alike; skipping it is silent, and the frame JUMPS to coordinates no board shows
  it at. A TASK carries no position at all: it is laid out in a status SWIMLANE, so a drag only
  REPARENTS. [Doc](./frontend/app/README.md#task-swimlanes).

## Frontend

The SPA's own authoring guides (component layers, stores, real-time coherence, i18n mechanics) are
[`frontend/app/README.md`](./frontend/app/README.md). What binds from outside it:

### Internationalization (i18n)

- **All user-facing copy goes through `@nuxtjs/i18n`; never hard-code a display string.** **The
  backend does not localize prose**: a localizable condition emits a machine-readable
  `error.details.reason`/`code` that the SPA maps to a frontend key, with the wire vocabulary in
  `@cat-factory/contracts` so both sides import the SAME source of truth. **Every failure toast goes
  through the ONE funnel** (`usePipelineErrorToast().present(error, titleKey)`), never a hand-built
  `toast.add({ description: err.message })`: raw prose is DETAIL behind a disclosure, and the funnel
  is what makes a failure translated, non-auto-dismissing, and copyable WITH the `requestId`.
- **Never ship an English string as a non-`en` value.** Locale parity is CI-gated per change
  (`i18n-locale-parity.mjs`) but checks only that the key EXISTS, so a verbatim English copy passes
  and is a bug. If you genuinely cannot produce a translation, say so in the PR.
- Migration is incremental: when you touch a component, lift its visible copy into the catalog.

### The two narrowings, and the extension registry

- **A new user-facing surface decides BOTH narrowings, and neither answer is "ignore this"**: the
  interface TIER (`basic` vs `advanced`: does the everyday delivery loop need it?) and the ROLE
  (does the opt-in `intake` persona, which never configures the platform, need it?). **HIDE, never
  disable, and only ever hide an OVERRIDE**, so what remains is exactly the default the hidden field
  would have shown: gate override controls on `showOverrideField(isAdvanced, ...values)`, not on
  `isAdvanced` alone, because an EXISTING entity can already carry an override. **Never mark the way
  BACK as `advanced`, nor hide it from a narrowed role**: neither axis is AUTHORIZATION (workspace
  RBAC is, server-side). Agent tiers (`presentation.tier`) are a THIRD, separate axis.
- **Frontend extension seams are all contributed through the one `registerAppModule` registry**
  (`app/modular/registry.ts`), the frontend analogue of the backend registries: result views,
  inspector panels, overlays. Placement rules:
  [`frontend-extension-mechanism.md`](./docs/initiatives/frontend-extension-mechanism.md); adoption:
  [ADR 0049](./backend/docs/adr/0049-modular-vue-adoption.md).

## Workspace RBAC enforcement

Per-workspace authorization ([ADR 0025](./backend/docs/adr/0025-workspace-rbac.md)) is enforced in
exactly three shared places, never re-derived per controller: `mountAuthGate` (resolution plus the
404 hide on every `/workspaces/:ws/*` request), the viewer write floor inside it (any non-GET/HEAD
requires `≥ member`, so a member-tier write mounts NO gate of its own), and
`mountWorkspacePermission(app, perm, prefixes)` on each admin controller's own top-level paths.

**It takes PREFIXES, never `'*'`; no gate factory is exported, so the wildcard is unrepresentable.**
`app.route(prefix, sub)` re-registers a sub-app's `use('*')` as `ALL <prefix>/*`, which Hono runs for
every route registered AFTER it, so each admin gate silently refused the siblings mounted later. A
NEW admin controller joins `WORKSPACE_CONTROLLERS`, gates its own prefixes, and gains a `member 403`
case in `defineWorkspaceRbacSuite`.
