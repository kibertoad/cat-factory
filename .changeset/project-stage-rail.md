---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
---

The project takeover gains a Stages tab, opened first for a staged project: each stage of the pinned definition with its status, what it waits on, the task working on it, whether it is stale, and the report on its newest result against its acceptance criteria. A person starts a ready stage there (its task is created and its run started) and accepts a result at its checkpoint, settling a stage whose task type requires a settlement (a decisions register) item by item, with the evidence and any required question the proposal left out shown. The board's `ProjectStageView` gains `revision` (`none`, `optional` or `required`), what the stage's task type takes at its checkpoint.
