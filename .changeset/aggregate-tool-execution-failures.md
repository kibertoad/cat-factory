---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Aggregate tool-execution failures: a rollup, a signal and an `?ok=` filter

A failed tool call was a row nowhere counted. The trajectory sink recorded each one (`ok: false`,
with what the tool returned), and nothing above it added them up: the run overview reported only how
many tool calls the run made, no filter narrowed a page to the failures, and no signal was derived
from them. That is the one class of failure the LLM telemetry beside it structurally cannot see: a
rejected edit or a non-zero command is a perfectly healthy model call whose result came back bad, so
a run stuck re-running a broken tool reports a clean model side and an inexplicable death. Finding
it meant paging the whole trajectory and reading each row's `ok` by eye.

`AgentToolCallRepository.summarizeByExecution` is now the one GROUP BY, at the `(agentKind, tool)`
grain, and it REPLACES the bare `countByExecution`: the overview's `sinks.toolCalls.count`, its new
`toolCalls` rollup and both of that rollup's breakdowns are folds over the same cells, so a count and
a breakdown that disagree is not a representable state. The grain keeps both halves deliberately,
because the finding is the CONCENTRATION: one agent kind retrying one tool is a stuck loop, the same
count scattered over nine tools is an agent exploring, and either axis alone folds that away. Every
level carries `failureRate` beside its counts (34 of 36 and 34 of 3,600 are the same number and
opposite diagnoses) and a run that called no tools reports it as `null` rather than a clean 0%, which
would file "nothing happened" beside "everything worked".

Two signals ride it, and their severities carry the difference between them. `tool_calls_failed` is
an `info` reporting the run-wide count with its ratio: a failing tool call is the ordinary shape of
an agent loop (a test that fails before it is fixed, a `grep` that matches nothing), so as a warning
it would fire on most healthy runs and cost the severity ordering the thing it is for.
`tool_retry_loop` is the `warning`, firing only where the failures concentrate on one
`(agentKind, tool)` cell that is both mostly-failing and has failed enough times to not be a single
bad command. It selects among the cells that QUALIFY rather than testing the run's most-failed one,
which is not the same thing: ranking first would hide a fixer wedged 5-for-5 on `apply_patch` behind
a coder's 6 failures across 100 healthy `bash` calls, silently missing the run the sink exists for.
`failure_outside_model_calls` now reads the sink before deciding where to send the reader: failing
tool calls to start at, a recorded loop with none in it (so what is left is the engine), or no
trajectory at all — which is unrecorded rather than uneventful, and was previously indistinguishable
from a clean one.

Public API 1.11.0 → 1.12.0, additive: `?ok=true|false` on `GET /api/v1/debug/runs/:runId/tool-calls`
(both orders, applied in SQL, because a caller filtering a page itself has already spent that page's
`limit` on the calls that worked) and the `toolCalls` block on the run overview. The four SDK clients
and the MCP facade are regenerated. Worth a reviewer's attention: `countByExecution` is gone from the
kernel port, so all three telemetry stores, the mothership read-through and its bounded-read table
move together, and the new aggregate is classified `telemetry` in the drift guard rather than routed
over the persistence RPC.

No migration, and the aggregate is knowingly costlier than the COUNT it replaces: the existing run
index served that count without touching the table, while grouping reads `agent_kind`, `tool` and
`ok` off each row. A covering index would buy that back and is the wrong trade here: this sink is
append-hot (a row per tool call of every run) and the aggregate runs once per debug overview, so a
fifth index would tax the hot path for the rare read. Either way the scan is bounded by one run's
rows.
