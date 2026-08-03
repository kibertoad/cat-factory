# Initiative: bugfix reproduction proof

Tracker for **machine-captured reproduction proof** on a bugfix run: evidence that a
reproducing check was **RED on the pre-fix tree and GREEN on the final tree**, published on the
run's PR, or, when reproduction is genuinely infeasible, an explicit machine-readable
declaration of that with the agent's stated alternative verification.

This is slice **10** of the PR-verification-report Phase 2 backlog
([`pr-verification-report.md`](./pr-verification-report.md)), whose own notes already point
here: _"Slice 10 pairs naturally with the existing `repro-test` agent kind (bug-triage phase G),
whose `{ outcome, testPaths, notes }` assessment already names the reproduction tests; the
missing half is the before/after evidence."_ Keep both trackers' rows in sync.

## Goal & rationale

The verification report cat-factory maintains on a run's PR proves the state of the work at the
end: CI verdict, pre-PR validation output, tester report, environment lifecycle. For a **bugfix**
run it proves nothing about the bug itself. Concretely, today:

- The `repro-test` kind (bug-triage Phase G) writes a failing test and returns
  `{ outcome: 'reproduced' | 'partial' | 'not_reproducible', testPaths, notes }`, but that
  outcome is **self-reported by the model**. Nothing runs the test. A run that wrote a test which
  never actually failed, or which fails for an unrelated reason, records `reproduced` and looks
  identical to one that genuinely demonstrated the defect.
- The `ci` gate proves the final tree is green. It says nothing about whether the tree was ever
  red, which is the entire content of the claim "this change fixes the bug".
- A run that skipped writing a regression test at all is **indistinguishable** from one that
  couldn't write one. Both surface as an absent test; neither says why.

That is precisely the class of claim the verification report exists to replace with captured
facts. Its own governing rule already says a section whose producing step didn't run must SAY so
(`status: 'absent'` + a note), because a silently missing section reads exactly like a clean one.
Reproduction is the last big agent _assertion_ on a bugfix PR still taken on trust.

End state: a bugfix run carries a `reproduction` block on the PR report that is one of

- **`reproduced`**: the declared check ran RED at the pre-fix tree and GREEN at the final tree,
  with both captured outputs;
- **`declared_infeasible`**: the agent structurally declared reproduction impossible, with its
  reason and the alternative verification it performed, recorded verbatim;
- **`absent`**: the phase did not run (not opted in, no declaration in the run), with a note
  saying which.

A **failed** verification (declared reproduced, but green on the pre-fix tree) is not a fourth
outcome the reviewer has to interpret: it is fed back to the agent inside the existing repair
budget, exactly like a red pre-PR validation check.

## Decisions

### D1: The proof is a HARNESS PHASE on the PR-opening dispatch, not a new pipeline step

**Decision: the verification runs inside the container, in the same checkout, between the agent
settling and the PR opening; the `validation-checks.ts` position. It is NOT a pipeline step.**

The `pr-verification-report` initiative already rejected a `pr-report` STEP for reasons that
apply verbatim here: a step would need inserting into every bugfix pipeline (including
deployment-authored ones), and a run that fails or parks part-way (the runs most worth
inspecting) would never reach it.

There is a stronger reason specific to this feature: **the proof needs both trees in one place.**
The pre-fix tree and the final tree are two commits in the same clone; a separate step would have
to re-clone, re-resolve the base sha, and re-install a toolchain the coder's container already
had warm. Running where `runValidationLoop` runs gets both for free, reuses the repair loop, and
inherits the "only a green checkout opens a PR" gate.

### D2: Opt-in home: an agent-config descriptor `coder.reproductionProof` (`auto`/`always`/`off`)

**Decision: a per-task tri-state contributed as an `AgentConfigDescriptor` on the `coder` kind,
copying `CODER_FORK_DECISION_CONFIG_ID` (`backend/packages/agents/src/agents/kinds/configs.ts`)
verbatim in shape.**

The brief asked for "a tri-state on the coder step config, the `forkDecision` shape": this IS
that shape. Worth stating explicitly because there are now two plausible homes and they are not
interchangeable:

