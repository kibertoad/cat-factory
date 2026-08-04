# ADR 0036: In-app tutorial tours; a course the product brings to the user

- **Status:** Accepted (implemented)
- **Date:** 2026-08-04
- **Context layer:** the SPA (`@cat-factory/app`) + backend (`@cat-factory/contracts`,
  `@cat-factory/kernel`, `@cat-factory/orchestration`, `@cat-factory/server`, both runtime facades)

Supersedes the `in-app-tutorials` initiative tracker, whose committed scope is complete. How the
runtime WORKS (authoring rules, anchoring, accessibility, the offer/library split) is documented in
[`frontend/app/README.md`](../../../frontend/app/README.md#in-app-tutorial-tours), which remains the
authority; this records the decisions and why they were made.

## Context

The product's shape is not guessable from its board. The pipeline a task will run, the inspector
that holds every run control, the fact that a parked run waits for a human indefinitely, the fact
that a task is only done when its PR actually merged: a user who never finds those has a board full
of finished-looking work that shipped nothing. Documentation does not reach them, because the thing
they need pointed at is on the screen they are already looking at.

Guided tours answer that, but only if they are ACTUALLY TAKEN, and the first four slices
progressively discovered that reachability is not the same as reach:

- a tour had to survive a real board (an anchor on the page but off screen, a control replaced
  underneath a stationary cursor, a gate flipping as a direct result of following the tour);
- a tour the deployment could not run had to be LISTED with what would unlock it, not hidden, or a
  six-walkthrough product reads as a two-walkthrough one;
- the launch prompt had to stay one answerable question even as the catalog grew past the delivery
  loop into the platform behind it.

What remained was the gap that made all of it optional: **nothing brought a walkthrough up.**
`startTour` writes `decision: 'accepted'`, which is exactly what stops the launch prompt
auto-opening again, so after a user's first tour the product never mentioned the tutorial unless
they went and found the catalogue. The two tours carrying the costs the initiative was written for
(`answer-park`, `review-merge`) are also the two only available inside a transient window, so
"go and look" and "be available" rarely coincided. And whether any of it was reached was
unmeasured, so every further decision about the feature was a guess.

## Decision

**A tour is DATA, not components**: an ordered list of steps, each naming an on-screen control by
its `data-testid` and carrying i18n keys, contributed to the `tutorialTours` slot through
`registerAppModule`. One shared runtime (`TutorialOverlay.vue`) renders every tour, and everything
that DECIDES lives in pure modules (`utils/tutorial.ts`, `TutorialOverlay.logic.ts`) so it is
unit-tested rather than eyeballed against a real board.

**A tour is a set of OPPORTUNITIES.** A missing anchor SKIPS its step, because controls come and go
with RBAC, interface tier and deployment wiring; reaching the end having skipped is reported rather
than congratulated. A step whose BRANCH may not apply carries its own `when` and is DROPPED instead,
because a skip means "this control should be here and isn't" while a branch means "this board is not
on that path", and rendering the second as the first tells a user who saw exactly the right
walkthrough that they missed half of it.

**A tour's preconditions are DECLARED** (`TutorialRequirement`: an id, a copy key, the gate
predicate) rather than an anonymous predicate, because the catalogue has to say why a tour it is
showing cannot be started. That also forces `blocked` (something to go and do) apart from
`not-applicable` (nothing to fix), which need opposite reactions.

**The requirement must be the same fact that renders the control the tour clicks, and that is
CHECKED, not restated.** `navRequirementDrift` derives the pairing from the nav entry's own `gate`
over a permutation matrix of the gate booleans, because the two edits that break it (tightening a
gate, marking an entry `advanced` and so hiding it from the shipped-default tier) both happen in the
nav catalog and touch no tour.

**Three surfaces OFFER a tour; one is the library.** The launch prompt asks once. The finish card
HANDS OFF to the one walkthrough the user's own last action unlocked (`nextTourAfter`), which is the
last moment the product can still say "and now this one". The contextual nudge catches a tour's
`requires` flipping `blocked → ready` (`newlyAvailableTour`), on a TRANSITION seeded from the first
resolution. All three thin against `offeredAtLaunch`; the catalogue never does.

