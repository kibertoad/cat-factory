# Initiative: reporting-surface gaps

**Status:** in progress (gaps 1 and 2 landed) · **Owner:** core · **Started:** 2026-08-29

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

Tracker for the **analytics reporting READ surface**: the account-scoped Reports panel
(`ReportsService` / `ReportsRepository` / `SpendRollupRepository` / `ReportsPanel.vue`), the
public per-dimension read it shares a code path with (`GET /api/v1/usage/spend`), and the
boundary it holds with the operator dashboard beside it.

## Goal & rationale

The reporting surface is built and answers its question well: where an account's money and
work go, sliced eight ways, routed by window between the live ledger and the durable
`spend_days` rollup, with each source named on the projection so a reader can never mistake
one for the other. Design record: [`backend/docs/reports.md`](../../backend/docs/reports.md).

A review of it against the repo's own rules found the gaps below. They fall into two kinds,
and the split is what this tracker is for:

- **Rules the surface states everywhere else and misses in one place.** "Every cap records
  what it dropped" and "degrade loudly" are honoured across the projection, and were not
  honoured by the two breakdowns that grow with activity. That is a defect, not a feature
  request, and it is what the first slice fixed.
- **Questions the surface deliberately declined, whose reasoning has since stopped
  holding.** The repository activity axis is the worked example: the stated reason ("a run is
  already counted under the service that owns its repo") is true only for a deployment whose
  services map one-to-one onto repositories, which the monorepo shape is not.

## Scope boundary

Four in-flight trackers touch spend and telemetry, and this one is none of them. The
dividing line is that they own PRODUCERS and this owns the READ over what they produced:

| Tracker                                                                               | Owns                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Token-usage and subscription-quota tracking](./usage-and-quota-tracking.md)          | the `token_usage` ledger, quota cycles, what gets recorded |
| [Spend forecasting, burn-rate and budget alerts](./spend-forecasting-and-alerts.md)   | projection math, thresholds, proactive notification        |
| [Per-class token telemetry + cost surfacing](./token-telemetry-per-class-and-cost.md) | the token classes a single call is recorded in             |
| [Per-run token-burn instrumentation](./token-burn-instrumentation.md)                 | why one run pushes the volume it does                      |

[PR verification report](./pr-verification-report.md) owns the OTHER thing this repo calls a
report: the per-run evidence reduction on a pull request body. Nothing here touches it.

A gap that turns out to belong to one of those goes there, not onto the checklist below.

## Gaps

Ordered by impact. Each states the evidence, because "a report could also show X" is not a
gap and this list should stay refusable.

### 1. The activity-scaled breakdowns were served and rendered uncapped (LANDED)

`spend.byRun` is one row per pipeline execution that spent anything in the window and
`spend.byTicket` one per tracker issue a run touched. Both grow with ACTIVITY where every
other dimension keys on a catalog and stays in the tens. The panel read returned all of them
and `ReportsSpendBreakdown.vue` rendered each as a DOM row, so a busy account opening a `90d`
window paid for it twice.

The port's own "no row cap" rationale had gone stale: it enumerated the bounded dimensions and
named `ticket` as the single exception, having been written before `run` was added, which is
strictly worse than `ticket` (every run with spend is a row; only some of them carry tickets).
The public read had already reached the opposite conclusion for its own reasons
(`PUBLIC_SPEND_MAX_ROWS`, `truncated`), so one service was capping for one caller and not the
other.

### 2. Activity had no repository axis (LANDED)

Spend answered "what did this repository cost", activity did not answer "how much work went
into it, and how much of it failed". The recorded reason was that a run is already counted
under the service that owns its repository, so a repository axis would answer the same
question twice. That holds only at one service per repository. Several services on one
repository is the ordinary monorepo shape, and no read publishes the service-to-repository
map, so a reader could not fold the service counts up even knowing they had to.

### 3. Activity duration is a bare mean where the sibling panel computes percentiles

`ReportActivityRow.avgDurationMs` is `AVG(updated_at - created_at)` over a slice's terminal
runs. One stuck run drags a service's apparent duration for the whole window, which is exactly
why `PlatformMetricsRepository` computes p50/p90/p99 beside its own mean. Two panels over the
same runs therefore disagree about how long things take, and the more misleading of the two is
the one an operator reads per service.

The pattern to copy exists on both runtimes (a cumulative-distribution inner query on SQLite
matching Postgres `percentile_disc`, pinned by conformance). It was not lifted in slice 1
because that pattern computes ONE global distribution, and a percentile per GROUP is a
different query shape that needs its own parity pass.

### 4. The failure taxonomy is not sliceable, so "which repository fails, and why" spans two panels

`ReportActivityRow` carries a `failed` count and no reason. The failure taxonomy lives on
`platformObservabilitySchema.failures` as a flat `{ kind, count }[]` over the whole window with
no board, service, repository or task-type axis. So the deployment can say what its failures
are and where its failures are, and cannot say both at once. A reader cannot join them: the
two reads partition different populations (`PlatformMetricsRepository` groups by run kind,
Reports counts every kind on purpose).