- `agentConfig` (this choice) is a **per-task** bag keyed by descriptor id, rendered by the
  task-creation form and the inspector, frozen once the owning step runs. `coder.forkDecision`
  lives here. It needs no migration and no schema column.
- `stepOptions` (`entities.ts`) is a **per-pipeline-step** bag. Right home for a knob an author
  sets when building a pipeline; wrong home for one a person sets per bug.

Reproduction proof is a property of the _task_ ("is this bug reproducible in a test?"), not of
the pipeline definition, so it goes with `forkDecision`.

`auto` resolves to **on when the run carries a prior `repro-test` step output**, off otherwise.
Rationale: a run with a `repro-test` step has already paid for a declaration, so verifying it is
nearly free and is exactly the run the feature is about; a run without one has nothing to verify
and must not pay for a phase that would immediately record `absent`. Keying `auto` off the
**tracker issue type** is the brief's own stated later step and stays deferred: it needs the
intake metadata threaded to dispatch, which nothing does yet.

### D3: The declaration comes from the `repro-test` step, NOT a new structured tail on the coder

**Decision: v1 reads the declaration from the prior `repro-test` step's structured outcome,
extended with the missing field (`command`). The coder is NOT made a structured-output kind.**

The brief sketched "the coding prompt directs the agent to author a reproducing test and declare
it in a structured reply field". That was written without the `repro-test` kind in view; it
already exists and already declares `testPaths` + `notes`, and Phase G deliberately made it the
one committing step whose deliverable is BOTH a pushed commit and a parsed JSON outcome.
Duplicating that on the coder would mean:

- making `coder` structured: a kind deliberately excluded from `FINAL_ANSWER_IN_REPLY` precisely
  because it is a side-effect kind that legitimately ends with no final text (CLAUDE.md,
  "Final answer must land in the reply");
- two declaration formats to keep in step, and an ambiguity about which wins when a run has both.

So the declaration seam stays exactly one. What `repro-test` gains is the field it is missing:

| Field                     | Status  | Purpose                                                           |
| ------------------------- | ------- | ----------------------------------------------------------------- |
| `outcome`                 | exists  | `reproduced` / `partial` / `not_reproducible`                     |
| `testPaths`               | exists  | the declared test files                                           |
| `notes`                   | exists  | what was reproduced, or WHY not                                   |
| `command`                 | **new** | the command that runs exactly those tests: what the harness runs |
| `alternativeVerification` | **new** | for `not_reproducible`: what the agent verified INSTEAD           |

`not_reproducible` + `notes` + `alternativeVerification` **is** the brief's "explicit
machine-readable declaration with the agent's stated alternative verification". The infeasibility
path therefore needs no new vocabulary: only the missing field and a report section that renders
it instead of leaving an empty block.

**Consequence to accept deliberately:** `pl_bugfix` (the manual bugfix pipeline) has NO
`repro-test` step today: its shape is `bug-investigator → clarity-review → spec-writer →
architect → coder → reviewer → conflicts → ci → merger`. Only the recurring `pl_bug_triage` has
one. So v1 covers `pl_bug_triage` and any pipeline an author gave a `repro-test` step; `pl_bugfix`
is covered by **Phase E**, which inserts `repro-test` into its seed (a version bump + reseed
offer). Adding the step is the right fix rather than special-casing the coder: `pl_bugfix` should
produce a red test before the fix regardless of this feature.

### D4: Symmetric worktrees: the defence against a FALSE "reproduced"

**Decision: both phases run in freshly-created `git worktree` checkouts of the SAME clone, with
the SAME setup command, differing only in the tree under test. Neither phase runs in the agent's
working checkout.**

This is the sharpest edge in the whole feature and the reason to be careful rather than
fast. A naive implementation runs the check at the pre-fix sha and calls a non-zero exit
"reproduced". But a non-zero exit proves nothing on its own: it is equally produced by:

- a missing toolchain / uninstalled dependencies in a fresh worktree (no `node_modules`);
- a test that imports a module the fix introduces, so it fails to _load_ rather than to _assert_;
- an unrelated pre-existing breakage on the base.

All three make a green-on-base test look like a genuine reproduction, which is worse than no
proof at all: it launders an unverified claim into a captured "fact".

