---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Structured, elaborated container/runner dispatch failures (error-message coverage initiative,
items D1/I2). A `dispatch()` rejection used to throw a bare `Container dispatch failed (HTTP n)`
string that named the symptom but not the cause, and downstream consumers decided "was this a
dispatch failure?" by regex-matching `/dispatch failed/i` — so error IDENTITY rode a string, and a
self-hosted-pool fault (`Runner pool … → <status>`, a different wording) fell through and was
mislabelled a `preflight` error.

- **I2** — new kernel `DispatchError` (`domain/dispatch-errors.ts`) carries the HTTP `status` as a
  structured field, thrown by every transport `dispatch()`: `CloudflareContainerTransport`,
  `KubernetesRunnerTransport`, the local `postHarnessJob` (both local transports), and
  `RunnerPoolTransport` (which re-wraps the pool provider's `RunnerPoolApiError`, carrying its
  status). `BootstrapService`, `EnvConfigRepairService`, and the execution engine
  (`classifyDispatchFailure`) now classify via `instanceof` / the `isDispatchFailure` extractor,
  with the legacy `/dispatch failed/i` message shape kept only as a fallback. This fixes the pool
  dispatch fault being mislabelled `preflight`.
- **D1** — a 404 from the harness `/jobs` route (the deployed executor-harness image predates the
  route because its tag was never bumped, so new containers run stale code) now elaborates with the
  stale-image cause + the republish-under-a-fresh-tag remedy and a link to the release rules. The
  raw `<label> dispatch failed (HTTP n): <body>` first line is preserved verbatim (still greppable,
  still matched by the fallback regex); the cause + remedy is only appended.

No behaviour changes beyond error message text and failure classification. No executor-harness
image change (the dispatch signal is minted by in-repo transports).
