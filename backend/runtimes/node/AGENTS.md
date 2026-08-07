# `@cat-factory/node-server`: Node.js runtime facade

> Directory `backend/runtimes/node`, published as `@cat-factory/node-server`.

One of **three runtime facades** serving the same `@cat-factory/server` Hono app; keep them
**symmetric** (`CLAUDE.md` → "Keep the runtimes symmetric"). Node differentiators:
**Drizzle/Postgres** persistence, **pg-boss** durable execution, a raw-WebSocket real-time
transport, and Node model provisioning.

**Entry:** `src/index.ts` (exports `start()` / `createServer()` / `buildNodeContainer`);
`src/main.ts` (runnable entrypoint); `src/server.ts`.

**Where things live:**

- `repositories/drizzle.ts`: the Drizzle repos implementing the kernel ports (the **twin** of
  the CF D1 repos; a 3.9k-line monolith slated for splitting, see
  `docs/internal/refactoring-candidates.md` #1).
- `db/schema.ts` + `db/tables/*` + `drizzle/` (generated migrations): the Postgres schema.
  `schema.ts` is the single entry point every repo imports; the VCS/projection tables live in
  `db/tables/vcs.ts` and the tenancy & identity ones (the `workspaces`/`users` roots, login
  identities, the account + membership graph, invitations / password resets and the per-account
  rows) in `db/tables/identity.ts`, the account audit log in its own `audit` schema in
  `db/tables/audit.ts` (separate for RETENTION, not write profile: see the module header), and the observability group (the `telemetry` Postgres schema
  with its three append-heavy sinks, plus the two main-schema projections the operator dashboard
  aggregates) in `db/tables/observability.ts`, all re-exported from it (size-budget splits, so
  drizzle-kit and every importer still see one module). `identity.ts` is also where the schema's only two FK
  targets live, so the referencing credential tables import FROM it and the graph stays acyclic. `migrate()`
  (`db/migrate.ts`) bootstraps it idempotently on boot, failing fast with an actionable error on
  a ledger↔schema desync and wrapping apply failures with a recovery hint. `scripts/db-reset.mjs`
  (`pnpm db:reset`) is the destructive clean-slate recovery. Schemas are configurable for a shared
  database via `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` / `DB_PGBOSS_SCHEMA` (see CLAUDE.md →
  "Migration safety").
- `container.ts`: the DI composition root (`buildNodeContainer`, with injected
  `resolveTransport`/`mintInstallationToken`/`githubClient` seams the local facade overrides).
  Cohesive slices of the composition root live in sibling `container-*-deps.ts` modules so the
  root stays within the file-size budget (the public seams stay exported from `container.ts`):
  `container-executor-deps.ts` (transport resolver, provisioning-log wrapper, container executor +
  env-config repairer, GitHub-issue filer, trace-sink builder), `container-github-deps.ts`
  (`selectNodeGitHubDeps`: the engine GitHub client + CI/mergeability/review/doc-quality gate
  wiring + task-source + issue-writeback + GitHub projection/sync module deps),
  `container-model-deps.ts` (credential/token stores + the model-provider resolver + inline
  executor), `container-run-services-deps.ts` (agent-observability + web-search + sealed-secret
  services), `container-transport-deps.ts` (runner transport + deploy seams + repo bootstrapper),
  `container-account-deps.ts` (per-account settings + binary-artifact storage +
  observability/incident gate wiring), `container-realtime-deps.ts` (event publisher +
  notification channel + consensus wrap), and `container-content-library-deps.ts`.
- `execution/`: pg-boss durable execution (`PgBossWorkRunner` enqueues `execution.advance`;
  `driveExecution` runs the same advance/poll loop with plain sleeps; `signalDecision` re-enqueues
  a parked run).
- `gateways.ts`, `modelProvider.ts`, `realtime.ts`, `config.ts`, `retention.ts`: Node gateway
  - model + transport wiring and the retention sweep.
- `platformMetrics.ts` + `logExport.ts`: the opt-in OTLP pushes. Both are the FETCH exporter on
  both runtimes, so the Worker runs the same code on its cron / per-invocation flush; what is
  Node-specific here is only the timer and the shutdown flush (`logExport` detaches the sink LAST,
  after every other stop, so the shutdown's own lines get out).

## Real-time & multi-node

Real-time is a per-workspace `NodeRealtimeHub` plus `attachRealtime`, serving the SAME
raw-WebSocket + `?ticket=` protocol via a `ws` server on the HTTP `upgrade` event
(`@hono/node-server` can't upgrade from a Hono `Response`, and the SPA speaks raw WebSocket).
**Multi-node** rides a layered propagator behind a narrow `LocalEventSink` seam: Redis pub/sub
today, another adapter on the same port tomorrow; with no bus the layer is exactly the bare hub.
The Worker needs none of this (its `WorkspaceEventsHub` DO is globally addressed, so propagation
is inherent; a genuine Node-only concern, not a parity gap).

Container steps dispatch to a workspace's self-hosted runner pool, which runs the same harness
image and therefore serves EVERY dispatch kind with no opt-in allow-list; unconfigured, the
composite serves inline kinds and fails container kinds loudly.

## The deployment extension surface

`src/index.ts` is the WHOLE surface a deployment package needs: every app-owned registry's
constructor beside the option that takes it, plus the authoring types, the descriptor helpers and
the `*_PIPELINE_ID` constants. A deployment's only cat-factory runtime dependency is this facade,
because every `@cat-factory/*` package publishes at an EXACT version and reaching below the facade
for a builder re-creates the two-physical-copies failure the registry seams exist to remove
([ADR 0044](../../docs/adr/0044-facade-extension-surface.md)).

`test/registry-seams.spec.ts` owns the authoritative classification for ALL THREE facades and holds
three separate rules: a seam is an option on `NodeContainerOptions`, an option on `StartOptions`
(the door a deployment actually calls), and CONSTRUCTIBLE from this module's own exports. They fail
independently and have each failed alone. Adding a registry to `CoreDependencies` stops the file
compiling until all three are answered; the local and Worker facades assert they publish the same
constructors.

`start({ escalateRegistrationWarning })` lets a deployment raise selected boot-validation warnings
to errors. Severity is platform judgement (boot warns only where it structurally cannot see the
answer); the disposition belongs to the deployment, which may know the cause the platform cannot
rule out does not apply to it.

## Resolving conflicting Drizzle migrations (post-merge)

Node's Postgres migrations (`drizzle/`) use drizzle-kit 1.x snapshot v8: a content-addressed DAG
(each `snapshot.json` has an `id` and a `prevIds` array), not a linear journal. `src/db/schema.ts`
is the source of truth and `pnpm db:generate` diffs it; `migrate()` applies folders in timestamp
order, so `prevIds` affects only the consistency analysis. A merge keeps both branches' folders
with no textual conflict, but the later branch's `prevIds` still points at the pre-merge tip, so
`db:check` fails with "Non-commutative migrations detected". (D1 has no such DAG; duplicate
numeric prefixes are fine.)

Do NOT hand-merge snapshot JSON or rerun `db:generate` (a table move triggers an interactive
rename prompt that can't run in a non-TTY shell). Instead:

1. Resolve conflicts in `src/db/schema.ts` first, keeping BOTH branches' columns.
2. From `backend/runtimes/node`, run
   `node scripts/rebase-migration-snapshot.mjs <later-migration-folder>`, which rewrites that
   snapshot's `ddl` from the merged schema and re-points `prevIds` at every other migration's
   leaf, non-interactively. It does not touch `migration.sql`.
3. Check `migration.sql` still encodes the delta to the merged schema.
4. Verify with `pnpm db:check`. Keep the symmetric D1 migration in step.

**See also:** `CLAUDE.md` → "Multi-runtime facades", "Migrations".
