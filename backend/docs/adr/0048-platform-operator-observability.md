# ADR 0048: Platform operator observability and alerting

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/kernel`, `@cat-factory/orchestration`,
  `@cat-factory/server`, `@cat-factory/observability-otel`, both runtime facades) + the SPA
  (`@cat-factory/app`)

Supersedes the `platform-operator-observability` initiative tracker, whose committed scope is
complete. The retention rules for the projections it introduced are in
[`storage-and-retention.md`](../storage-and-retention.md); the per-run telemetry this ADR
deliberately does not touch is in [`llm-telemetry.md`](../llm-telemetry.md).

## Context

Observability was rich at the single-run level (`llm_call_metrics` plus
`agent_context_snapshots` in the telemetry store, the per-run `ObservabilityPanel.vue`, the Langfuse
sink, the OTel package) and absent at the deployment level: no run success/failure rates, no
throughput or duration trends, no failure-kind breakdown, no gate or CI-fixer attempt statistics, no
container eviction rates, and no alerting on the platform itself. Diagnosing "runs have been failing
since yesterday" meant ad-hoc SQL against `agent_runs` in the Cloudflare dashboard. The product
ships a `post-release-health` gate that watches the USER's Datadog for regressions while cat-factory
had no equivalent self-watch.

## Decision

An operator dashboard over aggregate deployment health plus threshold alerts, built on data that
already exists.

- **Aggregates in SQL.** A kernel `PlatformMetricsRepository` port (`runOutcomesSince`,
  `runOutcomeTrend`, `failureKindBreakdown`, `activeAndParkedCounts`, `durationStatsSince`), each one
  `GROUP BY` query, mirrored D1 ⇄ Drizzle with conformance. No rows are reduced in JS anywhere.
- **Scope is per-ACCOUNT, not global.** `requireAdmin` is account-scoped and there is no superadmin,
  so the port and route take an `accountId` and filter `agent_runs` through a
  `workspace_id IN (SELECT id FROM workspaces WHERE account_id = ?)` sub-select, tenancy-correct on
  single-account and multi-account deployments alike. The route is
  `GET /accounts/:accountId/observability/platform?window=…`.
- **Single store.** The port reads only `agent_runs` in the main DB and never crosses into the
  telemetry store.
- **Duration percentiles** (p50/p90/p99) are discrete nearest-rank: Postgres uses `percentile_disc`,
  SQLite uses a `row_number()/count()` cumulative-fraction order statistic, and the conformance suite
  seeds a known distribution to pin that both dialects return the same values.
- **Two deployment-level projections in the MAIN store** beside `agent_runs`, account-scoped through
  the same `workspaces` sub-select and pruned by the RETENTION sweep rather than the telemetry one:
  `gate_outcomes` (one row per gate reaching a terminal verdict) and `platform_run_days` (one row per
  workspace / UTC day / status / failure kind, serving the `30d` and `90d` windows).
- **Alerting is evaluate plus notify, not a new subsystem.** A periodic runtime-symmetric sweep
  (Worker `scheduled` cron ⇄ Node interval) evaluates the same `PlatformObservabilityService.summarize`
  projection per account through the pure `evaluatePlatformHealth`, and raises a `platform_health`
  card through the existing `NotificationChannel` seam on a STATE CHANGE, clearing it when the
  account recovers. Opt-in via `PLATFORM_ALERTS`, with ceilings layered per account
  (`config.platformAlerts` merged over env defaults by `resolveAccountAlertConfig`).
- **Paging rides its own event family.** `alertEvents` (`platform_health.firing` /
  `platform_health.resolved`) delivers through a kernel `PlatformAlertSink` port implemented by
  `WebhookPlatformAlertSink`, built by the same `buildNotificationWebhookSupport` as its two
  siblings so a facade cannot wire the management surface and leave the alerts undelivered.
- **A push counterpart for the deployment operator.** `PlatformMetricsOtelExporter` pushes the same
  projection per account to any OTLP/HTTP backend as OpenTelemetry gauges, opt-in behind
  `OTEL_PLATFORM_METRICS`, using the fetch transport on both runtimes because a stateless snapshot
  POST needs no SDK counterpart.

## Rationale

- **A card is not an alert.** The per-workspace outbound webhook could technically carry the
  `platform_health` card, and that is the trap: a card is delivered on every content change AND
  re-delivered when a human acts on it or dismisses it, and on the wire that dismissal is
  byte-identical in shape to the sweep dismissing the card because the account recovered. An
  integration built on the card resolves its incident whenever somebody tidies the inbox. The card
  stays right for a human overseer; paging needs an edge only the sweep's verdict can produce.
- **The edge carries the numbers the card omits.** The card's payload is its dedup identity, so a
  fluctuating value in it would re-toast the inbox every sweep. The delivery is an edge, stored
  nowhere and fired only on a change, so it carries each condition's observed value and the threshold
  it crossed. The sweep keeps the whole verdict and derives the reason set from it, not the reverse.
- **The dedupe key is `<cardId>:<event>:<transition>[:<reasons>]`.** The card id alone collapses an
  escalation onto the page it escalated from. The reason SET does not fix that: a set RECURS within
  one incident, so `{A}` → `{A,B}` → `{A}` is three transitions over two distinct sets and a receiver
  keyed on the set drops the page saying it had subsided. A timestamp fails the other way, since
  sweepers are only guarded against overlap within a process and two nodes can observe one
  transition. The ordinal is counted on the card itself, so both sweepers derive the same value from
  the same row.
- **`occurredAt` cannot come off the card.** `raise` preserves an open card's `createdAt` so the card
  keeps its escalating overdue state; reading the edge's time from it would report every escalation
  as having happened when the incident opened. The pass supplies one value shared by every edge it
  emits, which is also the honest grain: an account-level verdict fanned out to its workspaces is one
  observation.
- **`cleanPasses` is reported apart from `passed`.** A gate the precheck satisfied with nothing spun
  up and one the fixer got green on the third try are the same `passed` and completely different
  platform health. The same reasoning splits `helperFailures` (the fixer's own job crashed) from the
  rest of `attempts` (it ran and left the check red): a platform fault versus a product one.
- **Gate statistics needed a projection, not a cleverer query.** A gate's `attempts` / `attemptLog`
  live inside the run's `detail` JSON as `steps[].gate.*`, where no `GROUP BY` reaches without
  dialect-divergent JSON-array expansion over the engine's internal step serialization. One flat row
  per settled gate makes the statistic an ordinary aggregate over columns.

## Consequences

Three rules bind anything added beside these projections:

- **A rollup is REWRITTEN, never appended, and an UPSERT is not a rewrite.** `agent_runs.status`
  mutates in place while `created_at` stays put, so a pass that ran mid-day leaves a
  `(day, 'running')` bucket the next pass's `SELECT` no longer produces and `DO UPDATE` never
  touches; the orphan then double-counts that run until retention. The pass DELETEs its trailing
  window and re-inserts it in one transaction.
- **A rollup's coverage is a fact about the SWEEP.** `dailyRollupWatermark` reads what the pass
  recorded (`platform_rollup_state`, deployment-scoped, forward-only, written in the same
  transaction), never `max(day_start)`, which reads a quiet account as a lagging sweep and a new
  account as a rollup that never ran. The projection states which store answered (`source`) and how
  far the sweep covered (`rolledUpThrough`), so the dashboard renders "no rollup yet" / "the rollup
  is behind" / "complete through <date>" rather than 90 days of confident zeros.
- **A projection whose writer REPLAYS derives its row id** (`<runId>:<stepIndex>:<outcome>`) rather
  than minting one, or one settle becomes two rows and inflates every number the table exists to
  report.

Further consequences:

- **A projection the ENGINE writes is `remote` in mothership mode, not `telemetry`.** The local-first
  bucket is for state a node also reads locally; a gate outcome is written on the node and read only
  by the admin-gated dashboard on the mothership, so a `node:sqlite` copy would be a write-only store
  nobody can see. Because an un-wired writer reads downstream as "this never happens" rather than as
  an outage, `CoreDependencies.gateOutcomeRepository` is REQUIRED, with
  `noopGateOutcomeRepository` for a caller with no store, the same rule as `logger` and
  `operationalMetrics`.
- **Absent inherits, and never means zero.** In the per-account alert settings a zero is a live
  setting (`minStalledPriorRuns: 0` says "page even on an idle window"), so the editor keeps blank
  and `0` apart end to end and sends only the fields an admin filled in. `enabled` is a one-way
  switch, because the env var decides whether the sweep runs at all and no stored row can start a
  timer that was never started. An unreadable settings row costs the account its overrides, not its
  alerting.
- **The resolved edge follows the card, which leaves one honest hole.** A human dismissing the card
  mid-incident leaves the sweep nothing to clear, so a later recovery emits no `resolved`. Closing it
  would mean a second store of alert state beside the card, for an edge a receiver can cover with its
  own timer. It is documented in the delivery contract rather than papered over.
- **One account-level condition fans out per subscribed workspace**, because health is aggregated per
  account and endpoints are registered per workspace. The delivery names the `accountId` so a
  receiver can collapse the fan-out.
- **This watches the PLATFORM; `post-release-health` watches the user's release.** Keep the
  vocabularies distinct: reusing the `ReleaseHealthProvider` port here would tangle two unrelated
  concerns.
- **Conditions needing data the projection lacks are deferred**, for example "N runs stuck > 30min",
  which needs a per-run age query. Same reasoning that split the gate statistics into their own
  projection.
- **Mothership caveat.** A mothership-mode local node would 503 the dashboard until the
  platform-metrics reads are added to the persistence-RPC allow-list, and it skips the
  Postgres-backed sweeps because its own scheduler owns them. The dashboard and the pushes are
  intended for the DB-backed deployment.
