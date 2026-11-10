---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A project task now runs, through one engine path for every project kind, and research is the
first kind that uses it.

- A project kind ships a `ProjectKindModule`, its code half: how its definitions validate, how a
  task is planned and its agent briefed, how a parked dispatch's checkpoint folds into the reply,
  and which artifacts an outcome references. `ProjectKindModuleRegistry` is a new option on
  `start()`, `startLocal()` and the Worker, defaulting to the built-in kinds' modules, and the
  default definition registry validates exactly those kinds.
- The engine's `ProjectStepController` does the rest for every kind: it refuses a changed or
  missing pinned definition, claims the task's outcome sequence when it first starts, fixes the
  kind's plan on the step (`PipelineStep.project`), hands the agent the kind's brief
  (`AgentRunContext.project`), parks on a credential the agent asks for with its partial output
  kept on the step, and records one outcome per task, inline.
- The platform ships a built-in `research` kind (`defaultProjectKindRegistry()`, which now pins a
  definition with `definition: 'required'`), the `research` task type (refused under a service with
  `task_type_requires_project`), the `project-research` pipeline purpose and the `pl_research`
  pipeline. Its `project-researcher` agent runs on the `ui` image as the new `container-project`
  surface, dispatching the harness's `project` job.
- New refusals: `project_not_pinned`, `project_definition_changed`,
  `project_task_already_recorded` and `outcome_too_large_for_inline`, plus the research kind's own
  `research_nothing_to_ask`.
- The input gate does not judge a research task's description: its brief is the definition.
- The board's create-project form hides a kind that requires a definition until it can collect one.

Public API 1.96.0: the task-type vocabulary gains `research`. SDKs regenerated.
