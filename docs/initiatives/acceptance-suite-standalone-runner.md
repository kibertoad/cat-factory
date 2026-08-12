# Initiative: a standalone runner for the acceptance suite

Tracker for **removing vitest from the acceptance specs** (`backend/internal/acceptance/acceptance/`)
and running them from a plain Node entrypoint instead. The package's own unit tests stay on vitest;
only the five live-deployment specs move.

## Goal & rationale

The acceptance suite uses vitest as a shell while switching off almost everything vitest does, and
pays for the parts it cannot switch off in workarounds that are now among the most complicated code in
the package.

**What the specs actually use.** Across 792 lines of spec, exactly six vitest APIs appear: `describe`,
`it`, `beforeAll`, `expect` (18 calls), and `inject` (2). No `vi.`, no mocking, no `afterAll`, no
`test()`. Nothing is faked here by design, so the mocking half of the framework is dead weight.

**What the config switches off**, each with a comment in `vitest.acceptance.config.ts` explaining why
the default is wrong for this suite:

| Feature          | Setting                                   | Why                                                       |
| ---------------- | ----------------------------------------- | --------------------------------------------------------- |
| test timeouts    | `testTimeout: 0`, `hookTimeout: 0`        | no honest number for an hour-long real run                |
| file parallelism | `fileParallelism: false`, `maxWorkers: 1` | one narrative, one repository, one workspace, one cluster |
| file sequencing  | a custom sequencer                        | see D4                                                    |

**What it cannot switch off, and what that costs.** Vitest forks workers and gives every spec file its
own module graph, so:

- The pass's RUN ID cannot be minted per file (five files would open five ledgers). It is settled in
  `acceptance/globalSetup.ts` and handed over vitest's RPC channel via `provide`/`inject`.
- The operator's personal password cannot be asked lazily (a pass would be asked four times, each
  prompt drawn over by the reporter). It is asked in `globalSetup` and injected the same way.
- A worker is forked with PIPED stdio, so `stdin.isTTY` is undefined there and the prompt cannot use
  stdin at all. It opens the CONTROLLING TERMINAL (`/dev/tty`, `CONIN$` on Windows) for reading and
  writes the prompt back down it. On Windows that handle must be opened READ-WRITE, because turning
  echo off is `SetConsoleMode`, which writes. Roughly ten README bullets document this.
- The reporter owns the workers' stdout, so anything printed from a spec competes with it. The
  journal + `status` CLI exist partly because vitest's reporter cannot answer "where is this pass".

The last point is the one that decides this. **The suite has already rebuilt the parts of a test
framework it needed**: its own progress record (`journal.ts`), its own reporting (`status.ts`,
`statusCli.ts`), its own per-wait deadlines with observations (`deadline.ts`), its own all-at-once
refusal gate (`preflight.ts`), its own resume. What vitest still supplies is `describe`/`it`
structure, 18 assertions, and a mechanism (`provide`/`inject`) that exists only to undo vitest's own
isolation.

End state: `pnpm --filter @cat-factory/acceptance run acceptance` invokes a Node script that runs the
five scenarios in order in ONE process, with the run id and password as ordinary values, prompts on
ordinary stdin, and a summary it prints itself.

## Decisions

### D1: A plain Node entrypoint, not a different test framework

**Decision: `node --experimental-strip-types src/runAcceptance.ts`, the shape the package's three
other CLIs (`configureCli.ts`, `statusCli.ts`, `resetCli.ts`) already use.**

Swapping vitest for another runner (node:test, tinytest, ava) was considered and rejected: every one
of them brings the same two assumptions that do not hold here (isolation between files, a timeout per
test) and would re-import a subset of the same workarounds. The thing this suite needs is not a
different framework but no framework: a sequential script with a ledger.

### D2: `node:assert/strict` for the 18 assertions

**Decision: `node:assert/strict`, no assertion library.**

The specs assert on values `evidence.ts` has already reduced (`reproduction.verdict`,
`environments.proof`, `ci.verdict`, `merge.outcome`), which is rule 1 of the suite: assert on evidence
the platform COMPUTED. Those are equality checks on small values, which `assert.deepEqual` covers. If
a case wants better failure output, it belongs in `evidence.ts` as a reduction with its own unit test,
where it is checked on every CI run rather than only during an afternoon pass.

### D3: What must survive unchanged

Non-negotiable, because each is a property somebody debugged into existence:

- **The ledger**, and resume. It is not a vitest workaround: it survives across INVOCATIONS, which no
  runner gives you. Facts moving in-process does not remove the need to write them down.
- **`bail`-equivalent semantics.** Stop at the first failing scenario. The narrative is sequential, so
  the second failure is the first one's shadow, and stopping keeps the ledger pointing at what broke.
