---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Serve the board a LEAN projection of its runs, and bound the SPA state that grew per session.

Five items off the frontend half of the performance initiative, grouped because they land on the
same three seams.

**The board snapshot no longer carries every run's captured prose.** Its heaviest half is text
nobody on the board is looking at: the agent's output per step, the prose a restart superseded, the
proposal a reviewer bounced, the tester-quality verdicts. All of it was fetched, valibot-parsed and
hydrated on every full refresh, for text that is only ever read one run at a time in a step-detail
overlay. `projectExecutionForBoard` withholds it and the overlays fetch the run they are about
through a new by-id read.

WITHHELD is not ABSENT, which is what the rest of the design is about. The instance says it is a
projection; `step.output` leaves a `hasOutput` behind so the board's "there is prose here"
affordance still answers (ask through `stepHasOutput`, never either field alone); the store carries
the withheld fields forward when a projection lands on a run it already holds whole, but ONLY at an
equal revision, because one revision later the cached prose may not be what was withheld and
pasting it back is the same clobber in reverse. `step.custom` and the park-routing states stay in
the projection deliberately: both are read on the board itself.

**Three stores stopped growing for the session's lifetime.** The per-run LLM call log is capped and
records what it dropped (a capped list is not a prefix, and a reader who cannot see the number
concludes the run made exactly the calls they are scrolling); Kaizen folds gradings into the screen
history only once the screen has asked for it; both stores now reset on a board switch, which
nothing had ever evicted them on; and the notifications live-write map is bounded on write, for the
long stream period that carries only targeted events and so triggers no hydrate to bound it.

**`execution.instances` is shallow-reactive.** Every step-level read on the board paid proxy
overhead on a structure only this store writes. The conversion is three write sites because
`echoAfter` is the one seam an action store's in-place step patch goes through.

**Store and composable hygiene**, including one real bug: a drag interrupted by `pointercancel`, or
by its component unmounting, stranded two window listeners and a stuck `draggingId`. Also a shared,
demand-gated wall clock (N mounted step timers were N 1s intervals), `useViewport` as the singleton
its docstring claimed, a key index in `useUpsertList`, single-flight on the panel loads that two
openers routinely fire twice, and memoised board nodes so a hover restacks two of them instead of
all of them.

What to watch when reviewing: the equal-`rev` gate on the carry-forward, and the `triggerRef` pair,
are the two places where being wrong is SILENT rather than loud. Both are pinned by store specs
that fail if either is removed. Viewport culling is refused rather than deferred, with the reason
recorded in the tracker: it needs a frame's extent to be known without rendering it, and `fitView`
only fits nodes it has measured.
