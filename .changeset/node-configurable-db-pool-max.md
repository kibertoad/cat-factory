---
'@cat-factory/node-server': patch
---

Make the Postgres connection-pool size configurable via `DATABASE_POOL_MAX` (unset ⇒ node-postgres'
default of 10). The whole app shares one pool — HTTP controllers, the durable execution worker
(`driveExecution`), and the periodic initiative-loop sweep — so under concurrency a default-size
pool can serialize their DB work and starve the sweep, delaying an initiative's first task spawn.
A concurrency-heavy deployment (or a single-process test backend serving a whole suite) can now
raise the ceiling.
