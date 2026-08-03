# In-app tutorials

**Goal.** A new user should be able to learn the delivery loop from inside the product, on their own
board, without reading a doc — and should be able to come back to any part of it later, on purpose.

**Why.** The product's shape is not guessable from its board: the pipeline a task will run, the
inspector that holds every run control, the fact that a parked run waits for a human indefinitely and
that a task is only done when its PR actually merged. A user who never finds those has a board full
of finished-looking work that shipped nothing. Documentation does not reach them, because the thing
they need pointed at is on the screen they are already looking at.

## Target pattern

A tour is **data, not components**: an ordered list of steps, each naming an on-screen control by its
`data-testid` and carrying i18n keys. One shared runtime (`components/tutorial/TutorialOverlay.vue`)
renders every tour; the catalog is the `tutorialTours` slot, so a consumer deployment contributes its
own tours through `registerAppModule` exactly as it contributes nav items. Authoring rules,
anchoring, accessibility and the resume/abridged semantics are documented in
[`frontend/app/README.md`](../../frontend/app/README.md#in-app-tutorial-tours) — that section is the
authority; this tracker records the arc and what each slice learned.

## Slices

- [x] **1 — The runtime and the first tours.** The store (persisted decision + per-tour completion),
      the coach-mark overlay, the launch prompt, and tours covering the delivery loop end to end:
      board basics, add a repository, create a task, run it, answer a park, review and merge
      ([#1570](https://github.com/kibertoad/cat-factory/pull/1570)).
      _Learned:_ a tour must be a set of OPPORTUNITIES — a missing anchor skips the step rather than
      stranding the walkthrough — and a running tour's script has to be resolved once and HELD,
      because gates over live run state flip as a direct result of following the tour.
- [x] **2 — Anchoring that survives a real board.** Reveal an on-page-but-off-screen anchor (camera
      move on the canvas, scroll elsewhere), event-driven tracking, focus rules, and the drift guard
      that pins every built-in anchor against the ids the layer really renders
      ([#1598](https://github.com/kibertoad/cat-factory/pull/1598)).
      _Learned:_ the anchors are the one thing about a tour nothing else in the build checks, and a
      renamed id would leave every user on a permanent "you missed N steps" notice.
- [x] **3 — The catalogue.** Every tour the deployment ships, startable / resumable / repeatable at
      any time from the sidebar's Help section, the palette, or the prompt's footer; declared
      requirements so a held-back tour states what would unlock it; progress across the whole
      catalog and a reset that restores the first-launch experience.
      _Learned:_ availability could no longer live in `navSlotFilter` — a `SlotFilter` maps slots to
      slots, so it can only DROP, and the whole point of the catalogue is to explain what was
      dropped. Resolution moved to the pure `resolveTourCatalogue`, read once in
      `useTutorialTours`, which reads the same registered `gates` service the nav filter does.
- [ ] **4 — Reaching the user who needs it.** The catalogue is now discoverable; whether it is
      DISCOVERED is unmeasured. Three candidates, in rough order of expected value: a CONTEXTUAL
      offer, surfacing the one relevant tour beside the surface it explains (the first time a run
      parks, the first time a PR is ready to merge) rather than only at launch; completion that
      follows the USER rather than the browser, which the persisted store does not (a second
      machine re-offers everything); and tours for the surfaces later initiatives added
      (foundational services, consensus panels, compose environments), which the catalogue can now
      hold without crowding the launch prompt.

## Gotchas the slices surfaced

- **A step's `when` and a tour's `requires` are different facts.** A step's `when` says "this board
  is not on that branch" and DROPS the step silently; a tour's `requires` says "this cannot run yet"
  and is REPORTED. Rendering either as the other is how a user who saw exactly the right walkthrough
  gets told they missed half of it.
- **An unavailable tour must never be simply absent.** The catalogue's contract is that its list is
  the deployment's whole catalog — a filtered list is indistinguishable from a smaller product.
- **The launch prompt is the offer, not the library.** Growing it into a browsing surface was the
  alternative to slice 3 and was rejected: it is a modal the user is trying to answer and dismiss,
  and a returning user has already answered it once.
- **Copy for a state or an action is looked up from data**, so it needs an exhaustive `Record` plus a
  spec pinning every value against `en.json`; the typed-message-key check cannot see an assembled key.
