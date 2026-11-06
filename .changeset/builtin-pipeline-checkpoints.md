---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/app': minor
'@cat-factory/conformance': minor
---

Built-in pipelines accept approval checkpoints, and a producer with a companion can pause before the companion runs, after it, or both.

- `PUT /workspaces/:ws/pipelines/:id/approvals` replaces a pipeline's `gates` and the approval half of each step's gate configuration. The request names the chain it was composed against (`agentKinds`) and is refused when the stored chain differs. It is accepted on built-ins, which still refuse every other structural edit. A workspace may add checkpoints to a built-in but not remove one its catalog definition ships and the row carries. The write is held to the checkpoint rules only, so a row breaking an unrelated structural rule still takes a checkpoint. The two refusals carry `details.reason` (`approvals_chain_stale`, `approvals_builtin_checkpoint_locked`, from contracts' `PIPELINE_APPROVALS_REFUSAL_REASONS`), which the SPA words in every locale.
- A reseed keeps the checkpoints a workspace added, matched to the same step by kind and occurrence rather than by position. A checkpoint the new definition refuses, or whose step left the chain, is dropped and logged, and the pipeline health dialog names it. An approver policy the new definition refuses is dropped on its own, keeping the checkpoint on the default approvers.
- The workspace snapshot gains `pipelineCatalogApprovals`, the checkpoints each catalog pipeline ships.
- A human approval gate on a companion whose producer can be skipped (estimate-gated, or carrying a run condition) is now refused at save and at run start, as a gate on the skippable step itself already was. A stored custom pipeline with that shape, which only the API could produce, will be refused at its next start until the gate is moved.
- The pipeline builder's checkpoint control on a producer with a companion offers four placements instead of a toggle that only ever gated the producer, and switching the companion off moves its checkpoint onto the producer. A built-in's library row opens an approval checkpoints dialog. Neither control offers a checkpoint the estimate or a run condition could skip past.