- **Rule 0**: the whole prerequisite gate runs before each scenario, not only the first, so a resumed
  pass cannot skip it.
- **Rule 3**: every wait carries its own deadline and reports its last observation. No global timeout
  is introduced by the new runner, in any form.
- **A non-zero exit code on failure**, and the failure text an operator currently reads.

### D4: This deletes `src/specOrder.ts`

[PR #1978](https://github.com/kibertoad/cat-factory/pull/1978) added a sequencer pinning the specs to
file-name order, because vitest's default reorders from a results cache (previously-failed first, then
longest-duration first) and, paired with `bail: 1`, ran the LAST spec first and stopped the pass before
the spec that populates the ledger had started.

**That module is expected to be deleted by this initiative, and that is not waste.** It is the fix for
a live bug, it landed in a day, and ordering becomes a property of a `for` loop once there is no
sequencer to configure. Recorded here so the deletion reads as intended rather than as a regression.

### D5: The package's unit tests stay on vitest

`vitest.config.ts` collects 23 files / 458 tests under `test/`, which are ordinary fast unit tests
with mocks and CI runs them. Nothing about them is served by this change. Only
`vitest.acceptance.config.ts` and the five files under `acceptance/` are in scope, and the split
between the two configs is what makes that separable.

## Target pattern

- `src/runAcceptance.ts`: the entrypoint. Resolves the config, settles the run id, asks for the
  password once, then runs the scenarios in order, stopping at the first failure. Owns the exit code,
  as the other three CLIs do.
- `src/scenarios/*.ts`: the five scenarios, each an exported `async function` taking the harness the
  current `fixtures.ts` builds. `describe`/`it` become the scenario's name and a small number of
  named steps the runner prints and the journal already records.
- `src/scenarioRunner.ts`: the sequential driver and the summary. Pure over a list of scenarios and
  a reporter seam, so it is unit-testable with no deployment (the shape `reset.ts` uses).
- Deleted: `acceptance/globalSetup.ts`, `src/specOrder.ts`, `vitest.acceptance.config.ts`, the
  `inject` calls, and the `ProvidedContext` declaration.

## Status

Nothing is built. This tracker lands ahead of the work.

| Area                                                                | Status      | Notes                                       |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------- |
| Tracker                                                             | done        | this document                               |
| `scenarioRunner.ts` + unit tests (ordering, bail, exit code)        | not started |                                             |
| `runAcceptance.ts` entrypoint, run id + password settled in-process | not started | replaces `globalSetup.ts`                   |
| Convert the five specs to scenarios                                 | not started | 792 lines; `expect` ⇒ `node:assert/strict`  |
| Simplify the password prompt to ordinary stdin                      | not started | see the gotcha below: verify, do not assume |
| Delete `specOrder.ts`, the vitest acceptance config, `inject`       | not started | D4                                          |
| README rewrite (the console section largely disappears)             | not started |                                             |

## Conventions & gotchas carried forward

- **Verify the stdin simplification rather than assuming it.** In one process launched from a shell,
  `process.stdin` should be a real TTY and the whole `/dev/tty` / `CONIN$` apparatus should collapse to
  a normal prompt. But `pnpm run` sits between the shell and the script, and the Windows read-write
  console handle rule (`setRawMode` answering `EPERM` on a read-only handle) was found the hard way. Keep
  `personalUnlock.ts`'s fallbacks until a real Windows run proves them unnecessary, and keep its unit
  tests either way.
- **The refusal to run without a console is a FEATURE**, not an artefact of vitest: a pass that cannot
  ask for a personal-subscription password must refuse at the first dispatch naming the two ways out,
  and a headless caller (CI, cron, a detached agent shell) must still hit it.
- **`beforeAll` per file becomes one call per scenario**, and it must stay per scenario. The gate runs in
  every spec on purpose (rule 0), so hoisting it to "once at startup" would reintroduce exactly the hole
  the current shape closes for resumed passes.
- **The journal is the reporting contract**, not the console. Whatever the new runner prints, `status`
  must keep answering from the journal alone, because the question is asked from another window.
- **Do not introduce a timeout.** The most likely accidental regression is a well-meaning per-scenario
  deadline in the new runner. `deadline.ts` owns every wait, and a stall must be reported as "step
  `coder` was still working, 4/9 subtasks", never as an anonymous expiry.
- **`bail` is the default, not an option.** Running the remaining scenarios after a failure wastes real
  model spend on runs whose input never got created.

## Follow-ups (deliberately out of scope)

- Any change to what the scenarios ASSERT. This is a runner swap; a converted scenario that changes a
  claim is a bug in the conversion.
- The unit tests under `test/` (D5).
- `acceptance:watch`, which disappears with the vitest config. Nothing is known to use it for a suite
  whose runs take an afternoon; if somebody does, it comes back as a follow-up rather than a blocker.
