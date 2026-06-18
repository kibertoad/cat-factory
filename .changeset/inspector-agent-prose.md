---
'@cat-factory/app': patch
---

Inspector: read an agent's prose output without leaving the panel.

The inspector's task-execution view listed every pipeline role (architect,
researcher, reviewer, …) but only ever showed their state and subtask counts —
the prose those agents produce was reachable solely from the full-screen focus
view. Each step that produced output now carries a chevron + two-line teaser that
expands to the full text inline, mirroring the focus view's `PipelineProgress`.
