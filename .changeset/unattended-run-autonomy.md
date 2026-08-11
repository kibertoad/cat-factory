---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A run nobody is watching now finishes instead of waiting on a person who is not coming, and a
workspace states that posture per intake rather than once for everything.

Three parks stopped an otherwise-autonomous run, and none of them is a checkpoint anybody asked for:
a companion at its automatic rework cap, an iterative review at its reviewer-pass cap, and the
Coder's follow-up companion holding the run while any item is undecided. Each is the automation
reporting that it gave up, and each already offered a person a documented "proceed anyway". A run
started over `/api/v1`, dispatched from a ticket or fired by a schedule had nobody to offer it to,
so it waited indefinitely. The headless acceptance suite found this on `pl_build`, stopping on an
`approval-gate` raised by `architect-companion`.

- **`RiskPolicy.autonomy`** (`attended` | `unattended`) decides which way those three go. `attended`
  is byte-for-byte the previous behaviour and is what every existing policy, every custom one, and
  the built-in fallback get. `unattended` takes the "proceed" answer ON THE RECORD:
  `step.companion.capSettledByPolicy` and `followUpItem.dismissedByPolicy` say that policy decided,
  because the last companion verdict already says the producer was below the bar and a run that
  advanced anyway must not read like one whose companion quietly stopped grading.
- **It never touches a park the PIPELINE asked for.** An approval gate, a `human-test` step, visual
  confirmation, the human/PR review gate, a brainstorm or interview, the fork choice and the input
  gate all stop the run under either value. A companion step that is ALSO gated still raises its
  human approval gate at the cap, because the cap settling is routed through the same pass branch a
  converged companion takes.
- **A workspace now has TWO default policies.** `isDefault` governs a task somebody started in the
  app; the new `isUnattendedDefault` governs one nothing is watching. Which applies is
  `riskPolicyDefaultScopeFor(intakeOrigin)`, its own `Record` rather than a reuse of
  `isHeadlessIntake` — the two disagree about `schedule`, which is not headless (its reused block
  has no stable place to hold a clarification conversation) and is nonetheless unwatched.
- **A third built-in, `mp_unattended` ("Unattended delivery")**, seeded as that default. It is
  `Balanced` with one field changed, deliberately: a seed may decide that an unwatched run should
  not wait forever on an automation budget, and may not decide that it gets to land a change an
  operator's own thresholds would have held.

**Migration, and the one thing to check.** Both facades' migrations materialise `mp_unattended` in
every existing workspace and then name the unattended default _unless configured differently_: a
workspace still sitting on the shipped `mp_balanced` gets the new policy, and one whose operator had
already moved the default onto a policy of their own keeps THAT for unattended runs too. So landing
authority does not move underneath anyone; what changes is that such runs stop parking on the three
caps. A deployment that WANTS its API-started runs to keep parking re-points `isUnattendedDefault`
at a policy whose `autonomy` is `attended` (the shipped `Balanced` or `Manual review only` both
qualify).

**Public API (additive, OpenAPI 1.49.0).** `GET /api/v1/risk-policies` gains `isUnattendedDefault`
and `autonomy`. `isDefault` keeps its exact former meaning, so nothing an existing client was told
becomes wrong; it was reading about the other scope. A caller predicting whether its own runs can
reach a terminal state unassisted should read `autonomy` on the `isUnattendedDefault` row.

**Internal break.** `RiskPolicyRepository.getDefault` takes the scope, and
`RunMergePolicy.resolve` / the engine's `resolveRiskPolicy` callback take the run. Both are required
rather than defaulted: a call site that has not decided which kind of run it is resolving for now
fails to compile, because the alternative reads as correct and silently hands an unwatched run the
in-app policy.

Design record: [ADR 0053](../backend/docs/adr/0053-unattended-run-autonomy.md).
