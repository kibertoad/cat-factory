---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Platform-operator observability: threshold alerting (initiative slice 5). A periodic,
runtime-symmetric sweep (Worker cron ⇄ Node interval) evaluates each account's aggregate
run-health projection — the same read the operator dashboard renders, so no new SQL — against
operator-configured thresholds (failure rate, p99 run duration, live backlog depth) and raises a
new `platform_health` notification through the existing NotificationChannel seam (in-app + Slack)
when one is crossed, auto-clearing when the account recovers. The card de-dupes on the firing
reason set, so a persistently-unhealthy deployment re-notifies only on state change, not every
sweep. Opt-in via `PLATFORM_ALERTS=true` (thresholds/window/interval tunable via
`PLATFORM_ALERTS_*`). Adds block-less `NotificationRepository.findOpenByType` (single-workspace
dedup) and `listOpenByType` (batched across workspaces, so the sweep avoids a point-read per
workspace) lookups (D1 ⇄ Drizzle + conformance) and threads `platform_health` through the Slack
transport and the SPA notification inbox (routable/action labels localized in all 10 locales).
