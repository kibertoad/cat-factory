---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Stamp every `llm_call_metrics` row with the run PHASE that spent it and its TURN ordinal, so a
run's token burn can be attributed to the slice that caused it — the agent's own edit loop, a
pre-PR validation repair round, a reproduction-proof repair round — instead of piling into one
figure per agent kind (token-burn instrumentation, slice 2).

The phase comes from whoever owns the boundary, never from a downstream guess: the harness's job
registry stamps it on each streamed call as it is emitted, and the Pi path — whose calls are
metered server-side by the proxy — carries it on the URL Pi is pointed at
(`${proxyBaseUrl}/phase/<phase>`, rewritten per pass), since Pi makes those requests from a config
with no per-request header to set. The proxy therefore serves completions on a second, optional
phase-tagged path; the plain path is unchanged and its calls are recorded as unattributed.

`LlmCallMetric` gains `phase: string` (`''` = unattributed, a real slice of the rollup rather
than a dropped row) and `turnIndex: number | null` (the harness's job-scoped `seq`; NULL where the
producing channel has no turn concept, so a proxied call is never faked into "turn 0").
`HarnessCallMetric` gains an optional `phase`, read leniently off a runner pool's envelope.
Both telemetry stores gain the two columns (D1 `0004_llm_call_phase_turn` ⇄ a Drizzle migration);
existing rows keep the unattributed default and are not backfilled — the table is pruned to a
3-day window, so they churn out on their own.
