---
'@cat-factory/app': patch
---

Hovering a task card on the board now expands its build pipeline underneath the card at any zoom
level, instead of only past the deep `steps` zoom band.

A pointer resting on a task is asking what that task is doing right now, and the answer — the
step list with its live subtask counts — was previously reachable only by first zooming the board
in past 1.8x, so the question could not be answered from the scale people actually plan at. The
board driver already resolved the card under the pointer to win overlap ties at deep zoom, so this
promotes that hit to a grant in its own right: the hover grant applies at every band, and the
zoom grant (every on-screen card, minus the ones that would collide with a card nearer the screen
centre) is unchanged.

The two grants are now combined in the `taskExpansion` store rather than at each call site, so the
component that renders the pipeline and the wrapper that stacks the card above its neighbours read
one predicate and cannot disagree about which cards are expanded. The hover grant is also filtered
to tasks that have a run with steps, so a frame, a module, or an idle task is never marked expanded
and never lifts an empty card over its neighbours.
