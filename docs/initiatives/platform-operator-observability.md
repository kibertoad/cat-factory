# Initiative: platform operator observability & alerting

**Status:** planned (tracker only — no slices landed) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Observability today is rich at the **single-run** level — `llm_call_metrics` +
`agent_context_snapshots` (telemetry store), the per-run `ObservabilityPanel.vue`, the
Langfuse sink, the OTel package — but there is **no deployment-level view at all**: no run
success/failure rates, no throughput or duration trends, no failure-kind breakdown
(eviction vs timeout vs agent vs preflight), no gate/CI-fixer attempt statistics, no
container eviction rates, and **no alerting on the platform itself**. Diagnosing "runs have
been failing since yesterday" means ad-hoc SQL against `agent_runs` in the Cloudflare
dashboard (the `investigate-telemetry` skill automates exactly this — evidence the surface
is missing, not that it exists). Note the irony: the product ships a `post-release-health`
gate that watches the _user's_ Datadog for regressions, while cat-factory itself has no
equivalent self-watch.

End state: an **operator dashboard** (aggregate health of the deployment: run outcomes,
durations, failure taxonomy, queue/park depth, spend burn — over time windows) plus
**threshold alerts** ("failure rate > X% over the last hour", "N runs stuck > 30min")
delivered through the existing `NotificationChannel` seam.

## Target pattern

1. **Aggregates in SQL, on data that already exists.** `agent_runs` (both kinds) +
   `llm_call_metrics` already carry outcome, failure kind, timing, and token/cost fields.
   Add rollup read methods to a new kernel `PlatformMetricsRepository`-shaped port
   (`runOutcomesSince`, `failureKindBreakdown`, `durationPercentiles`, `activeAndParkedCounts`
   — each ONE `GROUP BY` query, mirrored D1 ⇄ Drizzle + conformance). Never load rows to
   aggregate in JS (the N+1/aggregate rule).
2. **Retention-aware windows**: telemetry is pruned to `LLM_CALL_METRICS_RETENTION_DAYS`
   (default 3d); `agent_runs` lives longer. Dashboard windows must degrade gracefully where
   telemetry has been pruned (label the window, don't render misleading zeros). If longer
   trend history is wanted, add a small daily rollup table written by the existing
   retention sweep — coordinate with `storage-and-retention.md`'s deferred monthly-rollup
   idea rather than duplicating it.
3. **Surface**: an operator/deployment view (extend `ObservabilityPanel.vue`'s pattern into
   a deployment-scoped panel; charts can start as simple sparkline/bar components already
   used by `StepMetricsBar.vue`). Gate it to account `admin` roles.
4. **Alerting = evaluate + notify, not a new subsystem**: a periodic sweep (Worker
   `scheduled` cron ⇄ Node `setInterval`, runtime-symmetric like every sweeper) evaluates
   configured thresholds against the same rollup port and raises a `platform_health`
   notification through `NotificationService` — which already fans out in-app + Slack (and
   email once the `email-notification-channel` initiative lands). Deduplicate: an alert
   that is still firing re-notifies on state change, not every sweep.

## Prioritized checklist

| #   | Slice                                                                                                                | Status  | PR  |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | Rollup port + D1 ⇄ Drizzle impls (`runOutcomesSince`, `failureKindBreakdown`, `activeAndParkedCounts`) + conformance | ⬜ todo |     |
| 2   | `GET /observability/platform` controller + contracts (windowed aggregate projections; admin-gated)                   | ⬜ todo |     |
| 3   | Operator dashboard panel in the SPA (outcome trend, failure taxonomy, durations; i18n all locales)                   | ⬜ todo |     |
| 4   | Duration percentiles + per-step/gate attempt stats (CI-fixer attempts, gate exhaustion counts)                       | ⬜ todo |     |
| 5   | Threshold alert sweep + `platform_health` notification type (state-change dedup; both runtimes)                      | ⬜ todo |     |
| 6   | Alert threshold config surface (deployment env defaults + settings UI)                                               | ⬜ todo |     |
| 7   | Optional daily rollup table for >3d trends (coordinate with storage-and-retention's deferred rollup)                 | ⬜ todo |     |

## Conventions & gotchas

- **Push counts into SQL** — every dashboard number is a `COUNT`/`GROUP BY`/percentile
  query behind the port; no "list all runs and reduce" anywhere.
- **Telemetry store isolation**: `llm_call_metrics` lives in the dedicated telemetry
  store (`TELEMETRY_DB` D1 ⇄ `telemetry` pg schema); the rollup port must respect that
  split rather than joining across stores.
- **The sweep is a sweeper like the others**: idempotent, cheap when healthy, mirrored on
  both runtimes in the same PR, and visible in the stuck-run-audit taxonomy (don't create a
  new class of silent background failure while building the thing that watches for them).
- **This watches the PLATFORM; `post-release-health` watches the user's release.** Keep the
  vocabularies distinct — reusing the `ReleaseHealthProvider` port here would tangle two
  unrelated concerns.
- Alert copy is notification copy: machine-readable `reason` codes on the wire, i18n
  mapping in the SPA (the `usePipelineErrorToast` pattern).
