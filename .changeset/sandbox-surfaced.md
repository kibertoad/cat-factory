---
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
with no way to use the feature; this wires the full stack:

- **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
  fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
  (the run-driver + judge — expands an experiment matrix into cells, runs each inline
  candidate against the prompt-version's system text + the fixture input, grades it with a
  judge model against the task rubric, and records the deterministic objective findings
  score). Assembled as the `sandbox` core module when its repositories are wired.
- **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
  experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
- **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
  isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
  `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
  (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
  `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
  conformance asserts parity.
- **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
  command palette) to clone/version prompts, browse graded fixtures, and define + run
  experiments with a scored results grid.

BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
it, provision a second D1 database and point the binding + its `migrations_dir` at the
package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
`sandbox` schema is created automatically by the boot migrator.

Container/repo fixtures (a real checkout) are not yet supported by the in-product run
driver and are refused at launch; the builtin fixtures are all inline.
