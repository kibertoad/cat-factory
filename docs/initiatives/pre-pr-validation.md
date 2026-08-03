# Initiative: Pre-PR validation checks

Tracker for **pre-PR validation**: per-service check commands the executor-harness runs
against the checkout after the coding agent settles and **before** the PR opens, feeding
failures back into the agent loop under an attempt budget.

## Goal & rationale

Today the first machine verification of a coder run happens **after** the PR exists: the
harness opens the PR, the `ci` gate polls real check runs, and `ci-fixer` attempts follow.
That ordering has three costs:

- broken lint/tests/build become **public PR churn** and burn provider CI minutes;
- the run records the agent's _assertion_ that it verified its work, never command output;
- the feedback loop is slow (dispatch → poll → dispatch) for failures a 30-second `pnpm lint`
  would have caught in the checkout the agent still has open.

End state: a service declares validation commands; a coder run runs them in the checkout,
iterates the agent against the captured failure output, and opens a PR **only** once they
pass. Budget exhausted ⇒ the step fails with the captured output: nothing pretends success.

## Decisions

### D1: Config source: the per-service table only (repo manifest deferred)

**Decision: a per-block config table (`validation_configs`, D1 ⇄ Drizzle), keyed by the
service frame and resolved up the frame chain; the `test_secrets` / `release_health_configs`
shape. A checked-in repo manifest is deliberately NOT in v1.**

Evaluated and rejected for now:

- A manifest (`.cat-factory/validation.json`) would have to be read at **dispatch** time, which
  means an extra `RepoFiles` round-trip per coder dispatch on every run: including the vast
  majority with no manifest, where the read is pure latency for a 404.
- Precedence is a real design question (manifest overrides table? merges? table wins for
  operator control?) that is better answered once operators have used the table and told us
  which way they want it. Guessing now bakes a wrong default into the wire contract.
- The table is the surface the inspector already knows how to render, so v1 ships a complete
  UX with one config home rather than two half-explained ones.

The resolution is deliberately funnelled through **one** seam
(`ValidationConfigService.resolveForFrame`), so adding a manifest source later is a change
inside that method plus a precedence rule, not a new path through the executor.

### D2: Scope: the PR-opening coding flow, keyed off job data (not the kind)

**Decision: the loop runs where a coding job would OPEN a PR (`job.pr` set) and carries
`validationChecks`. In practice that is the `build`-phase Coder. `ci-fixer` and
`conflict-resolver` are NOT in scope.**

Rationale: the feature's whole value is _pre_-PR. `ci-fixer` and `conflict-resolver` push onto
an **existing** PR head, where the `ci` gate is already the verification loop: adding a second,
weaker in-container loop there would duplicate the gate and slow every fix round. Keying the
harness off `job.pr` + `job.validationChecks` (both job DATA) rather than the agent kind also
satisfies the "zero `switch(agentKind)` in the harness" rule for free: the backend decides which
dispatches resolve checks, the harness only sees a body that has them or doesn't.

Follow-up if wanted: extend the backend's resolution to the fixer kinds (a one-line change to
the job-body condition); the harness needs nothing.

### D3: Attempt budget: on the config record, default 3

**Decision: `maxAttempts` lives on the per-service `validation_configs` row (default 3,
clamped 1..10), not on the merge threshold preset.**

The brief suggested "a preset knob shaped like `ciMaxAttempts`". Same _shape_ (a bounded
attempt budget), different _home_, deliberately:

- The budget is inherently coupled to the commands it bounds: a service whose validation is
  `pnpm lint` tolerates far more attempts than one whose validation is a 12-minute build. That
  coupling is per-service, exactly like the commands.
- It is resolved in the **same read** as the commands. Putting it on the merge preset would
  mean a second resolution path (preset resolution) threaded into the dispatch context purely
  for one integer, and would split one operator decision across two unrelated config screens.
- It needs no migration on `merge_threshold_presets` on both runtimes.

`ciMaxAttempts` stays what it is: the budget for the post-PR CI gate.

### D4: Output budget

- The harness captures each command's combined stdout+stderr, keeping the **last
  `MAX_CAPTURED_OUTPUT_CHARS` (16k)**: the existing constant, the same treatment as the local
  post-mortem tail and the ralph validation tail.
