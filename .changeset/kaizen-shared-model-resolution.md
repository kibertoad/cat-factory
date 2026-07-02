---
'@cat-factory/orchestration': patch
---

Fix: the Kaizen grader now resolves its model through the SAME shared inline model-resolution
seam every other inline agent uses (`resolveInlineModelRef`) instead of a hand-rolled copy of the
precedence in `KaizenService.modelFor`. A workspace with a "Claude for everything" preset could see
the unattended grader silently degrade to the env routing default (e.g. `qwen`) and fail with
"Unsupported model provider", because its bespoke resolver could diverge from the canonical path.
Routing it through the one shared helper keeps kaizen behaviourally identical to the requirements
reviewer et al. (block pin > workspace per-kind default > routing default, keeping an ambient-eligible
subscription harness ref rather than degrading it) and prevents future drift — the same de-duplication
`assertRunnable` did for start/retry/restart.
