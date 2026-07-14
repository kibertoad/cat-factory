---
'@cat-factory/orchestration': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
---

Reuse the already-loaded list instead of looping point-reads on four engine/board paths
(performance-optimizations initiative — items 15, 16, 17, 18). No behaviour change; each
collapses a per-item repository read into one batched read or a reused list.

- **`autoStartDependents` (item 15)** now resolves every dependent's pipeline from a single
  `pipelineRepository.listByWorkspace` indexed into a `Map`, instead of a `get` per dependent
  in the loop (the board "Run" default already came from the first pipeline).
- **`InitiativeLoopService.spawn` (item 16)** loads the pipeline catalog once per tick and
  checks each spawned item's pipeline against that `Set`, instead of a `pipelineRepository.get`
  per eligible item.
- **`BoardScanService.reconcileBlueprint` / `spawnBlueprint` (item 17)** insert missing modules
  through a new batched `BoardService.addModules` seam (resolve + list the board once for the
  whole batch), instead of `addModule` re-listing the entire board per module. `addModule` now
  delegates to it.
- **Block delete (item 18)** — `teardownForBlockTree` returns the workspace block list it loaded
  (it deletes only run records, never blocks) and `removeBlock` accepts it via a new `preloaded`
  option, reusing it when it was loaded for the block's home workspace (the common locally-owned
  delete) and re-listing only for a mounted shared service homed elsewhere. Removes the second
  full board read the DELETE path used to pay. New shared `PreloadedBlocks` kernel type.
