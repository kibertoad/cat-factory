---
'@cat-factory/executor-harness': patch
'@cat-factory/worker': patch
---

Clean up the now-stale error-string classifier comments (deferred tail of error-message coverage I5).

The string-fallback classifiers (`classify{Agent,Bootstrap,Repair}Failure`) were deleted in I5, so
the harness comments claiming the watchdog abort phrases (`no agent activity`, `max duration`)
"MUST stay stable" because they're regex-matched downstream are no longer true — the backend now
classifies purely on the structured `FailureCause` the harness already emits. Reworded
`failure.ts` / `runner.ts` to say the abort wording is human-readable only and free to change; the
one phrase that stays load-bearing is the facade-owned eviction sentinel
`(container evicted or crashed)`, matched by `isContainerEvictionError` for a dispatch-time throw
that carries no job view.

Also fixed the stale inline comment in the Cloudflare transport's 404 branch (worker facade) that
still claimed the eviction string is regex-classified by the bootstrap flow — it now reads the
structured `evicted` field.

Harness image bump (comment-only `src/**` edit, but any `src/**` change re-tags the image): the
emitted bytes are unchanged, so this is a byte-identical republish that carries the version through
the runner-image-tag pins.
