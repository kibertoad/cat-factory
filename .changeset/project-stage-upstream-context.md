---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': patch
'@cat-factory/app': patch
'@cat-factory/conformance': patch
---

A staged project task reads the stages its stage `consumes`. Each consumed stage's result, up to exactly the outcome the task's stage started from, is rendered by the handler that wrote it (the new optional `ProjectTaskHandler.renderContext`; research folds a stage's findings against that stage's questions) and reaches the agent the way a linked project does: a `.cat-context/` file and an index line. A project job now materialises its context files and appends the shared linked-context index for every project kind, so linked projects, documents and issues reach a project task's agent too. A result the task started from that cannot be read refuses the dispatch with `project_stage_upstream_unreadable`, and a stage may read an upstream stage only once. The step records what it read in `step.project.upstream`, and a consumed stage with no accepted result is stated rather than left out.

Breaking for code calling the kernel's research renderer directly: `renderResearchContext` takes a `{ spec, label }` source instead of a pinned definition, and `ProjectRunContext` carries `upstream`.
