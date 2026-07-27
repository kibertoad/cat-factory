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
  (with the prompt updated to ask for them), and a new `coder.reproductionProof` tri-state
  agent-config descriptor (`auto` / `always` / `off`).
- **Engine**: pure `reproductionProof.logic.ts` resolves the tri-state + declaration into the
  spec `AgentContextBuilder` folds onto `AgentRunContext.reproduction`; the job body forwards it
  only on a dispatch that opens a PR; the harness verdict is recorded on the step from all three
  poll paths.
- **Infeasibility is structural**: a run whose reproduction step conceded dispatches no proof and
  instead records the declaration itself — the reason plus the agent's stated alternative
  verification — so "could not be reproduced" no longer reads the same as "nobody tried".

Behaviour is unchanged for every run that is not opted in or carries no declaration: no context
field, no job-body field, the existing harness path. Asserted on both runtimes.

Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.
