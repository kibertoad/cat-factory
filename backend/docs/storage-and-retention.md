# Storage & data-retention follow-ups

Status: items 1–3 implemented (migration `0006`, the cron retention sweep, and
the bounded commit backfill). Item 4 remains a watch item. Companion to
[`adr/0002-cloudflare-platform.md`](./adr/0002-cloudflare-platform.md), which
records why the backend runs on Cloudflare D1.

This is a working list of storage-related improvements to make before the
database becomes large enough for any of them to bite. None is urgent today: with
GitHub off the unbounded projection tables receive no writes, the `token_usage`
ledger only grows with real agent runs, and at ~0.2 KB/row the 10 GB D1 ceiling is
tens of millions of rows away. The point of writing them down now is
that every fix here is cheap while the tables are small and progressively more
disruptive once they aren't.

## Telemetry lives in its own store

Telemetry has a very different write profile from the transactional domain
(append-heavy, high-volume, write-and-rarely-read, short retention), so the
observability tables live in a **dedicated telemetry store** rather than the main DB:

- **Cloudflare:** a separate, required `TELEMETRY_DB` D1 database (its own
  `[[d1_databases]]` binding + `migrations_dir = telemetry-migrations`). Provision it
  once with `wrangler d1 create cat_factory_telemetry` and paste the id into
  `wrangler.toml`. The worker fails fast at container build if the binding is absent.
- **Node:** a `telemetry` Postgres schema (declared via `pgSchema('telemetry')` in
  `db/schema.ts`), served by the same connection/pool; `migrate()` creates it on boot.

Two tables live there: `llm_call_metrics` (per-call LLM telemetry) and
`agent_context_snapshots` (the complete, redacted context provided to each container
agent; composed prompts, folded-in fragment bodies, and the full content of the files
injected into the container). Both are pruned to the same window
(`LLM_CALL_METRICS_RETENTION_DAYS`, default 3 days).

## The audit log lives in its own store too, for the OPPOSITE reason

The account audit log (`audit_events`) is also kept out of the main DB, but none of the telemetry
reasoning applies to it and repeating that reasoning would get the design wrong:

- **Cloudflare:** a separate, required `AUDIT_DB` D1 database (its own `[[d1_databases]]` binding
  - `migrations_dir = audit-migrations`). Provision it once with
    `wrangler d1 create cat_factory_audit`. The readiness probe reports `audit` so an unbound
    binding is found before the trail is needed rather than after.
- **Node:** an `audit` Postgres schema (`pgSchema('audit')` in `db/tables/audit.ts`), served by
  the same connection/pool; the generated migration creates it.

**Audit is LOW-volume and LONG-retention** — the mirror image of telemetry's high-volume,
three-day profile. Admin actions run to single digits per account per month. What makes it a
storage question at all is the run-lifecycle slice: once run start/stop/retry are audited, this
becomes **the only table in the platform that grows monotonically with run volume AND wants a
multi-year window**. Everything else is one or the other (`token_usage` grows with runs but prunes
at ~395 days; the telemetry sinks grow far faster but prune at 3). On a store with a hard 10 GB
per-database ceiling, that combination is what would put a years-deep trail in competition with
live transactional state.

Measured cost, so the arithmetic is not guesswork: **~508 B/row** on Postgres (264 heap + 244
index — the index costs as much as the data, because the keyset carries `id` as its tie-break).
That is ~2.5× the ~0.2 KB/row the rest of this document assumes. At ~3 rows per run:

| runs/day | rows/year | size/year |
| -------- | --------- | --------- |
| 100      | 110k      | ~55 MB    |
| 1,000    | 1.1M      | ~550 MB   |
| 10,000   | 11M       | ~5.5 GB   |

Two things the separation does **not** buy, both worth stating so nobody relies on them:

- **It does not survive a reset.** `db-reset.mjs` drops every app-owned schema together, `audit`
  included, deliberately: a ledger that outlived its data is the desync that script exists to
  prevent.
- **It is not blast-radius isolation** in the sandbox sense. What it does buy besides capacity is
  **governance**: audit retention cannot be swept by a knob named for something else, because
  nothing else lives in the store to share one.

It also makes one correctness property structural rather than remembered: `audit_events` carries a
`workspace_id` but must **never** be reached by the workspace-delete cascade, since a board being
deleted is itself worth having a record of. Both facades' cascade-completeness guards exclude it by
schema/database rather than by an entry in a list someone could add.

