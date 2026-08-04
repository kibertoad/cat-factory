# ADR 0033: Bugfix reproduction proof; red-before, green-after, captured rather than claimed

- **Status:** Accepted (implemented)
- **Date:** 2026-08-04
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/executor-harness`, both
  runtime facades) + the SPA

Supersedes the `bugfix-reproduction-proof` initiative tracker, whose committed scope (phases A-E)
is complete. It is slice 10 of the PR-verification-report backlog
([`../../docs/initiatives/pr-verification-report.md`](../../docs/initiatives/pr-verification-report.md)),
which keeps its own row pointing here.

## Context

The verification report the engine maintains on a run's pull request proves the state of the work
at the END: the CI verdict, the pre-PR validation output, the tester report, the environment
lifecycle. For a **bugfix** run it proved nothing about the bug itself.

- The `repro-test` kind (bug-triage phase G) writes a failing test and returns
  `{ outcome, testPaths, notes }`, but that outcome is **self-reported by the model**. Nothing ran
  the test. A run that wrote a test which never actually failed, or which fails for an unrelated
  reason, recorded `reproduced` and looked identical to one that genuinely demonstrated the defect.
- The `ci` gate proves the final tree is green. It says nothing about whether the tree was ever
  red, which is the entire content of the claim "this change fixes the bug".
- A run that skipped writing a regression test was **indistinguishable** from one that could not
  write one. Both surfaced as an absent test; neither said why.

That is exactly the class of claim the verification report exists to replace with captured facts,
and it was the last big agent ASSERTION on a bugfix PR still taken on trust.

## Decision

A bugfix run carries a `reproduction` block, computed by the platform, in three shapes:

- **`reproduced`** — the declared check ran RED at the pre-fix tree and GREEN at the final tree,
  with both captured outputs;
- **`inconclusive`** — any other shape, stated plainly rather than dressed up;
- **`declared_infeasible`** — the agent structurally declared reproduction impossible, with its
  reason and the alternative verification it performed, recorded verbatim.

Six decisions shape it. They are settled; do not re-litigate them.

### D1: The proof is a HARNESS PHASE on the PR-opening dispatch, not a pipeline step

It runs inside the container, in the same checkout, between the agent settling and the PR opening:
the `validation-checks.ts` position. A step would need inserting into every bugfix pipeline
(deployment-authored ones included), and a run that fails or parks part-way — the runs most worth
inspecting — would never reach it. The stronger reason is specific to this feature: **the proof
needs both trees in one place.** The pre-fix tree and the final tree are two commits in the same
clone; a separate step would re-clone, re-resolve the base sha and re-install a toolchain the
coder's container already had warm.

### D2: Opt-in home is the per-task `coder.reproductionProof` tri-state (`auto`/`always`/`off`)

An `AgentConfigDescriptor` on the `coder` kind, copying `CODER_FORK_DECISION_CONFIG_ID` in shape.
Reproduction proof is a property of the TASK ("is this bug reproducible in a test?"), not of the
pipeline definition, so it belongs in the per-task `agentConfig` bag rather than in a step's
`stepOptions`. `auto` resolves to ON when the run carries a prior `repro-test` step output: such a
run has already paid for a declaration, so verifying it is nearly free, and a run without one has
nothing to verify and must not pay for a phase that would immediately record `absent`.

### D3: The declaration comes from the `repro-test` step, not a structured tail on the coder

`repro-test` already declares `testPaths` + `notes`; it gained `command`, `setupCommand` and
`alternativeVerification`. Making `coder` structured would contradict its exclusion from
`FINAL_ANSWER_IN_REPLY` (it is a side-effect kind that legitimately ends with no final text) and
would leave two declaration formats to keep in step, with an ambiguity about which wins.

### D4: Symmetric worktrees are the defence against a FALSE `reproduced`

Both phases run in freshly-created `git worktree` checkouts of the SAME clone, with the SAME setup
command, differing only in the tree under test. A non-zero exit proves nothing on its own: a
missing toolchain, a test importing a module the fix introduces, or an unrelated pre-existing
breakage all make a green-on-base test look like a genuine reproduction, which is worse than no
proof — it launders an unverified claim into a captured "fact". Symmetry defuses it: an
environmental defect fails BOTH, and red-then-red is reported as `inconclusive`, never as proof.

What symmetry does NOT catch is red-for-the-wrong-REASON. **This is a stated limitation, not an
oversight**: both captured outputs ride the report precisely so a human can see WHY it was red. Do
not let a later iteration quietly claim more.

### D5: Output budget, redaction and per-job state follow `validation-checks.ts`

`redactSecrets` before truncation (a token straddling the cut would otherwise survive as a
partial); the worktree path, the commands and the environment ALL arrive as arguments, and nothing
is read from or written to `process.env` / `HOME` (the local native transport serves every
concurrent job from ONE host process, so a shared worktree root would let two bugfix runs clobber
each other's base trees). Both phases feed the inactivity watchdog on a 30s heartbeat.

### D6: A failed verification is a REPAIR, not a run failure

"Declared reproduced, but green at base" feeds the agent inside the EXISTING pre-PR validation
attempt budget, and exhausting it degrades to `inconclusive` on the report. A red validation check
means the WORK is broken, so refusing the PR is right; an unproven reproduction means the EVIDENCE
is weak, which is a reviewer's call, and failing the run would throw away a fix that may well be
correct.

## Rationale for the shapes that bite

- **`baseSha`, never a base-branch ref.** The coding clone is `--depth 1 --single-branch`, so
  `HEAD~1` and `origin/<base>` are not in history.
- **Declared test paths are applied onto the base worktree, never a whole-tree checkout**, which
  would drag the fix across and green the base. They are refused for git PATHSPEC MAGIC
  (`:(glob)`, `*`, `?`, `[…]`) as well as traversal, in BOTH sanitizers: `--` stops a path being
  read as a revision but not as a pathspec. Every dropped path is COUNTED onto
  `omittedTestPaths` and rendered, because a dropped path can leave the base tree without the
  reproduction, which greens it and reads as "the test does not capture the defect".
- **The overlay of declared test files is UNCONDITIONAL.** In the resumed case `baseSha` already
  carries the identical file, so it is a no-op by construction; making it unconditional guarantees
  the property the report actually claims, that both trees ran the byte-identical check.
- **A green base SKIPS the final phase**, so an absent `final` is NORMAL for `inconclusive`, not
  missing data, and every renderer says which.
- **A green base is not self-explanatory.** A resumed run's `baseSha` can be this same coder step's
  own interrupted work, fix included. The harness probes `changedFilesSinceBase` on a green base
  only and reports the ambiguity in its `note`; **every renderer shows that note VERBATIM rather
  than re-deriving a cause from `base.passed`**, which is exactly the inference that was wrong.
- **A declaration is only trusted when the raw reply NAMED an outcome.** `reproTestOutcome` falls
  back to `not_reproducible` for an unreadable reply, which is right for telling the coder there is
  no trustworthy test and wrong here, because this feature PUBLISHES that value as the agent's own
  structural declaration.
- **The concede report is minted by the ENGINE, not the harness**: a concede dispatches no proof,
  so there is nothing to run. It is gated on the PR-opening producer kind so every other step in
  the run does not pick up the same declaration.
- **The phase runs BEFORE the pre-PR validation loop**, deliberately: validation is the GATE, so it
  stays the last thing that touches the tree. Consequence accepted: a later validation repair round
  can alter the tree after the proof measured it. The alternative breaks "only a green checkout
  opens a PR", which is the stronger invariant.
- **A setup failure, a timeout, and a pre-fix tree already carrying non-test work are NOT
  repairable** and short-circuit the loop with zero agent passes: the agent is not what is wrong,
  and burning the budget against a broken environment buys nothing. Repairability is an explicit
  OUTPUT of an attempt (`ReproductionAttempt.repairable`), never re-derived by a later reader.
- **`resetStepForRerun` clears `step.reproduction`.** Unlike the validation report, this one can
  legitimately go present → absent, since a looped-back `repro-test` step has its `custom` cleared.
- **`sameReproductionReport` participates on `at`**, so the harness stamps a fresh timestamp on
  every publish.

## Consequences

- `pl_bugfix` gained a `repro-test` step before its `coder` (version bumped for the reseed offer),
  so the manual bugfix preset produces a red test before the fix regardless of this feature.
  `pipelineShape.test.ts` pins the ORDER for every bugfix preset: the step SEEDS the shared work
  branch the coder resumes, and after the coder there would be no pre-fix tree left to prove
  anything against.
- The verdict reaches a human on three surfaces, all reading the same `step.reproduction`: the PR
  report's `reproduction` section, the result-window shell's trailing section, and the step-detail
  card. **Both SPA surfaces are needed**: the engine records the proof on whichever step OPENED the
  pull request, which in every built-in pipeline is the `coder` — a kind with no dedicated result
  view, so it opens the step-detail panel the shell is never involved in.
- **Unconfigured is byte-for-byte the old behaviour**: tri-state `off`, `auto` unmet, or no
  declaration ⇒ no context field ⇒ no job-body field ⇒ the harness's existing path untouched. Both
  halves are asserted in conformance on D1 and Postgres alike.
- `always` still resolves identically to `auto`. The divergence arrives with the tracker-issue-type
  gating; the descriptor's option labels say what each one MEANS rather than pretending they differ
  today.
- **`agent.ts` in the harness is at 1,494 of its 1,500-line budget.** The next slice touching it
  should extract the single-repo coding flow (`buildSingleRepoCodingSpec` + `runSingleRepoCoding`)
  rather than raise the ratchet, which is never an option.
- **`repro-test` is estimate-GATABLE but no built-in preset gates it.** The step is the most
  expensive thing a small bugfix pays for (a `container-coding` dispatch: a real checkout, a commit
  and a push) and the least likely to earn its keep on a one-line change, which is the range
  gating exists to collapse into one preset. It qualifies for `BUILTIN_GATABLE_KINDS` under that
  set's own test rather than by convenience: its absence THINS a run where `merger`'s BREAKS one,
  because the only thing reading the declaration structurally is the proof, which resolves to "no
  spec" and does not run. Shipping it gated would have changed what every existing bugfix run
  costs and dropped the evidence on whichever tasks a model scored low, so that is the pipeline
  author's call and `pipelineShape.test.ts` pins the ungated default. A skipped step is its OWN
  `absent` cause in the report (checked BEFORE the un-opted-in one, since gating leaves the step in
  `instance.steps` carrying `skipped` and it would otherwise satisfy "this pipeline declares one"),
  because the operator fix is a threshold rather than a look at the step's output.

### Deliberately out of scope (follow-ups)

- **Environment-based reproduction**, for bugs with no unit-testable surface, captured from a
  deployer-provisioned ephemeral environment.
- **Coder-declared reproduction** for a pipeline an author builds without a `repro-test` step: it
  records `absent` with a note saying so.
- **Multi-repo peers**: the proof runs in the PRIMARY checkout only, mirroring the pre-PR
  validation boundary.
- **`auto` keyed off tracker issue type** (D2): needs intake metadata threaded to dispatch.
- **Output-based "red for the reported reason" detection** (D4): needs a notion of the reported
  reason the harness does not have.
