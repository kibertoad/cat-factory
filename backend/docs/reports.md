# Reports: design

**Status:** Implemented (see the "Landed code" map at the end).
**Scope:** account-scoped, admin-gated, read-only. No new table, no migration.

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
  by board, by service, by task type**, and **run activity by board, by service, by task
  type**, plus a **spend trend**.
- **Never conflate real money with flat-rate quota usage.** A subscription harness call's
  cost is illustrative (what the same tokens WOULD have cost on the metered API); the spend
  gate excludes it, and so must every number here.
- Every breakdown is **one SQL `GROUP BY`**, per the repo's N+1/aggregate ban.
- Runtime-symmetric (D1 ⇄ Drizzle) with conformance coverage, per the parity rule.
- **No new persistence.** Everything is already recorded.

## The data, and why no table was added

Every number comes from tables that already exist in the MAIN store on both runtimes:

| Source        | Supplies                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `token_usage` | the metered ledger: workspace, agent kind, provider/model, tokens, cost, `billing`, timestamp  |
| `agent_runs`  | run outcomes and wall-clock duration, plus the run's `service_id` / `block_id`                 |
| `blocks`      | a task's `task_type`, and a service frame's `title` (its display name)                         |
| `services`    | the service → frame-block link                                                                 |
| `workspaces`  | the board's name, and the `account_id` scope sub-select                                        |

`token_usage` carries no service or task type (a metered call records the RUN, not the
board shape), so those two spend dimensions join through `execution_id → agent_runs` and
then to the run's service/block. That join is why the port lives in the main store and
never touches the telemetry database (a physically separate D1 database on Cloudflare).

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

### No row cap

Every dimension has naturally bounded cardinality: the model catalog, the agent-kind
catalog, an account's boards, its services, the task-type picklist. Capping would either
silently drop slices (which the repo's "no silent caps" rule forbids) or make the folded
totals disagree with the rows shown. Documented on the port so a future dimension with
unbounded cardinality is a deliberate decision, not an accident.

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
what the spend breakdowns key on. So `ReportActivityDimension` is `workspace | service |
taskType` while `ReportSpendDimension` adds `model` and `agentKind`. The contract encodes
the difference rather than returning empty arrays for combinations that cannot exist.

### One request, nine parallel aggregates

`ReportsService.summarize` issues five spend breakdowns, three activity breakdowns and the
trend in ONE `Promise.all`. They are independent aggregates over indexed columns, not an
N+1: the alternative (a dimension query param) would make the panel issue the same nine
requests serially from the browser.

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
{ window, generatedAt, since, workspaceId, currency,
  totals:   { inputTokens, outputTokens, calls, meteredCost, subscriptionCost },
  spend:    { byModel, byAgentKind, byWorkspace, byService, byTaskType },   // ReportSpendRow[]
  activity: { byWorkspace, byService, byTaskType },                        // ReportActivityRow[]
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

Model and agent kind render unconditionally (they have no activity counterpart); the other
three share a dimension switch that drives the paired spend + activity cards.

## Landed code

| Layer       | File                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Contract    | `backend/packages/contracts/src/reports.ts`, `routes/accounts.ts`                                                                     |
| Port        | `backend/packages/kernel/src/ports/reports.ts`                                                                                        |
| Service     | `backend/packages/orchestration/src/modules/reports/`                                                                                 |
| Controller  | `backend/packages/server/src/modules/reports/ReportsController.ts`                                                                    |
| Cloudflare  | `backend/runtimes/cloudflare/src/infrastructure/repositories/D1ReportsRepository.ts`                                                  |
| Node        | `backend/runtimes/node/src/repositories/drizzle/reports.ts`                                                                           |
| Conformance | `backend/internal/conformance/src/reports-suite.ts` (+ a spec in each runtime)                                                        |
| SPA         | `frontend/app/app/components/panels/ReportsPanel.vue`, `ReportsSpendBreakdown.vue`, `stores/reports.ts`, `composables/api/reports.ts` |

## Not done (deliberately)

- **No CSV/JSON export.** The endpoint already returns the whole projection as JSON; an
  export button is a thin SPA addition once someone asks for one.
- **No per-user spend dimension.** `token_usage.user_id` is denormalized and would make a
  sixth spend axis trivial, but attributing cost to individuals is a policy decision, not a
  reporting one.
- **No scheduled report delivery.** The notification channel seam exists
  (`CompositeNotificationChannel`); a periodic digest would ride it rather than anything
  added here.
