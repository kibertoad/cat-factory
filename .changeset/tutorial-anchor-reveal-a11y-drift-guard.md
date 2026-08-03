---
'@cat-factory/app': minor
---

Make a tutorial tour point at controls the user can actually see, reach by keyboard, and come
back to — and drift-guard the anchors it points at.

The tour runtime accepted any anchor with layout boxes, which an element scrolled out of a panel
or panned off the board still has: the highlight ring was drawn at off-screen coordinates while
the tooltip clamped to a viewport edge, so the user read "click this" beside nothing. Both
`task-card` steps hit it routinely, since they anchor whichever card is first in the DOM.
`needsReveal` now decides against `min(anchorArea, viewportArea)` — so a control bigger than the
viewport is judged on how much of the screen it fills — and the reveal picks its mechanism from
the container the DOM reports, moving the Vue Flow camera for a canvas node (clamped to the
current zoom) and scrolling everything else.

Tracking is event-driven once an anchor is held; only the hunt for a not-yet-mounted one polls
fast, bounded by the step's own wait budget. The backstop tick still re-resolves the selector, so
a step re-anchors when its control is replaced underneath it. Re-measures are coalesced to one
per frame, since capture-phase scroll fires for every container on the page and each measure
reads layout before writing it.

Accessibility: focus moves onto the card when a tour starts and on every Next/Back (it is
teleported to the end of `body`, so a keyboard user previously had to tab the whole page), but
never on a click-to-advance step, where the app is opening a modal that owns focus — that choice
is a tested predicate rather than an inline condition, because a call site that forgets it fails
silently. Step changes are announced through a dedicated `role="status"` region, because a dialog
whose contents are replaced wholesale is not reliably announced; the region outlives the steps
and its text lands a tick after the node, so the first step is announced rather than arriving
pre-populated and unread. Ring and spinner motion sit behind `motion-safe:`, and a reveal is
instant under `prefers-reduced-motion`. Deliberately still not a focus trap: half the catalog
asks the user to operate the real control behind the card.

Esc and Skip now leave a session-scoped resume point, so breaking off a tour no longer costs the
whole walkthrough; the prompt offers Resume in place of Start.

Finally, a spec pins every built-in step's anchor against the ids this layer actually renders.
Nothing else in the build checked them — a renamed `data-testid` passed typecheck, lint and the
full e2e suite — and because those steps carry no `when`, the miss counted as an unexpected skip
and put a permanent, false "you missed N steps" notice on the tour for every user who took it.
