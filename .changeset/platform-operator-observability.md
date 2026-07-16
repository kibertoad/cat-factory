---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add platform-operator observability: a deployment-level operator dashboard.

A new `PlatformMetricsRepository` kernel port exposes SQL rollups over `agent_runs`
(run outcomes, failure-kind taxonomy, live/parked depth, duration stats, and a
time-bucketed outcome trend), scoped to an account and implemented on both the D1
(Cloudflare) and Drizzle (Postgres/Node) stores with cross-runtime conformance. The
admin-gated `GET /accounts/:accountId/observability/platform` endpoint returns a
windowed (1h / 24h / 7d) projection, surfaced in the SPA as an operator dashboard
panel (outcome tiles + success rate, an outcome-trend sparkline, the failure
breakdown, live depth, and duration stats), reachable from the sidebar by account
admins. Fully internationalized.
