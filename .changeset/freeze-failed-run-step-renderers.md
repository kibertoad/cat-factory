---
'@cat-factory/app': patch
---

Stop a failed run's pipeline step from looking like it's still executing.

When a run fails, the step that was in flight stays `state: 'working'` (and may
still carry `startingContainer`) with no `finishedAt`, because the failure path
records the fault without normalising the live step. The run-step renderers keyed
their live affordances purely off that step state, so a failed task kept spinning
the last agent, showed "Spinning up container…", and counted its elapsed time up
forever next to the error card.

`PipelineProgress`, `TaskPipelineMini`, `TaskExecution` and `AgentStepDetail` now
gate those live affordances on the instance not being `failed`: no working spinner,
no "spinning up" phase, and the step-detail duration freezes at the failure time
instead of ticking. The failure banner + retry is the only live surface left.