- Every captured tail goes through `redactSecrets` before it leaves the command runner.
- What crosses the wire onto the step is bounded again: **`VALIDATION_REPORT_TAIL_CHARS` = 4k
  per command outcome**, and only the **latest attempt's** outcomes are reported (plus a count
  of the attempts that preceded it). The agent-feedback prompt uses the full 16k tail; the
  persisted report uses the 4k one, so a chatty build can't inflate the run's `detail` blob.
- A passing command's output is kept too (truncated the same way): the acceptance criteria
  ask for the passing output to be captured on the step.

### D5: Watchdog

Each command gets its own watchdog (`VALIDATION_COMMAND_TIMEOUT_MS`, default 15 min: the same
default the ralph validation command uses), so one hung `pnpm test` cannot wedge a run. A
timeout is a FAILURE (exit 124), fed back like any other.

### D6: Autodetection: a read-only SUGGESTION derived from the repo, never a write

**Decision: a "Detect" button in the inspector calls
`GET /services/:blockId/validation-checks/detect`, which reads the repo root through the
existing `resolveRunRepoContext` seam and returns suggested `{ label, command }` pairs. It
persists NOTHING; the operator reviews the rows and saves them through the same `PUT`.**

The config table (D1) is the right home for the commands, but it starts EMPTY, and an operator
staring at an empty panel has to remember their repo's package manager, its script names and
the incantation for a reproducible install. Almost all of that is written down in the repo
already.

Three constraints shaped it:

- **It suggests, it does not configure.** A detector that wrote the config would be a silent
  behaviour change on the next run: a service that verified nothing would suddenly start
  failing PRs on a command nobody chose. Keeping it in the panel's UNSAVED rows means the
  button is always reversible by walking away, and the merge never rewrites a command the
  operator hand-tuned (`mergeDetectedChecks`, deduplicated by command).
- **Prefer the repo's own evidence; gate opinionated checks on their config.** A command is
  suggested when the repo DECLARES it (an npm script, a Make target) or when it is the
  ecosystem's canonical, non-opinionated verification (`go test ./...`, `mvn verify`). A
  formatter check or a `-D warnings` linter is suggested only when its config file is checked
  in: suggesting `cargo fmt --check` to a repo that never ran rustfmt produces a check that
  is red on its first run for a reason the coding agent did not cause and cannot legitimately
  fix.
- **Degradation is stated.** "No repo linked", "the repo could not be read" and "we read it and
  recognised nothing" are three different `status` values, because they send an operator to
  three different places. Collapsing them into an empty list would tell someone whose token
  had been revoked that their repo is unrecognised.

Where the pieces live: the rules are PURE and in kernel (`domain/validation-detection.ts`
composes, `domain/validation-detectors.ts` holds one function per ecosystem), so every rule is
unit-testable against a literal. Reading the surface is `detectValidationChecksFromRepo`
(integrations), shaped as ONE root listing plus one file read per manifest the listing PROVED
exists, never a speculative probe per candidate path, which would be a dozen 404s on every
repo behind an interactive button. Because it reads through the checkout-free `RepoFiles` port
it is runtime-symmetric by construction; conformance asserts the wiring and the no-repo status
on both runtimes.

Covered today: node (pnpm/yarn/bun/npm), python (uv/poetry/pdm/pipenv/pip + ruff/black/mypy/
pyright/pytest/tox), go, rust, maven, gradle, dotnet, ruby, php, elixir, plus make/just/task as
a FALLBACK tier; consulted only when no language ecosystem matched, since `make test` in a Go
repo almost always shells out to the command the Go detector already suggested.

## Target pattern

- **Config**: `validation_configs` table (workspace_id, block_id) ⇒ `ValidationConfigRepository`
  (kernel port) ⇒ `ValidationConfigService` (integrations; CRUD frame-only + `resolveForFrame`
  frame-chain walk) ⇒ `ValidationConfigController` (server) ⇒ `ServiceValidationConfig.vue`
  inspector panel.
- **Threading**: `resolveValidationChecks` (optional `AgentContextBuilder` dep, the
  `resolveTestSecretRefs` shape) ⇒ `AgentRunContext.validationChecks` ⇒ the coding job body's
  `validationChecks` field (only when the body opens a PR) ⇒ harness.
