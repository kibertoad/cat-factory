---
'@cat-factory/app': minor
---

Board: spatial drill-down into a task's build steps and live subtasks.

The semantic-zoom ladder gains two deeper bands beyond `close`. Keep zooming into
an in-flight task and its full build-pipeline steps appear on the card (`steps`
band); zoom one notch further and each step expands its live todo breakdown —
done / in-progress / pending — the same way a zoomed-in bootstrap card reads
(`subtasks` band). Max canvas zoom is raised to 3 to give the new bands room, and
the toolbar's level indicator labels them ("Build steps" / "Subtasks"). The data
already streamed per step; this surfaces it spatially instead of only in the
inspector. The `far`/`mid`/`close` thresholds are unchanged.
