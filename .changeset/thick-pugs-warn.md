---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Roll a run's model spend up by the PHASE that spent it, so "why did this small task cost a million
tokens" is a breakdown rather than a guess. The per-call phase axis already existed; what was
missing was the aggregate that reads it.

Each phase reports its turns, the three input classes, its output, and a **carry cost**: each
call's total input counted once for every later turn in the SAME conversation that had to re-send
it. That is the figure a plain token sum cannot produce — it separates a phase that read a lot from
a phase that made everything after it expensive, which is precisely the distinction between "trim
the prompt" and "cut the turns". It is a proxy: comparable between one run's phases, meaningless as
an absolute.

It surfaces two ways, both folds over one aggregate: `step.metrics.byPhase` on every pipeline step
(pushed live, rendered as a run-level table in the model-activity panel) and `llm.byPhase` on the
remote debugging overview (`GET /api/v1/debug/runs/:runId`), ordered costliest-first. The
unattributed `""` phase is always a row, never a dropped one — a run metered by a channel with no
phase concept must not read as a run that spent nothing outside the agent.

Compatibility break: `LlmCallMetricSummary` (the `LlmCallMetricRepository.summarizeByExecution`
row) is now keyed by `(agentKind, phase)` rather than by `agentKind` alone, and carries
`carryCostTokens`. Consumers fold it with the new kernel helpers (`foldRollupTotals`,
`foldRollupsByAgentKind`, `foldRollupsByPhase`) instead of indexing it directly. No migration: the
aggregate reads only columns that already exist on both telemetry stores.
