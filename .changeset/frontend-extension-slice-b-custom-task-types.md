---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

feat(frontend-extension-mechanism slice B): custom task types — a deployment-registered work
item (an "incident", "pentest", "compliance-audit") is now a first-class create-task choice +
card badge, symmetric with custom agent kinds, with zero host edits.

- **Contracts.** `taskTypeSchema` / `createTaskTypeSchema` widen from a closed picklist to
  `picklist ∪ namespaced` (`<ns>:<name>`) — the shape `presentation.resultView` already uses. The
  result-view-only `NAMESPACED_RESULT_VIEW_ID_PATTERN` is generalized into a shared `primitives.ts`
  atom (`NAMESPACED_ID_PATTERN` / `isNamespacedId` / `namespacedIdSchema`) reused across every
  extension surface. New `customTaskTypeSchema` (+ `taskTypeFieldDescriptorSchema`), a sparse
  `taskTypeFields.custom` bag for descriptor values, and `workspaceSnapshot.customTaskTypes`.
- **Kernel.** App-owned `TaskTypeRegistry` (`defaultTaskTypeRegistry()`, empty), mirroring
  `AgentKindRegistry`/`PipelineRegistry`; `defaultPipelineIdForTaskType` consults it after the
  built-in map.
- **Orchestration.** `CoreDependencies.taskTypeRegistry` threaded into `BoardService` + re-exposed
  on `Core`; `validateRegistrations` gains task-type checks (namespaced id, `formPanel`,
  `defaultPipelineId` resolves).
- **Server + all three facades.** Snapshot projects `customTaskTypes` (shared `WorkspaceController`);
  the Worker / Node / local facades build, install, validate, and re-export the registry (a
  `taskTypeRegistry` option on `createApp`/`start`/`startLocal`).
- **Frontend (`@cat-factory/app`).** A `taskTypes` slot + a `useTaskTypesStore` (cloning the
  agents-store merge → `taskTypeMeta` read-model); `buildAgentCapabilitiesManifest` generalized to
  one `buildWorkspaceCapabilitiesManifest(kinds, taskTypes)` carrying both slots (agents store's
  `hydrateCustomKinds` → `hydrateCapabilities`). `AddTaskModal` merges custom types into its picker
  and renders their descriptor fields (or a `taskTypeFormPanels`-paired section) into
  `taskTypeFields.custom`; `TaskCard` shows a type badge via `taskTypeMeta` (unregistered
  namespaced types degrade to the `feature` presentation).

Cross-runtime conformance asserts the backend round-trip on both runtimes; the `deploy/frontend`
`acme:security` module dogfoods a CODE-shipped `acme:incident` task type end to end (e2e).
