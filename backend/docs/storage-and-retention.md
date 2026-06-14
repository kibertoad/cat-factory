# Storage & data-retention follow-ups

Status: items 1–3 implemented (migration `0006`, the cron retention sweep, and
the bounded commit backfill). Item 4 remains a watch item. Companion to
[`adr/0002-cloudflare-platform.md`](./adr/0002-cloudflare-platform.md), which
records why the backend runs on Cloudflare D1.

This is a working list of storage-related improvements to make before the
database becomes large enough for any of them to bite. None is urgent today: in
the default configuration (`AGENTS_ENABLED=false`, GitHub off, `EXECUTION_MODE=
tick`) the unbounded tables receive no writes, and at ~0.2 KB/row the 10 GB D1
ceiling is tens of millions of rows away. The point of writing them down now is
that every fix here is cheap while the tables are small and progressively more
disruptive once they aren't.

## How the retention sweep is wired

`sweepRetention` (`src/infrastructure/workflows/retention.ts`) prunes each
unbounded table to a configurable age window. The windows are set via
`wrangler.toml` vars (parsed in `src/infrastructure/config.ts`), default to the
values noted per item below, and a window of `0` disables that table's pass.

It runs on its **own daily cron** (`0 3 * * *`), separate from the 2-min
run-sweeper cron; `src/index.ts` `scheduled` routes by `controller.cron`. The
windows are days-to-months long, so a daily pass is plenty — running the same
boundary `DELETE`s every two minutes would just add pointless write load on the
single D1 primary (the very contention §4 warns about).

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
consumer reads beyond the current period yet — deletion already bounds the table,
and the rollup can be added when such reporting exists.

## 2. Bound or expire the `github_rate_limits` telemetry

**Concern.** `github_rate_limits` (migration `0004`) records one append-only row
per observed `x-ratelimit-*` header snapshot (`D1RateLimitRepository.record`),
with no pruning. Under busy GitHub sync this can out-grow `token_usage`, and it is
pure operational telemetry — the only consumer cares about _recent_ headroom.

**Implemented.** The same sweep deletes snapshots older than
`GITHUB_RATE_LIMIT_RETENTION_DAYS` (default **7**, the most aggressive window —
this table has the least reason to retain history) via
`RateLimitRepository.deleteOlderThan`.

**Still open (deferred).** If historical trend data is never used, collapsing the
table to "latest snapshot per `(installation_id, resource)`" (an upsert into a
small table) would eliminate the growth entirely. Retention already bounds it, so
this is only worth doing if the ledger shape turns out to be unwanted.

## 3. Bound the `github_commits` backfill

**Concern.** `github_commits` (migration `0004`) is the only append-only GitHub
projection — it has **no `deleted_at` tombstone**, so rows are never reclaimed,
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
load — write _throughput_ is. All projection writes plus token metering serialize
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

1. ~~**`token_usage` retention/rollup**~~ — done (deletion-based; rollup deferred).
2. ~~**`github_rate_limits` retention**~~ — done.
3. ~~**`github_commits` backfill bounds + retention**~~ — done.
4. **Throughput / read-replica review** — revisit when real multi-tenant load
   data exists; don't pre-optimize.
