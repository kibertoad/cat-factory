---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Fix critical/high race conditions from the July 2026 audit:

- **Spend-resume on Cloudflare (1.1):** a spend-paused run's `ExecutionWorkflow`
  instance no longer returns (going terminal). It now stays alive **parked on a
  `waitForEvent`** (like a human-decision wait, not a busy sleep-loop), so a long pause
  no longer accretes unbounded durable steps. `/spend/resume` wakes it immediately via a
  new `WorkRunner.signalResume` (a `spend-resume` event), and a 24h re-check chunk
  auto-resumes it when the monthly budget frees — instead of the terminal-instance-id
  trap that let the cron sweeper force-fail the "resumed" run.
- **Spend-resume on Node/local (parity):** Node/local now auto-resume spend-paused runs
  when the monthly budget frees, via a new `agentRunRepository.listPausedExecutions`
  polled by the reclaim sweeper (gated on `isOverBudget`, so a still-exhausted workspace
  causes no churn) — matching the Cloudflare facade. Covered by a conformance assertion.
- **BootstrapWorkflow re-drive (1.2):** past the poll-read tolerance the workflow no
  longer returns (going terminal, which made the sweeper force-fail a merely-busy
  container). It keeps the instance alive and keeps polling, so a long clone/install
  recovers.
- **One live execution run per block (2.1):** a new partial unique index on live
  execution rows per block (D1 migration `0033` ⇄ Drizzle) plus an **atomic**
  `ExecutionRepository.insertLive` that deletes the block's terminal rows (and the
  caller's own `replaceId`) and inserts the new run **in one transaction** (D1
  `db.batch` / Drizzle `transaction`). `start`/`retry`/`restartFromStep` no longer
  `deleteByBlock` first, so a genuinely-concurrent double start is rejected with a 409
  instead of the pre-delete wiping a concurrent winner and creating two live runs — two
  drivers, two containers — on one branch. Covered by cross-runtime conformance
  assertions (terminal cleanup + `replaceId` supersede).
