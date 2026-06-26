---
'@cat-factory/app': patch
---

Remove the redundant Vue Flow `<Controls>` zoom widget from the bottom-left of the
board. The floating top toolbar already provides zoom in/out and fit-view (plus the
zoom percentage and semantic LOD label), so the bottom controls were a strict subset.
Drops the now-unused `@vue-flow/controls` dependency and its CSS import.
