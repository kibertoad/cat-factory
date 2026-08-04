# Initiative: platform operator observability & alerting

**Status:** COMPLETE (every slice landed; convert to an ADR on the next pass) · **Owner:** core · **Started:** 2026-07-16

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

Observability today is rich at the **single-run** level: `llm_call_metrics` +
`agent_context_snapshots` (telemetry store), the per-run `ObservabilityPanel.vue`, the
Langfuse sink, the OTel package, but there is **no deployment-level view at all**: no run
success/failure rates, no throughput or duration trends, no failure-kind breakdown
(eviction vs timeout vs agent vs preflight), no gate/CI-fixer attempt statistics, no
container eviction rates, and **no alerting on the platform itself**. Diagnosing "runs have
been failing since yesterday" means ad-hoc SQL against `agent_runs` in the Cloudflare
dashboard (the `investigate-telemetry` skill automates exactly this: evidence the surface
is missing, not that it exists). Note the irony: the product ships a `post-release-health`
gate that watches the _user's_ Datadog for regressions, while cat-factory itself has no
equivalent self-watch.

End state: an **operator dashboard** (aggregate health of the deployment: run outcomes,
durations, failure taxonomy, queue/park depth, spend burn; over time windows) plus
**threshold alerts** ("failure rate > X% over the last hour", "N runs stuck > 30min")
delivered through the existing `NotificationChannel` seam.

## Target pattern

1. **Aggregates in SQL, on data that already exists.** `agent_runs` (both kinds) +
   `llm_call_metrics` already carry outcome, failure kind, timing, and token/cost fields.
   Add rollup read methods to a new kernel `PlatformMetricsRepository`-shaped port
   (`runOutcomesSince`, `failureKindBreakdown`, `durationPercentiles`, `activeAndParkedCounts`:
   each ONE `GROUP BY` query, mirrored D1 ⇄ Drizzle + conformance). Never load rows to
   aggregate in JS (the N+1/aggregate rule).
