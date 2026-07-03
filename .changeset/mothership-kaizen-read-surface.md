---
'@cat-factory/server': patch
---

mothership: allow-list the Kaizen grading read surface

In mothership mode the Kaizen SCREEN (`KaizenController` → `KaizenService.getOverview` /
`listForExecution`) was not functional over `/internal/persistence`: the run-path grade
reads/writes (`kaizenGradingRepository.getByStep`/`upsert`,
`kaizenVerifiedComboRepository.getByKey`) were remotely callable, but the screen's list reads
came back `unknown_method`, so a mothership-mode SPA could not display the grading history, the
verified-combo library, or a run's per-step grading status. This widens
`REMOTE_PERSISTENCE_METHODS` with the screen's reads, each workspace-scoped on arg0 (the existing
`workspace` rule), read-only and member-level (the Kaizen endpoints are not admin-gated):

- `kaizenGradingRepository.listByWorkspace` — the Kaizen screen's bounded grading history.
- `kaizenGradingRepository.listByExecution` — the run-window per-step grading status.
- `kaizenVerifiedComboRepository.listByWorkspace` — the verified-combo library.

Still off the SPA path: the internal-only single-grade `kaizenGradingRepository.get` (the service
never calls it), the background-sweep reads (`listPending`/`claim`, kind-spanning cron), and the
combo `upsert` (the streak/verified write) — kaizen GRADING itself is best-effort in mothership
mode until the Phase 5 telemetry/local-first sync, but the screen that VIEWS prior grades now reads
them over the RPC. These are core repositories (`createDrizzleRepositories`), so a mothership-mode
node already sources them from the full-surface remote registry (`composeMothership`) when `db` is
undefined — an allow-list change only, symmetric by construction (the dispatcher reflects over each
facade's registry).
