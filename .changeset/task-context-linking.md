---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/orchestration': patch
---

Link integration context at task creation, GitHub issues as a source, and feed
all linked context to every agent step.

- **Linked context now reaches every step.** Documents (Confluence / Notion / …)
  and tracker issues (Jira / GitHub) attached to a task were only rendered into the
  prompts of the generic agent kinds — the four standard phases (architect, coder,
  reviewer, tester) silently dropped them, so the agents doing the work never saw
  the linked requirements/issues. The engine already resolves this context per step
  (`ExecutionService.buildAgentContext`); a shared `linkedContextSection` is now
  appended to every kind's user prompt (`@cat-factory/agents`), standard phases
  included.
- **Attach context when creating a task.** The "Add a task" modal now lets you
  select already-imported documents and issues and links them to the new task on
  creation (previously only possible from the inspector after the fact).
- **GitHub Issues as a task source.** A new `github` task source reuses the
  workspace's installed GitHub App (no separate credentials): it resolves the
  installation that owns the issue's repo and fetches the issue body + comments via
  the existing `GitHubClient` (new `getIssue`). Refs accept a full issue URL or the
  `owner/repo#number` shorthand. Wired in when `TASK_SOURCES` includes `github` and
  the GitHub integration is enabled.
