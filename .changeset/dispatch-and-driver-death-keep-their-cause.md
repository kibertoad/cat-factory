---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/observability-otel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Keep the cause of a failed dispatch and a dead durable driver, instead of discarding it at the
moment it becomes the only thing anyone wants.

Three sites had the same shape: the record of a failure was written by the thing that only exists
once the failure did not happen.

A run's `diagnostics.lastDispatch` was stamped from the job HANDLE, which `startJob` returns only
after a container has accepted the job. So the two failure classes the block exists to explain, a
container that never started and a preflight rejection like "GitHub not connected", were exactly
the ones that recorded nothing. The block is now opened before the dispatch from what is already
known and refined afterwards by what only the accepted dispatch resolved, and it carries the
dispatch's own failure verdict, which the step also holds but loses to the next retry. Inline
steps stamp one too, naming their backend `inline`: dispatching nowhere is why they stamped
nothing, and the result was a mixed pipeline reporting whatever container step ran last as where
the run was when it died.

The Cloudflare stale-run sweeper answered "the instance was lost, re-create it" for both of its
swallowed error paths, so a Workflows API outage read as every stale run losing its instance at
once and re-drove the fleet with no log line to say why. The lookup now returns a probe over four
states, and the fourth is the point: an instance it could not classify produces no action at all.
Every action the sweep has is destructive against a run that is actually fine, so one unclassified
tick costs a run some recovery latency where a guess costs it its container. Two states were also
reaching the finalize branch by fall-through, Workflows' own `unknown` status and an instance
finishing its work before pausing, and a terminal instance's own error, destructured by nobody,
now reaches the stop reason that until now said only that some driver ended without finalizing
something. An unconfigured workflow binding says so once per isolate rather than reporting the
kind as healthy forever.

The local pooled container poll now passes `postMortem`, the same argument the per-run poll always
did, so a pool member that dies mid-run leaves its exit state and log tail behind rather than the
bare eviction sentinel.

Additive on the public API (`info.version` 1.29.0): `diagnostics.lastDispatch` grows an optional
`failure` object and `executionBackend` one further value. What does change for a consumer is the
population, since a pure-inline run used to answer no diagnostics at all and now answers a block.
A new `sweep.run_state_unknown` operational counter reports what the sweeper could not classify,
which is the one signal that separates a blind sweeper from a healthy one.
