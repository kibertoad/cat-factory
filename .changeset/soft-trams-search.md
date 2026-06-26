---
---

CI/test infrastructure only (no shipped behaviour change): parallelise the Postgres-backed
Node/Local suites. Each vitest worker now gets its own database (per-worker isolation in the
test harness) so `fileParallelism` is enabled, and the monolithic cross-runtime conformance
suite is split into per-group spec files (core/agents/integration/execution/misc) that fan out
across those workers. CI's `test-rest` job is split into a no-DB `test-units` lane and a
Postgres `test-db` lane. `@cat-factory/conformance` gains exported group functions
(`defineCoreConformance` … `defineMiscConformance`) and a `deriveWorkerDatabase` helper;
`defineConformanceSuite` still composes them for the Cloudflare Worker.