Symmetry is what defuses it. Because both phases run in equivalent fresh worktrees with identical
setup, an environmental defect fails **both**, and a run that is red-then-red is reported as
**`inconclusive`**, never as proof. The only shape that yields `reproduced` is red-then-green
across the same command in the same environment, which is exactly the claim being made.

What symmetry does NOT catch is red-for-the-wrong-_reason_ (a load error at base that the fix
incidentally resolves). Detecting that mechanically would need output comparison and a notion of
"the reported reason" the harness does not have. **This is a stated limitation, not an oversight**:
both captured outputs ride the report precisely so a human can see WHY it was red, and the
existing `repro-test` prompt already directs the agent that the failure "must demonstrate the
actual bug, not an unrelated assertion". Do not let a later iteration quietly claim more.

Mechanics that bite:

- **Target `baseSha` specifically**, the value `prepareCodingCheckout` already returns, never
  `HEAD~1` or an `origin/<base>` ref. The default coding clone is `--depth 1 --single-branch`
  (`cloneRepo`), so those refs are not in history; `baseSha` is the clone's HEAD at checkout and
  is always present.
- **In the RESUMED case the pre-fix tree needs no reconstruction.** When a `repro-test` step
  already pushed the failing test onto the shared work branch, the coder resumes that branch and
  `baseSha` is its tip: the test is present and the fix is not. That IS the pre-fix tree, so the
  base worktree is a plain `git worktree add <dir> <baseSha>` with nothing applied on top. The
  brief's "apply only the declared test files onto a clean worktree" is needed only for the
  non-resumed case (Phase E's `pl_bugfix`, or a run whose repro step conceded and whose coder
  wrote the test itself), and it is applied from the declared paths ONLY, never a whole-tree
  checkout, which would drag the fix across and green the base.

### D5: Output budget, redaction and per-job state: inherit the validation-checks rules

**Decision: reuse `validation-checks.ts`'s constants and discipline rather than inventing
parallel ones**; `MAX_CAPTURED_OUTPUT_CHARS` (16k) for what the agent sees in a repair prompt,
a 4k-per-phase tail on the wire, `redactSecrets` applied BEFORE truncation (a token straddling
the cut would otherwise survive as a partial), and every cap recorded in the report's own
`truncations` log.

Per-job state is non-negotiable and is a correctness rule here, not hygiene: the worktree path,
the setup/test commands and the environment ALL arrive as arguments, and nothing is read from or
written to `process.env` / `HOME`. The local native transport (`LOCAL_NATIVE_AGENTS`) serves
every concurrent job from ONE host process, so a shared worktree root would let two bugfix runs
clobber each other's base trees, and the container path would never catch it. Hence the
concurrency test in Phase B is a required item, not a nice-to-have.

Both phases the harness spawns itself must feed the inactivity watchdog on the 30s
`opts.onActivity` heartbeat, for the same reason the validation loop and the frontend stand-up do:
`JOB_INACTIVITY_MS` (10 min) is TIGHTER than a single command's own watchdog (15 min), so a
legitimately slow test run would otherwise abort the whole run as "inactivity".

### D6: A failed verification is a REPAIR, not a run failure

**Decision: "declared `reproduced` but green at base" feeds the agent inside the EXISTING
attempt budget (the pre-PR validation `maxAttempts`), and exhausting it degrades to
`inconclusive` on the report; it does NOT fail the step.**

Rationale: a red pre-PR validation check means the work is broken, so refusing the PR is right. A
reproduction that could not be demonstrated means the _evidence_ is weak, which is a reviewer's
call, not a machine's, and failing the run would throw away a fix that may well be correct. The
report is the deliverable; it states plainly what was and was not proven, and a reviewer decides.
This is deliberately a different disposition from `validationFailureMessage`, which opens nothing.

## Target pattern

Copy these, per piece: do not invent a parallel shape:

- **Config resolution → context → job body**: pre-PR validation end to end
  (`AgentContextBuilder.validationChecksFor` → `AgentRunContext.validationChecks` →
  `jobBody.ts` gated on `opensPr` → harness). Same `opensPr` gate, same degrade-on-throw.
