---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/conformance': patch
---

Give every request and every container job a correlation id.

Both facades now mount a shared request middleware as their FIRST middleware — ahead of CORS and
the per-request container build, so a CORS denial and the Worker's misconfiguration fallback are
covered too. It adopts a bounded, safe `X-Request-Id` from the caller or mints one, echoes it on
the response, puts it in **every error envelope**, binds `{ requestId, method, path }` on a
request-scoped child logger, and emits one line per request: `info` on success, `warn` on a 4xx
(naming the mapped error code), `error` on a 5xx. Previously only unexpected 500s were logged at
all, so a 4xx spike — a validation regression, an RBAC denial, a conflict loop — left no
server-side trace and a user report had nothing to join against. `/health` and `/ready` drop to
`debug` when they succeed, so an orchestrator's probes don't bury the request stream.

`X-Request-Id` is allow-listed inbound (so a caller that already has an id propagates it rather
than the backend minting a second one for the same request) and newly EXPOSED outbound, so a
browser can read it off the response.

The **misconfiguration fallback backend** is covered on every facade. The Worker inherits the
middleware because it serves the fallback from inside `createApp`, but Node/local swap in the
whole `createMisconfiguredApp` — so that app mounts it itself, or the one deployment shape an
operator is actively debugging is the only one serving requests with no id and no request line.

Across the workflow↔container seam, `workspaceId` and `executionId` now ride the agent job body
and the harness binds them onto its per-job logger beside `jobId` — the two halves of a run
previously shared no id and were stitched only by a job-id naming convention. This covers EVERY
dispatcher of the `agent` kind, not just the execution path: `ContainerRepoBootstrapper` and
`ContainerEnvConfigRepairer` hand-build their bodies, and a bootstrap is a first-class agent run
(same table, same retry surface), so leaving them out would have left their containers' logs
joinable to nothing. Neither has a separate execution row, so the job id doubles as the run id.

`ContainerAgentExecutor` gained a bound logger and logs the seam's transitions (dispatched /
dispatch-failed / poll-failed / running at `debug` / settled). A dispatch OR poll that throws is
now reported: those are the failure classes nothing downstream can account for, because the job
either never gets a handle or the transport fault is recorded against no job at all.

Only the request PATHNAME is ever logged, never the raw URL, and a client-supplied id is refused
unless it is short and `[\w\-=]+` — both are untrusted text going straight into a log stream, and
query strings carry the WebSocket `?ticket=` and OAuth `?code=`. An unexpected fault's STACK is
scrubbed with `redactSecrets` in its own right, not just its message: a stack's first line is
`Error: <message>` verbatim, so attaching it raw beside the scrubbed `err` would republish
exactly what the scrub just removed.
