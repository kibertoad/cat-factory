---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': patch
---

Stream per-call LLM telemetry while a run is in flight, and stop losing the cause of death when a local container dies mid-run.

A `pr-reviewer` run whose container died 18 minutes in surfaced no slices and no calls — not a subagent-handling regression, but three separate gaps that together made the run unfalsifiable: its telemetry was never written, its container logs were deleted before anyone could read them, and the error it did report described a symptom of the cleanup path rather than the failure.

- **Per-call telemetry now streams.** The harness buffers each model call as its CLI yields it and drains it on the next poll (`RunnerJobView.callMetrics`, drain-on-read like `spans`/`followUps`); `ContainerAgentExecutor.pollJob` records it immediately. It previously arrived only on the terminal `RunnerJobResult.callMetrics`, so a run that died mid-flight reported ZERO calls no matter how many tokens it had spent — precisely the run worth inspecting. Subagent calls stream too, which matters most: that is where a long review spends its tokens and where the parent stream goes quiet.

- **Recording a call twice is now a no-op instead of a duplicate row.** Each metric carries a job-scoped `HarnessCallMetric.seq` stamped by the harness and stable across both channels, so the live drain and the terminal list mint the same `<jobId>-hc-<seq>` id, and `LlmCallMetricRepository.record` ignores an id it already holds (`ON CONFLICT DO NOTHING` on Drizzle, `INSERT OR IGNORE` on D1). First write wins deliberately — an upsert would recompute a row's stored prompt delta against a chain tip that has since moved on. A self-hosted runner pool opts into the live channel with the new `callMetricsPath` response mapping.

- **An exited container no longer blocks its own replacement (local mode).** `DockerRuntimeAdapter.endpoint()` let `docker port`'s non-zero exit ("no public port '8080/tcp' published for …") escape, but `find()` returns exited containers by design and `resolve()` reads an endpoint-less container as absent. The throw therefore skipped the remove-and-recreate recovery in `dispatchPerRun` and surfaced that CLI line as the run's recorded cause of death. A dead container now resolves to `undefined` per the port contract; a fault against a still-RUNNING container still throws, so the spin-up path keeps its fail-fast diagnostic.

- **A container that dies mid-run leaves a post-mortem.** The poll now captures the container's exit state (new `ContainerRuntimeAdapter.exitState()`, including whether the runtime OOM-killed it) plus a tail of its own logs onto the failed view's `detail`, and the engine carries that through `recoverContainerEviction` onto the recorded failure. `release()` removes the container as the run settles, so this was the only surviving record of why the harness process went away — and it was being thrown away. Container logs were previously captured only on the spin-up path, never for a container that died after a healthy start.

Not addressed here: a PR review's `slices` are still written only when the reviewer job completes, so a killed review still shows none. That is a work-product persistence change, not an observability one.
