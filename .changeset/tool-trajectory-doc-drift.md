---
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
---

Correct the tool-call trajectory's stale ordering and tool-error claims

The trajectory sink landed and was then re-ordered by review in the same PR (`(jobId, seq)` to
`(startedAt, seq)`), and several places still described the pre-review behaviour or the state of
the world before the sink existed at all.

`agentToolCallSchema.jobId` still documented itself as half the sort key, which is the derivation
the server exists to prevent a client from making: it now says what `jobId` is for (narrowing to
one dispatch) and points at the repository contract that owns the order.

The `failure_outside_model_calls` signal told a caller that tool-execution errors are recorded
nowhere and to go grep prompt deltas. A failing tool call is now a row of its own, so the pointer
names the trajectory read first and keeps the delta search behind it for the two cases it genuinely
cannot answer: an engine-side failure, which no producer records, and a workspace whose bodies are
withheld.
