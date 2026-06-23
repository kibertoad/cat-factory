---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Create board tasks directly from imported GitHub issues or Jira tickets.

Previously an imported issue could only be attached to an *existing* task block as
agent context. The task-source integration now also materialises an issue as a
brand-new board task: `TaskLinkService.createTaskFromIssue` seeds a leaf block
(title `KEY: summary`, description = a source-reference line + the issue body)
inside a chosen service frame or module via `BoardService.addTask`, then links the
issue to the new task so every agent step still sees the full issue (description,
comments, metadata) as context. The issue stays the source of truth — re-importing
refreshes it. Backed by `POST /workspaces/:ws/tasks/create-block`
(`{ source, externalId, containerId }` → `{ block, task }`). In the UI, the
task-source import modal gains a "create tasks in" container picker and a per-issue
"Create task" action.

Also closes two cross-runtime parity gaps in the task-source layer so the feature
works identically on both facades:

- **GitHub issues as a task source now work on the Node runtime.** The
  runtime-neutral `GitHubIssuesProvider` (it depends only on the `GitHubClient` /
  `GitHubInstallationRepository` ports) moved from the Cloudflare package into the
  shared `@cat-factory/integrations`, and the Node facade wires it whenever a GitHub
  client is available (the App is configured) — mirroring the Worker's
  `config.github.enabled` gate. Previously only the Worker offered GitHub issues.
- **Jira search now works on the Node runtime.** The Node `JiraProvider` gained the
  `search()` method its Cloudflare twin already had (the legacy Node copy had
  silently dropped it).
