---
'@cat-factory/orchestration': patch
---

Refactor: the Kaizen grader now resolves its model through the SAME shared inline
model-resolution seam every other inline agent uses (`resolveInlineModelRef`) instead of a
hand-rolled copy of the precedence in `KaizenService.modelFor`. The bespoke copy was
behaviourally equivalent but a divergent code path that could drift and silently degrade a
subscription preset (e.g. a "Claude for everything" preset) to the env routing default (e.g.
`qwen`) — the same class of drift the `assertRunnable` de-duplication addressed for
start/retry/restart. Routing it through the one shared helper keeps kaizen identical to the
requirements reviewer et al. (block pin > workspace per-kind default > routing default, keeping
an ambient-eligible subscription harness ref rather than degrading it) and prevents future
drift. Adds `KaizenService.model.test.ts` pinning that precedence and the keep-vs-degrade
behaviour so the qwen-degrade scenario is now a regression test.
