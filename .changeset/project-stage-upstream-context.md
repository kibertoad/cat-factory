---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': patch
'@cat-factory/conformance': patch
---

A staged project task reads the stages its stage `consumes`. Each consumed stage's result, up to exactly the outcome the task's stage started from, is rendered by the handler that wrote it (the new optional `ProjectTaskHandler.renderContext`; research folds a stage's findings against that stage's questions) and reaches the agent the way a linked project does: a `.cat-context/` file and an index line, which the project researcher's prompt now includes. The step records what it read in `step.project.upstream`, and a consumed stage with no accepted result is stated rather than left out.

Breaking for code calling the kernel's research renderer directly: `renderResearchContext` takes a `{ spec, label }` source instead of a pinned definition, and `ProjectRunContext` carries `upstream`.
