---
'@cat-factory/app': patch
'@cat-factory/node-server': patch
---

Startup-time optimizations (no behavior change):

- **Node server boot**: run `migrate()` and `pgBoss.start()` concurrently (they touch
  independent schemas) and start the pure-timer background sweepers after the HTTP
  listener binds, so the server accepts requests sooner. The local facade inherits this
  via the shared `start()`.
- **SPA workspace init**: fetch the accounts list and workspace list concurrently instead
  of sequentially on first board load.
- **SPA bundle**: code-split the occasional, store-gated `BlockFocusView`,
  `TaskSourceConnectModal`, `TaskImportModal`, and `RecurringPipelineModal` into their own
  chunks (mounted only while open), matching the existing async-panel pattern.