- **Harness**: `validation-checks.ts`; generic, keyed off the body. `runValidationLoop` sits
  BETWEEN the agent run and the finalize/push/PR step in `runCodingAgent`.
- **Result**: `RunnerJobView.validationReport` (live, per attempt) + `RunnerJobResult.validationReport`
  (terminal) ⇒ `AgentRunResult.validationReport` ⇒ `PipelineStep.validation`.

## Status (v1: complete)

| Area                                                                  | Status | Notes                                  |
| --------------------------------------------------------------------- | ------ | -------------------------------------- |
| Contracts (`validation-checks.ts`, routes, `step.validation`)         | done   | rides `detail`; no execution migration |
| Kernel port + `AgentRunContext.validationChecks` + runner result/view | done   | `ports/validation-repositories.ts`     |
| `ValidationConfigService` (CRUD + frame-chain resolve)                | done   | `integrations/modules/validation`      |
| Server controller + job-body threading + result forwarding            | done   | gated on `opensPr`                     |
| Harness: generic check runner + repair loop + PR gate + image bump    | done   | version 1.55.0, 3 pins synced          |
| Engine: record `step.validation`, failure detail on exhaustion        | done   | `orchestration`                        |
| Persistence: D1 migration + Drizzle schema/migration + both repos     | done   | runtime-symmetric                      |
| Frontend (panel, store, result surfacing, i18n ×10, testids)          | done   | `@cat-factory/app`                     |
| Conformance (config resolution + job-body threading) + unit tests     | done   | both runtimes                          |
| Autodetection (kernel rules, repo reader, detect route, panel button) | done   | see D6; suggestion only, no write      |

## Conventions & gotchas carried forward

- **Per-job state**: the check runner takes `RunOptions.agentEnv` and a per-job cwd; it never
  reads or writes `process.env` or `HOME`. `validation-checks.concurrency.test.ts` runs two
  concurrent jobs with different configs and asserts no leakage; the container path alone would
  not catch a native-transport regression.
- **The report must be FINAL when published.** The live `RunnerJobView.validationReport` is
  drained per poll like `spans`/`followUps`; the terminal result repeats the last one. Do not
  mutate an already-published attempt.
- **A no-op run skips the loop** (`producedWork` in `coding-agent.ts`). If the agent changed
  nothing there is nothing to validate, and the run's real failure is "no file changes": blaming
  it for a red BASE branch would be wrong and would burn the whole repair budget re-running an
  agent that already declined to act.
- **A config-store read failure DEGRADES, it does not fail the run.**
  `AgentContextBuilder.validationChecksFor` swallows a resolver throw and falls back to "no
  checks": the unconfigured behaviour. A mothership node whose server doesn't reflect
  `validationConfigRepository` (an older image), or a transient store outage, would otherwise
  fail EVERY coding dispatch. The trade is deliberate: a store outage degrades to the pre-feature
  guarantee rather than stopping all builds.
- **Unconfigured is byte-for-byte the old behaviour**: no row ⇒ no `validationChecks` on the
  context ⇒ no field on the job body ⇒ the harness's existing code path, untouched.

## Follow-ups (deliberately out of v1)

- **Repo manifest source / override** (see D1): the resolution seam is ready for it.
- **Multi-repo runs**: the checks run in the PRIMARY checkout only; a peer-repo fan-out gets no
  validation (it also opens a PR per repo). Mirrors the ralph v1 boundary.
- **`ci-fixer` / `conflict-resolver` coverage** (see D2).
- **Workspace-level default checks** (so a new service inherits the org's lint/test commands).
- **Autodetection below the repo root** (D6 reads the root only, so a monorepo service whose
  manifest sits in `packages/x/` is unrecognised). The checks themselves already run at the
  checkout root, so this waits on a per-service directory concept rather than on the detector.
- **Reusing the report as the PR verification report** (the separate initiative): the captured
  outcomes are already shaped for it.
- **Playwright e2e spec**: covered by conformance + unit tests for v1.

When these are picked up (or explicitly dropped), convert this tracker into a numbered ADR
under `backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
