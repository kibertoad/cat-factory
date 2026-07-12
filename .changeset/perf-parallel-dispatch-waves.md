---
'@cat-factory/server': patch
---

perf(dispatch): fan out independent dispatch I/O in one wave (perf item 4)

`ContainerAgentExecutor.buildJobBody` resolved the per-dispatch inputs one after another —
installation-token mint → work-branch ensure → auth → package registries → tester secrets →
web-search availability — so every step dispatch (and every tester→fixer re-dispatch epoch)
paid ~6 serial GitHub/DB round-trips of latency. Once the repo target is resolved these are
mutually independent, so they now run in a single `Promise.all` wave (the repo-scoped token
mint + work-branch ensure alongside the workspace/block-scoped auth / registries / secrets /
web-search). The apriori/work-branch resolution moved into a `resolveWorkBranchReady` helper so
it fits the wave with unchanged behaviour. The best-effort `agentContextObservability.record`
stays awaited (with a swallowing `catch`) — it runs after the container job is already
dispatched, so it is off the container's critical path, and a bare fire-and-forget `void` would
be silently dropped on the Worker once the isolate hibernates on the next durable sleep. Per-kind
job-body shapes are byte-identical.
