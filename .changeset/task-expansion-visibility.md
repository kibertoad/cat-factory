---
'@cat-factory/app': patch
---

Only expand a task card's full build-pipeline list on deep zoom when the card is
actually on screen, and when two expanded cards would overlap, expand only the one
closest to the screen centre.

Deep-zoom (`steps`/`subtasks`) grows each task card downward, and cards are
absolutely positioned in their frame, so several expanded cards stacked vertically
used to pile heavily on top of each other. A board-level driver (`useTaskExpansion`)
now recomputes a permitted set every frame from live DOM rects (so it tracks pan /
zoom / drag / resize): off-screen cards stay compact, and among visible cards that
would overlap, only the centre-most expands (greedy, nearest-to-centre first).
`TaskPipelineMini` reads the permitted set; with no board driver mounted it falls
back to the plain zoom behaviour.
