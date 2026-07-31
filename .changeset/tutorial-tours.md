---
'@cat-factory/app': minor
---

In-app tutorial tours. On first launch the app asks whether the user wants a guided tour
and persists the answer ("no thanks" stops the prompt for good; closing without answering
asks again next launch; the command palette's "Take a tour" entry is the way back either
way). Tours are declarative data over a new `tutorialTours` modular slot — each step anchors
to an existing `data-testid`, carries i18n keys, and either advances on Next or waits for
the user to really click the highlighted control — rendered by one shared coach-mark
overlay that skips steps whose control the caller's role, tier, or deployment doesn't show.
A tour that reaches its end having skipped steps says so instead of claiming to have shown
the walkthrough, and a tour that could only ever be abridged is not offered — which is what
each tour's `when(gates)` predicate decides, over the same reactive gates service as the nav
catalog (gaining a `boardHasService` availability gate for this).

Ships two happy-path tours (board basics, create your first task); a consumer deployment
contributes its own tours through `registerAppModule`.
