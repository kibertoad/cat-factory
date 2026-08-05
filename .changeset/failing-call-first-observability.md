---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Failing-call-first debugging: pin what broke, and let both drill-downs narrow to it

The observability panel already held everything needed to diagnose a run, and asked an operator to
find it by scrolling. Worse, one whole failure class had nowhere to be found from: a tool that
errors executes INSIDE the container, so the model call that requested it still records `ok` with a
clean finish reason. Every LLM number on the panel, and every rollup on the debug overview, reads
healthy right up to the moment the run dies. The remote-debugging doc named this as a known
limitation ("tool-execution errors are rows, but no rollup counts them"); this closes it on both
surfaces.

**The panel opens with the failure.** A pinned section above the lists carries the run's structured
`failure` record (kind, message, hint, the step it died on) beside the last model call that failed
and the last tool call that failed, each with a count of the earlier ones and a jump into the list.
It appears whenever there is something to pin rather than only on `status === 'failed'`: a run still
in flight whose calls are already erroring is exactly the one worth interrupting.

The two evidence rows are shown in a fixed order and are deliberately NOT ranked against each other.
They come from different clocks (a call's recorded `createdAt`, a tool span's harness-stamped
`startedAt`), so "which happened last" is not a comparison this can make honestly, and a confident
wrong ordering is worse than none in a section whose whole job is to be believed.

**When nothing failing can be pinned, it says which of three things that means.** Both sinks
answered and nothing failed (the cause left no row: look at the engine), neither sink recorded
anything (the run died before any agent work), or one answered and the other stayed silent. A single
"no failures found" would render a clean bill of health over a run that died with no telemetry at
all, which is the same false picture in the opposite direction.

**Both drill-downs narrow by outcome.** The model-call list gets `All / Failed / Cut short / OK`
with live counts, split that way because a failed call and a truncated one need different fixes
(transport, proxy or spend-gate trouble versus an output-limit conversation). The tool-call
trajectory is a new panel view with `All / Failed / OK`, keeping trajectory order under every
filter: reading the failures in sequence is what tells one tool that failed and was worked around
from an edit loop stuck repeating the same failing call.

On the public API (additive; OpenAPI `1.12.0`): `GET /api/v1/debug/runs/:runId/tool-calls` takes
`?outcome=ok|error`, composing with both orders and with `?jobId=`, and the run overview's
`sinks.toolCalls` carries `failed` beside its `count`, with a `tool_calls_failed` signal derived
from it. `failure_outside_model_calls` now states what the trajectory actually holds instead of
pointing at it unconditionally.

The narrowing is applied IN SQL on all three stores, which is the part that makes it correct rather
than convenient: the trajectory read is bounded to a PREFIX of the run, so a filter applied after
the read would report no failures on any run whose failures came after its opening moves. Internal
breaks: `AgentToolCallRepository.countByExecution` returns `{ total, failed }` (one aggregate pass,
so the two can never be read at different instants and disagree), and the trajectory/page queries
gain an `outcome` field.

`LLM_WARNING_FINISH_REASONS` and the call-outcome classification move to `@cat-factory/contracts`
(kernel re-exports them, so its SQL aggregations are untouched). The SPA had a hand-copied list,
which was tolerable while it only picked a badge colour and stopped being so the moment the filter
decides which rows an operator is shown.