**Progress follows the PERSON.** A per-user `tutorial_progress` row on both facades, mirrored
best-effort from the browser-persisted store, with both id lists treated as grow-only sets and
UNIONED on both sides. `remote` in mothership mode under a `selfUser` scope rule; "Reset progress"
is a DELETE.

**The funnel is COUNTED** on the kernel `OperationalMetrics` port
(`tutorial.tour_started` / `_completed` / `_abandoned`, dimensioned by tour), with the tour
dimension bounded twice: the wire schema constrains an id's shape, and the service caps how many
distinct ids one process reports.

## Rationale

**Why the finish card rather than more tours.** The catalog was already the largest part of the
feature and the least binding constraint on it: the delivery loop is a CHAIN, each tour producing
the state the next one requires, and the chain simply stopped at every finish card. Handing off cost
one pure function and two i18n keys and turned six walkthroughs into a course. It also needs no new
persisted state and cannot nag, which is what made it the right thing to do before the more
expensive halves.

**Why a transition, and why `requires` is the trigger.** Every tour already declares the exact
predicate meaning "you can take this now", so a single rule over the resolved catalogue covers the
whole catalog and inherits the nav drift guard. Per-surface triggers ("when a run parks, mention
`answer-park`") would have been a second copy of each requirement to keep in step. Firing on the
standing state instead of the transition would greet every board load with an offer about a
walkthrough available for weeks; the transition rule also means the permission-gated platform tours,
ready from the first render, never reach it at all.

**Why the transition needs two guards, not one.** A transition rule is only as good as what it is
measured against, and this one was measured against nothing: every gate reads a store something
fills asynchronously, so a baseline taken when the offer's watcher mounts records "nothing is
takeable" and the app's own startup reads as a transition. That is the every-board-load greeting the
rule exists to prevent, arriving through the mechanism meant to be its cure, and the review that
caught it also caught that the assembled test asserting otherwise could not fail (the fixture it
used declines the tutorial, which switches the whole mechanism off).

The first guard is board READINESS: no baseline is taken until the workspace snapshot has been fanned
out, and a board switch discards the baseline rather than reporting everything the incoming board
satisfies as newly available. That alone was still wrong, which is the more interesting half:
`workspace.ready` flips before the RBAC access and the integration probes have landed, so those
resolutions widened availability and the offer fired on a plain board load anyway. The second guard
is therefore a board-state FINGERPRINT, and an offer requires it to have MOVED. Readiness widening
is not the world changing: a capability probe answering makes a tour takeable that was "blocked"
only because the app had not found out yet, and the app finding out about itself is not a moment to
interrupt anyone about. The alternative was to enumerate which stores load late and wait for them,
which is a list that rots the moment a gate gains a new source; the fingerprint needs no list,
because nothing outside the `boardHas*` gates describes the world.

**Why the failure path is part of the delivery loop.** `boardHasFinishedRun` deliberately excludes
failures, because a result view and a merge control are not what a failed run renders. That left the
state a first run reaches most often as the only one on the whole arc with no walkthrough, and it is
the state at which people conclude the product does not work.

**Why grow-only sets.** Two browsers signed in as one person each hold a full local copy and each
write it back. A last-writer-wins replace on either side silently drops what the other learned since
they diverged, and the symptom is a finished walkthrough going back to "not started" on one machine,
days later. A union has no ordering requirement, needs no revision guard, and makes the write
idempotent under the retries a fire-and-forget mirror inevitably does. Only `decision` is replaced,
being a preference someone re-answers rather than an accumulating fact. That is also why the reset
is a DELETE: a merge would ignore empty arrays, and "never touched the tutorial" and "reset it" must
be the same state.

**Why product counters on the operational port.** There is no second counter seam, and adding one to
keep the operational surface tidy would be a second place to get delta temporality wrong. The
signal is worth the impurity: started-vs-completed separates "nobody opens it" from "everybody drops
it halfway", which need opposite fixes, and neither was distinguishable before.

**Why the dimension needs two bounds.** A shape constraint stops junk but not volume: a buggy client
can emit unlimited well-formed ids, and every distinct one is its own time series in the operator's
backend. The cap folds the rest onto a visible `other` bucket and logs once, because a cap nobody
can see reads exactly like complete coverage.

**Alternatives rejected.** Growing the launch prompt into a browsing surface (it is a modal someone
is trying to answer, and a returning user has already answered it). Capping the prompt's list
instead of declaring `offeredAtLaunch` (a cap picks what to bury by sort order rather than by what
it is for). Gating tour availability in `navSlotFilter` (a `SlotFilter` maps slots to slots, so it
can only DROP, and explaining what was dropped is the catalogue's whole contract). Anchoring the
failure tour on the environment deep-link and the error history (each renders in a narrower state
than the tour's own requirement, so each would need its own gate for one step, and without one the
miss counts as an unexpected skip).

## Consequences

- **Adding a tour is data plus copy**, in `modular/tutorial-tours.ts` and every locale catalog. A
  consumer deployment contributes its own through `registerAppModule` and it appears in the prompt,
  the catalogue and the progress count with nothing to declare.
- **The anchors are the one thing nothing else in the build checks**, so they are drift-guarded
  (`tutorial-tours.spec.ts`) against the ids the layer really renders. A renamed `data-testid`
  otherwise passes typecheck, lint and the whole e2e suite while leaving every user of that tour on
  a permanent "you missed N steps" notice.
- **A new OFFER surface must thin against `offeredAtLaunch`**, or it starts interrupting people with
  reference material.
- **A new `boardHas*` gate belongs in `BOARD_STATE_GATES`, and a new gate of any other kind does
  not.** The contextual offer fires only when that fingerprint moves, so a board-state gate left out
  of it silently costs the moment it was added to catch, while a permission or capability gate put
  INTO it re-opens the every-board-load greeting. The test for which it is: could following the
  product change this value, or does it only ever become KNOWN?
- **A new gate field doubles `navRequirementDrift`'s matrix.** At sixteen booleans the whole
  enumeration still costs milliseconds, which is the price of a guard that assumes nothing about how
  either predicate is spelled; a materially larger gate set would need a different strategy.
- **A tour can be hidden by a SECTION, not only by a nav entry**, and the drift guard cannot see one
  level in. `panel-reviews` clicks a basic-mode entry whose consensus section renders only in
  advanced mode or once a group exists, so its tier requirement is declared by hand and pinned by a
  named test.
- **Both mirror directions are best-effort by design.** The local store stays the source the SPA
  reads and stays fully functional with no accounts, no progress store wired, or offline. A burnt
  contextual offer (raised, suppressed, then reloaded before it was shown) is lost rather than
  re-armed, because re-arming turns one missed moment into a prompt that keeps returning on a board
  whose gates flip constantly.
- **The merge is NOT rev-guarded, which is a deliberate exception to the one-JSON-blob rule.** That
  rule exists where the row IS the data and a lost update is data loss; this row is a mirror of a
  client-authoritative store. A union is idempotent under RETRY but not commutative under
  CONCURRENCY, so two simultaneous merges can still drop a writer's ids, and the exception is only
  defensible because the repair is automatic: the response is the merged row, the client reconciles
  against it, and an answer missing something local re-pushes. Anything that stops the client
  reconciling the response turns this back into the bug the rule is about.
- **A grow-only set needs a ceiling on the RESULT, not just on the request.** The wire schema caps
  each write at `MAX_TUTORIAL_TOUR_IDS`, which bounds nothing about a row built from unioned writes,
  and this row rides every workspace snapshot for its user, so the cost is paid per board load rather
  than per write. Merges that would cross it are refused (`tutorial_progress_too_large`), not
  truncated, because a real catalog is a few dozen ids and a silently dropped tail is
  indistinguishable from a client that never sent one.
- **`POST /tutorial/events` is bounded by sign-in and nothing else.** A signed-in user can inflate
  the aggregate counts. What they cannot do is cost the operator's backend anything structural, since
  the `tour` dimension is separately capped and nothing is stored or per-user. A throttle becomes
  worth its complexity the moment these counters gate a decision instead of informing one.
- **`offeredAtLaunch` still defaults to OFFERED**, so prompt crowding returns for a deployment
  shipping four tours of its own. That remains the right default (nothing may fall out of the offer
  by omission) and the contextual offer is the answer to it.
