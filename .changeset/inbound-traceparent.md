---
'@cat-factory/kernel': minor
'@cat-factory/observability-otel': minor
'@cat-factory/server': minor
---

Join the platform's telemetry to a caller's own distributed trace.

`mountRequestLogging` now adopts an inbound W3C `traceparent`, binding `traceId`/`spanId` onto
the request-scoped logger so an SDK client or gateway already collecting a trace sees this
deployment's log lines inside it rather than beside it. A line naming a RUN still takes that
run's derived trace id: that derivation is the only thing joining a run's logs to its spans, and
nothing else asserts it, so the caller's context fills in everywhere else (which is most of what
an API request emits). The header is untrusted, so the parse admits only the exact fixed-width
hex grammar and refuses the spec's all-zero sentinels; malformed means ignored, never a refused
request.

Not shipped, deliberately, after weighing it: exporting COST over OTLP. It is derived data
(`tokens x rates`) in a store that cannot reprice it, so a corrected rate table would leave
history permanently wrong with nothing marking it, and it would sit beside `SpendService` as a
second answer for money, at a grain that drops `workspace_id` and therefore can never be
reconciled against what anyone is billed. The exporter carries the observed facts a downstream
consumer prices FROM instead: the model, the three input token classes kept apart, and the
output count. The reasoning is recorded in the README's not-emitted list so it is not
re-proposed.
