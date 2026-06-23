---
'@cat-factory/orchestration': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Surface the real reason a run failed instead of a generic "the implementation container
reported a failure", and stop the cross-runtime conformance suite from hiding driver bugs.

- **Fix the clobbered failure record.** Two inline gates that already knew the precise
  failure — an unparseable companion (Spec Reviewer) verdict (`companion_rejected`, with
  the companion's raw reply as the detail) and a Tester gate that exhausted its fixer
  budget (`agent`) — recorded a rich `failRun` AND then returned `job_failed`. The durable
  driver (Cloudflare `ExecutionWorkflow` / Node `driveExecution`) treated `job_failed` as
  "fail the run" and fired a SECOND `failRun`, overwriting the good record with a generic
  one: kind `job_failed`, message the literal `"companion_rejected"`, no detail, and the
  misleading "inspect the container logs" hint. Those gates now RETURN the classification +
  detail on the `job_failed` result (`failureKind`/`detail` on `AdvanceResult`), and the
  driver funnels them through the single `failRun` — so the board shows the actual message,
  the precise kind/hint, and the raw reply under "Show detail".

- **`failRun` is now idempotent.** A run already in a terminal `failed` state keeps its
  first (richest) failure rather than being overwritten, so no future
  record-then-return-`job_failed` path can clobber it.

- **Share the production driver loop.** The runtime-neutral per-run driver
  (`driveExecution`) moved into `@cat-factory/orchestration` and is now exported; the Node
  service injects a real `setTimeout` sleep, the Cloudflare workflow wraps the same
  advance/poll calls in durable steps. The cross-runtime conformance harnesses no longer
  hand-roll their own advance/poll loop (which never re-called `failRun` on `job_failed`,
  the gap that let this ship) — both drive runs through the SAME `driveExecution` via a
  shared `driveWorkspace` helper, so the suite exercises real production driving logic. The
  companion-rejected conformance assertion now checks the rich message + stored detail.
