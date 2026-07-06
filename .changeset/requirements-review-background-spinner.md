---
'@cat-factory/app': patch
---

Show a spinning loader (not a static question mark) on a requirements-review /
clarity-review step while it folds answers and re-reviews in the background. The gate
parks the step in `waiting_decision`, but during the async incorporate + re-review cycle
it is actively doing LLM work and needs no human, so the pipeline rail node
(`PipelineProgress`) and the board card drill-down (`TaskPipelineMini`) now render it as
working — matching the working indicators already shown on the task card and inspector.
