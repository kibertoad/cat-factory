---
'@cat-factory/observability-otel': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
---

OTLP traces: arrange a run's spans into a `run → agent kind → generations + tool calls`
hierarchy instead of siblings sharing a trace id, and document the GenAI semantic-convention
coverage explicitly.

Parent ids are derived from the run rather than held anywhere, so a stateless per-call emission
names a parent it has never seen; the parents themselves are emitted when the run settles, through
the new optional `LlmTraceSink.recordRunSpans`. Their extent is folded from stamps the run already
recorded rather than read off a clock, so the terminal hook re-firing for an already-settled run
re-exports a byte-identical tree instead of the same span ids carrying a different duration.

Span names changed, so an existing dashboard filtering on them needs re-pointing. A generation
adopts the convention's `{operation} {model}` (the agent kind now names the step span above it and
still rides as `cat_factory.agent_kind`), a tool call becomes `execute_tool {tool}`, and a run's
root span is the bare `run` with its pipeline as `cat_factory.pipeline`, keeping every span name a
bounded class rather than workspace-authored free text.