- **The harness phase**: `executor-harness/src/validation-checks.ts`; generic machinery keyed
  off a job-body field, zero `switch(agentKind)`, per-job arguments throughout.
- **The tri-state**: `CODER_FORK_DECISION_CONFIG_ID` + `resolveForkTriState`
  (`forkDecision.logic.ts`) for the descriptor and the lenient resolution.
- **The report section**: `prReport.logic.ts` `composeTests` / `renderTests` for the
  compose+render pair, the `absent`+note discipline, and the `hostMarkdown` `cell`/`inline`/
  `prose` boundary for every interpolated hole.
- **The structured outcome**: `reproTestOutcome` (`agents/kinds/repro-test.ts`); lenient
  `v.fallback` everywhere so a partially-malformed reply degrades rather than failing the run.

## Phase checklist

Each phase ≈ one PR. Update the status column (+ PR link) at the end of every PR.

### Phase A: foundation: contracts, kernel, engine threading (harness-free)

Implemented on branch `claude/bugfix-reproduction-proof-jnlugx`. **Zero harness changes / no image
bump**: this slice only resolves and threads the spec; nothing consumes it in the container yet,
which is exactly why the "unconfigured means unchanged" assertions matter more than usual here.

| Item                                                                                         | Status | PR  |
| -------------------------------------------------------------------------------------------- | ------ | --- |
| Contracts `reproduction.ts`: spec + report schemas; `PipelineStep.reproduction`              | done   |     |
| `reproTestOutcome` gains `command` / `setupCommand` / `alternativeVerification` (+ prompt)   | done   |     |
| Kernel: `AgentRunContext.reproduction`, `RunnerJobView`/`RunnerJobResult.reproductionReport` | done   |     |
| `coder.reproductionProof` config id + lenient tri-state resolution (descriptor → Phase D)    | done   |     |
| Pure `reproductionProof.logic.ts` (tri-state + declaration → spec) + unit tests              | done   |     |
| `AgentContextBuilder` threading + `jobBody` forward gated on `opensPr`                       | done   |     |
| Engine records `step.reproduction` from all three poll paths                                 | done   |     |
| Conformance: threading + concede + unconfigured-means-unchanged, both runtimes               | done   |     |

Notes for Phase B (which consumes all of this):

- **The task-facing DESCRIPTOR is deliberately deferred to Phase D**, though the config id and the
  accepted wire values ship here. Two reasons, both fatal to shipping the control now: it would
  render a select promising a verification (Phase B) and a PR section (Phase C) that do not exist;
  and until the D2 tracker-issue gating lands, `always` resolves identically to `auto`, so the
  control would offer two options a user cannot tell apart. A value set by hand or by a deployment
  is already honoured, so adding the descriptor later is a pure addition.
- **The declared strings are MODEL-AUTHORED and bounded at the engine's resolution boundary**, the
  last point we control before they reach a job body: `REPRODUCTION_MAX_COMMAND_CHARS` on the
  command and setup command (over-length declines the whole spec; an over-long setup command must
  NOT be silently dropped, since running the final tree with a setup the base never got is exactly
  the D4 asymmetry), and `isSafeTestPath` on each declared path (repo-relative, no `..`, no root or
  drive anchor, length-capped) because Phase B APPLIES those paths onto the base worktree.
- **Every dropped path is COUNTED into `ResolvedReproduction.omittedTestPaths`** and rides the job
  body. Phase B must echo it onto the report (`ReproductionReport.omittedTestPaths`) and Phase C
  must render it: a dropped path can leave the base tree without the reproduction, which greens it
  and reads as "the test does not capture the defect"; a silent truncation would launder a broken
  input into a verdict.
- **A declaration is only trusted when the raw reply NAMED an outcome.** `reproTestOutcome` falls
  back to `not_reproducible` for an unreadable reply: right for telling the coder there is no
  trustworthy test, wrong here, because this feature publishes that value as the agent's own
  structural declaration. `reproductionDeclarationFrom` therefore requires the literal, and a real
  concede that named neither a reason nor an alternative gets an explicit `note` rather than a
  blank card.
- **`sameReproductionReport` participates on `at`**, so the harness MUST stamp a fresh timestamp on
  every publish; every other compared field is one whose change a reviewer would see, so a
  same-timestamp republish that altered the verdict still lands.
