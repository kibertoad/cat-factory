---
'@cat-factory/observability-otel': minor
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
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

A step that dispatched a helper kind (a gate's `ci-fixer`, a Tester's fixer, a two-phase coder's
`fork-proposer`) gets a span for that kind nested under it. Those dispatches are what the helper's
telemetry is tagged with, so without one every generation and tool span they produced would name a
parent nobody emits. The run now records what it dispatched on `PipelineStep.dispatches`, written
through the single `recordDispatchAttribution` funnel.

Cycles are counted rather than separated. A fixer loop, a Ralph iteration and a bounced step all
repeat under one span, and the events beneath it carry no attempt ordinal to split it by, so each
step span states `cat_factory.attempt_count` beside `step_count`. A re-run step's span now starts
from the new `PipelineStep.firstStartedAt`, which survives the reset that re-stamps `startedAt`;
without it the span began after the generations of its own earlier attempts.

Span names changed, so an existing dashboard filtering on them needs re-pointing. A generation
adopts the convention's `{operation} {model}` (the agent kind now names the step span above it and
still rides as `cat_factory.agent_kind`), a tool call becomes `execute_tool {tool}`, and a run's
root span is the bare `run` with its pipeline as `cat_factory.pipeline`, keeping every span name a
bounded class rather than workspace-authored free text.
