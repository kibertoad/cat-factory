---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Agent step-detail overlay, with execution timing.

Clicking any agent — in the inspector's pipeline list (`TaskExecution`) or the
zoomed-in pipeline (`PipelineProgress`) — now opens a full-screen detail overlay
for that step instead of expanding a cramped inline teaser. The overlay resolves
the step live from the execution store and always shows its metadata: state,
**execution duration** (counting up live while the step runs), started/finished
timestamps, model, step position, the live subtask breakdown, applied standards,
and any decision/approval. When the agent produced prose (architect, researcher,
reviewer, …) the overlay also renders it as markdown (via `markdown-it`,
`html: false` so raw HTML is escaped), split into **collapsible sections** at each
heading with an **auto-generated table-of-contents sidebar**; clicking an entry
expands and scrolls to its section, and the in-view section stays highlighted as
you scroll.

To support this, pipeline steps now track timing: `PipelineStep` gains
`startedAt` / `finishedAt` (epoch ms), stamped by `ExecutionService` when a step
transitions to `working` / `done`. Both are set-once so a Workflows replay or an
approval-gate re-assertion preserves the agent's true execution window; an explicit
"request changes" re-run clears them so the fresh attempt is timed from scratch.
Steps persist as JSON, so no migration is required.
