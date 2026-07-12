---
'@cat-factory/node-server': patch
---

feat(node): add a `/ready` readiness probe distinct from liveness `/health` (audit item 9)

`/health` was a static 200 regardless of downstream health, so a replica whose Postgres pool
had died or whose pg-boss worker had stopped still reported healthy and a load balancer could
not drain it. Adds a PUBLIC `GET /ready` that round-trips the app's Postgres pool (a bounded
`SELECT 1`) and checks a pg-boss `running` flag, answering `200 {status:'ready'}` /
`503 {status:'not_ready'}` with per-dependency `checks`. It also drains the instant graceful
shutdown begins — `bootServer` flips a `draining` flag at the top of `shutdown()`, so a
SIGTERM'd node reports not-ready immediately and new traffic stops arriving while in-flight
requests finish. `/health` stays a static 200 (liveness: a restart can't fix a dead pool). The
verdict is a pure `checkReadiness` in `readiness.ts`; `createApp` gained an optional `readiness`
probe (wired by `start()` from the live pool + boss). Node-facade-specific by design — the
Worker has no long-lived process and local mothership mode has no local Postgres/pg-boss, so
both wire no probe and `/ready` falls back to a bare `ready`.
