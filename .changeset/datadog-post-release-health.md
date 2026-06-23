---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
---

Datadog post-release-health gate + Agent-On-Call.

After a release ships, a new **`post-release-health`** polling gate (the last step of
the standard pipelines, after `merger`) watches the team's Datadog **monitors/SLOs** over
a monitoring window. It reuses the existing gate machinery (`ci`/`conflicts`): a clean
window advances with nothing spun up; a regression escalates — Datadog credentials stay on
the backend and never enter containers.

- **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
  that clones the base branch (the merged release; the work branch is deleted on merge),
  locates the merged commit and correlates its diff with the regression evidence (alerting
  monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
  `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
  engine raises a **`release_regression`** notification for a human to decide. The gate only
  engages once the PR actually merged, attributes only post-release alerts (not pre-existing
  ones) to the release, and honours the full configured watch window even when it outlasts a
  single poll budget.
- **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
  a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
  `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
  API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
- **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
  (default 1) bound the watch window + on-call dispatches.
- **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
  re-alert (they already page off the same monitors/SLOs) — instead the on-call
  investigation is posted onto an incident they already opened (annotate, never duplicate),
  behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
  human-facing `release_regression` notification.
- Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
  columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
- New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

**Breaking (pre-1.0, acceptable):** the standard seeded pipelines gain a trailing
`post-release-health` step and `merge_threshold_presets` gains two columns — stale rows are
re-seeded with the defaults.
