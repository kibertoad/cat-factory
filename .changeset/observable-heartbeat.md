---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/app': patch
---

observability: forward the container agent's liveness heartbeat so a quiet-but-alive run stops looking wedged.

A long, output-less phase — a `pr-reviewer` reading hundreds of files, say — advances the harness heartbeat but not its subtask counts. That heartbeat was dropped at the transport boundary: `ContainerAgentExecutor.pollJob` forwarded phase/progress/follow-ups but never `view.heartbeatAt`, so `agent_runs.updated_at` only moved on a progress change. A live-but-quiet run was indistinguishable from a wedged one to the DB, the stale-run sweeper (keys off `updated_at`), and the UI (a client clock off `startedAt`, not a server liveness signal). This is the observable-heartbeat gap ADR 0026 P3 named (its D2.1/D3 restored progress + the watchdog heartbeat, not the observable one).

`RunnerJobView` now carries `heartbeatAt` (Cloudflare/local cast the harness view verbatim; the runner pool maps an optional `heartbeatPath`), `pollJob` forwards it as the running `AgentJobUpdate.lastActivityAt`, and the engine folds it onto the step's new `lastActivityAt` **throttled** (`shouldPersistActivity`, a 20s window well under the 5-min sweeper lease) — so a live-but-quiet run keeps `updated_at` fresh while a wedged run's frozen heartbeat correctly lets it go stale. The field rides the step JSON, so both runtimes persist it with no migration. The SPA surfaces "active Ns ago" in `StepRunMeta` (and thus the PR-review window), distinct from the elapsed clock. No harness change (the `heartbeatAt` field already exists), so no image bump.
