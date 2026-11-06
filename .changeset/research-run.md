---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

A research project's task now runs. A `research` task under a research project starts the
`pl_research` pipeline, whose one `project-researcher` step answers the project's pinned research
definition against the vendor it describes and records one findings revision on the project.

- The platform ships a built-in `research` project kind (`defaultProjectKindRegistry()`), the
  `research` task type (refused under a service with `task_type_requires_project`), the
  `project-research` pipeline purpose (offered only to a `research` task) and the `pl_research`
  pipeline.
- The `project-researcher` kind runs on the `ui` image as a new `container-research` surface: the
  harness's `research` job kind, with no checkout of its own. The linked services' repos ride as
  read-only reference repos, and the definition's credentials are resolved from the credential
  store into the job body; one needed at start that is not stored parks the step before any
  container starts.
- A task claims its findings sequence number when it first starts and fixes its questions by mode
  (`initial`, `extend`, `clarify`, `refresh`, plus ad-hoc questions). A credential the agent asks
  for mid-run parks the step with its partial findings kept on it, and the resumed run starts from
  them. The revision is written once per task, inline.
- The input gate does not judge a research task's description: its brief is the definition.
- The board's create-project form hides a kind that keeps research data until it can collect the
  definition to pin.

Public API 1.96.0: the task-type vocabulary gains `research`. SDKs regenerated.
