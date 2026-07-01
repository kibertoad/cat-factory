---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/executor-harness': patch
'@cat-factory/app': patch
---

Recover and surface stalled runs instead of letting them spin `running` forever.

A run whose durable driver was lost (a crashed/restarted orchestrator that left its
pg-boss advance job orphaned-`active`) previously stayed `running` indefinitely with no
error: the Node stale-run sweeper's re-`send` is a silent no-op while the `exclusive`
singleton is still held, so the run was never recovered or flagged.

- **Sweeper now reclaims orphaned advance jobs.** It classifies each stale run's advance
  job by pg-boss's own heartbeat (`live` / `orphaned` / `missing`); an orphaned job (dead
  worker, frozen heartbeat) is deleted to free its singletonKey before re-driving, so a
  bare re-send no longer no-ops onto a dead job. Runs on boot too (immediate reconcile),
  not just on the interval.
- **Hard-stall backstop.** A run orphaned past a deadline (`STALE_RUN_HARD_FAIL_MINUTES`,
  default 60) that recovery can't resume is failed with the new `stalled`
  `AgentFailureKind` — surfaced by the existing failure banner + retry (a new "Run stalled"
  title) instead of spinning silently. Symmetric on the Cloudflare cron sweeper.
- **Orphaned local containers are reaped at boot** — a still-running per-run container
  whose run has since gone terminal/away (its `release()` never ran) is removed, via a new
  `AgentRunRepository.liveRunIds` batch query + a `ContainerRuntimeAdapter.listRunContainers`.
- **Harness structured-repair retries transient failures.** The last-ditch structured-output
  repair call now retries HTTP 429 / 5xx / network errors with exponential backoff honoring
  `Retry-After`, so a transient rate-limit no longer turns a recoverable parse into a hard
  `no structured result` run failure. (executor-harness image bumped to 1.27.5.)

Breaking (internal): `AgentRunRepository.listStale` now returns `StaleAgentRun` (adds
`updatedAt`) and gains `liveRunIds`; both D1 and Drizzle repos implement them.
