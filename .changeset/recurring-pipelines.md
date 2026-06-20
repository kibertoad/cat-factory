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
  `GitHubClient` gains `createIssue`, and a runtime-neutral `TicketTrackerService`
  files GitHub issues (against the service's repo) or Jira tickets (markdown→ADF
  against the stored Jira connection). Two new seed pipelines: `pl_dep_update`,
  `pl_tech_debt`.
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
