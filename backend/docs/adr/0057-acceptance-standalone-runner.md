# ADR 0057: A standalone runner for the acceptance suite

- **Status:** Accepted (implemented)
- **Date:** 2026-08-12
- **Context layer:** `@cat-factory/acceptance` only. No product code, no other package.

Supersedes the `acceptance-suite-standalone-runner` initiative tracker, whose committed scope is now
complete. What the suite IS, and how to run one:
[`backend/internal/acceptance/README.md`](../../internal/acceptance/README.md). The operator setup it
builds on is [ADR 0056](./0056-acceptance-suite-operator-setup.md).

## Context

The five live-deployment acceptance specs used vitest as a shell while switching off almost
everything vitest does, and paid for the parts it could not switch off in workarounds that had become
among the most complicated code in the package.

**What the specs actually used.** Across 792 lines of spec, four vitest APIs appeared: `describe`
(5 calls), `it` (16, two of them `it.each`), `beforeAll` (5) and `expect` (18). No `vi.`, no
mocking, no `afterAll`, no bare `test()`. Nothing is faked in this suite by design, so the mocking
half of the framework was dead weight. A fifth API, `inject` (2 calls), appeared nowhere in a spec:
it lived in the shared `acceptance/fixtures.ts`, where it existed only to undo vitest's own file
isolation, which is the next section.

**What the config switched off**, each with a comment explaining why the default was wrong here: the
test and hook timeouts (`0`, because there is no honest number for an hour-long real run), file
parallelism (one narrative, one repository, one workspace, one cluster), and the file sequencer (a
custom one, pinning the specs to file-name order).

**What it could not switch off, and what that cost.** Vitest forks workers and gives every spec file
its own module graph, so:

- The pass's RUN ID could not be minted per file (five files would open five ledgers, and the id is
  the ledger's key). It was settled in a `globalSetup` hook and handed over vitest's `provide` /
  `inject` RPC channel.
- The operator's personal password could not be asked lazily (a pass would be asked once per file
  that starts or answers a run, four times, each prompt drawn over a reporter redrawing the same
  lines). It was asked in the same hook and injected the same way, which also forced the suite to
  have one function that handed a password back as a value rather than sealing it in a closure.
- A worker is forked with PIPED stdio, so `stdin.isTTY` is undefined there and the prompt could not
  use stdin at all: it opens the CONTROLLING TERMINAL (`/dev/tty`, `CONIN$` on Windows) instead.
- The reporter owned the workers' stdout, so anything printed from a spec competed with it.

The last point is what decided this. **The suite had already rebuilt the parts of a test framework it
needed**: its own progress record (`journal.ts`), its own reporting (`status.ts`), its own per-wait
deadlines with observations (`deadline.ts`), its own all-at-once refusal gate (`preflight.ts`), its own
resume. What vitest still supplied was `describe`/`it` structure, 18 assertions, and a mechanism that
existed only to undo vitest's own isolation.

## Decision

**`pnpm --filter @cat-factory/acceptance run acceptance` is `node src/runAcceptance.ts`**: the five
scenarios in order, in ONE process, with the run id and the password as ordinary values, and a summary
the suite prints itself. It is the shape the package's three other CLIs (`configureCli.ts`,
`statusCli.ts`, `resetCli.ts`) already had.

1. **A plain Node entry point, not a different test framework.** node:test, tinytest and ava were
   considered and rejected: each brings the same two assumptions that do not hold here (isolation
   between files, a timeout per test) and would re-import a subset of the same workarounds. What this
   suite needs is not a different framework but no framework: a sequential script with a ledger.
2. **`node:assert/strict` for the assertions**, no assertion library. The scenarios assert on values
   `evidence.ts` has already reduced (`reproduction.verdict`, `environments.proof`, `ci.verdict`,
   `merge.outcome`), which is rule 1 of the suite; those are equality checks on small values. A case
   wanting better failure output belongs in `evidence.ts` as a reduction with its own unit test, where
   it is checked on every CI run rather than only during an afternoon pass.
3. **`src/scenarioRunner.ts` owns the four properties the framework used to**, and each is pinned by
   a unit test: ORDER (the array in `src/scenarios/index.ts`), BAIL (stop at the first failure; what
   follows reports as `not run`, never as passed), the PREREQUISITE GATE before every scenario that
   declares itself `gated`, and NO TIMEOUT in any form. It is pure over a seams object, so the whole
   driver is testable with no deployment. Order takes TWO tests and needs both:
   `test/scenarioRunner.test.ts` pins that the loop walks the array it is handed, over synthetic
   scenarios, and `test/scenarios.test.ts` pins the REAL array (each id's numeric prefix against its
   position, and that the preflight report is the one ungated scenario) as a relation rather than a
   copy, so adding a sixth scenario in the right place passes and adding it in the wrong one fails.
4. **Type stripping is Node's own.** The entry points target modern Node and carry no
   `--experimental-strip-types`; the package declares `engines.node >= 24`, which is now the whole
   repository's floor (root `package.json`) as well as the version documented for the generated
   project and the Node deployment. Nothing checks the version at runtime, deliberately: below 24 a
   `.ts` entry point does not load at all, so the check would have to be a JavaScript shim in front
   of every command, and Node 24+ is a supported-platform statement rather than a condition to
   degrade around. It is stated in the README's prerequisites instead.
