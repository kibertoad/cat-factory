---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/observability-langfuse': minor
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': minor
---

Persist an agent's tool calls as a first-class trajectory: one row per invocation, in the order it
made them, carrying the tool's arguments and result. The evidence standard for a merged PR is
"how, not just the diff", and until now the tool loop survived a run only as metadata spans a
trace sink had to be wired to see, so reconstructing what an agent actually did meant diffing
consecutive prompt bodies against each other.

The fourth telemetry sink (`agent_tool_calls`), beside the per-call cost rows and the dispatch
context snapshots, in the same store and on the same retention window: D1 on Cloudflare, the
`telemetry` Postgres schema on Node, `node:sqlite` on a mothership-mode node, with the same
cross-runtime conformance assertions and the same local-first routing as its siblings. Readable
through a new `GET /api/v1/debug/runs/:runId/tool-calls` (additive; the spec's `info.version`
takes a minor and the four SDK clients plus the MCP facade gain the operation), and exported on
the OTel and Langfuse tool spans alongside the dispatch and ordinal a trajectory orders by.

The endpoint serves two orders, because the order is the product and a client cannot derive it
from the rows: `recent` is the newest-first keyset every sibling debug list shares, and
`order=trajectory` is the run's calls oldest-first as the agents made them, a bounded prefix that
issues no cursor (pairing one with it is refused rather than quietly served in the other order).
Both narrow to a single dispatch with `jobId`. The server orders by when each call STARTED, with
`seq` separating the calls that share a millisecond: sorting by the job id instead would order a
run's dispatches by agent-kind spelling and its re-runs `-10` before `-2`.

Both harnesses produce it: the Pi runner pairs each `tool_execution_start` with its end, and the
claude-code runner pairs each `tool_use` block with the `tool_result` that answers it — the CLI's
own stream being the only place a subscription run's tool loop is visible at all. Bodies are
capped and secret-scrubbed at capture, and ride the same `LLM_RECORD_PROMPTS` +
`storeAgentContext` double gate as every other captured body; a withheld body is recorded AS
withheld, so an opted-out workspace's trajectory never reads as a run whose every tool took no
arguments.

Breaks nothing, retains nothing new by default beyond a run's tool metadata, and requires the
`1.91.0` runner image (an older image's calls still reach the trace sinks; their trajectory is
skipped rather than persisted under colliding ids, and the skip is logged).
