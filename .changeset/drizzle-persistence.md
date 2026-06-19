---
'@cat-factory/node-server': minor
'@cat-factory/server': patch
'@cat-factory/worker': patch
---

The Node runtime now persists to Postgres via Drizzle (the latest 1.0 RC) — the
single persistence used in dev, test and prod (no test-only in-memory store). It
implements every core kernel repository port (workspaces, accounts, memberships,
blocks, pipelines, executions-on-agent_runs, token usage, agent-runs) over a
node-postgres pool, reusing the SAME row<->domain mappers the Cloudflare D1 repos
use — which moved into `@cat-factory/server` so both stores share one mapping (the
Worker re-exports them from their old path). The schema mirrors the D1 tables
column-for-column; `migrate()` bootstraps it idempotently on boot. `DATABASE_URL`
selects the database; the in-memory repositories are removed.
