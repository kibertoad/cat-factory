---
'@cat-factory/app': patch
---

Make the whole service-card header a drag handle. The stats line below the title row
(`N/M implemented · modules · PR ready`) sat outside the drag handle, so a pointer-drag
starting there fell through to the Vue Flow pane and panned the board instead of moving
the service. The title row and the stats line are now wrapped in one `nopan` grab handle.
