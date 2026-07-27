---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
---

Bugfix reproduction proof — foundation (Phase A)

Threads a machine-verifiable reproduction declaration from a run's `repro-test` step onto the
PR-opening coder dispatch, so a later slice's harness phase can prove the defect was real: run
the declared check against the pre-fix tree (expect red) and the final tree (expect green).

- **Contracts**: new `reproduction.ts` (the resolved spec, the harness report + its
  `reproduced` / `inconclusive` / `declared_infeasible` verdict, `parseReproductionReport`) and
  `PipelineStep.reproduction`, which rides the run's `detail` blob — no migration.
- **Agents**: `reproTestOutcome` gains `command`, `setupCommand` and `alternativeVerification`
  (with the prompt updated to ask for them), and the `coder.reproductionProof` tri-state config id
  (`auto` / `always` / `off`). The task-facing descriptor is deliberately NOT contributed yet —
  the verification phase and the PR section are later slices, and `always` resolves identically to
  `auto` until the tracker-issue gating lands, so a control rendered now would offer two
  indistinguishable options and promise behaviour that does not exist. A value set by hand or by a
  deployment is already honoured.
- **Engine**: pure `reproductionProof.logic.ts` resolves the tri-state + declaration into the
  spec `AgentContextBuilder` folds onto `AgentRunContext.reproduction`; the job body forwards it
  only on a dispatch that opens a PR; the harness verdict is recorded on the step from all three
  poll paths.
- **Model-authored input is bounded at the resolution boundary**: the declared command and setup
  command are length-capped (over-length declines the whole spec), and each declared test path
  must be repo-relative with no `..` segment, since the harness applies them onto a base worktree.
  Every dropped path is counted onto the spec's `omittedTestPaths` and carried to the report, so a
  proof run against an incompletely rebuilt tree says so instead of implying a clean verdict.
- **Infeasibility is structural**: a run whose reproduction step conceded dispatches no proof and
  instead records the declaration itself — the reason plus the agent's stated alternative
  verification — so "could not be reproduced" no longer reads the same as "nobody tried". A reply
  that never named an outcome is NOT treated as a concession (the schema's lenient fallback would
  otherwise publish an infeasibility claim the agent never made), and a concession with neither a
  reason nor an alternative records an explicit note rather than a blank card.

Behaviour is unchanged for every run that is not opted in or carries no declaration: no context
field, no job-body field, the existing harness path. Asserted on both runtimes.

Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.
