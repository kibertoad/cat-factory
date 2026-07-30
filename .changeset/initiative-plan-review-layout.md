---
'@cat-factory/app': patch
---

Give the initiative plan-approval gate the step reader's layout instead of a card inside the tracker.

The plan review had the right tools — an outline, per-block commenting, the same composables the
step reader gives the architect's prose — in a shape that wasted them. It rendered as a card inside
the tracker's own scrolling column, so the outline and the document split that column's width
between them, the document was capped at a 20rem letterbox, and the tracker's goal / phases /
policy / logs sections repeated the whole plan underneath it (the gate's document is a rendering of
the ingested entity, which is exactly what those sections project).

So while a rendered plan is parked, the review now OWNS the window: the outline is a sidebar beside
the document rather than inside it, the plan gets the window's full height, and the commands sit in
an end-side rail with the anchored comments — the step reader's proportions. Replacing the tracker
body is safe because the document already contains it, and everything the tracker adds on top (PR
links, item curation, checkpoints, follow-ups) is execution-time state that cannot exist before the
plan is committed; the run details move into the sidebar rather than disappearing for the duration.

A gate carrying no rendering at all keeps a compact notice above the tracker's sections, because
there they are the only view of the plan there is. One helper (`planReviewDocument`) decides which
shape applies, read by both the window and the surface, so they cannot disagree about what is on
screen.
