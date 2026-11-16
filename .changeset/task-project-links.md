---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': patch
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A task can link projects as read-only context. Every dispatch of the task reads each linked
project's current result, rendered by its kind's module (the new optional
`ProjectKindModule.renderContext`) or, for a kind that renders none, as the newest outcome of each
stream. It is summarised in the prompt's linked-context index and given in full as a
`project-<name>.md` file in `.cat-context/`. A research project contributes its folded findings
with coverage. The step records which outcome it read (`contextProjects`).

A link is admitted only for a project of the task's organization (`project_link_invalid`) that has
a result to read, meaning at least one outcome (`project_has_no_result`). Links are made on the board's task inspector, over
`/workspaces/:workspaceId/blocks/:blockId/projects`, over the public
`/api/v1/tasks/{taskId}/projects` routes, with the create-time `projects` field, and through an
initiative item's `spawn.projects`. Public API 1.98.0; SDKs regenerated.

Links live in a new `task_project_links` table on D1 (`0117_task_project_links.sql`) and Postgres,
and are dropped when either the task or the project is deleted. `ProjectRecordRepository` gains the
batched `listOutcomesOfProjects` and `projectsWithOutcomes` on both runtimes. The research-projects
initiative tracker is now ADR 0069.