**Retention for it is not wired yet** (its own initiative slice), so the table is unbounded today.

## How the retention sweep is wired

`sweepRetention` (`src/infrastructure/workflows/retention.ts`) prunes each
unbounded table to a configurable age window. The windows are set via
`wrangler.toml` vars (parsed in `src/infrastructure/config.ts`), default to the
values noted per item below, and a window of `0` disables that table's pass.

It runs on its **own daily cron** (`0 3 * * *`), separate from the 2-min
run-sweeper cron; `src/index.ts` `scheduled` routes by `controller.cron`. The
windows are days-to-months long, so a daily pass is plenty: running the same
boundary `DELETE`s every two minutes would just add pointless write load on the
single D1 primary (the very contention §4 warns about).

## Background: the relevant D1 constraints

(Cloudflare platform limits: confirm against current docs, they have been raised
before.)

- **10 GB per database**: the hard ceiling.
- **Single writer.** D1 is SQLite; reads can fan out to replicas but every write
  serializes through one primary.
- **Per-query row-read / response-size limits**, and ~100 bound parameters per
  statement.

Most of the schema is **bounded by live state** and needs no attention: `blocks`,
`pipelines`, `executions`, and the GitHub projections (`github_repos`,
`github_branches`, `github_pull_requests`, `github_issues`, `github_check_runs`)
are workspace-scoped, churn in place, and are soft-deleted via `deleted_at`
tombstones. They track real-world data volume rather than growing without bound.

The follow-ups below concern the tables that **do not** self-limit.

## 1. Retention/rollup for the `token_usage` ledger

**Concern.** `token_usage` (migration `0003`) gets one append-only row per metered
LLM call and is never pruned (`D1TokenUsageRepository` only `INSERT`s; there is no
`DELETE` anywhere). It grows for the life of the deployment whenever agents are
enabled.

**Why it's not urgent.** Rows are tiny and the hot read (`totalsSince()` for the
spend budget) is already a range scan on `idx_token_usage_created`
(`WHERE created_at >= periodStart`), so query cost is bounded by rows _in the
current period_, not by total history. The table grows but the budget query does
not slow down.

**Implemented.** The retention sweep deletes rows older than
`TOKEN_USAGE_RETENTION_DAYS` (default **395 ≈ 13 months**, generous for
year-over-year reporting) via `TokenUsageRepository.deleteOlderThan`. The budget
query only reads the current period, so this caps the ledger without affecting
spend gating.

**Still open (deferred).** A **monthly rollup** into a `token_usage_monthly`
aggregate (per workspace / provider / model) would preserve long-range reporting
while letting raw rows be purged far sooner. Skipped for now because no reporting
consumer reads beyond the current period yet: deletion already bounds the table,
and the rollup can be added when such reporting exists.

## 1b. The daily run rollup (`platform_run_days`)

The deferred `token_usage_monthly` idea above has a sibling that HAS shipped, for the
neighbouring reason: the operator dashboard wanted `30d` and `90d` windows over `agent_runs`,
and a fine-grained scan of a quarter of every run the deployment has ever made, on each
dashboard load and each alert sweep, is exactly the cost a rollup removes.

`platform_run_days` holds one row per `(workspace, UTC day, status, failure kind)`, written by
the same retention sweep that bounds everything else on this page. Three properties are worth
carrying over to any future rollup here:

- **It is REWRITTEN, never appended, and an upsert is not a rewrite.** A day's counts are not
  final until the day is over, so each pass recomputes a short trailing window
  (`RUN_DAY_ROLLUP_LOOKBACK_MS`) and REPLACES those buckets: it DELETEs the window and re-inserts
  it, in one transaction. The delete is the load-bearing half. `agent_runs.status` mutates in
  place while `created_at` stays put, so a pass that ran mid-day wrote a `(day, 'running')` bucket
  that the next pass's `SELECT` no longer produces, and `ON CONFLICT DO UPDATE` never touches a
  row the new result set omits. The orphan then sits beside the run's settled bucket until
  retention, counting it twice. Rewriting also makes a missed pass self-healing rather than
  leaving a day permanently half-counted, which is indistinguishable from a quiet day.
