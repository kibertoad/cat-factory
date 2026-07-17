# Initiative: platform operator observability & alerting

**Status:** in progress (read-path dashboard + OpenTelemetry export landed; alerting pending) · **Owner:** core · **Started:** 2026-07-16

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

| #   | Slice                                                                                                                | Status  | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 1   | Rollup port + D1 ⇄ Drizzle impls (`runOutcomesSince`, `failureKindBreakdown`, `activeAndParkedCounts`) + conformance | ✅ done | #1157   |
| 2   | `GET /observability/platform` controller + contracts (windowed aggregate projections; admin-gated)                   | ✅ done | #1157   |
| 3   | Operator dashboard panel in the SPA (outcome trend, failure taxonomy, durations; i18n all locales)                   | ✅ done | #1157   |
| 4a  | Duration percentiles (p50/p90/p99) on `durationStatsSince` (D1 ⇄ Drizzle parity) + dashboard render                  | ✅ done | #1165   |
| 4b  | Per-step/gate attempt stats (CI-fixer attempts, gate exhaustion counts) — needs a queryable gate-attempt projection  | ⬜ todo |         |
| 5   | Threshold alert sweep + `platform_health` notification type (state-change dedup; both runtimes)                      | ⬜ todo |         |
| 6   | Alert threshold config surface (deployment env defaults + settings UI)                                               | ⬜ todo |         |
| 7   | Optional daily rollup table for >3d trends (coordinate with storage-and-retention's deferred rollup)                 | ⬜ todo |         |
| 8   | Export the aggregates via OpenTelemetry (periodic OTLP gauge push, per account; both runtimes)                       | ✅ done | this PR |

### What slice 8 (OpenTelemetry export) shipped

The read-path dashboard is a pull surface (an admin loads it). Slice 8 adds the **push**
counterpart for the deployment operator: a periodic, runtime-symmetric sweep (Worker
`scheduled` cron ⇄ Node interval, exactly like the retention sweeps) that computes the SAME
`PlatformObservability` projection per account and pushes it to any OTLP/HTTP backend as
OpenTelemetry **gauge** metrics — so the operator watches run outcomes / failure taxonomy /
live depth / duration percentiles in Grafana/Datadog/etc. The dual of `post-release-health`,
which watches the _user's_ release; this watches the platform.

- **Reuses the existing account-scoped read** (`PlatformObservabilityService.summarize`) — no
  new SQL, no port change, no deployment-wide/null-account query (which the account-isolated
  conformance suite couldn't test anyway). Accounts are enumerated from the workspace
  projection (`listVisible(null)` → `distinctAccountIds`), the same shape the artifact-retention
  sweep uses to enumerate tenants — NOT a per-row N+1.
- **Exporter** (`PlatformMetricsOtelExporter` in `@cat-factory/observability-otel`) is the
  **fetch transport on both runtimes** — the platform push is a stateless snapshot POST, so it
  needs no `@opentelemetry/*` SDK counterpart (mirrors the Langfuse fetch-on-both shape). Gauge
  points carry `cat_factory.account_id` (bounded tenant scope) + `cat_factory.window`; the pure
  mapping lives in `mapping.ts` alongside the per-call metric mapping. The runtime-neutral
  `sweepPlatformMetrics` driver lives in `@cat-factory/orchestration`.
- **Opt-in on top of the base OTel exporter** (`OTEL_PLATFORM_METRICS=true`, since it adds
  recurring DB rollup load); off ⇒ no sweep, no emission. `OTEL_PLATFORM_METRICS_WINDOW` +
  (Node) `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it; the Worker is cron-driven.
- **Mothership caveat** carries over: mothership-mode local nodes skip the Postgres-backed
  sweeps (their own scheduler owns them), so the OTel push runs on the DB-backed Node/Worker
  deployments — consistent with where the dashboard read is intended.

### Why slice 4 was split (4a done, 4b deferred)

The original slice 4 bundled duration percentiles with per-step/gate attempt stats. They
turned out to be two different modelling problems:

- **4a (percentiles) is a clean SQL rollup** over the SAME `agent_runs` columns the rest of
  the dashboard reads, so it fits the "one aggregate query, mirrored D1 ⇄ Drizzle +
  conformance" pattern exactly. Shipped: `durationStatsSince` now also returns discrete
  (nearest-rank) p50/p90/p99. Postgres uses `percentile_disc`; SQLite (no percentile
  aggregate) uses the `row_number()/count()` cumulative-fraction order-statistic workaround.
  The conformance suite seeds a known distribution and pins that both dialects return the
  same values.
- **4b (gate/CI-fixer attempt stats) is NOT cleanly SQL-aggregatable today.** Gate attempts
  (`attempts` / `attemptLog`) and CI-fixer/exhaustion state live INSIDE the per-run `detail`
  JSON blob (`steps[].gate.*`), not in queryable columns. Rolling them up in SQL would mean
  dialect-divergent JSON-array expansion (`json_each` vs `jsonb_array_elements`) reaching into
  the internal step-serialization shape — a fragile coupling that violates "clean over quick"
  and the one-GROUP-BY rule. The right shape is a dedicated **queryable gate-attempt
  projection** (a small telemetry-style table written when a gate round settles, mirrored on
  both runtimes) that these rollups then GROUP BY — a self-contained slice that touches the
  gate machinery, kept separate from the percentiles read.

## What the read-path PR (slices 1–3) shipped

- **Scope is per-ACCOUNT, not global.** `requireAdmin` is account-scoped and there is no
  superadmin, so the port + route take an `accountId` and filter `agent_runs` via a
  `workspace_id IN (SELECT id FROM workspaces WHERE account_id = ?)` sub-select — tenancy-correct
  on both single-account (Node/local) and multi-account (mothership) deployments. The route lives on
  the accounts contract file: `GET /accounts/:accountId/observability/platform?window=1h|24h|7d`.
- **Single store.** The port reads ONLY `agent_runs` (main DB) — outcome/failure/timing all live
  there — so it never crosses into the telemetry store. Token/cost rollups (which need
  `llm_call_metrics`) are deferred to a later slice with its own store-local read.
- **Port methods delivered:** `runOutcomesSince`, `runOutcomeTrend` (bucketed for the sparkline),
  `failureKindBreakdown`, `activeAndParkedCounts`, and `durationStatsSince` (avg/min/max/count in
  the read-path PR; **slice 4a** extended it with discrete p50/p90/p99 percentiles — see below).
- **Wiring:** `PlatformMetricsRepository` (kernel) ⇄ `D1PlatformMetricsRepository` /
  `DrizzlePlatformMetricsRepository` (in `drizzle/execution.ts`) + `definePlatformMetricsSuite`
  conformance on both runtimes; `PlatformObservabilityService` (orchestration, on `Core`) +
  `PlatformObservabilityController` (server, admin-gated); SPA `platformObservability` store + API +
  `OperatorDashboardPanel.vue` + sidebar entry (admin-only), i18n in all 10 locales.
- **Mothership caveat:** a mothership-mode local node (no DB, RPC-backed repos) would 503 the
  dashboard until the platform-metrics reads are added to the persistence-RPC allow-list — not wired
  here since the dashboard is intended for the DB-backed (hosted) deployment. Follow-up if needed.

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
