---
'@cat-factory/executor-harness': minor
---

Harness `preview` mode — the long-lived browsable-serve mechanic (slice 5b of the
frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

A new `mode: 'preview'` on the generic agent job clones a `frontend` frame's branch and builds +
serves the app with its other upstreams mocked using the SAME `standUpFrontend` the UI tester uses
— but KEEPS IT RUNNING. No agent runs, and the serve / WireMock child processes are deliberately
NOT torn down when the job returns, so the app stays reachable inside the container until the
container itself is stopped (the transport's explicit stop path, wired in a later slice). The
checkout is cloned into a directory that is NOT auto-removed (the ephemeral preview container
reclaims it), since the served files must outlive the job.

A preview that never comes up (failed build / server never bound) is a hard failure — unlike the
tester's "test what you can" fallback — so the partial stand-up is torn down and its temp checkout
removed, leaking neither processes nor disk. The `preview` result carries the in-container serve
URL (the runtime publishes the serve port to a host port and forms the browsable URL from that).
The success/failure boundary is a pure `buildPreviewOutcome` helper with unit coverage.

Runner image bumped to 1.29.0 (the `src/**` change ships in the image consumed by local/node).
