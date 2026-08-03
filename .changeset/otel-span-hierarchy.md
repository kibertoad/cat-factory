---
'@cat-factory/observability-otel': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
---

OTLP traces: arrange a run's spans into a `run → agent kind → generations + tool calls`
hierarchy instead of siblings sharing a trace id, and document the GenAI semantic-convention
coverage explicitly.

Parent ids are derived from the run rather than held anywhere, so a stateless per-call emission
names a parent it has never seen; the parents themselves are emitted once when the run settles,
through the new optional `LlmTraceSink.recordRunSpans`. Generation spans adopt the convention's
`{operation} {model}` name (the agent kind now names the step span above them and still rides as
an attribute), and tool spans become `execute_tool {tool}`, so an existing dashboard filtering on
span name needs re-pointing.
