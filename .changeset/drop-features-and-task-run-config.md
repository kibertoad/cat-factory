---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': patch
---

Simplify task granularity and run configuration; open the pipeline-step detail
overlay from the zoomed-in board.

- **Open the agent step-detail overlay from the board.** Clicking a pipeline agent
  in a zoomed-in task card now opens the full `AgentStepDetail` overlay (execution
  metadata + the agent's prose output), exactly like clicking it from the inspector
  or the focus-view pipeline — instead of expanding raw text inside the card.
- **Removed the per-task auto-merge "confidence threshold".** The confidence-score
  auto-merge gate (`Block.confidenceThreshold`, the inspector + task-card UI, the
  `DEFAULT_CONFIDENCE_THRESHOLD` constant) is gone; the `merger` step's merge-policy
  preset (complexity/risk/impact ceilings) is the sole auto-merge gate. (The raw
  `confidence` score is still recorded for transparency.)
- **Removed "feature" tracking from the board and the service map.** `Block.features`
  (the inspector's "Features implemented" tags and the board/module feature badges)
  is removed, and the in-repo blueprint / board-scan decomposition is now
  service → modules only — the Blueprinter, harness rendering, and reconciliation no
  longer produce a "feature" sub-level or derive tasks from it. Acceptance scenarios
  are now freeform per task (decoupled from features) pending a deeper
  requirements-driven model.
- **Task creation picks a pipeline + merge policy; model selection removed.** The
  "Add a task" modal now offers a default pipeline (`Block.pipelineId`, which the
  task's Run/Start controls use) and a merge policy preset. The per-task model
  picker is gone — a model is resolved per step, not per task.

Migration `0025_task_run_config.sql` drops the `confidence_threshold` and `features`
columns and adds `pipeline_id`. Bumps `@cat-factory/executor-harness` (the blueprint
rendering inside its image changed).
