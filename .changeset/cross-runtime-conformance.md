---
'@cat-factory/node-server': minor
'@cat-factory/worker': patch
---

Mandate cross-runtime feature parity with a shared conformance suite, and wire the
Node facade's durable execution onto pg-boss.

- New private `@cat-factory/conformance` package: a runtime-neutral suite of the key
  backend behaviour (workspaces, board, the execution engine) parameterised by a
  `ConformanceHarness`, plus the single canonical deterministic `FakeAgentExecutor`.
  The Cloudflare Worker (over D1, inside workerd) and the Node service (over real
  Postgres) both run the IDENTICAL assertions, so any behavioural drift between
  runtimes fails a test instead of shipping silently. The Worker's `FakeAgentExecutor`
  is now a re-export of the shared one.
- `@cat-factory/node-server` gains a `PgBossWorkRunner` (`WorkRunner`) + `driveExecution`
  loop — the Node analogue of the Worker's Cloudflare Workflows driver — so a started
  run is driven to completion durably over Postgres-backed pg-boss. `start()` boots
  pg-boss and the execution worker; tests cover the full start → queue → drive → done
  path against a real pg-boss instance.
- CI runs the Node suite against a real Postgres service so parity is enforced on
  every PR.
