# Reports: design

> Reading the reports is on the website
> ([Observability](https://www.catfactory.ai/operate/observability.html)). This page is the
> design record: what the windows read, why long windows read a rollup, and the decisions that
> shaped the wire shape.

**Status:** Implemented (see the "Landed code" map at the end).
**Scope:** account-scoped, admin-gated, read-only. One table: the durable cost-attribution
rollup the long windows read (added after the first cut; see "Durable cost attribution").

## Problem

The deployment already answers _"is it healthy?"_: `PlatformObservabilityService` rolls
`agent_runs` up into outcomes, a failure taxonomy, live/parked depth and duration
percentiles. It does not answer the other operator question: **where are the money and the
work actually going?**

What existed was scattered and none of it composed:

- The **Usage** settings tab (`SpendService.usageBreakdown`) shows the CURRENT billing
  period for ONE workspace, grouped by `(billing, vendor, provider, model)` only. There is
  no agent-kind axis, no service axis, no task-type axis, no cross-workspace view, and no
  window other than "this month so far".
- The **per-run** observability panel shows one run's calls in full detail, the opposite
  end of the aggregation scale.
- Nothing at all connected spend to the BOARD SHAPE. "Which service is expensive?" and
  "does the bug pipeline cost more than the feature pipeline?" were unanswerable without
  exporting the ledger.

## Goals

- One admin view over an **account**, with an optional narrowing to a single board, that
  slices the same window every way an operator asks about: **spend by model, by agent kind,
  by board, by service, by repository, by task type, by tracker ticket, by run**, and **run
  activity by board, by service, by repository, by task type**, plus a **spend trend**. Run, repository and
  ticket are the TCO axes: what an organisation actually budgets against, and the ones that
  have to still be answerable a year later (see "Durable cost attribution").
- **Never conflate real money with flat-rate quota usage.** A subscription harness call's
  cost is illustrative (what the same tokens WOULD have cost on the metered API); the spend
  gate excludes it, and so must every number here.
- Every breakdown is **one SQL `GROUP BY`**, per the repo's N+1/aggregate ban.
- Runtime-symmetric (D1 ⇄ Drizzle) with conformance coverage, per the parity rule.
- **No new persistence for the live windows.** Everything the short windows need is already
  recorded. The long (TCO) windows are the exception, and the reason is in "Durable cost
  attribution" below: the ledger cannot answer their question durably at all.

## The data the live windows read

Every number on a `24h` / `7d` window comes from tables that already exist in the MAIN store on
both runtimes (the long windows read the rollup in the next section instead):

| Source         | Supplies                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| `token_usage`  | the metered ledger: workspace, agent kind, provider/model, tokens, cost, `billing`, timestamp |
| `agent_runs`   | run outcomes and wall-clock duration, plus the run's `service_id` / `block_id`                |
| `blocks`       | a task's `task_type`, and a service frame's `title` (its display name)                        |
| `services`     | the service → frame-block link, and its `repo_github_id` (the `repo` dimension's key)         |
| `github_repos` | the repo projection: `owner/name`, the `repo` dimension's label                               |
| `tasks`        | imported tracker issues and their `linked_block_id` (the `ticket` dimension's key)            |
| `workspaces`   | the board's name, and the `account_id` scope sub-select                                       |

`token_usage` carries no service, repo, task type or ticket (a metered call records the RUN,
not the board shape), so those spend dimensions join through `execution_id → agent_runs` and
then to the run's service/block. That join is why the port lives in the main store and
never touches the telemetry database (a physically separate D1 database on Cloudflare).

## Durable cost attribution: why the long windows read a rollup

The first cut computed every dimension from the ledger at read time. That is correct for "what
is this costing me now" and wrong for "what did this repository cost us last quarter", because
each of the three sources it joins is mutable in a way the reader cannot see:

- `token_usage` is pruned to `TOKEN_USAGE_RETENTION_DAYS` (~13 months).
- `agent_runs`, the row every board-shape dimension reaches the board through, is prunable too;
  a call whose run is gone falls into the unattributed bucket, which is honest and useless.
- `services.repo_github_id` and `tasks.linked_block_id` are LIVE links. Re-point a service at a
  new repository, or re-import an issue under a different ref, and last quarter's answer
  changes underneath a report that already went into a budget.

So the retention sweep now materialises **`spend_days`** (D1 migration 0084 ⇄ Drizzle
`spendDays`): one row per `(workspace, UTC day, run, agent kind, provider:model, billing,
vendor)`, carrying the attribution FROZEN at rollup time: the run, its block and title, its
service and name, its repository id and `owner/name`, its task type, its ticket ref, and the
account and board names. A read of it joins nothing.

- **Routing is by window, not by preference**: `24h`/`7d` scan the ledger (millisecond-exact,
  and a sweep cadence would show there as a missing tail); `30d`/`90d` read the rollup, which is
  where TCO questions are actually asked. The projection reports `source` and, on the rollup
  path, `rolledUpThrough`, because an un-materialised rollup and an account that spent nothing
  produce the same empty breakdown. The SPA renders "no rollup yet" / "the rollup is behind" /
  "complete through <date>" rather than a confident quarter of zeros, exactly as the operator
  dashboard does for `platform_run_days`.
- **One window is answered by ONE store.** Every breakdown partitions the same rows and the
  totals fold from one of them, so mixing sources inside a window would leave the tiles and the
  cards describing different data.
- **The two must agree where they overlap**, or an account's spend would change the moment a
  reader switched from `7d` to `30d`. The conformance suite asserts every dimension of the
  rollup equals the ledger's answer over the same window, on the same fixture, including the
  deterministic multi-ticket pick and the colliding-frame-block fan-out guard, which the fold
  has to reproduce exactly rather than merely resemble.
- **A rollup with a window would be pointless**, so it has none: no prune in either facade's
  sweep, no `deleteOlderThan` on the port, and it is excluded from the workspace-delete cascade.
  Surviving the cascade takes a second half, since the sweep folds only boards that still exist:
  the delete itself folds the board's un-rolled days first, so what the table keeps of a deleted
  board ends where the board did. The storage arithmetic that makes the no-retention choice
  affordable, and the three ways that final fold differs from a sweep pass, are in
  [`storage-and-retention.md`](./storage-and-retention.md) §1c.
- **Freshness is the trade.** On the Worker the sweep is a daily cron, so a `30d` window can be
  up to a day behind. That is what `rolledUpThrough` is for; it is not hidden.

## Design decisions

### Account-scoped and admin-gated, with a board filter

Reports read across every board an account owns, which is exactly the cross-workspace
operational data `platformObservabilityController` already reserves for admins, so
`GET /accounts/:accountId/reports` reuses that gate (`accountService.requireAdmin`).

The optional `workspaceId` query param narrows every breakdown at once. It needs no
authorization of its own: an admin already sees every board's numbers in the account-wide
rollup, so filtering to one reveals nothing new, and the account scope is applied in SQL;
a foreign board id simply matches no rows rather than escaping the scope. A conformance
assertion pins that.

Per-workspace members keep the existing **Usage** tab, which is their own board's current
billing period. Reports is deliberately the operator's cross-cutting view, not a
per-member one.

The public API serves ONE dimension of the same read, scoped to a key's own board:
`GET /api/v1/usage/spend?dimension=repo|ticket|run|…` goes through `ReportsService.breakdown`,
which routes by window exactly as `summarize` does, so an external cost dashboard and the panel
cannot disagree about what a repository cost. It publishes no `workspace` dimension and no
account-wide scope: that is the cross-workspace half this gate exists for. Wire shape and the
reading traps: [`public-api.md`](./public-api.md#spend-by-repository-ticket-or-run).

### Metered and subscription cost are two columns, never one

Each spend slice carries `meteredCost` AND `subscriptionCost`, split by a conditional
`SUM` in the same GROUP BY (no second scan). Summing them produces a number that means
nothing, so the port documents it, the wire schema documents it, the totals fold keeps
them apart, and the SPA renders them as two tiles and two bar segments with distinct
colours and a legend.

Anything that is not literally `'subscription'` is priced as metered (matching how the
row decoders widen the column), so an unexpected value reads as real spend rather than
being silently discounted to zero.

### The unattributed bucket is a real slice

A call whose run cannot be resolved (a run pruned by retention, or a call recorded with no
`execution_id`) groups under the EMPTY key rather than being dropped by an inner join.
Dropping it would under-report the window while the report still looked complete. The SPA
labels it "Unattributed"; conformance asserts it survives.

### No row cap in the PORT

The store returns every slice it grouped, and the cap above happens a layer up. That is what
lets the cap report an exact `omitted`, and it keeps the port's "a breakdown partitions the
whole window" property intact, which is what every caller's totals fold rests on. Documented on
the port, so a new dimension with unbounded cardinality has to decide where its cap goes rather
than acquiring one by accident.

### Totals are folded, not queried

Every spend breakdown partitions the SAME ledger rows, so any of them totals identically.
`foldTotals` sums the model breakdown in JS rather than costing a sixth aggregate query.
(This is not the banned "reduce rows in JS" pattern: it reduces already-aggregated
GROUP BY output, not raw rows.)

This is only true while every breakdown stays one-row-per-ledger-row, which is why the
`service` label is resolved through a **pre-aggregated** sub-select (`SERVICE_LABELS` /
`serviceLabels`) instead of joining `blocks` straight from the aggregate. `blocks` is keyed
`(workspace_id, id)` and a block id is only unique WITHIN a board (the reason the
services↔frame unique index is account-scoped) so a seeded or templated frame id recurring
across an account's boards would make a direct join match N rows and multiply that service's
calls, tokens and cost by N. The failure is silent: the numbers stay plausible, and only the
service breakdown's disagreement with the folded totals gives it away. Grouping the title
down to one row per service first makes the join provably 1:1. The residual ambiguity (which
colliding block's title wins) is confined to the cosmetic label. Conformance seeds exactly
this collision, so every `service` assertion doubles as the fan-out guard.

### Costs are never summed into one figure for a reader

`meteredCost` and `subscriptionCost` are added together in exactly one place: the ranking
and bar-scaling measure (`spendMagnitude` / `trendMagnitude`, mirroring the SQL `ORDER BY`).
Nothing renders that sum with a currency symbol: only metered spend is money, and the
subscription figure is the illustrative equivalent-API cost of flat-rate quota usage, so
their sum denominates nothing. Each breakdown row shows the metered amount, with the
subscription amount beside it in its own series colour when non-zero.

### Activity counts every run kind

The activity breakdowns span `execution`, `bootstrap` and `env-config-repair` alike:
deliberately unlike `PlatformMetricsRepository`, which groups by kind because its question
is run health. Here activity sits beside spend on the same row, and spend is the ledger of
the calls those same runs made: a bootstrap's LLM calls are in `token_usage` like any
other's. Filtering activity to `execution` would put the two halves of one row on different
populations, so a board could show more spend than it had runs to explain. The cost is that
a bootstrap run, carrying no block and usually no service, lands in the unattributed slice
of the `service` and `taskType` breakdowns, which is where it belongs, since there is
genuinely nothing to attribute it to.

### The window start is snapped to a bucket edge

`since` is `generatedAt - window` floored to a multiple of the trend's bucket width.
Unsnapped, the first column of the chart holds a fraction of a bucket's data while rendering
at the same width as its complete neighbours, and nothing distinguishes that short column
from a genuinely quiet period; that is the one distinction a trend reader must not get
wrong. Snapping makes
every bucket complete except the trailing in-progress one, whose partialness is inherent.
A window therefore covers up to one bucket more than its nominal length; the projection
reports the real `since`, and the panel prints it, so the view always says what it charted.

### Activity has a narrower axis than spend

A RUN carries no single agent kind or model: those are per-step facts, which is precisely
what the spend breakdowns key on. So `ReportActivityDimension` is `workspace | service | repo
| taskType` while `ReportSpendDimension` adds `model`, `agentKind`, `ticket` and `run`. The
contract encodes the difference rather than returning empty arrays for combinations that
cannot exist.

`ticket` stays out of it because a ticket is a unit of INTENT that carries no runs of its own
and that a run may share with other tickets, so counting runs under it would invent a
population. `run` stays out because a run IS the unit activity counts.

`repo` was originally out too, on the reasoning that a run is already counted under the
service that owns its repository, so a repository axis would answer the same question twice.
That holds only where services map one-to-one onto repositories. Several services pointing at
ONE repository is the ordinary monorepo shape (it is what the repo link's `directory` carries),
and no read here publishes the service-to-repository map, so a reader could not fold the
service counts up to a repository even knowing they needed to. "How much work went into this
repository, and how much of it failed" was therefore unanswerable while its cost sat one card
away. It is now its own `GROUP BY` over `agent_runs`, joining the same two primary-key joins
the `repo` spend dimension uses (`services.id`, then `github_repos (workspace_id, github_id)`),
so neither can fan the run count out. The conformance fixture seeds two services on one
repository across two boards, which is what pins the fold.

### The activity-scaled dimensions are capped, and each says what it dropped

`ticket` and `run` are the two dimensions whose row count grows with ACTIVITY rather than with
a catalog: one row per tracker issue that a run touched, one per pipeline execution that spent
anything. Every other dimension keys on a model catalog, an agent-kind catalog, an account's
boards, its services, its repositories or the task-type picklist, and stays in the tens on its
own. A busy account over `90d` produces thousands of the first two, which the panel projection
carried whole and the SPA rendered as one DOM row each.

So `summarize` caps those two at `REPORT_SLICE_LIMIT` (100) and reports each cap on the
projection's `capped` array as `{ dimension, returned, omitted }`; a dimension with no tail
contributes no entry, so an empty array means every breakdown in the projection is complete.
The public `GET /api/v1/usage/spend` had already reached this conclusion for its own reasons
(`PUBLIC_SPEND_MAX_ROWS`), and the two now cap through the same service.

Three properties make the cap honest rather than a smaller number that reads as complete:

- **The cap is applied to the AGGREGATED rows, not pushed into the `GROUP BY` as a SQL
  `LIMIT`.** A `LIMIT` would leave the store unable to say how big the tail was, which is the
  difference between "100 shown, 4,212 more" and a bare "there was more".
- **Totals fold from an UNCAPPED breakdown** (the `model` one), so what a cap costs the reader
  is the identity of the tail and never its money: the share the shown slices account for stays
  computable. This is the same rule the public read states about its own `totals`.
- **Rows arrive heaviest-first from the store**, so the prefix is the heavy end a cost question
  is actually about.

The panel prints the note under the capped card. Pushing the cap down into SQL would save
transferring the tail, and is the follow-up if that transfer ever becomes the cost; it needs a
`COUNT` beside the aggregate to keep `omitted` exact.

### One request, thirteen parallel aggregates

`ReportsService.summarize` issues eight spend breakdowns, four activity breakdowns and the
trend in ONE `Promise.all`. They are independent aggregates over indexed columns, not an
N+1: the alternative (a dimension query param) would make the panel issue the same thirteen
requests serially from the browser.

### A dimension that can FAN OUT is pre-aggregated first

`tasks.linked_block_id` carries a plain index, not a unique one: a block can legitimately be
linked from more than one imported issue (two trackers, or a re-import). Joining `tasks`
straight into the aggregate would multiply that block's calls, tokens and cost by the number
of tickets pointing at it, and the breakdown would stop summing to the window's totals. So
the `ticket` dimension joins a sub-select grouped down to one row per
`(workspace_id, linked_block_id)`, exactly as `service` does for colliding frame blocks, and
attributes a multi-linked block to the LOWEST `source:externalId` ref deterministically.
Splitting the cost across its tickets would be worse: the halves answer no question anyone
asked. The ticket's TITLE is deliberately not carried out of that sub-select, because a
second `MIN` over a different column need not come from the same row as the first, and a
label that names a different ticket than the key is worse than no label. The ref is
self-describing (`jira:PROJ-412`), so the dimension reports none.

`repo` needs no such guard: `services.id` and `(workspace_id, github_id)` are both primary
keys, so both of its joins are provably 1:1. Its key comes off the SERVICE (which always
knows its repo id) and its label off the projection (which the run's workspace may not hold a
row in), so an unsynced repo loses its name and keeps its money.

### Labels come from the SQL, not a second round trip

The `workspace` and `service` dimensions resolve a display name with a `LEFT JOIN` inside
the same aggregate (`max(workspaces.name)`, `max(blocks.title)` through
`services.frame_block_id`). The alternative (returning bare ids and resolving them in the
service through batch repository reads) would need a new `WorkspaceRepository.listByIds`
mirrored across both runtimes to save nothing. The remaining dimensions are
self-describing, so their `label` is null and the SPA renders the key.

## Wire shape

`GET /accounts/:accountId/reports?window=24h|7d|30d|90d&workspaceId=<id>` →
`reportsViewSchema`:

```
{ window, generatedAt, since, workspaceId, currency, source, rolledUpThrough,
  totals:   { inputTokens, outputTokens, calls, meteredCost, subscriptionCost },
  spend:    { byModel, byAgentKind, byWorkspace, byService,
              byRepo, byTaskType, byTicket, byRun },                       // ReportSpendRow[]
  capped:   [ { dimension, returned, omitted } ],                          // ReportSpendCap[]
  activity: { byWorkspace, byService, byRepo, byTaskType },                // ReportActivityRow[]
  trend:    { bucketMs, points } }                                         // ReportTrendPoint[]
```

Costs are in the **deployment's base currency**, not a workspace override: an account-wide
report spans boards that may each override it, and summing different denominations into
one number would be wrong.

The trend is zero-filled into a contiguous, oldest-first series so a quiet period reads as
a flat run of zeros rather than a collapsed gap implying continuous spend. A bucket outside
the zero-filled span (clock skew across nodes) is kept rather than discarded: it is spend
that happened.

## Presentation

`ReportsPanel.vue`, opened from the sidebar (`nav.reports`, admin-gated like the operator
dashboard) and mounted lazily from `pages/index.vue`. It follows the panel-native charting
idiom (Tailwind marks, no charting dependency), with two deliberate encodings:

- **Spend** is two series: `violet-500` metered, `amber-600` subscription. The pair is
  validated colourblind-safe against the dark surface, and a legend is always present.
  Bars scale against the heaviest slice in their own list, so a full bar means "the biggest
  consumer here", never an absolute budget.
- **Activity** uses the app's RESERVED status colours (emerald done / rose failed / sky
  running / slate other), which are red-green adjacent by design across the product. Every
  status is therefore ALSO carried as a number under its bar and named in the legend, so
  identity is never colour alone.

Model, agent kind, repository and ticket render unconditionally (they have no activity
counterpart); the other three share a dimension switch that drives the paired spend +
activity cards.

## Landed code

| Layer       | File                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Contract    | `backend/packages/contracts/src/reports.ts`, `routes/accounts.ts`                                                                     |
| Port        | `backend/packages/kernel/src/ports/reports.ts`                                                                                        |
| Service     | `backend/packages/orchestration/src/modules/reports/`                                                                                 |
| Controller  | `backend/packages/server/src/modules/reports/ReportsController.ts`                                                                    |
| Cloudflare  | `backend/runtimes/cloudflare/src/infrastructure/repositories/D1ReportsRepository.ts`                                                  |
| Node        | `backend/runtimes/node/src/repositories/drizzle/reports.ts`, `drizzle/spendRollup.ts`                                                 |
| Rollup port | `backend/packages/kernel/src/ports/spend-rollup.ts` (+ `D1SpendRollupRepository`, migration `0084`)                                   |
| Conformance | `backend/internal/conformance/src/reports-suite.ts`, `spend-rollup-suite.ts` (+ a spec each, per runtime)                             |
| SPA         | `frontend/app/app/components/panels/ReportsPanel.vue`, `ReportsSpendBreakdown.vue`, `stores/reports.ts`, `composables/api/reports.ts` |

## Not done (deliberately)

- **No wire shape for a cap that is NOT a plain prefix.** `capped` says how many slices were
  dropped, and the reader may assume they were the cheapest, because the cap is a prefix of the
  store's heaviest-first order. A future cap that is not (a sampled tail, a per-board quota)
  would have to say so rather than reusing this field.
- **No CSV/JSON export.** The endpoint already returns the whole projection as JSON; an
  export button is a thin SPA addition once someone asks for one. The public per-dimension read
  above covers the machine consumer that would otherwise have been the reason to add one.
- **No backfill of ledger history older than 90 days.** The first rollup pass reaches back the
  length of the longest report window and no further, so a deployment upgrading into this keeps
  its older history only for as long as the ledger's own retention holds it. Widening that is a
  one-constant change plus a slower first few passes; it is not done by default because the
  catch-up cost lands on a cron nobody is watching.
- **No `repo` or `ticket` axis on the SPEND TREND.** The trend is one series over the window,
  and per-dimension trend lines are a different chart, not a wider aggregate.
- **No per-user spend dimension.** `token_usage.user_id` is denormalized and would make one
  more spend axis trivial, but attributing cost to individuals is a policy decision, not a
  reporting one.
- **No scheduled report delivery.** The notification channel seam exists
  (`CompositeNotificationChannel`); a periodic digest would ride it rather than anything
  added here.
