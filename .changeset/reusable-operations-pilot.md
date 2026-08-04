---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/conformance': minor
'@cat-factory/example-custom-agent': minor
---

Reusable operations, slice 1: a registered custom task type can now carry its whole bundle, and the
per-case values a user fills reach the agents that act on them.

A custom task type's collected `taskTypeFields.custom` bag previously reached ZERO prompts: it rode
the run context and nothing rendered it, so an operation's brief ("expose CRUD for Order", "auth:
service-to-service") was invisible to every step in the pipeline. The engine now resolves a labelled
projection once per dispatch (`AgentRunContext.customTaskType`, joined from the registered
descriptor by kernel's `describeCustomTaskType`) and the agents package renders it as a
`## Task parameters` section at all three prompt-assembly points, including the prepend a registered
kind that authors its own user prompt gets.

The descriptor gains two optional fields: `defaultFragmentIds`, the operation's standing context,
unioned onto every new task's own fragment selection at creation, and `presentation.category`, the
picker grouping axis a later slice renders. Boot validation warns (never refuses) on a
`defaultFragmentIds` entry the code pool cannot resolve, because an account/workspace-tier fragment
merges per workspace at run time and is invisible at boot.

Every existing prompt is byte-identical: the projection is absent whenever a block collected no
custom values, which is every run of a built-in task type. It is also absent for an un-namespaced
type, so a built-in carrying a stray `custom` bag renders no section: a custom type is namespaced by
construction, so the raw-id fallback that honestly names a withdrawn operation would otherwise invent
one. Seeding the standing context STATES a namespaced type this process does not register, since only
the id set freezes at creation and that task never gains the operation's fragments later.
