---
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/conformance': patch
'@cat-factory/worker': patch
---

Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: six product
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
  yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too.

The Worker keeps the same behaviour (it gains the new conformance assertions and the
shared promoted classes). **Breaking on Node/local:** these features now require their
new tables — boot-time `migrate()` applies them; there is no data to preserve.

Deferred (still Worker-only, flagged for follow-up): the fragment library (being
reworked separately), real-time push (Node `realtime` gateway still `501`s — needs a
WebSocket hub over Postgres `LISTEN/NOTIFY`), queue-backed async GitHub ingest (Node
ingests inline rather than via a pg-boss queue), and GitHub rate-limit telemetry
(Node keeps the no-op repository).
