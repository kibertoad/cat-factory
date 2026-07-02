---
'@cat-factory/executor-harness': patch
---

Native local mode (Windows): make ephemeral agent-workspace teardown best-effort

`withWorkspace` removed its temp checkout with a bare `rm` inside a `finally`. On Windows
native execution (`LOCAL_NATIVE_AGENTS`) a just-exited child — git, or the developer's own
`claude`/`codex` CLI — can still hold a transient handle on a file in the checkout, so the
`rm` throws `EBUSY: resource busy or locked, rmdir '…/agent-XXXXXX'`. Running in the
`finally`, that throw propagated out and failed an otherwise-successful agent step.

Teardown is now resilient: it retries via `fs.rm`'s Windows backoff (`maxRetries`/
`retryDelay`) and, if the directory still can't be removed, logs a warning and swallows the
error. A leaked temp dir is harmless (the OS reclaims the temp root); failing the run is not.
