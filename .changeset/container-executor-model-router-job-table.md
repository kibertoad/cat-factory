---
'@cat-factory/server': patch
---

Tame `ContainerAgentExecutor.buildJobBody` (Phase 3). The ~416-line method had eight
copy-adjust `agentKind` branches, each rebuilding the same `jobId`/`model`/auth/
`ghToken`/`repo`/`githubApiBase` fields. Extracted two collaborators with no behaviour
change:

- A `ModelRouter` that owns the model-routing policy (the canonical step precedence —
  block pin > workspace per-kind default > env routing — plus the "subscriptions always
  win" override for pooled and individual-usage vendors), decoupling routing from job
  dispatch. `resolveModel`/`isQuotaBased`/`buildJobBody` now delegate to it.
- A shared `common` job-body (built once) + a `resolveAuth` helper (Pi proxy session
  token vs. a leased subscription credential) + a per-kind `buildKindBody` table that
  contributes only each kind's delta. The eight inline bodies collapse to one shared
  base plus small per-kind deltas.

Pure refactor: the dispatched body shape per kind, the `startJob`/`pollJob` and
`RunnerTransport` seam, and all public surface are unchanged. Guarded by a new
per-kind body characterization snapshot test and `ModelRouter` unit tests.
