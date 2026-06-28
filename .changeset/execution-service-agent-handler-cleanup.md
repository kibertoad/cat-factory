---
"@cat-factory/orchestration": patch
---

ExecutionService split, phase 5 (final): rename the temporary `runStepBody` fallthrough to
`handleAgentStep` — the legitimate generic container/inline-agent StepHandler (`kind: 'agent'`,
lowest priority) — now that every specific kind is claimed by its own handler. `stepInstance`
is now just the fixed run-lifecycle preamble plus a single `dispatchStepHandler` call; the
old ~290-line implicit-ordering `if`/early-return chain is gone, replaced by explicit
`order`-driven handler dispatch. No behaviour change.
