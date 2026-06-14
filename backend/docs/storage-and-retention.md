# Storage & data-retention follow-ups

Status: backlog / not yet implemented. Companion to
[`adr/0002-cloudflare-platform.md`](./adr/0002-cloudflare-platform.md), which
records why the backend runs on Cloudflare D1.

This is a working list of storage-related improvements to make before the
database becomes large enough for any of them to bite. None is urgent today: in
the default configuration (`AGENTS_ENABLED=false`, GitHub off, `EXECUTION_MODE=
tick`) the unbounded tables receive no writes, and at ~0.2 KB/row the 10 GB D1
ceiling is tens of millions of rows away. The point of writing them down now is
that every fix here is cheap while the tables are small and progressively more
disruptive once they aren't.

## Background: the relevant D1 constraints

(Cloudflare platform limits — confirm against current docs, they have been raised
before.)

- **10 GB per database** — the hard ceiling.
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

**Why it's not urgent.** Rows are tiny and the hot read — `totalsSince()` for the
spend budget — is already a range scan on `idx_token_usage_created`
(`WHERE created_at >= periodStart`), so query cost is bounded by rows *in the
current period*, not by total history. The table grows but the budget query does
not slow down.

**Follow-up.**
- Add a retention job (the existing every-2-min cron sweeper, or a daily variant)
  that deletes or rolls up rows older than a small number of billing periods.
- Because the budget only needs the current period, a **monthly rollup** into a
  `token_usage_monthly` aggregate (per workspace / provider / model) preserves
  reporting while letting raw rows be purged, capping the table permanently.
- Make the retention window configurable via a `wrangler.toml` var, defaulting
  to something generous (e.g. 13 months for year-over-year reporting).

## 2. Bound or expire the `github_rate_limits` telemetry

**Concern.** `github_rate_limits` (migration `0004`) records one append-only row
per observed `x-ratelimit-*` header snapshot (`D1RateLimitRepository.record`),
with no pruning. Under busy GitHub sync this can out-grow `token_usage`, and it is
pure operational telemetry — the only consumer cares about *recent* headroom.

**Follow-up.**
- Add aggressive time-based retention (e.g. keep the last 7–30 days) in the same
  sweeper pass; this table has the least reason to retain history.
- Alternatively, collapse it to "latest snapshot per `(installation_id,
  resource)`" (an upsert into a small table) if historical trend data isn't
  actually used, eliminating the unbounded growth entirely.

## 3. Bound the `github_commits` backfill

**Concern.** `github_commits` (migration `0004`) is the only append-only GitHub
projection — it has **no `deleted_at` tombstone**, so rows are never reclaimed,
and `message` is a comparatively bulky `TEXT` column. The risk here is a **step,
not a drip**: a large monorepo's `GitHubBackfillWorkflow` can insert 100k+ commits
in a single connect/full-resync.

**Follow-up.**
- Cap the backfill window (e.g. only commits since a configurable horizon, or the
  most recent N per branch) instead of full history.
- Add a `deleted_at` tombstone (matching the other projections) and/or a
  retention pass so commit rows can be reclaimed for repos that are disconnected
  or pruned upstream.
- When backfilling in bulk, mind the **~100 bound-parameter** per-statement limit:
  chunk multi-row inserts so a large batch can't exceed it.

## 4. Single-writer throughput (watch item, not a task yet)

**Concern.** Storage is not the first ceiling we'd hit under heavy multi-tenant
load — write *throughput* is. All projection writes plus token metering serialize
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

1. **`token_usage` retention/rollup** — highest-value, simplest, and the table
   most likely to see sustained growth once agents are enabled.
2. **`github_rate_limits` retention** — trivial, removes a pointless grower.
3. **`github_commits` backfill bounds + tombstone** — do before onboarding any
   large/monorepo workspace.
4. **Throughput / read-replica review** — revisit when real multi-tenant load
   data exists; don't pre-optimize.
