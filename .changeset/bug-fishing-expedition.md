---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Bug fishing expeditions: hunt a codebase for the defects nobody has reported yet

Every defect flow the platform had started from a REPORT: `bug-investigator` triages one,
`pl_bugfix` fixes one, `bug-hunt` picks one off a tracker board. Nothing looked for the defects
nobody has hit, and those are the ones that surface as an incident rather than as a ticket.

A new `bug-fishing` task type runs the new read-only `bug-fisher` agent over a service's codebase
once per ANGLE — logic and control flow, failure handling, boundary conditions, concurrency and
idempotency, state and resource lifecycle, interface contracts, footguns, and conformance with the
supplied product requirements. One pass told to find everything returns the shallow half of
everything; a pass told to think only about concurrency reads the same files with a question that
makes the race visible, and each angle is its own dispatch with a fresh context, so one angle's
reading never lands on another's transcript. Nothing is written and no pull request is opened.

Triage does not wait for the hunt. A finished angle's findings are final the moment they land, so
the expedition window offers them while later angles are still fishing, and each finding a human
MARKS spawns its own bug-fix task — carrying the finding's evidence and reproduction — on the
pipeline the board configures for spawned fixes (`bugFishingFixPipelineId`, defaulting to the
built-in bug-fix preset, overridable per batch). The spawned task links back through the new
`Block.expeditionId`.

Three refusals are deliberately loud rather than convenient. A pass that crashes settles THAT
angle as failed carrying its reason, because a phase that silently reported nothing is
indistinguishable from one that honestly found nothing. A mark whose fix task cannot be created —
a pipeline that no longer exists, or one that cannot be started on a one-off task — fails with the
pipeline named instead of answering 200 and leaving somebody waiting for a task that will never
appear. And an expedition that caught nothing still parks and says so.

The pre-dispatch input gate learned about the type: a bug-fishing task legitimately carries no
description, because its input is the codebase, so `description_missing` no longer parks one at
step 0.

Public API: `taskType` gains `bug-fishing` and `NotificationType` gains `bug_fishing_triage`,
with two new optional notification-payload fields (`phaseCount`, `untriagedFindingCount`). Both are
additive enum members the SDKs already tolerate; the spec is `1.67.0`.

Internal break: `workspace_settings` and `blocks` each gain a column, and `ExecutionServiceDependencies`
gains an optional `serviceRepository`. Both facades ship the migration.
