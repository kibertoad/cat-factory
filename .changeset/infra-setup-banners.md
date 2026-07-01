---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Warn when required infrastructure is undefined. The workspace snapshot now carries an
`infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
deployment actually wired) that tracks three areas explicitly as `not_defined` /
`configured` / `not_applicable`:

- **Ephemeral environments** (all runtimes that wire the environments integration) —
  `not_defined` when no environment provider connection is registered, so testing agents
  that need a live environment can't run.
- **Agent executor** (stock/remote Node only — Cloudflare has built-in per-run containers, and
  local mode runs agents in per-run HOST containers) — `not_defined` when no self-hosted runner
  pool is registered, so NO container agents can run. This area fires only where the pool is the
  SOLE executor (the new `agentExecutorRequiresRunnerPool` container flag, set by the Node facade
  when it uses the default pool transport); Cloudflare and local both wire the runner surface but
  keep a built-in executor, so the pool is optional there and the area is `not_applicable` — a bare
  `!!container.runners` check would otherwise falsely nag on every local deployment.
- **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
  store) — `not_defined` when the account selected no content-storage backend, so UI
  screenshots / reference images have nowhere to live.

The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
into the relevant configuration. Dismissing a banner asks whether to hide it just for this
session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
again" — the latter persisted per-user in localStorage.

The advisory top-of-board banners (AI-readiness, provider-config, infra-setup) now render in a
single shared, click-through column so concurrent prompts on a fresh deployment stack vertically
instead of drawing on top of each other. The `RunnerPoolConnectionService` and
`EnvironmentConnectionService` gain a `hasConnection` presence probe (no secret decrypt) that the
projection uses on the hot board-load path.

Each area probe is additionally bounded by a timeout and its swallowed faults are logged, so a slow
or misconfigured backend read degrades that area to `not_applicable` (advisory-only, never 500s or
stalls the board load) while staying diagnosable. The banner's permanent-dismissal `localStorage`
key + the infra-setup area list are exported from `@cat-factory/contracts`
(`INFRA_SETUP_DISMISSED_STORAGE_KEY` / `INFRA_SETUP_AREAS`) so the SPA and the e2e seed share one
source of truth, and the stacked banner cards announce through a single polite live region instead
of one assertive alert each.
