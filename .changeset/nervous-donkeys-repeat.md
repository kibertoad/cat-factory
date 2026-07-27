---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add Reports: an account-scoped, admin-gated analytics view answering where the spend and the work go — spend per model and per agent kind, spend and run activity per board / service / task type, and a spend trend over a 24h/7d/30d/90d window with an optional single-board filter.

New `GET /accounts/:accountId/reports` over the new kernel `ReportsRepository` port, implemented on both runtimes (D1 ⇄ Drizzle) and pinned by a cross-runtime conformance suite. Every breakdown is one SQL `GROUP BY` over the existing `token_usage` and `agent_runs` tables — no new table and no migration. Real metered cost is reported separately from the illustrative equivalent-API cost of flat-rate subscription usage, and a call whose run / service / task type cannot be resolved is surfaced as its own unattributed slice rather than dropped.