2. **Retention-aware windows**: telemetry is pruned to `LLM_CALL_METRICS_RETENTION_DAYS`
   (default 3d); `agent_runs` lives longer. Dashboard windows must degrade gracefully where
   telemetry has been pruned (label the window, don't render misleading zeros). If longer
   trend history is wanted, add a small daily rollup table written by the existing
   retention sweep: coordinate with `storage-and-retention.md`'s deferred monthly-rollup
   idea rather than duplicating it.
3. **Surface**: an operator/deployment view (extend `ObservabilityPanel.vue`'s pattern into
   a deployment-scoped panel; charts can start as simple sparkline/bar components already
   used by `StepMetricsBar.vue`). Gate it to account `admin` roles.
4. **Alerting = evaluate + notify, not a new subsystem**: a periodic sweep (Worker
   `scheduled` cron ⇄ Node `setInterval`, runtime-symmetric like every sweeper) evaluates
   configured thresholds against the same rollup port and raises a `platform_health`
   notification through `NotificationService`, which already fans out in-app + Slack (and
   email once the `email-notification-channel` initiative lands). Deduplicate: an alert
   that is still firing re-notifies on state change, not every sweep.

## Prioritized checklist

| #   | Slice                                                                                                                | Status  | PR      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 1   | Rollup port + D1 ⇄ Drizzle impls (`runOutcomesSince`, `failureKindBreakdown`, `activeAndParkedCounts`) + conformance | ✅ done | #1157   |
| 2   | `GET /observability/platform` controller + contracts (windowed aggregate projections; admin-gated)                   | ✅ done | #1157   |
| 3   | Operator dashboard panel in the SPA (outcome trend, failure taxonomy, durations; i18n all locales)                   | ✅ done | #1157   |
| 4a  | Duration percentiles (p50/p90/p99) on `durationStatsSince` (D1 ⇄ Drizzle parity) + dashboard render                  | ✅ done | #1165   |
| 4b  | Per-step/gate attempt stats (CI-fixer attempts, gate exhaustion counts): needs a queryable gate-attempt projection   | ✅ done | this PR |
| 5   | Threshold alert sweep + `platform_health` notification type (state-change dedup; both runtimes)                      | ✅ done | landed  |
| 6   | Alert threshold config surface (env defaults + the per-account settings UI)                                          | ✅ done | this PR |
| 7   | Daily rollup table for >3d trends (the `30d`/`90d` windows), written by the retention sweep                          | ✅ done | this PR |
| 8   | Export the aggregates via OpenTelemetry (periodic OTLP gauge push, per account; both runtimes)                       | ✅ done | landed  |

### What slices 4b, 6 and 7 shipped (and the alert deep-link)

**4b, the settled-gate projection.** The blocker was never the rollup; it was that a gate's
`attempts` / `attemptLog` live INSIDE the run's `detail` JSON blob as `steps[].gate.*`, where no
`GROUP BY` reaches without dialect-divergent JSON-array expansion over the engine's internal step
serialization. So the engine now writes ONE flat row per gate that reaches a terminal verdict
(`gate_outcomes`, kernel `GateOutcomeRepository`, D1 ⇄ Drizzle + conformance), and the statistic is
an ordinary aggregate over columns.

- **One row per settled GATE, not per attempt.** The per-round history is already durable on the
  step and is what the run UI reads; what an operator cannot otherwise ask is how a gate ENDED and
  how much helper work it took, which is one row's worth of facts.
- **The row id is DERIVED** (`<runId>:<stepIndex>:<outcome>`), not minted, because the durable
  drivers replay: a minted id would turn one settle into two rows and inflate every number the
  table exists to report. A step re-run that ends DIFFERENTLY still records its own row.
- **`cleanPasses` is reported apart from `passed`**: a gate the precheck satisfied with nothing
  spun up versus one the fixer got green on the third try are the same `passed` and completely
  different platform health. Same reasoning splits `helperFailures` (the fixer's own job crashed)
  from the rest of `attempts` (it ran and left the check red): a platform fault versus a product one.
- It is in the MAIN store beside `agent_runs`, not the telemetry store, so it is account-scoped
  through the same `workspaces` sub-select as every other platform rollup rather than needing a
  cross-store join or a workspace-id list threaded through the read.

**7, the daily rollup.** `platform_run_days` (one row per workspace / UTC day / status / failure
kind) is materialised by the retention sweep on both facades and serves the two NEW windows,
`30d` and `90d`. It is REWRITTEN in place over a short trailing lookback rather than appended, so
the still-accruing day is corrected on each pass and a missed pass self-heals.

Two things about that were wrong in the first cut and are worth carrying forward. An UPSERT is not
a rewrite: `agent_runs.status` mutates in place while `created_at` stays put, so a pass that ran
mid-day leaves a `(day, 'running')` bucket the next pass's `SELECT` no longer produces and
`DO UPDATE` never touches, and the orphan then double-counts that run until retention. The pass
therefore DELETEs its window and re-inserts it in one transaction. And the rollup's COVERAGE is a
fact about the sweep, so it is recorded by the pass (`platform_rollup_state`, deployment-scoped,
forward-only, written in that same transaction) rather than derived as `max(day_start)`, which
reports the last day something HAPPENED and so reads a quiet account as a lagging sweep and a new
account as a rollup that never ran.

The projection SAYS which store answered (`source`) and how far the sweep has covered
(`rolledUpThrough`), because an un-materialised rollup and an idle quarter produce the same empty
series and are opposite facts. The dashboard renders "no rollup yet" / "the rollup is behind" /
"complete through <date>" rather than 90 days of confident zeros. Coordinated with
`storage-and-retention.md` §1b.

**6, the settings surface.** The alert ceilings now layer per account:
`config.platformAlerts` on the existing account-settings row (no migration), merged over the
env-derived deployment defaults by the pure `resolveAccountAlertConfig`. Two rules make it work:
ABSENT INHERITS and never means zero (a zero is a live setting here: `minStalledPriorRuns: 0`
says "page even on an idle window"), which is why the editor keeps blank and `0` apart end to end
and sends only the fields an admin filled in; and `enabled` is a ONE-WAY switch, because the env
var decides whether the sweep runs at all and no stored row can start a timer that was never
started. An unreadable settings row costs the account its OVERRIDES, not its alerting.

**The alert deep-link.** A `platform_health` card now carries the failing runs it aggregated
(`payload.platformFailingRuns`, capped per workspace by a window function so a noisy workspace
cannot starve another's card, plus `platformFailedTotal` so the cap states what it dropped). That
is only safe because the sweep now raises on a STATE CHANGE rather than every pass: it compares the
open card's stored reason set to the one now firing and skips entirely when they match, so a
volatile run list on the payload no longer re-toasts the inbox for the length of an incident. The
links are omitted entirely (not sent empty) for a condition with no failing run behind it, and
the evidence read is best-effort inside its own catch, because the deep link is an enhancement and
the ALERT is the thing that matters.

### What slice 8 (OpenTelemetry export) shipped

The read-path dashboard is a pull surface (an admin loads it). Slice 8 adds the **push**
counterpart for the deployment operator: a periodic, runtime-symmetric sweep (Worker
`scheduled` cron ⇄ Node interval, exactly like the retention sweeps) that computes the SAME
`PlatformObservability` projection per account and pushes it to any OTLP/HTTP backend as
OpenTelemetry **gauge** metrics, so the operator watches run outcomes / failure taxonomy /
live depth / duration percentiles in Grafana/Datadog/etc. The dual of `post-release-health`,
which watches the _user's_ release; this watches the platform.

- **Reuses the existing account-scoped read** (`PlatformObservabilityService.summarize`), no
  new SQL, no port change, no deployment-wide/null-account query (which the account-isolated
  conformance suite couldn't test anyway). Accounts are enumerated from the workspace
  projection (`listVisible(null)` → `distinctAccountIds`), the same shape the artifact-retention
  sweep uses to enumerate tenants, NOT a per-row N+1.
- **Exporter** (`PlatformMetricsOtelExporter` in `@cat-factory/observability-otel`) is the
  **fetch transport on both runtimes**: the platform push is a stateless snapshot POST, so it
  needs no `@opentelemetry/*` SDK counterpart (mirrors the Langfuse fetch-on-both shape). Gauge
  points carry `cat_factory.account_id` (bounded tenant scope) + `cat_factory.window`; the pure
  mapping lives in `mapping.ts` alongside the per-call metric mapping. The runtime-neutral
  `sweepPlatformMetrics` driver lives in `@cat-factory/orchestration`.
- **Opt-in on top of the base OTel exporter** (`OTEL_PLATFORM_METRICS=true`, since it adds
  recurring DB rollup load); off ⇒ no sweep, no emission. `OTEL_PLATFORM_METRICS_WINDOW` +
  (Node) `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it; the Worker is cron-driven.
- **Mothership caveat** carries over: mothership-mode local nodes skip the Postgres-backed
  sweeps (their own scheduler owns them), so the OTel push runs on the DB-backed Node/Worker
  deployments; consistent with where the dashboard read is intended.

### What slice 5 (threshold alerting) shipped

The dashboard is a PULL surface (an admin loads it); slice 5 adds the PUSH alert the tracker's
goal called out as the biggest gap ("no alerting on the platform itself"). A periodic,
runtime-symmetric sweep (Worker `scheduled` cron ⇄ Node interval, exactly like the retention +
platform-metrics sweeps) evaluates the SAME `PlatformObservabilityService.summarize` projection
per account and raises a `platform_health` notification through the existing `NotificationChannel`
seam when a threshold is crossed. The dual of `post-release-health` (which watches the USER's
release); this watches the platform.

- **Reuses the existing account-scoped read**, no new SQL, no port change. Every alert condition
  reads a field the projection already carries: `failure_rate_high` (window failure rate, gated by
  `minRuns` so a 1/1 blip is quiet), `duration_p99_high` (the p99 the average hides, from slice
  4a), `backlog_high` (live running/blocked/paused/pending depth). Conditions needing data the
  projection lacks (e.g. "N runs stuck > 30min", which needs a per-run age query) are deliberately
  deferred: the same "needs a new projection" reasoning that split 4b.
- **Pure evaluation** (`evaluatePlatformHealth` in `@cat-factory/orchestration`
  `platform-health.logic.ts`) → the sweep composition (`sweepPlatformHealth` in
  `@cat-factory/server`, the analogue of `escalateStaleNotifications`): enumerate accounts from the
  workspace projection (`distinctAccountIds`, NOT a per-row N+1), summarize ONCE per account, then
  raise/clear one card per workspace in the account.
- **State-change dedup, not every sweep.** `platform_health` is block-LESS, so a new
  `NotificationRepository.findOpenByType(workspaceId, type)` (D1 ⇄ Drizzle + conformance) lets
  `NotificationService.raise` de-dupe it on (workspace, type) exactly like the block-scoped path.
  The card's title/body/payload are a pure function of the FIRING reason SET (sorted; no fluctuating
  live numbers: those live on the dashboard the card links to), so a persistently-unhealthy
  deployment re-delivers only when the set changes. When the account recovers the sweep calls
  `NotificationService.clearByType` to dismiss the stale card.
- **Opt-in** (`PLATFORM_ALERTS=true`, since it adds recurring DB rollup load); off ⇒ no sweep. The
  thresholds/window/(Node) interval tune via `PLATFORM_ALERTS_*` (parsed once in the shared
  `resolvePlatformAlertConfig`, so both facades derive an identical `PlatformAlertConfig`).
  Independent of the OTel exporter: alerts fan out through the notification channel (in-app +
  Slack; `platform_health` is a routable Slack type). A no-op unless the notifications module AND
  the platform-observability read are both wired, so a mothership local node (no DB) is unaffected.
- **Slice 6 remainder:** closed. See the per-account settings surface above.

### Why slice 4 was split (4a first, 4b behind its own projection)

The original slice 4 bundled duration percentiles with per-step/gate attempt stats. They
turned out to be two different modelling problems:

- **4a (percentiles) is a clean SQL rollup** over the SAME `agent_runs` columns the rest of
  the dashboard reads, so it fits the "one aggregate query, mirrored D1 ⇄ Drizzle +
  conformance" pattern exactly. Shipped: `durationStatsSince` now also returns discrete
  (nearest-rank) p50/p90/p99. Postgres uses `percentile_disc`; SQLite (no percentile
  aggregate) uses the `row_number()/count()` cumulative-fraction order-statistic workaround.
  The conformance suite seeds a known distribution and pins that both dialects return the
  same values.
- **4b (gate/CI-fixer attempt stats) was NOT cleanly SQL-aggregatable at the time.** Gate attempts
  (`attempts` / `attemptLog`) and CI-fixer/exhaustion state live INSIDE the per-run `detail`
  JSON blob (`steps[].gate.*`), not in queryable columns. Rolling them up in SQL would mean
  dialect-divergent JSON-array expansion (`json_each` vs `jsonb_array_elements`) reaching into
  the internal step-serialization shape: a fragile coupling that violates "clean over quick"
  and the one-GROUP-BY rule. The right shape is a dedicated **queryable gate-attempt
  projection** (a small telemetry-style table written when a gate round settles, mirrored on
  both runtimes) that these rollups then GROUP BY: a self-contained slice that touches the
  gate machinery, kept separate from the percentiles read. That is what shipped: see slice 4b above.

## What the read-path PR (slices 1–3) shipped

- **Scope is per-ACCOUNT, not global.** `requireAdmin` is account-scoped and there is no
  superadmin, so the port + route take an `accountId` and filter `agent_runs` via a
  `workspace_id IN (SELECT id FROM workspaces WHERE account_id = ?)` sub-select: tenancy-correct
  on both single-account (Node/local) and multi-account (mothership) deployments. The route lives on
  the accounts contract file: `GET /accounts/:accountId/observability/platform?window=1h|24h|7d`.
- **Single store.** The port reads ONLY `agent_runs` (main DB) (outcome/failure/timing all live
  there) so it never crosses into the telemetry store. Token/cost rollups (which need
  `llm_call_metrics`) are deferred to a later slice with its own store-local read.
- **Port methods delivered:** `runOutcomesSince`, `runOutcomeTrend` (bucketed for the sparkline),
  `failureKindBreakdown`, `activeAndParkedCounts`, and `durationStatsSince` (avg/min/max/count in
  the read-path PR; **slice 4a** extended it with discrete p50/p90/p99 percentiles: see below).
- **Wiring:** `PlatformMetricsRepository` (kernel) ⇄ `D1PlatformMetricsRepository` /
  `DrizzlePlatformMetricsRepository` (in `drizzle/execution.ts`) + `definePlatformMetricsSuite`
  conformance on both runtimes; `PlatformObservabilityService` (orchestration, on `Core`) +
  `PlatformObservabilityController` (server, admin-gated); SPA `platformObservability` store + API +
  `OperatorDashboardPanel.vue` + sidebar entry (admin-only), i18n in all 10 locales.
- **Mothership caveat:** a mothership-mode local node (no DB, RPC-backed repos) would 503 the
  dashboard until the platform-metrics reads are added to the persistence-RPC allow-list, not wired
  here since the dashboard is intended for the DB-backed (hosted) deployment. Follow-up if needed.

## Conventions & gotchas

- **Push counts into SQL**: every dashboard number is a `COUNT`/`GROUP BY`/percentile
  query behind the port; no "list all runs and reduce" anywhere.
- **Telemetry store isolation**: `llm_call_metrics` lives in the dedicated telemetry
  store (`TELEMETRY_DB` D1 ⇄ `telemetry` pg schema); the rollup port must respect that
  split rather than joining across stores.
- **The sweep is a sweeper like the others**: idempotent, cheap when healthy, mirrored on
  both runtimes in the same PR, and visible in the stuck-run-audit taxonomy (don't create a
  new class of silent background failure while building the thing that watches for them).
- **This watches the PLATFORM; `post-release-health` watches the user's release.** Keep the
  vocabularies distinct: reusing the `ReleaseHealthProvider` port here would tangle two
  unrelated concerns.
- Alert copy is notification copy: machine-readable `reason` codes on the wire, i18n
  mapping in the SPA (the `usePipelineErrorToast` pattern).
