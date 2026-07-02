---
'@cat-factory/worker': patch
---

Stuck-run audit — Group A (Cloudflare recovery correctness): fix three ways a Worker run
could be wrongly killed instead of resumed.

- **F1** — the cron run-sweeper's hard-stall deadline now measures time-OBSERVED-orphaned via
  a per-isolate `orphanedSince` clock (mirroring the Node sweeper), not raw lease age. A cron
  outage / deploy freeze longer than the hard-stall window no longer fails a recoverable run on
  the first post-outage tick; every orphan gets at least one re-drive attempt first.
- **F2** — `BootstrapWorkflow` / `EnvConfigRepairWorkflow` no longer return (making the
  Workflows instance terminal) on a transient poll-read failure. A terminal instance for a
  still-`running` job was being finalized as STOPPED by the sweeper, failing a bootstrap that
  was merely slow or briefly unreachable. They now keep the instance alive and keep polling; a
  genuinely vanished container still surfaces as a 404→`failed` poll result.
- **F5** — each workflow's per-wake DI construction is retried with durable sleeps
  (`buildWorkflowRuntime`) so a transient throw can't kill a parked (`blocked`) instance
  terminally and discard the human's resolved decision. A persistent misconfiguration still
  fails loudly after the retries.