- **The read reports how far the SWEEP has covered** (`dailyRollupWatermark`), from what the pass
  recorded in `platform_rollup_state` rather than from the rolled-up rows. An un-materialised
  rollup and an idle quarter produce the same empty series and are opposite facts, and
  `max(day_start)` cannot tell them apart in either direction: it reports the last day something
  happened, so a quiet deployment reads as a lagging sweep, and a brand-new account reads as a
  rollup that has never run. The marker is deployment-scoped (one pass covers every workspace),
  written in the same transaction as the rewrite it describes, and only ever moves forward so a
  backfill cannot present a healthy sweep as a stalled one.
- **Its retention is the LONGEST of any table here** (`PLATFORM_RUN_DAY_RETENTION_DAYS`,
  default 400). A rolled-up day is a handful of tiny rows, and a short window would take away
  the very questions the table exists to answer.

The settled-gate projection (`gate_outcomes`, one row per polling gate that reached a terminal
verdict) rides the same sweep on a 90-day window. It is a projection rather than a rollup (no
aggregation happens at write time), and it exists because the gate's live state lives inside the
run's `detail` JSON blob, where no `GROUP BY` can reach it.

## 2. Bound or expire the `github_rate_limits` telemetry

**Concern.** `github_rate_limits` (migration `0004`) records one append-only row
per observed `x-ratelimit-*` header snapshot (`D1RateLimitRepository.record`),
with no pruning. Under busy GitHub sync this can out-grow `token_usage`, and it is
pure operational telemetry: the only consumer cares about _recent_ headroom.

**Implemented.** The same sweep deletes snapshots older than
`GITHUB_RATE_LIMIT_RETENTION_DAYS` (default **7**, the most aggressive window:
this table has the least reason to retain history) via
`RateLimitRepository.deleteOlderThan`.

**Still open (deferred).** If historical trend data is never used, collapsing the
table to "latest snapshot per `(installation_id, resource)`" (an upsert into a
small table) would eliminate the growth entirely. Retention already bounds it, so
this is only worth doing if the ledger shape turns out to be unwanted.

## 3. Bound the `github_commits` backfill

**Concern.** `github_commits` (migration `0004`) is the only append-only GitHub
projection: it has **no `deleted_at` tombstone**, so rows are never reclaimed,
and `message` is a comparatively bulky `TEXT` column. The risk here is a **step,
not a drip**: a large monorepo's `GitHubBackfillWorkflow` can insert 100k+ commits
in a single connect/full-resync.

**Implemented.**

- The initial backfill is capped to a configurable horizon: when a repo has no
  commit sync cursor yet, `GitHubSyncService` lists commits only since
  `now - GITHUB_COMMIT_RETENTION_DAYS` (default **90**) instead of from the dawn
  of the repo. Subsequent syncs use the (more recent) cursor as before.
- A retention pass (`CommitProjectionRepository.deleteOlderThan`, keyed on the
  new `idx_gh_commits_authored` index from migration `0006`) reclaims commit rows
  authored before the same horizon, so backfill and retention agree and the table
  stays bounded. Rows with no `authored_at` are kept. (Hard deletion is used
  rather than a `deleted_at` tombstone since the goal here is reclaiming space.)
- `D1CommitProjectionRepository.upsertMany` now chunks its `db.batch` so a large
  backfill can't exceed D1's statement-count / **~100 bound-parameter** limits.

## 4. Single-writer throughput (watch item, not a task yet)

**Concern.** Storage is not the first ceiling we'd hit under heavy multi-tenant
load: write _throughput_ is. All projection writes plus token metering serialize
through one D1 primary. This is a "many busy tenants" problem, not a near-term one,
and the fast-ack → queue design (ADR 0001) already smooths webhook write bursts.

**Follow-up (when load justifies it).**

- Confirm reads that don't need write-fresh data use D1 read replicas (Sessions
  API) so they don't contend with the write path.
- Keep the optional execution/GitHub admission queues (currently commented out in
  `wrangler.toml`) in mind as the throttle for write fan-in.
- If a single database genuinely saturates, the workspace-scoped composite keys
  make per-tenant or sharded databases a feasible (if larger) migration.

## Suggested sequencing

1. ~~**`token_usage` retention/rollup**~~: done (deletion-based; rollup deferred).
   1b. ~~**Daily run rollup + settled-gate projection**~~: done (see above).
2. ~~**`github_rate_limits` retention**~~: done.
3. ~~**`github_commits` backfill bounds + retention**~~: done.
4. **Throughput / read-replica review**: revisit when real multi-tenant load
   data exists; don't pre-optimize.