### 5. No export

Known and parked: the endpoint already returns the whole projection as JSON, and the public
per-dimension read covers the machine consumer. Slice 1 changed the shape of the answer,
though. An export that serialises the PANEL's projection now inherits its cap, so the honest
export reads `ReportsService.breakdown` per dimension at a higher limit and states its own
truncation, rather than saving what the browser happens to be holding.

### 6. No caching on a thirteen-aggregate read

Every panel open, window switch and board-filter change issues thirteen aggregates, and nothing
in the path touches the `AppCaches` seam. The short windows scan the ledger live, so this is
real work repeated for a reader clicking between `24h` and `7d`.

Not done with slice 1 on purpose. A cached analytics read has to reconcile `generatedAt` with
the cache's own age (a stale `generatedAt` is a worse lie than a slow panel), and the cache key
is the window itself, so it wants a designed slice rather than an entry added in passing.

### 7. Smaller, already recorded in the design doc

Restated here only so a reader of this list is not surprised by them; each is stated with its
reasoning in [`reports.md`](../../backend/docs/reports.md)'s "Not done (deliberately)":

- No backfill of ledger history older than the longest window.
- No per-user spend dimension (a policy decision, not a reporting one).
- No scheduled digest (it would ride `CompositeNotificationChannel`).
- No per-dimension series on the spend trend.

## Target pattern

The two landed slices are the model for anything else on this list:

- **A cap is applied to the AGGREGATED rows in the service, never as a SQL `LIMIT` in the
  port.** That is what keeps `omitted` an exact count rather than a boolean, and what keeps
  the port's "a breakdown partitions the whole window" property, which every caller's totals
  fold rests on. Totals fold from an UNCAPPED breakdown, so a cap costs the reader the
  identity of the tail and never its money.
- **A new axis is added on BOTH runtimes with a conformance assertion in the same change**,
  and the assertion pins the property that made the axis worth adding rather than merely
  exercising it. The repository activity fixture seeds two services on one repository across
  two boards, so the test fails if the fold is ever lost.
- **A dimension that can fan out is pre-aggregated first** (`SERVICE_LABELS`,
  `TICKET_BY_BLOCK`). Where both joins are on primary keys, say so at the site: it is the
  reason the next reader does not have to re-derive it.

## Prioritized checklist

- [x] **1. Cap `byRun` and `byTicket` on the panel projection** at `REPORT_SLICE_LIMIT`,
      reporting each cap on the projection as a dimension with its returned and omitted slice
      counts. An empty list means every breakdown is complete, and the capped card carries a
      footer note. (This PR.)
- [x] **2. Add `repo` to `ReportActivityDimension`**, wired on D1 and Drizzle, folded into the
      paired spend + activity dimension switch in the panel, with the monorepo fold pinned by
      conformance. (This PR.)
- [ ] **3. Percentile durations on activity rows.** Per-group p50 (and p90) beside the mean,
      mirroring `PlatformMetricsRepository`'s dialect-parity pattern. Decide first whether the
      mean stays: two numbers per slice may be more than the card can carry.
- [ ] **4. A failure-kind axis on the activity half.** Either a per-slice taxonomy on
      `ReportActivityRow` or a `failureKind` activity dimension. Note that Reports counts every
      run kind and the platform panel groups by it, so the two populations have to be
      reconciled before the numbers can be shown together.
- [ ] **5. Export.** Per-dimension, off `breakdown`, stating its own truncation.
- [ ] **6. An `AppCaches` entry for the window read**, keyed by `(account, workspace, window)`,
      with `generatedAt` reflecting the cached computation rather than the request.

## Conventions & gotchas carried between iterations

- **The `run` and `ticket` dimensions are the ones to check whenever a rule is written about
  "every dimension".** They are the two that do not key on a catalog, and the port comment
  that forgot this is what gap 1 was.
- **The panel's dimension switch is for axes with BOTH halves.** Model, agent kind, ticket and
  run render as spend-only cards because no activity population exists for them; repository
  moved into the switch when its activity half landed. A card rendered in both places is a
  duplicate, not a convenience.
- **Perturbing `seedReportsFixture` is cheap and its blast radius is not.** Roughly twenty
  assertions read it. The repository-activity slice added one service and one run and had to
  update two unrelated expectations (board B's status split and the `bug` task-type count);
  work the arithmetic out before seeding, because the suite needs real Postgres and workerd
  to run.
- **The public spend surface is FROZEN and declares its own copies of the vocabularies.**
  Adding an internal spend dimension fails `public-spend.test.ts` until it is either published
  or named in `PUBLIC_SPEND_DIMENSIONS_OMITTED` with a reason. Activity dimensions are internal
  only and have no such gate, which is why gap 2 needed no public-API decision.
