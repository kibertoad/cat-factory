---
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/conformance': patch
'@cat-factory/worker': patch
---

Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
features that worked on the Worker but `503`'d on the Node + local facades (their
repositories were never wired) now work identically on all three, each landed with
a cross-runtime conformance assertion.

- **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
- **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
  (the blueprint reads; the `blueprints` pipeline step already ran on Node).
- **Document sources** — `document_connections`/`documents` + repos; the Confluence /
  Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
  so both facades compose the same providers.
- **Ephemeral environments** — `environment_connections`/`environments` + repos;
  `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
  `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
- **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
  `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
  full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
  webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
  `@cat-factory/server`.
- **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
  `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
  `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
  Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
  yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
  self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
  kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
  serves it just like the local Docker transport — so a real bootstrap run dispatches +
  pushes for real on Node, not just on local.
- **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
  `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
  `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
  `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
  `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
  tenant fragment catalog feeding every agent run works identically on all three.

The Worker keeps the same behaviour (it gains the new conformance assertions and the
shared promoted classes). **Breaking on Node/local:** these features now require their
new tables — boot-time `migrate()` applies them; there is no data to preserve.

The Node/local Drizzle migration lineage was re-baselined to a single fresh
`drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
green again. Safe because no deployed database depends on the old lineage.

Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
and GitHub rate-limit telemetry (Node keeps the no-op repository).
