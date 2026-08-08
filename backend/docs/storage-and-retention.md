# Storage & data-retention follow-ups

Status: items 1–3 implemented (migration `0006`, the cron retention sweep, and
the bounded commit backfill). Item 4 remains a watch item. Companion to
[`adr/0002-cloudflare-platform.md`](./adr/0002-cloudflare-platform.md), which
records why the backend runs on Cloudflare D1.

> **Operators read the windows on the website**:
> [Upgrades & Data Retention](https://www.catfactory.ai/operate/upgrades-and-retention.html) owns
> which store holds what, every retention variable and its default, and what capture the two gates
> prevent in the first place. Change a default here and that page changes in the same PR: the
> defaults are the one part of this doc a reader acts on without a checkout.

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
(`LLM_CALL_METRICS_RETENTION_DAYS`, default 14 days). The window is sized for POST-MORTEMS
rather than for live debugging: an investigation into a failed run routinely starts days after
it, and the earlier 3-day default expired the record first.

**Sizing it against the 10 GB ceiling.** The window multiplies the store linearly, so raising it
from 3 to 14 days is ~4.7x the steady-state footprint, and the number that decides whether that
matters is bytes-per-call, not rows: with bodies OFF a row is metadata (~0.5 KB), so even a busy
deployment at 10k calls/day sits around 70 MB and the ceiling is not in view. With bodies ON a row
carries a full prompt + response and runs three orders of magnitude larger (a few hundred KB for a
long coding turn), where the same 10k calls/day reaches the ceiling inside the window. So the
variable to tune is the one that is already double-gated: a deployment recording bodies
(`LLM_RECORD_PROMPTS` plus the per-workspace `storeAgentContext`) should size this window against
its own observed row width rather than take the default, and 3 restores the previous footprint.

## The audit log lives in its own store too, for the OPPOSITE reason

The account audit log (`audit_events`) is also kept out of the main DB, but none of the telemetry
reasoning applies to it and repeating that reasoning would get the design wrong:

- **Cloudflare:** a separate, required `AUDIT_DB` D1 database, with its own `[[d1_databases]]`
  binding and `migrations_dir = audit-migrations`. Provision it once with
  `wrangler d1 create cat_factory_audit`. Required means required: the container build refuses an
  unbound binding, so the deployment answers the misconfiguration screen rather than running
  silently unaudited, and `/ready` names `audit` so an operator reads which binding it is.
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

Measured cost, so the arithmetic is not guesswork: **~500 B/row** on Postgres (~260 heap + ~245
index, the index costing as much as the data because the keyset carries `id` as its tie-break).
That is ~2.5× the ~0.2 KB/row the rest of this document assumes. The heap figure moves with the
`details` blob, which is a handful of short fields, so treat it as the order of magnitude rather
than a constant. At ~3 rows per run:

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

What a row holds is **`action` + `details`, never a sentence**: the values are machine-readable
fields (`{"previousRole":"viewer","role":"admin"}`) the viewer interpolates into translated copy.
The backend does not localize, and this store is where that rule bites hardest, because a row is
kept for years: English prose written today could never be re-rendered for a reader in another
locale, and unlike a wire shape a persisted one cannot be changed later.

**Retention is wired**, on its own knob: `AUDIT_EVENT_RETENTION_DAYS`, default **730 days** — by
far the longest window on this page, because the log answers a compliance question rather than an
operational one, and a short window makes the honest answer "we deleted it". `0` disables the
prune entirely, for a deployment that exports the log elsewhere. Its own knob rather than a shared
one is the governance point above made concrete: nothing else lives in this store, so audit
retention cannot be shortened as a side effect of tuning a telemetry window.

The prune takes a cutoff and **nothing else** — no account, actor or action predicate — so the
sweep can never be used to remove the record of one inconvenient thing, and it is the only DELETE
that exists on the table. The boundary is strict (`at < cutoff`), pinned by conformance: an
off-by-one there would silently shorten every deployment's window by a tick.

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

## 1c. The durable cost-attribution rollup (`spend_days`), the one table with NO retention

The Reports view's TCO axes (spend per repository, per ticket, per run) were computed at READ
time by joining the ledger to `agent_runs` and then to the LIVE `services.repo_github_id` /
`tasks.linked_block_id` links. That answers "what is this costing me now" correctly and
answers "what did this repository cost us last quarter" wrongly in three separate ways: the
ledger is pruned at 395 days, the runs it joins through are prunable too, and re-pointing a
service or re-importing an issue silently rewrites history that has already been reported.

`spend_days` folds the ledger once per sweep, per UTC day, and freezes the board shape the
spend happened under: run, block (and its title), service (and its name), repository id and
`owner/name`, task type, tracker ref, plus the account and board names. Reading it joins
nothing, so nothing downstream can be re-pointed or pruned out from under a report. The Reports
view routes to it on the `30d` / `90d` windows and says so (`source`, `rolledUpThrough`).

**It is deliberately never pruned**, which makes it the exception on this page and needs the
arithmetic stated rather than assumed:

- **The grain is what makes that affordable**: one row per `(workspace, day, run, agent kind,
provider:model, billing, vendor)`. A run writes hundreds of ledger rows and a handful of
  these, so the table grows with RUN volume, not call volume. At ~0.3 KB/row and ~8 rows per
  run, 1,000 runs/day is ~2.4 MB/day, ~0.9 GB/year, the same order as the audit log's
  multi-year budget in §"The audit log", and the reason the grain must not be widened to
  per-call without revisiting this.
- **A window would defeat the point.** A TCO table has to outlive the ledger it was folded
  from; one that expires is just a slower ledger. So there is no `deleteOlderThan` on
  `SpendRollupRepository` at all: the absence is structural, not an omission a future sweep
  could quietly fill.
- **It survives a board deletion too** (named in `WORKSPACE_CASCADE_SPECIAL_TABLES`): money
  already spent is an account-level fact, and reclaiming it would shrink last quarter's numbers
  retroactively and silently. The frozen labels (board name, block title, repo name) therefore
  outlive the board, which is the same trade the audit log makes.
  - Staying out of the cascade is only half of that. The rewrite below would have finished the
    job on the sweep's own schedule, with no further operator action: `token_usage` IS
    cascaded, so for a deleted board the re-fold reads nothing, and a window DELETE would have
    reclaimed every frozen row still inside the trailing window. **So the rewrite reaches only
    workspaces that still exist**, which is the general rule that a rewrite may only delete
    what it can reproduce. A live board whose ledger was pruned and a deleted board look
    identical to the fold and are opposites here: the first is still there to be asked and is
    answering "nothing"; the second can never be re-folded again, which is what makes its rows
    final.
  - Which leaves the mirror-image question, and **the delete answers it rather than the sweep**.
    The board's spend since the last completed rollup day has never been folded, and
    `token_usage` IS cascaded, so those rows would go before any pass could see them: at most
    one sweep interval, permanent, and skewed worst for exactly the boards an operator deleted
    BECAUSE they were expensive. So `WorkspaceService.delete` runs one final per-workspace fold
    (`SpendRollupRepository.rollupWorkspaceSpendDays`) before the cascade, beside the
    binary-artifact purge and for the same reason: afterwards there is nothing left to read.
    Four things make that fold a different shape from a sweep pass:
    - **It walks to `now` in CHUNKS instead of capping its window.** A sweep leaves a wide
      catch-up for its next pass; this board has no next pass, so `SPEND_DAY_ROLLUP_MAX_SPAN_MS`
      becomes a chunk size rather than a truncation. The resume point and the ledger-retention
      horizon are the sweep's own, derived by the shared `finalSpendFoldPlan` in kernel, so a
      board's last fold covers exactly the days a pass would have.
    - **It walks NEWEST FIRST, on a budget.** The sweep folds on a cron, where running long
      costs the cron; this fold runs inside a user's delete request, where it costs the
      request, and a watermark left stale by an outage plans a ledger-retention's worth of
      chunks. On the Worker, where the whole delete is one invocation, an unbounded walk stops
      preserving the board's spend and starts preventing its deletion: the request dies before
      the cascade, and the retry reads the same watermark and plans the same walk. So the walk
      stops at `FINAL_SPEND_FOLD_BUDGET_MS` (checked between chunks, which bounds how MANY
      aggregates run; the span cap bounds one), a chunk that throws does not end it, and the
      order decides what survives either. Newest first, because every report window this
      rollup serves is anchored at `now` while the far end of a stale catch-up falls outside
      even the 90-day one.
    - **It does not touch the coverage marker.** `rolledUpThrough` is deployment-scoped and
      states how far the SWEEP has covered every board at once. One board's final fold covers no
      other board's days, and the marker only ever moves forward, so advancing it there would
      permanently present days nothing folded as covered.
    - **It keeps the still-exists guard anyway**, which is what makes the fold-then-cascade
      ordering a property of the query rather than of the call site: run out of order it reads
      nothing, and an unguarded window `DELETE` would reclaim the frozen rows the exclusion
      exists to keep. Both halves of the rule now live in the same statement.

    Everything the fold does not cover is reported on one `warn`, and the fields on it keep the
    causes apart because they need different responses: `skippedFrom`/`skippedTo` is what the
    ledger no longer holds (past `TOKEN_USAGE_RETENTION_DAYS`, already unfoldable before the
    delete), `failedSpans` is what the store refused, `unattemptedSpans` is what the budget
    never reached (a sweep that has been behind long enough for one board's catch-up to outgrow
    a request), and `reason: watermark_unreadable` is a resume point that could not be read at
    all, where the extent is genuinely unknown. Spans rather than one extent over them: a
    failed chunk mid-walk leaves a hole, and a single `[from, to)` pair would render that hole
    as a clean truncation.
- **The pass resumes from its own watermark**, unlike the run rollup's fixed lookback, because
  a day missed here is missing from the only durable record of it. Each pass is capped
  (`SPEND_DAY_ROLLUP_MAX_SPAN_MS`) so a wide catch-up is several queries rather than one
  unbounded `GROUP BY`, and the first pass on a deployment backfills 90 days so the longest
  report window is not under-reported for a quarter while looking complete.
  - **The catch-up horizon is `TOKEN_USAGE_RETENTION_DAYS`, not that 90-day backfill.** The two
    answer different questions. The backfill bounds how much history a deployment ADOPTS on its
    first pass, a judgement call; a resumed pass has no such choice, because every day since the
    watermark is one this deployment already committed to recording and the ledger still holds
    it (the prune runs in this same sweep, so a sweep that was down pruned nothing either).
    Capping the resume at 90 days stepped over months of still-readable days and then advanced
    the high-water mark straight past the hole.
  - Past the ledger's retention there is nothing left to fold, so that is where the walk stops,
    and the pass **logs the span it gave up on** (`spend_days`, warn). A high-water mark
    structurally cannot represent a hole, so that line is the only notice the loss ever gets.
- **`rolledUpThrough` is the last COMPLETE day**, never the newest day written. A sweep firing
  at noon folds today's spend so far, because deferring the partial day would leave the newest
  bucket missing outright, but today goes on accruing after the pass returns. Stamping it would
  present the one bucket guaranteed to be short as finished, under a panel that reads "complete
  through <date>". The reader measures lag against the same day boundary (`lastCompleteRollupDay`
  in `@cat-factory/contracts`, shared with the SPA), so the verdict does not swing with the hour
  the report happened to be opened.
- **It runs BEFORE the ledger prune in the same sweep.** Ordering is a correctness property:
  the rollup reads `token_usage`, so a pass that pruned first would drop spend that had never
  been rolled up.

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

1. ~~**`token_usage` retention/rollup**~~: done (deletion-based).
   1b. ~~**Daily run rollup + settled-gate projection**~~: done (see above).
   1c. ~~**Durable cost-attribution rollup (`spend_days`)**~~: done (see above).
2. ~~**`github_rate_limits` retention**~~: done.
3. ~~**`github_commits` backfill bounds + retention**~~: done.
4. **Throughput / read-replica review**: revisit when real multi-tenant load
   data exists; don't pre-optimize.
