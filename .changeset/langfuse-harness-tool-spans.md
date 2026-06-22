---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Extend the Langfuse observability to the nested **tool-span tree**: each container
agent's tool calls now surface as child spans under its run's trace, completing the
generation tree.

The harness buffers a compact, metadata-only `ToolSpan` (`{tool, startedAt, endedAt,
ok}` — never tool args/results) per completed Pi tool call and returns the batch on its
existing `GET /jobs/{id}` poll with **drain-on-read** semantics (each poll returns the
spans since the last poll and clears the buffer). No new network from the container, no
hot-path work — only in-memory accumulation bounded to one poll interval, so OOM risk is
nil. `ContainerAgentExecutor.pollJob` forwards each drained batch to the trace sink as
child spans (`jobId === executionId`, so they nest under the same trace as the LLM
generations). Best-effort and fully isolated — a sink failure never affects the job
lifecycle.

Bumps the `@cat-factory/executor-harness` image tag (1.2.0 → 1.3.0); a deploy is needed
to roll out the harness change. The self-hosted runner-pool path (arbitrary,
manifest-driven APIs) gracefully yields no tool spans; the Cloudflare-container and
local-Docker paths carry them through automatically.