- **`resetStepForRerun` clears `step.reproduction`.** Unlike the validation report, which a re-run
  re-produces whenever checks are configured, this one can legitimately go present → absent, since
  a looped-back `repro-test` step has its `custom` cleared and the re-dispatch then resolves no
  spec. Left in place it would describe a tree that no longer exists.
- **`setupCommand` was added beyond the original sketch** and is load-bearing for D4: without it,
  a fresh worktree in any repo needing an install fails BOTH phases. That is reported as
  `inconclusive` (correct, not dangerous), but it makes the feature useless on most repos, so the
  harness must run it in both worktrees or neither.
- **The attempt budget is BORROWED from the pre-PR validation config** when the service has one
  (`AgentContextBuilder` passes `validationChecks.maxAttempts` through), else
  `REPRODUCTION_DEFAULT_MAX_ATTEMPTS`. Deliberate: one attempt-budget concept for an operator,
  not two. If Phase B needs to diverge, that is a new decision, not an oversight.
- **The concede report is minted by the ENGINE, not the harness** (`concededReproductionReport`,
  folded in `RunDispatcher.recordStepResult`), because a concede dispatches no proof at all:
  there is nothing to run. It is gated on the PR-opening producer kind so every other step in the
  run does not pick up the same declaration and litter the timeline with duplicate cards.
- **The resolution is PURE and reads no repository** (the declaration is already on
  `instance.steps[].custom`), so unlike `validationChecksFor` it needs no degrade-on-throw
  swallow and stays out of the `Promise.all` context wave.
- **The `FakeAgentExecutor` only returns a proof when the dispatch actually resolved a spec**
  (`context.reproduction`), mirroring the harness. Without that gate the unconfigured-means-
  unchanged conformance case passes vacuously: worth preserving when extending the fake.
- Verified green on BOTH runtimes: Node/Postgres (`conformance.agents.spec.ts`, 48/48) and
  Worker/D1 (`test/integration/conformance.spec.ts`, 318 passed / 1 skipped).

### Phase B: the harness phase + image bump

Implemented on branch `claude/bug-reproduction-proof-phase-mxq9c8`. Runner image `1.59.0`.

| Item                                                                                      | Status | PR  |
| ----------------------------------------------------------------------------------------- | ------ | --- |
| `executor-harness/src/reproduction-proof.ts`: symmetric worktrees, red/green, teardown    | done   |     |
| Declared-test application onto the base worktree (unconditional overlay; see below, D4)  | done   |     |
| Echo `omittedTestPaths` from the job body onto the report; stamp a fresh `at` per publish | done   |     |
| Heartbeat + per-job args; live publish on `RunnerJobView`, terminal on the result         | done   |     |
| Repair feedback on a failed verification, inside the existing budget (D6)                 | done   |     |
| **Concurrency test**: two jobs keep their worktrees isolated (required, D5)               | done   |     |
| Image-tag bump ritual: harness `version` + 3 pins (`pnpm sync:image-tags`) + changeset    | done   |     |

Notes for Phase C (which renders all of this):

- **The overlay of declared test files onto the base worktree is UNCONDITIONAL**, which is a
  refinement of D4's "needed only for the non-resumed case", not a departure from it. In the
  resumed case `baseSha` already carries the identical file, so the overlay is a no-op by
  construction; making it unconditional removes the special case AND guarantees the property the
  report actually claims, that both trees ran the byte-identical check. Keying off a `resumed`
  flag would have let a coder that touched the test file leave the base running an older version
  of it: asymmetry, reintroduced through the back door.
- **A green base SKIPS the final phase.** `reproduced` requires a red base, so the second run
  could only confirm what is already not proof, and each phase costs a full setup + test. The
  contracts schema already documents `final` as absent "when the base run settled it"; Phase C's
  renderer must therefore treat an absent `final` as normal for `inconclusive`, not as missing data.
- **A declared test path that is not COMMITTED is reported as its own shape** (no `base`, no
  `final`, a note naming the files). The proof runs against committed trees, so an unadded test
  took no part in it, and is equally missing from the push, which is the more useful half to tell
  the agent. Do not let Phase C render that case as "the test does not capture the defect".
