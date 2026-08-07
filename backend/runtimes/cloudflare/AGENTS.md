# `@cat-factory/worker`: Cloudflare Worker runtime facade

> Directory `backend/runtimes/cloudflare`, **published as `@cat-factory/worker`** (the
> package name predates the `runtimes/` layout). This is the Cloudflare deployment target:
> if you're looking for "the worker", it's here.

One of **three runtime facades** that serve the same runtime-neutral `@cat-factory/server`
Hono app. Keep them **symmetric**: any shared behaviour added here must land in the Node +
local facades too (root `CLAUDE.md` → "Keep the runtimes symmetric"). This facade supplies the
Cloudflare differentiators: D1 persistence, Durable Objects (real-time + per-run Containers),
Cloudflare Workflows (durable execution), queues/cron, and the `workers-ai` binding.

**Entry:** `src/index.ts` holds `createWorker(options?)` (the fetch/scheduled/queue handler) plus
the DO/Workflow classes; the default export is that handler with every registry defaulted, which is
what a deployment re-exports when it extends nothing. `src/app.ts` (`createApp()`, a thin wrapper
over `@cat-factory/server`).

**The default export builds its app LAZILY, on the first `fetch`.** Importing `createWorker`
evaluates this module, so an eager `createWorker()` at module scope would build a second complete
app inside every deployment that only wanted the factory, and on Workers module scope is the
startup-CPU budget. Keep it lazy.

**`createWorker` is this facade's INSTALLATION SEAM**, the counterpart of the Node facade's
`start({ … })` and the local facade's `startLocal({ … })`. A deployment registering its own agent
kinds, gates, pipelines, task types or foundational-service estate passes the instance in
(`createWorker({ overrides: { foundationalServiceRegistry } })`) and gets the whole boot sequence:
the `LOG_LEVEL` read, the once-guarded registration validation over ITS registries, and the
`scheduled`/`queue` handlers. **Never move a step of that back to the module scope of `index.ts`**:
a deployment cannot reach a registry newed there, and reassembling the sequence by hand costs it
a version-pinned direct dependency on `@cat-factory/server` (`setLogLevel` mutates module state, so
it only reaches the logger the Worker writes through while both imports resolve to ONE copy).

**Where things live** (under `src/infrastructure/`):

- `repositories/`: the D1 (SQLite) repos implementing the kernel ports (the **twin** of the
  Node facade's Drizzle repos).
- `container.ts`: the DI composition root (`buildContainer`), with its size-budget splits
  beside it: `container-assembly.ts` (the `ServerContainer` assembly), `container-registries.ts`
  (app-owned registry resolution), `container-trace-sinks.ts` (external LLM-trace destinations),
  `container-model-resolver.ts` (the memoised inline `ModelProviderResolver` + the per-step
  workspace default), `container-executor-deps.ts` (runner-transport selection, the container
  executor, the inline/sandbox composite and the consensus wrap), `container-notification-deps.ts`
  (how this facade DELIVERS a notification: the Slack transport, the outbound
  notification-webhook feature, and the composition of everything that is not the in-app push;
  keep symmetric with Node's own), `container-vcs-identity.ts`
  (the multi-App GitHub registry + the repo-target resolvers several siblings share) and
  `tasks-deps.ts` (the task-source registry: Jira, Linear, and the two VCS-backed issue sources,
  each fed its own provider's client). The
  executor and vcs-identity modules never import the root back (what they need from it arrives
  through `WorkerExecutorDeps`), so the module graph stays one-way.
- `ai/`, `gateways/`, `github/`: the CF gateway impls (realtime, GitHub, LLM upstream) + the
  container agent-executor **wiring** (same class names as `@cat-factory/server`'s `agents/`;
  those are the shared abstraction, these are the runtime wiring; see `docs/glossary.md`).
- `durable-objects/`, `workflows/`, `containers/`, `runners/`: durable execution + real-time
  - per-run-container machinery. `CacheGenerationDirectory` is the cache-coherency
    directory (per-group generation counters); its Worker-side client, the module-scope
    app-cache bag (one per ISOLATE, profile picked by the `CACHE_GENERATIONS` binding) and
    the `ctx.waitUntil` adopter for loader background work live in `appCachesHost.ts` +
    `requestContext.ts` (the ambient ExecutionContext every entry point brackets). That
    ambient is read for TWO things, and the second is the trap: `currentExecutionContext`
    adopts background work, and `currentInvocation` scopes the cache's IN-FLIGHT promises,
    because a bag that outlives the invocation would otherwise let one request await a
    promise another created, which workerd punishes by destroying the joining request
    UNCATCHABLY. Anything else hoisted to module scope owes the same question.
- `observability/`: the per-ISOLATE telemetry buffers and their flushes (`operationalFlush.ts`,
  `logExport.ts`, `logSettings.ts`, `platformMetrics.ts`, `cronSweep.ts`). Every entry point
  applies `applyLogSettings` and flushes what its isolate holds as a post-response `waitUntil`,
  because an isolate is discarded without notice and no later tick is guaranteed to reach what
  it held. Node's twins use timers. The WORKFLOW entry points cannot use that shape and have
  their own bracket (`workflows/logExport.ts`): a wake gives its isolate back at every durable
  wait (a sleep, a park, and a `step.do` attempt that threw into its retry backoff), so it drains
  in front of each one instead of after a response it does not serve.

Package root (not under `src/`): `migrations/` + `telemetry-migrations/` +
`sandbox-migrations/` + `migrations-provisioning/` + `audit-migrations/` hold the D1 schema, the
twin of the Node facade's `drizzle/` + `db/schema.ts`. One lineage per BINDING: a new one is also a
new `[[d1_databases]]` entry, a `files` entry in package.json, and a line in `deploy/backend`'s
`db:migrate:*` scripts plus deploy.yml's `migrations` path filter, or its schema never reaches
production.

## The deployment extension surface

`src/index.ts` publishes every app-owned registry constructor plus the authoring types, so a
deployment's only cat-factory runtime dependency is this facade
([ADR 0044](../../docs/adr/0044-facade-extension-surface.md)). This runtime takes its registries as
`overrides: Partial<CoreDependencies>`, so it accepts every seam by construction and the
reachability guard has nothing to say here; what still binds is constructibility, asserted by
`test/extension-surface.test.ts`. That list is a SYMMETRY copy of the Node facade's classification
(no shared dependency could carry one), so a seam added there lands here in the same change.

**See also:** `CLAUDE.md` → "Multi-runtime facades & cross-runtime conformance", "Execution
flow", "Repo bootstrap flow".
