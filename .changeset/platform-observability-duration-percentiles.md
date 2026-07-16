---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add duration percentiles (p50/p90/p99) to the platform-operator dashboard.

`PlatformMetricsRepository.durationStatsSince` now returns the discrete (nearest-rank)
p50/p90/p99 wall-clock duration percentiles alongside the existing avg/min/max, computed
over the same terminal-run set in one aggregate query per dialect — Postgres via
`percentile_disc`, D1/SQLite via a `row_number()/count()` cumulative-fraction
order-statistic workaround (SQLite has no percentile aggregate). The cross-runtime
conformance suite pins that the two dialects agree. The `GET /accounts/:accountId/observability/platform`
projection carries the new fields, and the operator dashboard's "Run duration" panel
renders them (internationalized across all locales), so tail-latency outliers the average
hides are visible.