- **The proof runs BEFORE the pre-PR validation loop**, deliberately: validation is the GATE, so it
  must stay the last thing that touches the tree. Consequence to accept: a subsequent validation
  repair round can alter the tree after the proof measured it. The alternative (proof last) breaks
  "only a green checkout opens a PR", which is the stronger invariant.
- **A setup failure is not repairable** and short-circuits the loop with zero agent passes: the
  setup command comes from the reproduction step's declaration, so a repair pass cannot change it,
  and burning the budget against a broken environment buys nothing. Two more shapes joined it in
  review, for the same underlying reason (the agent is not what is wrong): a **timed-out** tree,
  and a **pre-fix tree that already carries non-test work**. Repairability is therefore an explicit
  OUTPUT of an attempt (`ReproductionAttempt.repairable`), not re-derived from the report by a
  later reader: the two new cases are knowable only where the attempt ran.
- **A green base is NOT self-explanatory, and Phase C must not render it as though it were.** A
  resumed run's `baseSha` is the work branch as it stood when the pass started; after an eviction
  that is this same coder step's own interrupted work, fix included, so the check passes for a
  reason that has nothing to do with the test. The harness now probes `changedFilesSinceBase` on a
  green base only (it costs a fetch), memoised per loop, and reports the ambiguity in the `note`
  instead of blaming the test: degrading to the plain diagnosis when the probe cannot answer.
  **Phase C should render the note verbatim rather than re-deriving a cause from `base.passed`**,
  which is exactly the inference that was wrong.
- **The declared paths are refused for git PATHSPEC MAGIC** (`:(glob)`, `*`, `?`, `[…]`) as well as
  traversal, in BOTH sanitizers. `--` stops a path being read as a revision but not as a pathspec,
  so a glob would apply most of the final tree onto the base worktree and green it: a
  model-authored input turning a good reproduction into "the test does not capture the defect".
- **The phase carries a wall-clock ceiling** (`REPRODUCTION_TOTAL_BUDGET_MS`, 45m) on top of
  `maxAttempts`, because the heartbeat deliberately disables the only other backstop (the job
  inactivity watchdog) and attempts multiply two full tree runs each. Exceeding it is an
  `inconclusive` with its own note: a cost limit, never a verdict about the fix.
- **The `repro-test` prompt now states that both runs happen in a FRESH checkout** and that
  `setupCommand` is mandatory when tests need an install/build there. Without it the command errors
  identically on both trees, which is honest (`inconclusive`) but means the feature almost never
  produces proof for a dependency-installing repo: the most likely reason a fielded Phase C
  renders "unverified" more often than expected.
