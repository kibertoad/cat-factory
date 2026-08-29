---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Bound the activity-scaled Reports breakdowns, and give run activity its own repository axis

Two findings from a review of the account Reports surface.

**The two breakdowns that grow with activity were served and rendered whole.**
`spend.byRun` is one row per pipeline execution that spent anything in the window and
`spend.byTicket` one per tracker issue a run touched; every other dimension keys on a catalog
and stays in the tens. The panel read returned all of them and rendered each as a DOM row, so
a busy account opening a `90d` window paid for the tail twice. The port's "no row cap"
rationale had gone stale: it enumerated the bounded dimensions and named `ticket` as the one
exception, having been written before `run` was added, which is strictly worse. The public
`GET /api/v1/usage/spend` had already capped for its own reasons, so one service was capping
for one caller and not the other.

`ReportsService.summarize` now caps those two at 100 slices and reports each cap on the
projection as `capped: [{ dimension, returned, omitted }]`; an empty array means every
breakdown is complete, and the panel prints the note under the capped card. The cap is applied
to the aggregated rows rather than pushed into the `GROUP BY` as a SQL `LIMIT`, which is what
keeps `omitted` an exact count, and the window totals still fold from an uncapped breakdown,
so what a cap costs the reader is the identity of the tail and never its money. Both callers
of the port now cap through the one `capSlices` helper; the public `GET /api/v1/usage/spend`
keeps reporting it as the boolean `truncated` its frozen response schema carries.

**Run activity gained a `repo` dimension.** Spend answered what a repository cost while
activity could not answer how much work went into it or how much of it failed. The recorded
reason was that a run is already counted under the service owning its repository, which holds
only where services map one-to-one onto repositories: several services on one repository is
the ordinary monorepo shape, and no read publishes that mapping for a caller to fold the
counts itself. It is one `GROUP BY` over `agent_runs` through the same two primary-key joins
the `repo` spend dimension uses, so neither can fan the run count out.

Two internal wire changes ride along, per the pre-1.0 rule for internal shapes: the reports
projection gains `capped` and `activity.byRepo`, and `ReportActivityDimension` gains `repo`.
The public API is untouched (it publishes no activity axis). In the panel, the repository
breakdown moves out of the spend-only card row and into the paired spend + activity dimension
switch beside board, service and task type.
