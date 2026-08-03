---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Finish the operator-observability initiative: gate/CI-fixer attempt statistics, a daily run
rollup behind new 30d/90d dashboard windows, per-account alert-threshold settings, and a
platform-health alert card that deep-links to the runs it aggregated.

Two new main-store tables ship with it: `gate_outcomes` (one row per polling gate that reaches a
terminal verdict) and `platform_run_days` (the daily rollup, materialised by the retention
sweep). Both are pruned on their own retention windows, `GATE_OUTCOME_RETENTION_DAYS` (90) and
`PLATFORM_RUN_DAY_RETENTION_DAYS` (400).

Breaking (pre-1.0, no migration path offered): the `PlatformObservability` wire shape gains
required `source`, `rolledUpThrough` and `gates` fields, and `platformObservabilityWindowSchema`
gains `30d` / `90d`. A `platform_health` notification's `platformWindow` narrows to the
live-scanned windows only. Any stored projection or client pinned to the old shape must be
re-read rather than migrated.