- **The harness never emits `declared_infeasible`**: a concede dispatches no proof, so the engine
  mints that verdict (Phase A's `concededReproductionReport`). Phase C's renderer sees all three.
- **`agent.ts` is at 1,494 of its 1,500-line budget.** The next slice that touches it should expect
  to extract the single-repo coding flow (`buildSingleRepoCodingSpec` + `runSingleRepoCoding`) into
  its own module rather than raise the ratchet, which is never an option.
- Verified: 380/380 harness tests (19 new proof tests driving a REAL local git repo through
  `git worktree`, plus the 3 required concurrency cases), and typecheck across the harness +
  contracts/server/integrations.

### Phase C: the PR report section

| Item                                                                                     | Status | PR  |
| ---------------------------------------------------------------------------------------- | ------ | --- |
| `pr-report.ts` contracts: the `reproduction` block                                       | todo   |     |
| `composeReproduction` + `renderReproduction`; `absent`+note; caps → `truncations`        | todo   |     |
| All interpolated text through `hostMarkdown` (`cell`/`inline`/`prose`) + `redactSecrets` | todo   |     |
| Conformance assertion in `execution-pr-report.ts`                                        | todo   |     |

### Phase D: SPA surfacing

| Item                                                                                     | Status | PR  |
| ---------------------------------------------------------------------------------------- | ------ | --- |
| Step result surfacing for `step.reproduction` (shared shell trailing section or panel)   | todo   |     |
| `coder.reproductionProof` descriptor in `configs.ts` (deferred from Phase A: see above) | todo   |     |
| Task-config control for the tri-state (descriptor renders automatically: verify)        | todo   |     |
| i18n keys in ALL locales (the locale-parity gate) + `data-testid`s                       | todo   |     |

### Phase E: `pl_bugfix` gains a `repro-test` step

| Item                                                                     | Status | PR  |
| ------------------------------------------------------------------------ | ------ | --- |
| Seed: insert `repro-test` before `coder`, bump `pl_bugfix` version       | todo   |     |
| `pipelineShape.test.ts` case for the new shape                           | todo   |     |
| Docs: root README capability row (the CLAUDE.md flow note landed in B)   | todo   |     |
| Convert this tracker to an ADR under `backend/docs/adr/` and `git rm` it | todo   |     |

The glossary entry landed with Phase A (the vocabulary trap (the `repro-test` kind's `outcome`
is a CLAIM, the proof is the VERIFICATION) is worth naming before the harness exists). The
CLAUDE.md runtime-flow note landed with **Phase B**, which is when a runtime flow first exists to
describe. The root README **capability** row stays deferred to Phase C: until the report renders on
the pull request there is nothing user-facing to advertise, and advertising it early is exactly the
staleness the CLAUDE.md sweep rule is aimed at.

## Conventions & gotchas carried between iterations

- **Decisions already made: do not re-litigate**: the proof is a harness phase, not a step (D1);
  the tri-state is an `agentConfig` descriptor, not `stepOptions` (D2); the declaration seam is
  `repro-test`, and the coder is NOT made structured (D3); both phases run in symmetric fresh
  worktrees (D4); a failed verification repairs and then degrades to `inconclusive`, it never
  fails the step (D6).
- **`baseSha`, never a base-branch ref**: the coding clone is `--depth 1 --single-branch` (D4).
- **A red base is not proof on its own.** Red-then-red is `inconclusive`; only red-then-green is
  `reproduced`. Red-for-the-wrong-reason is a documented limitation (D4): do not let a later
  iteration claim it is detected.
- **Never whole-tree checkout the declared test files' commit onto the base worktree**: that
  drags the fix across and greens the base. Apply the declared PATHS only.
- **Unconfigured must be byte-for-byte the old behaviour**: tri-state `off`/`auto`-not-met, or no
  declaration ⇒ no context field ⇒ no job-body field ⇒ the harness's existing path untouched.
  Both halves are asserted in conformance (Phase A): that is the compatibility promise.
- **Per-job state, absolutely** (D5): the concurrency test is a required Phase B item; the
  container path alone would not catch a native-transport regression.
- **A config/declaration read failure DEGRADES**, it never fails the dispatch: the
  `validationChecksFor` swallow-and-fall-back precedent, for the same reason (a mothership node on
  an older image, or a transient outage, must not stop every build).
- **Best-effort at the report boundary**: publishing is bookkeeping; the PR-report controller
  already swallows and logs.
- Changeset per PR (empty for docs-only); SPA strings through i18n with ALL locales in the same
  PR (the locale-parity CI gate); runtime symmetry + a conformance assertion in the SAME PR.
- Harness changes carry the full image-tag ritual (`pnpm sync:image-tags`); a reused tag does NOT
  roll out.

## Deliberately out of scope (follow-ups)

- **Environment-based reproduction**: for bugs with no unit-testable surface, captured from a
  deployer-provisioned ephemeral env. Stated as a follow-up in the brief, not this slice.
- **Coder-declared reproduction** (no `repro-test` step in the pipeline): D3 routes v1 through
  the existing declaration and Phase E extends `pl_bugfix`; a pipeline an author builds without a
  `repro-test` step records `absent` with a note until this lands.
- **Multi-repo peers**: the proof runs in the PRIMARY checkout only, mirroring the pre-PR
  validation boundary. A peer-repo reproduction is a fan-out question.
- **`auto` keyed off tracker issue type** (D2): needs intake metadata threaded to dispatch.
- **Output-based "red for the reported reason" detection** (D4): needs a notion of the reported
  reason the harness does not have.

When these are picked up (or explicitly dropped), convert this tracker into a numbered ADR under
`backend/docs/adr/` and `git rm` this file, per CLAUDE.md.
