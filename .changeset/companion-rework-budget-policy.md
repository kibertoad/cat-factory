---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

A companion's automatic rework budget is now a risk-policy field instead of a constant in the engine.

Every other automatic loop reads its ceiling off the task's policy: the CI fixer (`ciMaxAttempts`),
the iterative requirements review (`maxRequirementIterations`), the Tester's quality gate
(`maxTesterQualityIterations`), a judge's bounces (`judgeMaxBounces`), the post-release-health watch.
The companion loop, which has the widest reach of them (every `reviewer`, `architect-companion`,
`spec-companion` and any pair a deployment registers) and is the one an operator actually watches
spend container dispatches, was pinned at 3 by `DEFAULT_COMPANION_MAX_ATTEMPTS` with no way to state
otherwise. `companionMaxReworks` closes that, on both policy tiers (account and workspace) and in the
policy editor beside the requirement-iteration budget.

`0` is a real posture rather than a disabled loop: the companion still grades and still writes its
verdict, and the first verdict below the bar goes straight to the iteration-cap park (or to
`proceed`, on a policy whose `autonomy` is `unattended`) instead of buying a round. A verdict at or
above the bar advances, comments and all. That last part is the one place this number changed an
existing rule rather than parameterising it: a companion's FIRST batch of comments loops the producer
back whatever it scored, and that rule now asks whether there is a round to spend before it fires.
Left alone, `0` would have parked every companion step, since a review with nothing at all to say is
the rare one.

A step is seeded with the catalog default at run start, where no policy is resolved, so the resolved
value is adopted onto `step.companion.maxAttempts` at the companion's first grading, the same way the
Tester's quality budget is adopted on its first report. That read happens once per step, keyed on the
step having recorded no verdict yet: a human granting an extra round at the cap does it by raising
that same field (and the grant charges the round immediately), so a later read would report a ceiling
the step no longer has. Keyed on the attempt count instead, it also fired a second time after a human
"request changes" on a gated companion, which re-runs the producer while deliberately charging no
round.

No behaviour changes by default. The column default and all three built-in seeds carry the 3 the
engine held, so a stored policy and a freshly seeded one are byte-for-byte identical and no seed
needed a version bump. The field stays off `/api/v1`, where the risk-policy projection deliberately
publishes only what decides whether a run can land without a person.
