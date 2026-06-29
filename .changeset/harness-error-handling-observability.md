---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
---

Harness error handling & observability: structured failure cause, stuck-run diagnosis, and transient API retry.

- **Structured failure cause.** The executor-harness now reports a structured `failureCause`
  (`inactivity-timeout` | `max-duration` | `agent` | `git` | `api` | `no-usable-output` |
  `no-changes`) and an extended `detail` on a failed job view, alongside the existing one-line
  `error`. The backend prefers the structured cause to classify a failure (→ `AgentFailureKind`
  / `BootstrapFailureKind`) and falls back to the existing error-string regex when it's absent
  (older image), so the change is backward compatible. Container eviction stays facade-detected
  (the harness never emits the eviction marker). The watchdog phrases are centralized so they
  can't drift from the regex that still reads them as a fallback.
- **Stuck-run diagnosis.** An inactivity kill now reports which phase was hung and the last tool
  that ran (e.g. "...likely hung in agent phase; last tool bash 40s ago"), with a per-phase
  timing breakdown in `detail` and on the failure log. A per-job child logger binds the run's
  correlation fields (jobId/repo/branch/kind) onto every line.
- **Transient API retry.** Opening a PR/MR now retries a transient upstream failure (5xx / 429 /
  network) with bounded, abort-aware exponential backoff (honoring `Retry-After`), so a momentary
  blip no longer fails an otherwise-complete run. The 422/409 "already exists" success paths are
  unaffected.
- **Surfaced silent degradation.** Checkpoint-push failures, dropped follow-up lines, malformed
  Pi JSONL records, and SIGKILL escalation are now logged at warn with counts instead of being
  swallowed. A final non-newline-terminated Pi event is flushed so its progress/span isn't lost.

Bumps the `@cat-factory/executor-harness` image to `1.22.0` (and the matching tag in
`deploy/backend`).
