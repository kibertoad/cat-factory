---
'@cat-factory/app': patch
---

Board: make hover-to-front for services authoritative over selection. Vue Flow
elevates a selected node's z-index by +1000 by default, so a frame stayed pinned on
top after a click and hovering another overlapping frame could never surface it. Turn
off `elevate-nodes-on-select` so frame stacking is driven purely by hover/drag; the
selection highlight remains the ring, not z-index.
