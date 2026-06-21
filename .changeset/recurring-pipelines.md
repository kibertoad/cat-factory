---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Scheduled recurring pipelines on services.

A service (a `frame` block) can now carry **recurring pipelines** that re-run a
pipeline on a cadence — primarily **Dependency updates** and **Tech debt**. A
schedule runs every `intervalHours`, optionally constrained to an allowed window
(weekdays + an hour-of-day range, in a chosen IANA timezone), and owns one reused
on-board task block inside the service that each fire runs the pipeline against
(skipping any fire while a run is still in flight). Run history is kept ~1 week and
surfaced in the inspector.

- **Tech-debt pipeline** adds two agent kinds: a read-only `analysis` container
  agent that audits the repo, then a special non-LLM `tracker` step that files a
  **GitHub issue or Jira ticket** from the analysis before implementation. The
  tracker is a per-workspace selection (`GET|PUT /workspaces/:ws/tracker-settings`);
  `GitHubClient` gains `createIssue`. The runtime-neutral `TicketTrackerService`
  resolves each **tenant's own** connected integration (it is injected with a
  `fileGitHubIssue` filer + a `resolveJiraConnection` resolver, never shared/env
  credentials): on Cloudflare it files GitHub issues through the workspace's GitHub
  App installation against the service's repo, and Jira tickets (markdown→ADF) using
  the workspace's encrypted `task_connections`. Two new seed pipelines:
  `pl_dep_update`, `pl_tech_debt`.
- **Per-tenant tracker on the Node facade**: both trackers now work on Node, each
  resolving the **workspace's own** integration. Jira: the task-source integration is
  wired on Node (always on; requires the shared `ENCRYPTION_KEY`) — a Drizzle
  `task_connections`/`tasks` store + the runtime-neutral Jira provider — so each tenant
  connects its own Jira through the existing UI (credentials encrypted at rest). GitHub:
  the filer mints a short-lived token from that workspace's own GitHub App installation
  (reusing the per-tenant App infra) and resolves the service's repo from the
  `github_repos` projection — no shared/env credentials.
- **Persistence + scheduling are symmetric across runtimes**: D1 migration
  `0029_recurring_pipelines.sql` ⇄ Drizzle schema + generated migration; the
  Cloudflare `scheduled` cron fires due schedules (and prunes run history) ⇄ a Node
  `setInterval` sweeper does the same. New ports `PipelineScheduleRepository` /
  `TrackerSettingsRepository` with D1 + Drizzle implementations; the cross-runtime
  conformance suite covers schedule CRUD, `runDue`, and the tracker setting.
- **UI**: an "Add recurring pipeline" button on the service frame (mirroring "Add
  task") opens a per-frame modal (pipeline + cadence editor; the tracker choice is
  surfaced inline for the tech-debt pipeline). The schedule's block shows a recurring
  badge on the board; selecting it reveals the cadence, run-now/pause, and run
  history in the inspector.
