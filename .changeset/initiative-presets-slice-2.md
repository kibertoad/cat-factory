---
'@cat-factory/orchestration': minor
'@cat-factory/conformance': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Initiative presets — slice 2: the per-run gate-override engine seam.

- **orchestration** (`ExecutionService.start`): a new optional `gatesOverride` argument — one
  boolean per pipeline step, indexed by the pipeline's ORIGINAL step index exactly like
  `pipeline.gates` — that REPLACES the pipeline's declared approval gates for a single run. It is
  copied onto the run's steps (`requiresApproval`, `gatesOverride?.[i] ?? pipeline.gates?.[i]`), so
  a retry/restart — which re-drive the STORED steps — preserve it with no extra persistence. A
  length that doesn't match the pipeline's step count is rejected up front (a `ValidationError`)
  before any side effects. Absent ⇒ today's behaviour byte-for-byte.
- **orchestration** (`InitiativeLoopService`): a spawned item's preset-authored `spawn.gates` is
  threaded straight into `ExecutionService.start` as that run's gate override, so a spawned task
  gates (or doesn't) per the preset's human-review mapping instead of the pipeline default.

Conformance: a new `startExecution` harness probe (start a run through the real `ExecutionService`
with an optional gate override — a path no HTTP route exposes) plus shared assertions that an
override flips a step's approval gate on/off, round-trips `requiresApproval` through each store, and
rejects a mismatched-length override — run identically on the Cloudflare (D1) and Node/local
(Postgres) facades.
