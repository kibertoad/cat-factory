---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Fix critical/high race conditions from the July 2026 audit:

- **Spend-resume on Cloudflare (1.1):** a spend-paused run's `ExecutionWorkflow`
  instance no longer returns (going terminal). It now stays alive, sleeping between
  budget re-checks, so the run auto-resumes when the budget frees up or `/spend/resume`
  flips it back to `running` — instead of the terminal-instance-id trap that let the
  cron sweeper force-fail the "resumed" run.
- **BootstrapWorkflow re-drive (1.2):** past the poll-read tolerance the workflow no
  longer returns (going terminal, which made the sweeper force-fail a merely-busy
  container). It keeps the instance alive and keeps polling, so a long clone/install
  recovers.
- **One live execution run per block (2.1):** a new partial unique index on live
  execution rows per block (D1 migration `0033` ⇄ Drizzle) plus an atomic
  `ExecutionRepository.insertLive` (ON CONFLICT DO NOTHING) make `start`/`retry`/
  `restartFromStep` reject a genuinely-concurrent double start with a 409 instead of
  creating two live runs — two drivers, two containers — on one branch. Covered by a
  cross-runtime conformance assertion.
