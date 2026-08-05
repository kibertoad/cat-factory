---
'@cat-factory/app': patch
---

Cover four essential product surfaces end to end (and instrument what they needed)

The Playwright suite had grown to 37 specs without touching four things the product cannot be used
without, each of them the kind of surface only the assembled product can fail on:

- **The pipeline builder.** Every spec created pipelines over REST, which is exactly the layer that
  cannot fail the way the builder does: it holds a draft as an ordered kind list plus parallel
  per-step flag arrays, assembles a save payload from them, and the engine reads those arrays back
  to decide where to stop. Nothing checked the three agree, and a flag written at the wrong index
  saves cleanly, lists correctly, and runs differently from the picture the human drew. The spec
  draws `architect → coder` with a gate on the FIRST step and asserts the run parks on the
  architect.
- **Deep PR review.** What a human curates is what reaches the pull request, and that curation
  exists only in this window. Dismiss a false positive, deselect a finding, publish the rest, read
  the report back.
- **The run outcome card** ("read the result"), which in basic mode is what a finished task's one
  result affordance opens. Its failure mode is a section reading CLEAN because a producer's output
  never arrived.
- **Board switching**, the affordance every other spec bypassed by pinning a board client-side, and
  the one that has to move the live WebSocket subscription. A stale subscription looks perfectly
  healthy — the new board renders from the REST snapshot — and only later updates go missing.

The SPA changes are `data-testid` hooks the specs select through (the suite's selector rule): the
agent palette's per-kind add buttons, the builder's name field, draft step rows (with their kind and
gate state) and per-step gate toggle, the step-detail rail's agent heading, and the board switcher
plus its per-board menu rows. No behaviour changes.

Two backend-fixture notes for whoever writes the next spec, both learned the hard way and both now
in the suite README. A `Service` is ACCOUNT-owned, so two specs importing the same repo get one
frame that belongs to whichever workspace imported it first (`seedOwnRepo` exists for that). And the
run↔repository seam is wired as a scoped override rather than the facade's production resolver:
the seeded board has no repo-linked frame, and the production walk THROWS for a block under none
(deliberately — a run must never guess a repository), which fails the poll of every seeded run whose
kind declares repo hooks.
