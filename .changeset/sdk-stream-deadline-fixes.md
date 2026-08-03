---
'@cat-factory/sdk': patch
---

Fix what the SDK clients' request deadline bounds, and how live stream frames reach a caller.

The four clients disagreed about a stream's lifetime, and two of them were wrong. Go's per-attempt
`context.WithTimeout` kept running over the response body, so every `Stream` died at `Timeout`
(30s by default) with `context deadline exceeded` on a run that was healthy. Python's reader called
`read(1024)` on urllib's `HTTPResponse`, which blocks until it has 1024 bytes — so no frame reached
the caller until the stream ENDED and they all arrived at once. Both present as the same thing in
production: a run that silently appears to stall.

The deadline now bounds the RESPONSE and never a stream, in all four. That is the correct semantic
for this API rather than a convenience: the deployment writes an SSE frame only when a run's
projection changes, sends no heartbeat, and a parked run waits for a human indefinitely by design,
so a quiet stream is the normal state of a healthy one.

Also in the hand-written halves: a TypeScript caller abort carrying a non-`AbortError` reason is no
longer retried and reported as a connection failure; `close()` on a stream that was never iterated
now actually releases the socket; Java stops emitting duplicate `authorization` headers when a
caller supplies their own, and an unmapped 4xx (402, 413, a status this surface gains later) stays
the base exception instead of being reported as a deployment fault; Go gains the `TimeoutError` the
other three already had; every SDK reads both `Retry-After` wire forms; and an auto-pager that is
handed back the cursor it just sent raises instead of looping forever.

Generated Go parameter names lose a leading-initialism bug that spelled ten published signatures
`Cancel(ctx, iD string)`.