5. **The package's unit tests stay on vitest.** `vitest.config.ts` collects `test/**/*.test.ts`,
   ordinary fast unit tests with mocks, and CI runs them. Nothing about them is served by this change.
   The include is deliberately narrow rather than counted: `src/` outside it is what keeps the
   scenarios (real spend, a real cluster) out of every CI lane.

**What had to survive unchanged**, because each is a property somebody debugged into existence: the
ledger and resume (it survives across INVOCATIONS, which no runner gives you); bail semantics; rule 0
(the whole prerequisite gate runs before each scenario, so a resumed pass cannot skip it); rule 3
(every wait carries its own deadline and reports its last observation); a non-zero exit code, and the
failure text an operator reads.

## Rationale

**The gate is run by the DRIVER, off a required `gated` flag on each scenario**, rather than as each
scenario's own first line. A scenario added without it would spend an afternoon against an unwired
deployment, and a required field means a new one cannot be written without answering the question.
Exactly one scenario answers `false`: the preflight REPORT, which is the same gate rendered one named
claim at a time and would otherwise be refused before it could say which prerequisite is red.

**The gate is re-evaluated per scenario rather than memoised.** Under vitest it was memoised per
module graph, and a module graph was one spec file, so it really did run once per scenario; a
module-level memo in one process would have quietly turned that into once per pass. Beyond rule 0,
this is what refuses a pass whose workspace went over budget during the feature runs before the next
scenario spends.

**The one exception is a hand-off, not a memo** (`createPrerequisiteGate`). The `00-preflight`
scenario evaluates every prerequisite to render them as named claims, and `01-adopt-and-scaffold`'s
gate then re-evaluated the identical set seconds later: ~14 duplicate round trips, every verdict
line printed to the operator twice, and two copies of each `prerequisite` entry in the journal
`status` reduces. So that evaluation is offered to the NEXT `assert` and consumed by it exactly
once, whatever happens after. It is bounded by construction rather than by a TTL, because the gate
after the first is separated from it by a scenario that spent an afternoon, which is precisely the
one that must not reuse anything.

**The password is still asked UP FRONT**, even though one process could hold a lazily-collected answer
for the whole pass. The reason changed rather than disappearing: a person is at the terminal when a
pass starts and by design not twenty minutes in, when the first dispatch would discover the model
needs one. The ask now goes THROUGH the holder (`unlock.obtain`), which deleted the one function that
handed a password back as a value.

**The controlling-terminal prompt is KEPT.** Its justification was vitest's piped worker stdio, and
the layer that decides this process's stdio is still there: `pnpm --filter … run` sits between the
shell and the script, and a `| tee pass.log` sits outside both. The tracker's instruction was to
verify rather than assume, and the honest verification (a real interactive Windows pass) is not
something this change performed, so the fallbacks and their unit tests stay.

**Two failure describers, not one.** kernel caps chain text at 400 characters for a human reader and
4,000 for a log field. A refusal printed WHOLE to this suite's console is a third reader: a preflight
naming fourteen prerequisites with their numbered remedies runs to thousands of characters, and cut at
400 an operator gets the first two and no fix for either, under a message that reads like the whole
refusal. `describeFailure` is that reader's describer; `describeThrown` stays for a failure
interpolated into a sentence.

**This deleted `src/specOrder.ts`, and that is not waste.** That module (added days earlier) pinned the
specs to file-name order because vitest's default sequencer reorders from a results cache and, paired
with `bail: 1`, ran the LAST spec first and stopped the pass before the spec that populates the ledger
had started. It was the fix for a live bug, it landed in a day, and ordering becomes a property of a
`for` loop once there is no sequencer to configure.

## Consequences

- **The suite prints its own report**: the run id and resume command, each scenario's steps as they
  start with how long each took, the failure in full, then a summary naming which scenario broke, at
  which step, and that the ones after it did not run. Exit 1 for a failed scenario, 2 for a pass that
  refused to start (nothing created, nothing spent).
- **`journal.ts`'s declared `failure` event kind is now written**, which nothing did before, so
  `status` from another window reports what a pass died of rather than only where it was.
- **A failed pass's closing words depend on whether it created anything**, read off the ledger through
  the same `recordsFacts` rule `status` and the `latest` pointer follow. The commonest failure is a
  prerequisite refusing a FRESH attempt, and offering that operator a resume (or telling them their
  run is still there to inspect) is a lie about state that does not exist.
- **`acceptance:watch` is gone** with the vitest config. Nothing is known to have used it for a suite
  whose runs take an afternoon; if somebody did, it comes back as a follow-up.
- **The vocabulary changed**: these are SCENARIOS, not specs, since no file is a spec to any runner any
  more. The ids (`02-feature-with-defect`) are unchanged, and they are still what the journal files
  observations under.
- **Nothing about what the scenarios ASSERT changed.** A converted scenario that changed a claim would
  be a bug in the conversion; the 18 `expect` calls became the same claims in `node:assert/strict`,
  several of them gaining the failure message they had no room for before.
