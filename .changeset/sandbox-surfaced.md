---
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/sandbox': minor
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

Run-driver hardening: a relaunch clears the prior result grid first (new
`SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
derived from whether any cell was actually graded (`failed` when every candidate failed OR
every grade failed — never a misleading `done` over a grid of unscored cells, and never
left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
than silently failing every cell) and is documented as a soft cap enforced between cells;
the judge model defaults to the deployment routing default (no hardcoded vendor) and
requires an explicit `judgeModel` when none is configured (the experiment builder now
exposes a judge-model picker so a deployment with no default still has recourse); an
unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
the cell rather than silently flooring every dimension to the minimum (which read as a
confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
`extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
document planner and the Sandbox judge (replacing two weaker object-only copies) — is
string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
(so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
(`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
launches of the same experiment are now serialised by an atomic
`SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
inside the terminal-status `finally` so a failure there can't strand the experiment
`running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
matrix inline in the launch request (bounded by the cell cap + token budget); a durable
fan-out (Workflows / pg-boss) for large matrices remains a follow-up.
